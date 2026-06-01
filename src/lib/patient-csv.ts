/**
 * QuickBooks "Sales by Patient Detail" CSV → ParsedPatientFile.
 *
 * Pure parser; no I/O, no Supabase, client + server safe. The server fn
 * runs it after the upload, and the import receipt UI can run it on the
 * dropped file before sending — preview-the-receipt-before-you-import is
 * the right pattern (see Reports v1 preview flow).
 *
 * The QuickBooks export is its own dialect:
 *
 *   Row 1 : "REJUV SKIN SPA, LLC",,,,,,,,,             ← business name
 *   Row 2 : Sales by Patient Detail,,,,,,,,,             ← report name
 *   Row 3 : "January 1, 2023-May 14, 2026",,,,,,,,,      ← date range
 *   Row 4 : (blank)
 *   Row 5 : ,Transaction date,Transaction type,Num,...    ← header row
 *   …
 *   "Last, First",,,,,,,,,                                ← patient header
 *   ,09/09/2023,Sales Receipt,1039,Jeuveau,…             ← transaction
 *   …
 *   "Total for Last, First",,,,,,QTY,,$AMOUNT,           ← patient subtotal
 *   "Next, Patient",,,,,,,,,
 *   …
 *   "Total for --",,,,,,QTY,,$AMOUNT,                    ← unassigned subtotal
 *   TOTAL,,,,,,QTY,,$AMOUNT,                              ← grand total
 *   "Accrual Basis …",,,,,,,,,                            ← footer timestamp
 *
 * The state machine: a "current patient" pointer is set when we see a
 * patient-header row (first column non-empty + all other columns empty),
 * cleared when we see a "Total for X" row, and every transaction row
 * (first column empty, second column a date) is attached to whichever
 * patient is current. Header rows and footer rows are skipped.
 *
 * Established 2026-05-15 (Patient Architecture P1).
 */

import { parseCsvGrid } from "@/lib/csv-grid";
import { normalizePatientName } from "@/lib/normalize-patient";
import {
  resolveProduct,
  type ProductManufacturer,
  type ProductKind,
} from "@/lib/product-manufacturer-map";

// ─── Public output shape ──────────────────────────────────────────────────

export type ParsedPatient = {
  /** Canonical lookup key — lowercase + non-alphanumerics → '-'. */
  normalizedName: string;
  /** Display name as captured — preserves capitalization and the comma. */
  displayName: string;
};

export type ParsedTransaction = {
  /** 1-based source row in the original CSV (for traceability). */
  sourceRow: number;
  /** Patient's normalizedName — joins back to ParsedPatient. */
  patientKey: string;
  /** ISO date YYYY-MM-DD. */
  transactionDate: string;
  /** QuickBooks "Num" column; null when blank in the CSV. */
  invoiceNum: string | null;
  /**
   * Ordinal within (patientKey, transactionDate, invoiceNum). Deterministic
   * from CSV order, so re-imports collapse to no-ops via the unique index.
   */
  lineIndex: number;
  productName: string;
  productManufacturer: ProductManufacturer | null;
  productKind: ProductKind | null;
  description: string | null;
  /** null when QuickBooks emitted a blank quantity (services / notes). */
  quantity: number | null;
  unitPriceUsd: number | null;
  /** Always present — negative for redemptions / refunds / discounts. */
  amountUsd: number;
  /** Running balance as captured — informational, not load-bearing. */
  balanceUsd: number | null;
};

export type ParseWarning = {
  /** 1-based source row where the issue was detected. */
  sourceRow: number;
  message: string;
};

export type ParsedPatientFile = {
  /** Business name from row 1 ("REJUV SKIN SPA, LLC"). null if absent. */
  businessName: string | null;
  /** Date range string from row 3 ("January 1, 2023-May 14, 2026"). */
  dateRangeLabel: string | null;
  patients: ParsedPatient[];
  transactions: ParsedTransaction[];
  /** Distinct unrecognized product names — surface in the receipt UI. */
  unknownProductNames: string[];
  warnings: ParseWarning[];
  /** Pre-aggregated for the post-import receipt. */
  totals: {
    patientCount: number;
    transactionCount: number;
    revenueUsd: number;
  };
};

// ─── Internal helpers ─────────────────────────────────────────────────────

/**
 * Lowercase + NFKD-strip + collapse non-alphanumeric → '-'. Backwards-compat
 * shim — delegates to the canonical `normalizePatientName` in
 * src/lib/normalize-patient.ts so the patient ingest and appointment
 * matching pipelines produce identical keys for the same input.
 * Pre-v378 the two sides used different normalizers, which made every
 * accented name a structural miss.
 */
export function normalizeName(display: string): string {
  return normalizePatientName(display);
}

/**
 * Parse a US-formatted date string ("MM/DD/YYYY") to ISO ("YYYY-MM-DD").
 * Returns null when the input doesn't match — caller is expected to flag
 * the row as a warning and skip it.
 */
function parseDate(raw: string): string | null {
  const m = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const month = m[1].padStart(2, "0");
  const day = m[2].padStart(2, "0");
  const year = m[3];
  return `${year}-${month}-${day}`;
}

/**
 * Parse a currency-formatted string. Handles:
 *   "$2,302.00"   → 2302
 *   "-40.00"      → -40
 *   "(40.00)"     → -40   (accounting negatives, rare in QB but seen)
 *   "1,376.00"    → 1376
 *   ""            → null  (empty quantity cells in QB)
 */
function parseMoney(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const paren = /^\((.+)\)$/.exec(trimmed);
  const body = paren ? `-${paren[1]}` : trimmed;
  const cleaned = body.replace(/[$,\s]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Is this row's first column a patient header? Patient headers are the
 * only rows where col 0 is non-empty AND every other column is empty.
 * Excludes "Total for X" rows (they have aggregate values in qty/amount).
 */
function isPatientHeaderRow(cells: string[]): boolean {
  if (!cells[0] || cells[0].trim() === "") return false;
  if (cells[0].trim().toLowerCase().startsWith("total for")) return false;
  // Allow up to the 10-col QB shape; tolerate trailing empties.
  for (let i = 1; i < cells.length; i++) {
    if (cells[i] && cells[i].trim() !== "") return false;
  }
  return true;
}

/**
 * Patient totals rows ("Total for Last, First") AND the section totals
 * ("Total for --") AND the grand total ("TOTAL"). All clear the current
 * patient pointer; we don't ingest them as transactions.
 */
function isTotalsRow(cells: string[]): boolean {
  const c0 = (cells[0] ?? "").trim().toLowerCase();
  return c0.startsWith("total for") || c0 === "total";
}

/**
 * Footer rows that QuickBooks emits at the very end:
 *   "Accrual Basis Friday, May 15, 2026 01:21 AM GMTZ",,…
 */
function isFooterRow(cells: string[]): boolean {
  const c0 = (cells[0] ?? "").trim().toLowerCase();
  return c0.startsWith("accrual basis") || c0.startsWith("cash basis");
}

/**
 * A transaction row has an empty first column and a parseable date in col 1.
 * Anything else (blank rows, the column-header row, mid-file separators)
 * the parser ignores.
 */
function isTransactionRow(cells: string[]): boolean {
  if ((cells[0] ?? "").trim() !== "") return false;
  return parseDate(cells[1] ?? "") !== null;
}

// ─── Public entry point ───────────────────────────────────────────────────

export type ParseOptions = {
  /** Filename for source_ref traceability — appended to "<file>:<row>". */
  sourceFilename?: string;
};

export function parsePatientDetailCsv(
  csv: string,
  opts: ParseOptions = {},
): ParsedPatientFile {
  const grid = parseCsvGrid(csv);
  const warnings: ParseWarning[] = [];
  const patients = new Map<string, ParsedPatient>();
  const transactions: ParsedTransaction[] = [];
  const unknownProducts = new Set<string>();

  // Pre-header metadata — first 3 rows of a QB Sales by Patient Detail.
  const businessName = pickFirstNonEmpty(grid[0]) ?? null;
  const dateRangeLabel = pickFirstNonEmpty(grid[2]) ?? null;

  let currentPatient: ParsedPatient | null = null;
  // Tracks (date|invoiceNum) → next line_index, scoped to currentPatient.
  // Reset on patient switch.
  let lineIndexByInvoice: Map<string, number> = new Map();
  // Don't treat patient-header-shaped rows ("REJUV SKIN SPA, LLC", "Sales by
  // Patient Detail", date-range row) as patients — wait until we've passed
  // the column-header row that separates metadata from data.
  let headerSeen = false;

  for (let i = 0; i < grid.length; i++) {
    const cells = grid[i];
    const sourceRow = i + 1; // human-friendly 1-based

    // Skip fully-empty rows.
    if (cells.every((c) => !c || c.trim() === "")) continue;

    // The column-header row ("," + "Transaction date" + …). Identifiable by
    // its content; we don't rely on a fixed row number because QB sometimes
    // adds an extra blank row or moves things. Skip and continue.
    if ((cells[1] ?? "").trim().toLowerCase() === "transaction date") {
      headerSeen = true;
      continue;
    }
    if (!headerSeen) continue; // pre-header metadata (business name etc.)

    if (isFooterRow(cells)) continue;

    if (isTotalsRow(cells)) {
      currentPatient = null;
      lineIndexByInvoice = new Map();
      continue;
    }

    if (isPatientHeaderRow(cells)) {
      const display = cells[0].trim();
      const normalized = normalizeName(display);
      if (!normalized) {
        warnings.push({
          sourceRow,
          message: `Couldn't normalize patient name "${display}"`,
        });
        currentPatient = null;
        continue;
      }
      // Last write wins if QB emits a duplicate patient header; in the
      // Rejuv snapshot there are no duplicates.
      const patient: ParsedPatient = { normalizedName: normalized, displayName: display };
      patients.set(normalized, patient);
      currentPatient = patient;
      lineIndexByInvoice = new Map();
      continue;
    }

    if (isTransactionRow(cells)) {
      if (!currentPatient) {
        // QB's "Sales by Patient Detail" emits an unassigned/walk-in
        // section at the bottom under the implicit "--" patient (no
        // header row, just transactions). Bucket them under a synthetic
        // "Unassigned" patient so the data isn't dropped — Karen can
        // reassign them later from the detail view if she wants.
        const unassigned: ParsedPatient = {
          normalizedName: "unassigned-walk-in",
          displayName: "Unassigned",
        };
        if (!patients.has(unassigned.normalizedName)) {
          patients.set(unassigned.normalizedName, unassigned);
        }
        currentPatient = patients.get(unassigned.normalizedName)!;
        lineIndexByInvoice = new Map();
      }

      const transactionDate = parseDate(cells[1] ?? "")!; // checked by isTransactionRow
      const invoiceNum = (cells[3] ?? "").trim() || null;
      const productName = (cells[4] ?? "").trim();
      if (!productName) {
        warnings.push({
          sourceRow,
          message: "Row has no product/service name — skipped.",
        });
        continue;
      }
      const description = (cells[5] ?? "").trim() || null;
      const quantity = parseMoney(cells[6] ?? "");
      const unitPriceUsd = parseMoney(cells[7] ?? "");
      const amountUsd = parseMoney(cells[8] ?? "");
      const balanceUsd = parseMoney(cells[9] ?? "");

      if (amountUsd === null) {
        warnings.push({
          sourceRow,
          message: `Couldn't parse amount "${cells[8]}" — row skipped.`,
        });
        continue;
      }

      const invoiceKey = `${transactionDate}|${invoiceNum ?? ""}`;
      const lineIndex = lineIndexByInvoice.get(invoiceKey) ?? 0;
      lineIndexByInvoice.set(invoiceKey, lineIndex + 1);

      const { manufacturer, kind } = resolveProduct(productName);
      if (manufacturer === null && kind === null) {
        unknownProducts.add(productName);
      }

      transactions.push({
        sourceRow,
        patientKey: currentPatient.normalizedName,
        transactionDate,
        invoiceNum,
        lineIndex,
        productName,
        productManufacturer: manufacturer,
        productKind: kind,
        description,
        quantity,
        unitPriceUsd,
        amountUsd,
        balanceUsd,
      });
      continue;
    }

    // Anything else is silently ignored — QB occasionally emits stray
    // formatting rows. Warn so a debug-mode UI can show them.
    warnings.push({
      sourceRow,
      message: `Unrecognized row shape — skipped. First col: "${(cells[0] ?? "").slice(0, 32)}"`,
    });
  }

  // ─── Aggregate totals for the receipt screen ────────────────────────────
  let revenueUsd = 0;
  for (const t of transactions) revenueUsd += t.amountUsd;

  return {
    businessName,
    dateRangeLabel,
    patients: Array.from(patients.values()),
    transactions,
    unknownProductNames: Array.from(unknownProducts).sort(),
    warnings,
    totals: {
      patientCount: patients.size,
      transactionCount: transactions.length,
      revenueUsd: Math.round(revenueUsd * 100) / 100,
    },
  };

  // Reference to keep TS happy about the opts param without forcing the
  // caller to pass it; sourceFilename is consumed by the server fn that
  // builds source_ref. (Kept in the signature for forward use.)
  void opts;
}

function pickFirstNonEmpty(row: string[] | undefined): string | null {
  if (!row) return null;
  for (const c of row) {
    const v = (c ?? "").trim();
    if (v) return v;
  }
  return null;
}

// ─── Summary materialization helpers (shared with server-side upsert) ─────

/**
 * Contact-info subset of the patient summary — sourced from the client-list
 * CSV (P1.5) via cross-match, NOT from the sales CSV. These fields are
 * preserved across re-rolls of the sales-side summary so a sales-CSV
 * re-upload doesn't wipe out the spa owner's contact work.
 */
export type PatientContactSummary = {
  phone: string | null;
  phoneRaw: string | null;
  email: string | null;
  daysSinceLastAppointment: number | null;
  banned: boolean;
  /**
   * v385.2: A-list / VIP flag. Living in PatientContactSummary (rather than
   * directly on PatientSummary) so the rollup-preservation path picks it
   * up automatically — a sales-CSV re-upload that recomputes the rest of
   * the summary won't blow away the spa's VIP designations.
   */
  vip: boolean;
  /**
   * v1.31.0: Patient Soft-Tags — Karen-set editorial layer (Profitability
   * Engine §3.2). NEVER inferred. Each entry carries value + setByUserId
   * + setAt + optional reason note. Lives here so re-rolls preserve them
   * (same path as vip).
   */
  softTags: PatientSoftTags;
  /** Provenance — 'client-csv', 'manual', 'fuzzy-confirmed', or null. */
  contactSource: "client-csv" | "manual" | "fuzzy-confirmed" | null;
  /** ISO timestamp the contact info last changed. */
  contactLinkedAt: string | null;
};

// ─── Patient Soft-Tags (v1.31.0) ───────────────────────────────────────────

export type PatientIncomeTier = "high" | "mid" | "low" | "unknown";
export type PatientNegotiator = "never" | "occasional" | "always";
export type PatientPersonality = "easy" | "neutral" | "complainer";
export type PatientShopperLoyalty = "loyal" | "comparison" | "unknown";

export type PatientSoftTagEntry<TValue> = {
  value: TValue;
  /** auth.uid of the owner who set this tag. */
  setByUserId: string;
  /** ISO timestamp of last write. */
  setAt: string;
  /** Optional free-text rationale captured at set time. */
  reason: string | null;
};

export type PatientSoftTags = {
  incomeTier?: PatientSoftTagEntry<PatientIncomeTier> | null;
  negotiator?: PatientSoftTagEntry<PatientNegotiator> | null;
  specialsSeeker?: PatientSoftTagEntry<boolean> | null;
  personality?: PatientSoftTagEntry<PatientPersonality> | null;
  shopperLoyalty?: PatientSoftTagEntry<PatientShopperLoyalty> | null;
  culturalNotes?: PatientSoftTagEntry<string> | null;
  /**
   * v1.31.1: Karen-defined custom tags (any name + free-text value).
   * Each carries the same provenance shape as the seeded six. Stable
   * uuid id for react keys + targeting updates/deletes. Owner-only
   * visibility (same scoping as the rest of softTags).
   */
  custom?: PatientCustomTag[] | null;
};

export type PatientCustomTag = {
  id: string;
  name: string;
  value: string;
  setByUserId: string;
  setAt: string;
  reason: string | null;
};

export type PatientSoftTagKey = Exclude<keyof PatientSoftTags, "custom">;

export type PatientSummary = {
  normalizedName: string;
  displayName: string;
  firstVisit: string | null;
  lastVisit: string | null;
  totalVisits: number;
  lifetimeUnits: number;
  lifetimeSpendUsd: number;
  netSpendUsd: number;
  primaryManufacturer: ProductManufacturer | null;
  productMix: Partial<Record<ProductManufacturer, number>>;
  loyaltyEngagement: Partial<Record<ProductManufacturer, number>>;
  /**
   * v1.31.2: Per-patient purchase patterns — the differentiator. Tracks
   * her individual cadence across every dimension (kind, manufacturer,
   * specific product) so downstream engines can target offers against
   * her real habits, not population averages. Recomputed on every
   * rollup; never editorial.
   */
  purchasePatterns?: PatientPurchasePatterns;
} & Partial<PatientContactSummary>;

// ─── Purchase patterns (v1.31.2) ──────────────────────────────────────────

/**
 * Per-dimension cadence metrics computed from transaction history. Each
 * dimension key (a kind, a manufacturer, a product name) gets one of
 * these. Computed on rollup, not editorial — pure derivation from the
 * patient_transactions table.
 */
export type CadenceMetrics = {
  /** Distinct visit-dates where this dimension key appeared. */
  visitCount: number;
  /** ISO date of the first visit of this dimension. */
  firstVisit: string | null;
  /** ISO date of the most-recent visit. */
  lastVisit: string | null;
  /**
   * Average days between consecutive visits across the entire history.
   * Null if visitCount < 2 (no intervals to average).
   */
  lifetimeAvgDays: number | null;
  /**
   * Average days between consecutive visits within the last 730 days.
   * Falls back to lifetimeAvgDays when patient tenure < 2 years OR
   * fewer than 2 visits land in the recent window.
   */
  recentAvgDays: number | null;
  /** Days since the most-recent visit of this dimension (UTC, today-anchored). */
  daysSinceLastVisit: number | null;
  /**
   * Cadence status relative to the patient&rsquo;s OWN norm (recent avg
   * preferred, lifetime fallback). Not relative to population norms.
   * &lsquo;unknown&rsquo; when there&rsquo;s no cadence baseline yet.
   */
  status: "on-cadence" | "overdue" | "lapsed" | "unknown";
  /**
   * Trend: recent avg vs lifetime avg. &lsquo;accelerating&rsquo; means buying
   * more often than long-term norm; &lsquo;slowing&rsquo; means engagement
   * dropping. Null when there&rsquo;s no meaningful comparison.
   */
  trend: "accelerating" | "steady" | "slowing" | null;
};

export type PatientPurchasePatterns = {
  /** Per clinical kind (toxin / filler / biostim / device / facial / etc). */
  byKind: Partial<Record<ProductKind, CadenceMetrics>>;
  /** Per manufacturer (AbbVie / Galderma / Merz / Revance / etc). */
  byManufacturer: Partial<Record<ProductManufacturer, CadenceMetrics>>;
  /**
   * Per specific product name. Keyed by raw product name (no
   * normalization) so &lsquo;Botox 100u Vial&rsquo; and &lsquo;Botox Vial 100u&rsquo;
   * are distinct entries until Karen consolidates them in catalog.
   */
  byProduct: Record<string, CadenceMetrics>;
};

// Product kinds excluded from cadence computation — these don't represent
// purchase events: a payment line / discount line / clinical note isn't a
// visit. Reward redemptions ARE visits (she came in to use Alle / Aspire).
const CADENCE_EXCLUDED_KINDS: ReadonlySet<ProductKind> = new Set([
  "payment",
  "discount",
  "note",
]);

/** Days between two ISO yyyy-mm-dd strings (UTC). Floors to whole days. */
function daysBetween(fromIso: string, toIso: string): number {
  const [fy, fm, fd] = fromIso.split("-").map(Number);
  const [ty, tm, td] = toIso.split("-").map(Number);
  if (!fy || !fm || !fd || !ty || !tm || !td) return 0;
  const fromUtc = Date.UTC(fy, fm - 1, fd);
  const toUtc = Date.UTC(ty, tm - 1, td);
  return Math.floor((toUtc - fromUtc) / 86_400_000);
}

function daysSinceToday(iso: string | null): number | null {
  if (!iso) return null;
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return null;
  return Math.floor((Date.now() - Date.UTC(y, m - 1, d)) / 86_400_000);
}

/**
 * Compute CadenceMetrics from a list of visit dates (one entry per visit;
 * may include duplicates which are de-duplicated to distinct calendar
 * dates).
 *
 * `nowDays` is &ldquo;today&rdquo; for status calculation, defaulted to actual now
 * but injectable for deterministic tests.
 */
function computeCadenceFromDates(
  rawDates: string[],
  nowDays: number = Math.floor(Date.now() / 86_400_000),
): CadenceMetrics {
  if (rawDates.length === 0) {
    return {
      visitCount: 0,
      firstVisit: null,
      lastVisit: null,
      lifetimeAvgDays: null,
      recentAvgDays: null,
      daysSinceLastVisit: null,
      status: "unknown",
      trend: null,
    };
  }

  // Distinct sorted dates ascending.
  const distinct = Array.from(new Set(rawDates)).sort();
  const firstVisit = distinct[0]!;
  const lastVisit = distinct[distinct.length - 1]!;
  const visitCount = distinct.length;

  // Intervals between consecutive visits in days.
  const intervals: number[] = [];
  for (let i = 1; i < distinct.length; i++) {
    intervals.push(daysBetween(distinct[i - 1]!, distinct[i]!));
  }

  const lifetimeAvgDays =
    intervals.length > 0
      ? Math.round(intervals.reduce((s, v) => s + v, 0) / intervals.length)
      : null;

  // Recent window: visits within last 730 days (2 years) of TODAY.
  const recentCutoffDays = nowDays - 730;
  const recentDates = distinct.filter((iso) => {
    const [y, m, d] = iso.split("-").map(Number);
    if (!y || !m || !d) return false;
    return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000) >= recentCutoffDays;
  });
  let recentAvgDays: number | null = null;
  if (recentDates.length >= 2) {
    const recentIntervals: number[] = [];
    for (let i = 1; i < recentDates.length; i++) {
      recentIntervals.push(daysBetween(recentDates[i - 1]!, recentDates[i]!));
    }
    recentAvgDays = Math.round(
      recentIntervals.reduce((s, v) => s + v, 0) / recentIntervals.length,
    );
  } else {
    // Fall back to lifetime when patient tenure is short OR recent window
    // is too sparse to be its own signal.
    recentAvgDays = lifetimeAvgDays;
  }

  const daysSinceLastVisit = daysSinceToday(lastVisit);

  // Status relative to patient&rsquo;s OWN norm. recentAvg preferred when
  // present, lifetime fallback. Buffered: on-cadence up to 1.2x norm,
  // overdue 1.2-1.5x, lapsed >1.5x.
  const norm = recentAvgDays ?? lifetimeAvgDays;
  let status: CadenceMetrics["status"] = "unknown";
  if (norm !== null && daysSinceLastVisit !== null) {
    const ratio = daysSinceLastVisit / Math.max(norm, 1);
    if (ratio <= 1.2) status = "on-cadence";
    else if (ratio <= 1.5) status = "overdue";
    else status = "lapsed";
  }

  // Trend: recent vs lifetime. Only meaningful when both present AND
  // they differ enough to call out (15% threshold avoids noise).
  let trend: CadenceMetrics["trend"] = null;
  if (
    recentAvgDays !== null &&
    lifetimeAvgDays !== null &&
    recentAvgDays !== lifetimeAvgDays
  ) {
    const ratio = recentAvgDays / lifetimeAvgDays;
    if (ratio < 0.85) trend = "accelerating";
    else if (ratio > 1.15) trend = "slowing";
    else trend = "steady";
  }

  return {
    visitCount,
    firstVisit,
    lastVisit,
    lifetimeAvgDays,
    recentAvgDays,
    daysSinceLastVisit,
    status,
    trend,
  };
}

/**
 * Compute the full PatientPurchasePatterns shape from a patient&rsquo;s
 * transaction lines. Groups by kind / manufacturer / product-name, then
 * runs computeCadenceFromDates on each group.
 */
export function computePurchasePatterns(
  lines: ParsedTransaction[],
): PatientPurchasePatterns {
  const byKindDates = new Map<ProductKind, string[]>();
  const byMfrDates = new Map<ProductManufacturer, string[]>();
  const byProductDates = new Map<string, string[]>();

  for (const t of lines) {
    if (t.productKind && CADENCE_EXCLUDED_KINDS.has(t.productKind)) continue;

    if (t.productKind) {
      const arr = byKindDates.get(t.productKind) ?? [];
      arr.push(t.transactionDate);
      byKindDates.set(t.productKind, arr);
    }
    if (t.productManufacturer) {
      const arr = byMfrDates.get(t.productManufacturer) ?? [];
      arr.push(t.transactionDate);
      byMfrDates.set(t.productManufacturer, arr);
    }
    if (t.productName) {
      const arr = byProductDates.get(t.productName) ?? [];
      arr.push(t.transactionDate);
      byProductDates.set(t.productName, arr);
    }
  }

  const byKind: Partial<Record<ProductKind, CadenceMetrics>> = {};
  for (const [kind, dates] of byKindDates) {
    byKind[kind] = computeCadenceFromDates(dates);
  }
  const byManufacturer: Partial<Record<ProductManufacturer, CadenceMetrics>> = {};
  for (const [mfr, dates] of byMfrDates) {
    byManufacturer[mfr] = computeCadenceFromDates(dates);
  }
  const byProduct: Record<string, CadenceMetrics> = {};
  for (const [name, dates] of byProductDates) {
    byProduct[name] = computeCadenceFromDates(dates);
  }

  return { byKind, byManufacturer, byProduct };
}

/**
 * Roll up a patient's transaction lines into the summary attachments shape
 * stored on the knowledge_nodes row. Mirrors the design doc's Decision 4
 * verbatim — fast list-view reads, no live joins. Total visits = distinct
 * transaction_date count (not invoice count) so a same-day multi-invoice
 * visit counts once.
 *
 * `priorContact` carries client-list-sourced contact fields forward when
 * re-rolling after a sales-CSV re-upload, so the spa owner's contact work
 * isn't lost. Pass null when there's no prior state.
 */
export function rollupPatientSummary(
  patient: ParsedPatient,
  lines: ParsedTransaction[],
  priorContact: Partial<PatientContactSummary> | null = null,
): PatientSummary {
  const dates = new Set<string>();
  let lifetimeUnits = 0;
  let lifetimeSpend = 0;
  let netSpend = 0;
  let firstVisit: string | null = null;
  let lastVisit: string | null = null;
  const productMix: Partial<Record<ProductManufacturer, number>> = {};
  const loyaltyEngagement: Partial<Record<ProductManufacturer, number>> = {};

  for (const t of lines) {
    dates.add(t.transactionDate);
    if (!firstVisit || t.transactionDate < firstVisit) firstVisit = t.transactionDate;
    if (!lastVisit || t.transactionDate > lastVisit) lastVisit = t.transactionDate;

    netSpend += t.amountUsd;
    if (t.amountUsd > 0) {
      lifetimeSpend += t.amountUsd;
      if (t.quantity && Number.isFinite(t.quantity)) lifetimeUnits += t.quantity;
    }

    const mfr = t.productManufacturer;
    if (mfr) {
      if (t.productKind === "reward") {
        loyaltyEngagement[mfr] = (loyaltyEngagement[mfr] ?? 0) + 1;
      } else {
        productMix[mfr] = (productMix[mfr] ?? 0) + 1;
      }
    }
  }

  // Primary manufacturer = top by productMix line count (rewards excluded —
  // they trail their purchase brand, so they'd double-count the signal).
  let primaryManufacturer: ProductManufacturer | null = null;
  let topCount = 0;
  for (const [mfr, count] of Object.entries(productMix) as [
    ProductManufacturer,
    number,
  ][]) {
    if (count > topCount) {
      topCount = count;
      primaryManufacturer = mfr;
    }
  }

  const summary: PatientSummary = {
    normalizedName: patient.normalizedName,
    displayName: patient.displayName,
    firstVisit,
    lastVisit,
    totalVisits: dates.size,
    lifetimeUnits: Math.round(lifetimeUnits * 100) / 100,
    lifetimeSpendUsd: Math.round(lifetimeSpend * 100) / 100,
    netSpendUsd: Math.round(netSpend * 100) / 100,
    primaryManufacturer,
    productMix,
    loyaltyEngagement,
    purchasePatterns: computePurchasePatterns(lines),
  };
  if (priorContact) {
    if (priorContact.phone !== undefined) summary.phone = priorContact.phone;
    if (priorContact.phoneRaw !== undefined) summary.phoneRaw = priorContact.phoneRaw;
    if (priorContact.email !== undefined) summary.email = priorContact.email;
    if (priorContact.daysSinceLastAppointment !== undefined)
      summary.daysSinceLastAppointment = priorContact.daysSinceLastAppointment;
    if (priorContact.banned !== undefined) summary.banned = priorContact.banned;
    if (priorContact.vip !== undefined) summary.vip = priorContact.vip;
    if (priorContact.contactSource !== undefined)
      summary.contactSource = priorContact.contactSource;
    if (priorContact.contactLinkedAt !== undefined)
      summary.contactLinkedAt = priorContact.contactLinkedAt;
  }
  return summary;
}
