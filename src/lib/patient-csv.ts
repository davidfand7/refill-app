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
import { KIND_CADENCE } from "@/lib/patient-cadence";
import type { ValueTier, ReliabilityFlag } from "@/lib/patient-value";
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
  /**
   * v2.2.0 (Lane 2): true for manufacturer last-treatment marker rows
   * (source = MFR_LAST_TXN_SOURCE, amount_usd = 0). These exist ONLY to
   * sharpen lapsed/overdue detection — they are NOT real visits or revenue.
   * rollupPatientSummary skips them so the patient-list summary stays
   * QuickBooks-truth (no inflated visit counts / primary brand). The
   * lapsed-detection queries read patient_transactions directly and opt
   * these rows IN by source. Defaults false / undefined for QB lines.
   */
  cadenceOnly?: boolean;
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
   * v1.34.9.3: soft-hide. Karen-toggled to remove a patient from the active
   * list without deleting the underlying record. Re-roll preserved like
   * banned + vip — a sales-CSV re-upload won't unhide. Hidden patients are
   * also excluded from rescue + recognition allocation flows (cohort
   * scoring continues to read them but suggestions/dispatches skip).
   */
  hidden: boolean;
  /**
   * v1.31.0: Patient Soft-Tags — Karen-set editorial layer (Profitability
   * Engine §3.2). NEVER inferred. Each entry carries value + setByUserId
   * + setAt + optional reason note. Lives here so re-rolls preserve them
   * (same path as vip).
   */
  softTags: PatientSoftTags;
  /**
   * v1.32.0: Life-Event Log entries. Same preservation path as softTags —
   * re-rolls don't blow away Karen's captured events.
   */
  lifeEvents: PatientLifeEvent[];
  /** Provenance — 'client-csv', 'manual', 'fuzzy-confirmed', or null. */
  contactSource: "client-csv" | "manual" | "fuzzy-confirmed" | null;
  /** ISO timestamp the contact info last changed. */
  contactLinkedAt: string | null;
  /**
   * v2.113.0: Patient Value Tiering (Patient-Profitability OS, Pillar 1).
   * Internal-only, NEVER patient-visible. Computed whole-book (percentile is
   * tenant-relative) by `recomputePatientValueTiers`, NOT on rollup — so they
   * live here in PatientContactSummary to survive sales-CSV re-rolls the same
   * way vip/softTags/lifeEvents do (a re-upload recomputes the spend/visit
   * summary but must NOT blow away the last computed tier). See
   * `@/lib/patient-value`.
   */
  valueTier?: ValueTier | null;
  /** 0–100 composite RFM percentile rank within the book at compute time. */
  valueScore?: number | null;
  /** Behavior axis, independent of value. "watch" = interference risk. */
  reliabilityFlag?: ReliabilityFlag | null;
  /** ISO timestamp the tiers were last recomputed. */
  valueTieredAt?: string | null;
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
   * v1.34.3.1: per-patient routing override for the Preshow Agent. UUID
   * of an preshow_profiles row under this tenant. When set,
   * dispatchPreShowReminder resolves THIS profile; when null/absent
   * (Karen never set it OR profile was deleted), falls back to the
   * spa's is_default=true profile. Lets Karen route the Chronic-cohort
   * profile to her chronic-reschedule patients without changing the
   * spa-wide default.
   */
  preshowProfileId?: PatientSoftTagEntry<string> | null;
  /**
   * v1.31.1 LEGACY: per-patient custom tags. v1.31.5 introduces
   * tenant-wide custom tag definitions (see customSelections) — new
   * tags use that shape. Old entries continue to render in a
   * &lsquo;Legacy&rsquo; subsection with a promote-to-tenant affordance.
   */
  custom?: PatientCustomTag[] | null;
  /**
   * v1.31.5: per-patient values for tenant-wide custom tag definitions.
   * Keyed by definitionId (uuid) which points to a row in
   * knowledge_nodes with node_type='custom_tag_definition' under the
   * tenant&rsquo;s user_id. The options chips come from the definition;
   * the patient&rsquo;s selected subset + provenance live here.
   */
  customSelections?: Record<string, PatientCustomTagValue> | null;
};

/**
 * v1.31.5: per-patient value for a tenant-wide custom tag definition.
 * The options chips themselves live on the definition; this just stores
 * which chips Karen toggled active for THIS patient + provenance.
 */
export type PatientCustomTagValue = {
  selected: string[];
  setByUserId: string;
  setAt: string;
  reason: string | null;
};

/**
 * v1.31.5: tenant-wide custom tag definition. Stored as a
 * knowledge_nodes row with node_type='custom_tag_definition'. Karen
 * creates one (&lsquo;Rescheduler&rsquo; with chips Chronic/Occasional/Never),
 * and it appears on every patient&rsquo;s SoftTagsCard with a Set tag
 * affordance &mdash; same UX as the seeded six tags.
 */
export type CustomTagDefinition = {
  id: string;
  name: string;
  options: string[];
  createdByUserId: string;
  createdAt: string;
};

// ─── Life-Event Log (v1.32.0, Profitability Engine §3.3) ─────────────────

/**
 * Seeded event types. Karen can also pick &lsquo;custom&rsquo; and type a
 * free-form label. Each seed has sensible default WTP/ATP modifier
 * directions + TTL that Karen can override per event. Choice of
 * seeded list comes from Grasshopper&rsquo;s 16-year front-desk
 * synthesis (the events that actually modulate spending behavior).
 */
export type PatientLifeEventType =
  | "job_loss"
  | "promotion"
  | "engagement"
  | "marriage"
  | "divorce"
  | "new_baby"
  | "milestone_birthday"
  | "retirement"
  | "vacation"
  | "health_event"
  | "relocation"
  | "graduation"
  | "bereavement"
  | "custom";

/**
 * A single life event Karen captured for a patient. WTP / ATP modifiers
 * are percentage shifts (-100 to +100) relative to that patient&rsquo;s
 * baseline. TTL controls how long the modifier stays active before
 * the event is &lsquo;preserved&rsquo; (archived but no longer modulating
 * scores). null TTL means the modifier never decays automatically.
 */
export type PatientLifeEvent = {
  id: string;
  eventType: PatientLifeEventType;
  /** When this seed is &lsquo;custom&rsquo;, the Karen-typed label. */
  customLabel: string | null;
  /** ISO yyyy-mm-dd date when the event happened (not when logged). */
  eventDate: string;
  /**
   * Willingness-to-pay modifier as a percentage shift. Negative =
   * less willing to pay full price; positive = more willing. E.g.,
   * &lsquo;engagement&rsquo; might be +20 (looking-her-best motivation),
   * &lsquo;divorce&rsquo; might be -15 (cost-cutting mindset).
   */
  wtpModifier: number;
  /**
   * Ability-to-pay modifier as a percentage shift. Distinct from
   * WTP: a patient may still WANT the treatment but have fewer
   * dollars (job loss = ATP -30%). Recognition / discount calibration
   * uses the lower of the two when deciding to upsell vs. discount.
   */
  atpModifier: number;
  /**
   * Days the modifier stays active before the event auto-archives.
   * Null = never decays automatically (Karen marks resolved manually).
   * E.g., job loss might be 180d, vacation 14d, engagement 365d.
   */
  ttlDays: number | null;
  /** Karen&rsquo;s free-text rationale captured at set time. */
  reason: string | null;
  /** auth.uid of the human who logged it. */
  setByUserId: string;
  /** ISO timestamp when logged (distinct from eventDate). */
  setAt: string;
};

/**
 * Computed live: is this event still modulating scores? An event is
 * active when (now - eventDate) &le; ttlDays, OR when ttlDays is null
 * and the event hasn&rsquo;t been manually archived. Use this in any
 * scoring path that needs to know whether to apply WTP/ATP shifts.
 */
export function isLifeEventActive(
  event: PatientLifeEvent,
  nowDate: Date = new Date(),
): boolean {
  if (event.ttlDays === null) return true;
  const [y, m, d] = event.eventDate.split("-").map(Number);
  if (!y || !m || !d) return false;
  const eventMs = Date.UTC(y, m - 1, d);
  const daysElapsed = Math.floor((nowDate.getTime() - eventMs) / 86_400_000);
  return daysElapsed <= event.ttlDays;
}

/**
 * Aggregate WTP/ATP modifier from all active events on a patient.
 * Modifiers are summed (not multiplied) so two active +10 events
 * stack to +20. Clamped to [-100, +100] at the boundary.
 */
export type ActiveLifeEventModifier = {
  wtpModifier: number;
  atpModifier: number;
  activeCount: number;
  /** Days until the next event decays (for surface display). */
  nextDecayDays: number | null;
};

export function computeActiveModifiers(
  events: PatientLifeEvent[],
  nowDate: Date = new Date(),
): ActiveLifeEventModifier {
  let wtp = 0;
  let atp = 0;
  let activeCount = 0;
  let nextDecayDays: number | null = null;
  for (const e of events) {
    if (!isLifeEventActive(e, nowDate)) continue;
    wtp += e.wtpModifier;
    atp += e.atpModifier;
    activeCount += 1;
    if (e.ttlDays !== null) {
      const [y, m, d] = e.eventDate.split("-").map(Number);
      if (y && m && d) {
        const eventMs = Date.UTC(y, m - 1, d);
        const daysElapsed = Math.floor(
          (nowDate.getTime() - eventMs) / 86_400_000,
        );
        const remaining = e.ttlDays - daysElapsed;
        if (nextDecayDays === null || remaining < nextDecayDays) {
          nextDecayDays = remaining;
        }
      }
    }
  }
  return {
    wtpModifier: Math.max(-100, Math.min(100, wtp)),
    atpModifier: Math.max(-100, Math.min(100, atp)),
    activeCount,
    nextDecayDays,
  };
}

/**
 * Default WTP / ATP / TTL per seeded event type. Karen can override
 * any of these per event. The defaults encode Grasshopper&rsquo;s
 * 16-year front-desk synthesis (e.g., engagement raises WTP without
 * touching ATP; job loss tanks ATP without changing WTP).
 */
export const LIFE_EVENT_DEFAULTS: Record<
  Exclude<PatientLifeEventType, "custom">,
  { wtpModifier: number; atpModifier: number; ttlDays: number | null; label: string }
> = {
  job_loss: { wtpModifier: 0, atpModifier: -30, ttlDays: 180, label: "Job loss" },
  promotion: { wtpModifier: +10, atpModifier: +15, ttlDays: 365, label: "Promotion / raise" },
  engagement: { wtpModifier: +25, atpModifier: 0, ttlDays: 365, label: "Engagement" },
  marriage: { wtpModifier: +20, atpModifier: 0, ttlDays: 180, label: "Marriage / wedding" },
  divorce: { wtpModifier: -10, atpModifier: -20, ttlDays: 270, label: "Divorce" },
  new_baby: { wtpModifier: -15, atpModifier: -10, ttlDays: 365, label: "New baby" },
  milestone_birthday: { wtpModifier: +30, atpModifier: 0, ttlDays: 90, label: "Milestone birthday" },
  retirement: { wtpModifier: -5, atpModifier: -15, ttlDays: null, label: "Retirement" },
  vacation: { wtpModifier: +20, atpModifier: 0, ttlDays: 60, label: "Vacation coming up" },
  health_event: { wtpModifier: -20, atpModifier: 0, ttlDays: 180, label: "Health event" },
  relocation: { wtpModifier: -10, atpModifier: 0, ttlDays: 120, label: "Relocation" },
  graduation: { wtpModifier: +15, atpModifier: 0, ttlDays: 90, label: "Graduation" },
  bereavement: { wtpModifier: -15, atpModifier: 0, ttlDays: 180, label: "Bereavement" },
};

/**
 * v1.31.4: Custom tags now match the preset-tag UX: Karen defines a list
 * of chip options once, then taps which ones apply for THIS patient.
 * Same shape regardless of whether she ends up with 1 chip ("Allergies:
 * lidocaine") or 4 ("Family/Friends Pricing: Mother/Daughter, Siblings,
 * Wife/Husband, Partner"). Backward compat: v1.31.1 tags stored as
 * `value: string` are hydrated to `options: [...split], selected: [all]`
 * on read.
 */
export type PatientCustomTag = {
  id: string;
  name: string;
  options: string[];
  selected: string[];
  setByUserId: string;
  setAt: string;
  reason: string | null;
};

/**
 * v1.31.1 → v1.31.4 hydration: takes any custom-tag-shaped object from
 * the JSONB attachments and returns a normalized v1.31.4-shape tag. Old
 * tags with `value: string` get split by comma into options + all
 * selected by default.
 */
export function normalizeCustomTag(
  raw: PatientCustomTag | { id: string; name: string; value: string; setByUserId: string; setAt: string; reason: string | null },
): PatientCustomTag {
  if ("options" in raw && Array.isArray(raw.options)) {
    return {
      id: raw.id,
      name: raw.name,
      options: raw.options,
      selected: Array.isArray(raw.selected) ? raw.selected : raw.options,
      setByUserId: raw.setByUserId,
      setAt: raw.setAt,
      reason: raw.reason,
    };
  }
  const legacy = raw as {
    id: string;
    name: string;
    value: string;
    setByUserId: string;
    setAt: string;
    reason: string | null;
  };
  const options = legacy.value
    .split(/,\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return {
    id: legacy.id,
    name: legacy.name,
    options,
    selected: options,
    setByUserId: legacy.setByUserId,
    setAt: legacy.setAt,
    reason: legacy.reason,
  };
}

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
  /**
   * v1.31.3: TYPICAL retreatment interval (industry / clinical / FDA /
   * rewards-program norm) for this dimension. Distinct from
   * recentAvgDays which is HER personal norm. Reward programs (Alle /
   * Aspire / Merz Rewards) + FDA label retreatment windows key off
   * this baseline, not her personal cadence. Null when no typical
   * baseline is known for this dimension.
   */
  typicalExpectedDays: number | null;
  /**
   * v1.31.3: Status relative to the TYPICAL baseline (not her own
   * cadence). This is the pill Karen acts on when deciding &ldquo;is she
   * due for an Alle-eligible Botox touchup?&rdquo; &mdash; rewards eligibility
   * is keyed off typical, not personal. &lsquo;unknown&rsquo; when
   * typicalExpectedDays is null or there&rsquo;s no last visit yet.
   */
  typicalStatus: "on-cadence" | "overdue" | "lapsed" | "unknown";
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
  typicalExpectedDays: number | null = null,
  typicalLapsedDays: number | null = null,
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
      typicalExpectedDays,
      typicalStatus: "unknown",
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

  // v1.31.3: status relative to TYPICAL (industry/clinical baseline),
  // distinct from personal `status`. Buffer: on-cadence up to
  // expectedDays, overdue between expected and lapsed, lapsed past.
  let typicalStatus: CadenceMetrics["typicalStatus"] = "unknown";
  if (
    typicalExpectedDays !== null &&
    typicalExpectedDays > 0 &&
    daysSinceLastVisit !== null
  ) {
    if (daysSinceLastVisit <= typicalExpectedDays) typicalStatus = "on-cadence";
    else if (
      typicalLapsedDays !== null &&
      daysSinceLastVisit > typicalLapsedDays
    )
      typicalStatus = "lapsed";
    else typicalStatus = "overdue";
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
    typicalExpectedDays,
    typicalStatus,
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
  // v1.31.3: track which kinds each manufacturer / product is associated
  // with, so we can pick the dominant kind&rsquo;s typical cadence as the
  // typical baseline for that dimension entry.
  const byMfrKindCounts = new Map<
    ProductManufacturer,
    Partial<Record<ProductKind, number>>
  >();
  const byProductKindCounts = new Map<
    string,
    Partial<Record<ProductKind, number>>
  >();

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
      if (t.productKind) {
        const counts = byMfrKindCounts.get(t.productManufacturer) ?? {};
        counts[t.productKind] = (counts[t.productKind] ?? 0) + 1;
        byMfrKindCounts.set(t.productManufacturer, counts);
      }
    }
    if (t.productName) {
      const arr = byProductDates.get(t.productName) ?? [];
      arr.push(t.transactionDate);
      byProductDates.set(t.productName, arr);
      if (t.productKind) {
        const counts = byProductKindCounts.get(t.productName) ?? {};
        counts[t.productKind] = (counts[t.productKind] ?? 0) + 1;
        byProductKindCounts.set(t.productName, counts);
      }
    }
  }

  const typicalForKind = (
    kind: ProductKind | null,
  ): { expected: number | null; lapsed: number | null } => {
    if (!kind) return { expected: null, lapsed: null };
    const win = KIND_CADENCE[kind];
    if (!win) return { expected: null, lapsed: null };
    return { expected: win.expectedDays, lapsed: win.lapsedDays };
  };

  const dominantKind = (
    counts: Partial<Record<ProductKind, number>> | undefined,
  ): ProductKind | null => {
    if (!counts) return null;
    let top: ProductKind | null = null;
    let topCount = 0;
    for (const [k, c] of Object.entries(counts) as [ProductKind, number][]) {
      if (c > topCount) {
        topCount = c;
        top = k;
      }
    }
    return top;
  };

  const byKind: Partial<Record<ProductKind, CadenceMetrics>> = {};
  for (const [kind, dates] of byKindDates) {
    const t = typicalForKind(kind);
    byKind[kind] = computeCadenceFromDates(dates, t.expected, t.lapsed);
  }
  const byManufacturer: Partial<Record<ProductManufacturer, CadenceMetrics>> = {};
  for (const [mfr, dates] of byMfrDates) {
    const t = typicalForKind(dominantKind(byMfrKindCounts.get(mfr)));
    byManufacturer[mfr] = computeCadenceFromDates(dates, t.expected, t.lapsed);
  }
  const byProduct: Record<string, CadenceMetrics> = {};
  for (const [name, dates] of byProductDates) {
    const t = typicalForKind(dominantKind(byProductKindCounts.get(name)));
    byProduct[name] = computeCadenceFromDates(dates, t.expected, t.lapsed);
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
    // Manufacturer last-treatment markers ($0, cadence-only) never count
    // toward the patient-list summary — they'd inflate visit counts and skew
    // the primary brand. The lapsed engine reads them straight from
    // patient_transactions instead. (Lane 2, v2.2.0.)
    if (t.cadenceOnly) continue;
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
    // Cadence-only ($0 manufacturer markers) excluded — the summary stays
    // QuickBooks-truth; lapsed detection reads the markers from the DB direct.
    purchasePatterns: computePurchasePatterns(lines.filter((l) => !l.cadenceOnly)),
  };
  if (priorContact) {
    if (priorContact.phone !== undefined) summary.phone = priorContact.phone;
    if (priorContact.phoneRaw !== undefined) summary.phoneRaw = priorContact.phoneRaw;
    if (priorContact.email !== undefined) summary.email = priorContact.email;
    if (priorContact.daysSinceLastAppointment !== undefined)
      summary.daysSinceLastAppointment = priorContact.daysSinceLastAppointment;
    if (priorContact.banned !== undefined) summary.banned = priorContact.banned;
    if (priorContact.vip !== undefined) summary.vip = priorContact.vip;
    if (priorContact.softTags !== undefined)
      summary.softTags = priorContact.softTags;
    if (priorContact.lifeEvents !== undefined)
      summary.lifeEvents = priorContact.lifeEvents;
    if (priorContact.contactSource !== undefined)
      summary.contactSource = priorContact.contactSource;
    if (priorContact.contactLinkedAt !== undefined)
      summary.contactLinkedAt = priorContact.contactLinkedAt;
    // v2.113.0: value-tiering fields are computed whole-book by a separate
    // recompute pass, not on rollup — so a sales-CSV re-upload must carry the
    // last computed tier forward (same preservation path as vip/softTags).
    if (priorContact.valueTier !== undefined)
      summary.valueTier = priorContact.valueTier;
    if (priorContact.valueScore !== undefined)
      summary.valueScore = priorContact.valueScore;
    if (priorContact.reliabilityFlag !== undefined)
      summary.reliabilityFlag = priorContact.reliabilityFlag;
    if (priorContact.valueTieredAt !== undefined)
      summary.valueTieredAt = priorContact.valueTieredAt;
  }
  return summary;
}
