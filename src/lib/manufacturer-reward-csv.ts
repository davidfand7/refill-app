/**
 * Manufacturer reward-signal CSV parsing + per-manufacturer mappers.
 *
 * Patient-Profitability OS · Phase 0 · Manufacturer Import → RewardSignal.
 *
 * A manufacturer "rewards" export is NOT a transaction log — it's a
 * per-patient SNAPSHOT of loyalty status (eligible / expiring / expired)
 * per brand-product. We ingest it, match each patient to the spa's own
 * patient graph, and surface the money-on-the-table the manufacturer's
 * own 0-click email never moves (see Synthesis v2 §2 — Evolus: 461
 * eligible now, 26 expiring ≤60d, off a single real 878-row export).
 *
 * This module is PURE (no I/O) so it can be validated directly against the
 * real vendor file before any DB exists — per the "validate against real
 * exports" doctrine. The server fn (manufacturer-reward-ingest.functions.ts)
 * wraps these with the patient-match + upsert layer.
 *
 * Adding a manufacturer = add one entry to MANUFACTURER_MAPPERS. Evolus
 * first (validated); Allergan / Galderma follow on the same shape, each
 * only once verified against a real export.
 *
 * Established 2026-06-07 (Patient-Profitability OS P0).
 */

import type { ProductKind } from "@/lib/product-manufacturer-map";

// ─── Normalized status taxonomy ────────────────────────────────────────────

/**
 * Vendor status strings vary ("Expiring Soon", "Not Yet Eligible", …). We
 * keep the raw string for display but normalize to this enum for filtering
 * and the headline counts. `unknown` is the safe fallback for a status we
 * don't recognize — surfaces in the table, never silently dropped.
 */
export type RewardStatusNorm =
  | "eligible"
  | "expiring_soon"
  | "expired"
  | "not_yet_eligible"
  | "unknown";

export function normalizeRewardStatus(raw: string | null): RewardStatusNorm {
  const s = (raw ?? "").trim().toLowerCase();
  if (!s) return "unknown";
  if (s.includes("expiring")) return "expiring_soon";
  if (s.includes("expired")) return "expired";
  if (s.includes("not yet") || s.includes("not-yet")) return "not_yet_eligible";
  if (s.includes("eligible")) return "eligible"; // after "not yet" check
  return "unknown";
}

// ─── The normalized entry ──────────────────────────────────────────────────

/**
 * One reward entry = one patient × one brand-product snapshot. A single
 * vendor CSV row can yield several (Evolus rows carry both Jeuveau and
 * Evolysse columns → up to two entries).
 */
export type RewardEntry = {
  manufacturer: string;
  program: string | null;
  /** Display brand-product, e.g. "Jeuveau" or "Evolysse Form & Smooth". */
  brandProduct: string;
  /** Resolved kind for cadence reuse (toxin/filler). Null if not mappable. */
  productKind: ProductKind | null;
  statusRaw: string | null;
  statusNorm: RewardStatusNorm;
  /** ISO yyyy-mm-dd (date the reward became / becomes eligible). */
  eligibleDate: string | null;
  /** ISO yyyy-mm-dd (reward expiration). Null when the vendor omits it. */
  expirationDate: string | null;
  rewardAmountUsd: number | null;
  // Patient identity / contact (used to match into the patient graph).
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  zip: string | null;
  /** ISO yyyy-mm-dd last visit / check-in. */
  lastVisit: string | null;
  /** ISO yyyy-mm-dd member-since. */
  memberSince: string | null;
  totalCheckins: number | null;
  /** Source data row (1-based, excludes header) for provenance. */
  sourceRow: number;
};

export type RewardParseWarning = { sourceRow: number; message: string };

export type ParsedRewardCsv = {
  manufacturer: string;
  program: string | null;
  entries: RewardEntry[];
  /** Data rows (CSV lines minus header). */
  dataRowCount: number;
  warnings: RewardParseWarning[];
};

// ─── RFC-4180-ish CSV parser (quoted fields, embedded commas, "" escapes) ──

/**
 * Minimal but correct CSV parser — handles double-quoted fields containing
 * commas, newlines, and "" escaped quotes. Vendor exports are simple, but
 * names/addresses do carry commas, so a split(",") would corrupt rows.
 * Returns an array of rows, each an array of cell strings.
 */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  // Strip a leading BOM if present.
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (c === "\r") {
      // swallow — \r\n handled by the \n branch; lone \r is rare.
    } else {
      cell += c;
    }
  }
  // Flush the trailing cell/row if the file doesn't end in a newline.
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

// ─── Field-normalization helpers (exported for the matcher + tests) ────────

/** "-" / "" / whitespace → null; otherwise the trimmed string. */
function cleanCell(v: string | undefined | null): string | null {
  if (v == null) return null;
  const t = v.trim();
  if (!t || t === "-") return null;
  return t;
}

/** MM/DD/YYYY → ISO yyyy-mm-dd. Returns null on blank / unparseable. */
export function parseUsDate(v: string | undefined | null): string | null {
  const t = cleanCell(v);
  if (!t) return null;
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  let [, mm, dd, yyyy] = m;
  if (yyyy.length === 2) yyyy = `20${yyyy}`;
  const mi = Number(mm),
    di = Number(dd),
    yi = Number(yyyy);
  if (mi < 1 || mi > 12 || di < 1 || di > 31) return null;
  return `${yi.toString().padStart(4, "0")}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

/** "$1,250.00" / "1250" / "-" → number | null. */
export function parseMoney(v: string | undefined | null): number | null {
  const t = cleanCell(v);
  if (!t) return null;
  const n = Number(t.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Lowercased, trimmed email — null when blank or obviously not an email. */
export function normEmail(v: string | undefined | null): string | null {
  const t = cleanCell(v);
  if (!t) return null;
  const e = t.toLowerCase();
  return e.includes("@") ? e : null;
}

/** Digits-only, last 10 (US). Null when fewer than 10 digits. */
export function normPhone(v: string | undefined | null): string | null {
  const t = cleanCell(v);
  if (!t) return null;
  const digits = t.replace(/\D/g, "");
  if (digits.length < 10) return null;
  return digits.slice(-10);
}

/**
 * Order-independent name key: lowercased alpha tokens, accent-stripped,
 * sorted. Matches "Lannette Lampert" to "Lampert, Lannette" — the spa's
 * QuickBooks names are often "Last, First" while the vendor's are
 * "First Last". Sorted token-set is the order-agnostic bridge.
 */
export function nameTokenKey(v: string | undefined | null): string | null {
  const t = cleanCell(v);
  if (!t) return null;
  const norm = t
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ");
  const tokens = norm.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  return tokens.sort().join(" ");
}

/**
 * The upsert identity for an entry's patient: prefer the strongest signal
 * (email > phone > name) so re-uploads of the same person collapse onto one
 * row even when one channel is blank in a later export.
 */
export function rewardMatchKey(e: {
  contactEmail: string | null;
  contactPhone: string | null;
  contactName: string | null;
}): string {
  const email = normEmail(e.contactEmail);
  if (email) return `e:${email}`;
  const phone = normPhone(e.contactPhone);
  if (phone) return `p:${phone}`;
  const name = nameTokenKey(e.contactName);
  if (name) return `n:${name}`;
  return "u:unknown";
}

// ─── Per-manufacturer mapper interface ─────────────────────────────────────

type RowObject = Record<string, string>;

export type ManufacturerMapper = {
  manufacturer: string;
  displayName: string;
  defaultProgram: string | null;
  /** Heuristic: do these headers look like this vendor's export? */
  detect: (headers: string[]) => boolean;
  /** Map a single header→value row to 0..N reward entries. */
  mapRow: (
    row: RowObject,
    sourceRow: number,
    warnings: RewardParseWarning[],
  ) => RewardEntry[];
};

function headerHas(headers: string[], needle: string): boolean {
  const n = needle.toLowerCase();
  return headers.some((h) => h.trim().toLowerCase() === n);
}

// ─── Evolus mapper (validated vs real "Patient Insights" export) ───────────

/**
 * Evolus "Patient Insights" export. Header (06.07.2026 export):
 *   Name, Facility, Phone Number, Email Address, Program,
 *   Jeuveau Status, Jeuveau Eligibility, Jeuveau Expiration,
 *   Evolysse Form & Smooth Status, Evolysse Form & Smooth Eligibility,
 *   Last Treated By, Birthday, Zip Code, Total Check-ins, Member Since,
 *   Last Check-in Date, Reward Amount, Product Rewarded,
 *   Total Form Syringes, Total Smooth Syringes
 *
 * Two brand-products per row: Jeuveau (toxin, has its own Expiration) and
 * Evolysse Form & Smooth (filler, Eligibility date only — no expiration
 * column in the export). We emit an entry per brand-product that carries a
 * status, sharing the patient-level contact/visit fields.
 */
export const EVOLUS_MAPPER: ManufacturerMapper = {
  manufacturer: "evolus",
  displayName: "Evolus",
  defaultProgram: "Evolus Rewards",
  detect: (headers) =>
    headerHas(headers, "Jeuveau Status") ||
    headerHas(headers, "Jeuveau Eligibility"),
  mapRow: (row, sourceRow) => {
    const shared = {
      manufacturer: "evolus",
      program: cleanCell(row["Program"]) ?? "Evolus Rewards",
      contactName: cleanCell(row["Name"]),
      contactPhone: cleanCell(row["Phone Number"]),
      contactEmail: cleanCell(row["Email Address"]),
      zip: cleanCell(row["Zip Code"]),
      lastVisit: parseUsDate(row["Last Check-in Date"]),
      memberSince: parseUsDate(row["Member Since"]),
      totalCheckins: (() => {
        const n = Number(cleanCell(row["Total Check-ins"]) ?? "");
        return Number.isFinite(n) ? n : null;
      })(),
      rewardAmountUsd: parseMoney(row["Reward Amount"]),
      sourceRow,
    };

    const out: RewardEntry[] = [];

    // Jeuveau (toxin) — carries an explicit expiration date.
    const jStatus = cleanCell(row["Jeuveau Status"]);
    if (jStatus) {
      out.push({
        ...shared,
        brandProduct: "Jeuveau",
        productKind: "toxin",
        statusRaw: jStatus,
        statusNorm: normalizeRewardStatus(jStatus),
        eligibleDate: parseUsDate(row["Jeuveau Eligibility"]),
        expirationDate: parseUsDate(row["Jeuveau Expiration"]),
      });
    }

    // Evolysse Form & Smooth (filler) — eligibility date only.
    const eStatus = cleanCell(row["Evolysse Form & Smooth Status"]);
    if (eStatus) {
      out.push({
        ...shared,
        brandProduct: "Evolysse Form & Smooth",
        productKind: "filler",
        statusRaw: eStatus,
        statusNorm: normalizeRewardStatus(eStatus),
        eligibleDate: parseUsDate(row["Evolysse Form & Smooth Eligibility"]),
        expirationDate: null,
      });
    }

    return out;
  },
};

// ─── Registry + top-level parse ────────────────────────────────────────────

export const MANUFACTURER_MAPPERS: Record<string, ManufacturerMapper> = {
  evolus: EVOLUS_MAPPER,
};

export function listSupportedManufacturers(): Array<{
  manufacturer: string;
  displayName: string;
}> {
  return Object.values(MANUFACTURER_MAPPERS).map((m) => ({
    manufacturer: m.manufacturer,
    displayName: m.displayName,
  }));
}

/**
 * Parse a manufacturer reward CSV into normalized entries. The mapper is
 * chosen explicitly by key (the UI lets the owner pick the manufacturer);
 * we also sanity-check detect() and warn — but never block — on mismatch.
 */
export function parseRewardCsv(
  manufacturer: string,
  text: string,
): ParsedRewardCsv {
  const mapper = MANUFACTURER_MAPPERS[manufacturer];
  if (!mapper) {
    throw new Error(`Unsupported manufacturer: ${manufacturer}`);
  }
  const rows = parseCsvRows(text).filter(
    (r) => r.length > 1 || (r.length === 1 && r[0].trim() !== ""),
  );
  if (rows.length === 0) {
    return {
      manufacturer,
      program: mapper.defaultProgram,
      entries: [],
      dataRowCount: 0,
      warnings: [{ sourceRow: 0, message: "Empty file." }],
    };
  }

  const headers = rows[0].map((h) => h.trim());
  const warnings: RewardParseWarning[] = [];
  if (!mapper.detect(headers)) {
    warnings.push({
      sourceRow: 0,
      message: `These headers don't look like a ${mapper.displayName} export — mapped anyway, but double-check the result.`,
    });
  }

  const entries: RewardEntry[] = [];
  let dataRowCount = 0;
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i];
    if (cells.every((c) => c.trim() === "")) continue; // blank line
    dataRowCount++;
    const obj: RowObject = {};
    for (let j = 0; j < headers.length; j++) obj[headers[j]] = cells[j] ?? "";
    try {
      const mapped = mapper.mapRow(obj, dataRowCount, warnings);
      if (mapped.length === 0) {
        warnings.push({
          sourceRow: dataRowCount,
          message: `${cleanCell(obj["Name"]) ?? "row"} had no reward status in any brand column — skipped.`,
        });
      }
      entries.push(...mapped);
    } catch (e) {
      warnings.push({
        sourceRow: dataRowCount,
        message: e instanceof Error ? e.message : "Row failed to map.",
      });
    }
  }

  return {
    manufacturer,
    program: mapper.defaultProgram,
    entries,
    dataRowCount,
    warnings,
  };
}

// ─── Headline summary (the "money on the table" the owner sees) ────────────

export type RewardSignalSummary = {
  totalEntries: number;
  /** Distinct patients (by match key) represented across all entries. */
  distinctPatients: number;
  byStatus: Record<RewardStatusNorm, number>;
  /** Eligible right now (status eligible OR expiring_soon). */
  eligibleNow: number;
  /** Expiring within `expiringWindowDays` (by date) OR status expiring_soon. */
  expiringSoon: number;
  /** Sum of known reward amounts. */
  dollarsOnTable: number;
};

/**
 * Compute the headline counts. `todayIso` is injected (the caller stamps
 * it) so this stays pure — no Date.now() in the lib.
 */
export function summarizeRewardEntries(
  entries: RewardEntry[],
  todayIso: string,
  expiringWindowDays = 60,
): RewardSignalSummary {
  const byStatus: Record<RewardStatusNorm, number> = {
    eligible: 0,
    expiring_soon: 0,
    expired: 0,
    not_yet_eligible: 0,
    unknown: 0,
  };
  const patientKeys = new Set<string>();
  let eligibleNow = 0;
  let expiringSoon = 0;
  let dollarsOnTable = 0;
  // Reward amount is a patient-level value duplicated onto every brand row, so
  // sum it once per patient (match key) — not once per entry — or the headline
  // double-counts a two-brand patient.
  const dollarsCounted = new Set<string>();

  const todayMs = Date.parse(`${todayIso}T00:00:00Z`);
  const windowMs = expiringWindowDays * 86_400_000;

  for (const e of entries) {
    byStatus[e.statusNorm]++;
    const key = rewardMatchKey(e);
    patientKeys.add(key);
    if (e.statusNorm === "eligible" || e.statusNorm === "expiring_soon") {
      eligibleNow++;
    }
    let expiring = e.statusNorm === "expiring_soon";
    if (!expiring && e.expirationDate && Number.isFinite(todayMs)) {
      const expMs = Date.parse(`${e.expirationDate}T00:00:00Z`);
      if (Number.isFinite(expMs) && expMs >= todayMs && expMs - todayMs <= windowMs) {
        expiring = true;
      }
    }
    if (expiring) expiringSoon++;
    if (e.rewardAmountUsd != null && !dollarsCounted.has(key)) {
      dollarsOnTable += e.rewardAmountUsd;
      dollarsCounted.add(key);
    }
  }

  return {
    totalEntries: entries.length,
    distinctPatients: patientKeys.size,
    byStatus,
    eligibleNow,
    expiringSoon,
    dollarsOnTable,
  };
}
