/**
 * Manufacturer TRANSACTION (last-treatment) CSV parsing — Lane 2 of the
 * master ingestion plan (project_manufacturer_data_ingestion_plan).
 *
 * Where the reward lane (manufacturer-reward-csv.ts) ingests loyalty
 * SNAPSHOTS → patient_reward_entries, this lane ingests last-TREATMENT
 * dates → patient_transactions, to sharpen lapsed/overdue detection.
 *
 * The Allergan "last transaction" reports are WIDE matrices: one row per
 * patient, product-named columns whose VALUES are the date of that
 * patient's most-recent treatment with that product (MM/DD/YY), blank =
 * never. We "melt" the matrix into one normalized row per (patient ×
 * product-with-a-date).
 *
 *   BotoxJuvedermLastTransactionReport — Last BOTOX® Cosmetic / Last
 *     JUVÉDERM® dates. THE cadence win: Botox→toxin, Juvéderm→filler are
 *     exactly the kinds KIND_CADENCE has windows for.
 *   ProductsLastTransaction — CoolSculpting / CoolTone / DiamondGlow /
 *     Kybella / Latisse / Natrelle. Device/retail recency markers (no
 *     cadence window, but real last-treatment provenance).
 *
 * ⚠️ These files carry NO dollar amount and NO reward credit — they are
 * pure recency signals. The ingest writes them at amount_usd = 0 with a
 * distinct source so they NEVER count as treatment revenue (the master
 * plan's "Reward Amount ≠ treatment price" nuance doesn't even apply here;
 * that's a full-TransactionsReport concern).
 *
 * This module is PURE (no I/O) so it can be validated directly against the
 * real vendor file — per [[feedback_validate_against_real_exports]].
 *
 * Established 2026-06-08 (Patient-Profitability OS · Lane 2).
 */

import type { ProductKind, ProductManufacturer } from "@/lib/product-manufacturer-map";
import { resolveProduct } from "@/lib/product-manufacturer-map";
import {
  parseCsvRows,
  parseUsDate,
} from "@/lib/manufacturer-reward-csv";

/**
 * The `source` stamped on every patient_transactions row this lane writes.
 * Load-bearing: the lapsed-detection queries (doListOverdue,
 * spa-rep-data-share) opt these rows IN despite amount_usd = 0, while every
 * revenue/reconcile/campaign consumer (which all filter amount_usd > 0)
 * automatically excludes them. Change in lock-step with those queries.
 */
export const MFR_LAST_TXN_SOURCE = "mfr-last-transaction";

/**
 * Stable synthetic invoice token. patient_transactions' dedupe unique index
 * is a plain (…, invoice_num, …) — Postgres treats NULL invoice_num as
 * DISTINCT, so NULL rows would NOT collapse on re-upload. A constant token
 * gives these rows a non-null, deterministic key so re-uploading the same
 * report is a clean no-op.
 */
export const MFR_LAST_TXN_INVOICE = "mfr-last-tx";

// ─── Normalized melted row ─────────────────────────────────────────────────

export type LastTreatmentRow = {
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  /** Canonical display product name, e.g. "BOTOX® Cosmetic". */
  productName: string;
  productManufacturer: ProductManufacturer;
  /** Resolved kind — toxin/filler drive cadence; device/retail are markers. */
  productKind: ProductKind | null;
  /** ISO yyyy-mm-dd of the last treatment with this product. */
  transactionDate: string;
  /**
   * Vendor transaction ID (long-format TransactionsReport only). When
   * present it becomes the dedupe invoice_num — a real, stable key, so
   * overlapping date-range exports collapse cleanly. Null for the wide
   * pre-aggregated reports (which fall back to MFR_LAST_TXN_INVOICE).
   */
  transactionId: string | null;
  /** 1-based source row (excludes header) for provenance. */
  sourceRow: number;
};

export type LastTxnParseWarning = { sourceRow: number; message: string };

export type ParsedLastTxnCsv = {
  /** Registry key for the detected report (display/history only). */
  report: string;
  displayName: string;
  manufacturer: string;
  rows: LastTreatmentRow[];
  /** Distinct patient data rows (CSV lines minus header). */
  dataRowCount: number;
  /**
   * Long-format only: non-treatment rows skipped (Points Used / Giftcard
   * Applied / Promotion Applied). Surfaced in the receipt so nothing looks
   * silently dropped — these are loyalty events, not treatments.
   */
  skippedLoyaltyRows: number;
  warnings: LastTxnParseWarning[];
};

// ─── Product-column → manufacturer/kind mapping ────────────────────────────

type ColMap = {
  productName: string;
  manufacturer: ProductManufacturer;
  kind: ProductKind | null;
};

/**
 * Map a wide product column header to its canonical product. Returns null
 * for non-product columns (name/email/phone/provider/admin). Matched by
 * keyword so it survives the report's exact wording / ® placement / the
 * "Last … Transaction" wrapper on the Botox/Juvéderm file.
 */
function mapProductColumn(header: string): ColMap | null {
  const h = header.toLowerCase();
  if (h.includes("botox"))
    return { productName: "BOTOX® Cosmetic", manufacturer: "abbvie", kind: "toxin" };
  if (h.includes("juvéderm") || h.includes("juvederm"))
    return { productName: "JUVÉDERM®", manufacturer: "abbvie", kind: "filler" };
  if (h.includes("coolsculpting"))
    return {
      productName: header.trim(),
      manufacturer: "abbvie-coolsculpting",
      kind: "device",
    };
  if (h.includes("cooltone"))
    return { productName: "CoolTone®", manufacturer: "abbvie", kind: "device" };
  if (h.includes("diamondglow") || h.includes("diamond glow"))
    return { productName: "DiamondGlow®", manufacturer: "abbvie", kind: "service" };
  if (h.includes("kybella"))
    return { productName: "Kybella®", manufacturer: "abbvie", kind: "device" };
  if (h.includes("latisse"))
    return { productName: header.trim(), manufacturer: "abbvie", kind: "retail" };
  if (h.includes("natrelle"))
    return { productName: header.trim(), manufacturer: "abbvie", kind: "device" };
  return null;
}

// ─── Contact-column resolution ─────────────────────────────────────────────

/** Index of the first header whose normalized text equals/contains a needle. */
function findCol(headers: string[], needles: string[]): number {
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i].trim().toLowerCase();
    if (needles.some((n) => h === n)) return i;
  }
  // Fall back to a contains-match (handles "Email Address" vs "Email").
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i].trim().toLowerCase();
    if (needles.some((n) => h.includes(n))) return i;
  }
  return -1;
}

function cell(row: string[], idx: number): string | null {
  if (idx < 0 || idx >= row.length) return null;
  const t = row[idx]?.trim();
  return t ? t : null;
}

// ─── Detection ─────────────────────────────────────────────────────────────

/**
 * Does this header row look like an Allergan last-transaction matrix?
 * Requires a name signal + at least one mappable product column. Returns
 * the report key (for the auto-import / email-drop path), or null.
 */
export function detectLastTxnReport(headers: string[]): string | null {
  const hasName =
    findCol(headers, ["first name"]) >= 0 ||
    findCol(headers, ["last name"]) >= 0 ||
    findCol(headers, ["name"]) >= 0;
  if (!hasName) return null;
  const productCols = headers.filter((h) => mapProductColumn(h) !== null);
  if (productCols.length === 0) return null;
  const hasBotox = productCols.some((h) => /botox/i.test(h));
  const hasJuvederm = productCols.some((h) => /juv[ée]derm/i.test(h));
  if (hasBotox || hasJuvederm) return "allergan-botox-juvederm";
  return "allergan-products-last-txn";
}

/** detectLastTxnReport but from raw CSV text — reads the header row. */
export function detectLastTxnReportFromCsv(text: string): string | null {
  const rows = parseCsvRows(text);
  if (rows.length === 0) return null;
  return detectLastTxnReport(rows[0].map((h) => h.trim()));
}

const REPORT_DISPLAY: Record<string, string> = {
  "allergan-botox-juvederm": "Allergan — last Botox / Juvéderm dates",
  "allergan-products-last-txn": "Allergan — last device / retail dates",
  "allergan-transactions-history": "Allergan — full treatment history",
};

// ─── Parse ─────────────────────────────────────────────────────────────────

/**
 * Parse a wide Allergan last-transaction matrix into melted
 * LastTreatmentRow[] — one per (patient × product cell that carries a date).
 */
export function parseLastTransactionCsv(text: string): ParsedLastTxnCsv {
  const grid = parseCsvRows(text);
  const warnings: LastTxnParseWarning[] = [];
  if (grid.length === 0) {
    return {
      report: "unknown",
      displayName: "Unknown report",
      manufacturer: "allergan",
      rows: [],
      dataRowCount: 0,
      skippedLoyaltyRows: 0,
      warnings: [{ sourceRow: 0, message: "Empty file." }],
    };
  }

  const headers = grid[0].map((h) => h.trim());
  const report = detectLastTxnReport(headers);
  if (!report) {
    return {
      report: "unknown",
      displayName: "Unrecognized report",
      manufacturer: "allergan",
      rows: [],
      dataRowCount: Math.max(0, grid.length - 1),
      skippedLoyaltyRows: 0,
      warnings: [
        {
          sourceRow: 0,
          message:
            "Couldn't recognize this as an Allergan last-transaction report (no product-date columns found).",
        },
      ],
    };
  }

  const firstIdx = findCol(headers, ["first name"]);
  const lastIdx = findCol(headers, ["last name"]);
  const fullNameIdx = firstIdx < 0 && lastIdx < 0 ? findCol(headers, ["name"]) : -1;
  const emailIdx = findCol(headers, ["email", "email address"]);
  const phoneIdx = findCol(headers, ["phone number", "phone"]);

  // Resolve product columns once.
  const productCols: Array<{ idx: number; map: ColMap }> = [];
  for (let i = 0; i < headers.length; i++) {
    const map = mapProductColumn(headers[i]);
    if (map) productCols.push({ idx: i, map });
  }

  const rows: LastTreatmentRow[] = [];
  let dataRowCount = 0;

  for (let r = 1; r < grid.length; r++) {
    const row = grid[r];
    // Skip fully-blank trailing rows.
    if (row.every((c) => !c || !c.trim())) continue;
    dataRowCount++;
    const sourceRow = r; // 1-based excl. header

    const first = cell(row, firstIdx) ?? "";
    const last = cell(row, lastIdx) ?? "";
    const contactName =
      fullNameIdx >= 0
        ? cell(row, fullNameIdx)
        : `${first} ${last}`.trim() || null;
    const contactEmail = cell(row, emailIdx);
    const contactPhone = cell(row, phoneIdx);

    for (const { idx, map } of productCols) {
      const raw = cell(row, idx);
      if (!raw) continue;
      const iso = parseUsDate(raw);
      if (!iso) {
        warnings.push({
          sourceRow,
          message: `Couldn't parse "${raw}" as a date for ${map.productName}.`,
        });
        continue;
      }
      rows.push({
        contactName,
        contactEmail,
        contactPhone,
        productName: map.productName,
        productManufacturer: map.manufacturer,
        productKind: map.kind,
        transactionDate: iso,
        transactionId: null,
        sourceRow,
      });
    }
  }

  return {
    report,
    displayName: REPORT_DISPLAY[report] ?? report,
    manufacturer: "allergan",
    rows,
    dataRowCount,
    skippedLoyaltyRows: 0,
    warnings,
  };
}

// ─── Long-format parser: Allergan TransactionsReport (full history) ─────────
//
// LONG shape — one row per transaction LINE (not a per-patient matrix):
//   Transaction ID, Transaction Item Type, Date (MM.DD.YY — DOTS),
//   Patient Name, Patient Email, Patient Phone Number, Status,
//   Reward Description, Reward Value, Front Desk Admin, Selected Provider,
//   Product Name, Treatment Areas, Points Earned, Offer Code
//
// We ingest only "Product Purchased" rows (the dated treatment timeline);
// "Points Used" / "Giftcard Applied" / "Promotion Applied" are loyalty
// events, not treatments — counted as skippedLoyaltyRows, not inserted.
// ⚠️ The file carries NO treatment price (only Points Earned / a redemption
// Reward Value), so this lane is cadence/recency, never treatment revenue —
// that's exactly the master-plan nuance. Amount stays 0 at ingest.

const TREATMENT_ITEM_TYPE = "product purchased";

/** Strip accents so the canonical resolveProduct regex (expects "juvederm",
 *  not "juvéderm") classifies Allergan's accented product names. */
function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** MM.DD.YY (dots) → MM/DD/YY → ISO, reusing the shared US-date parser. */
function parseDotOrSlashDate(v: string | null): string | null {
  if (!v) return null;
  return parseUsDate(v.replace(/\./g, "/"));
}

export function detectTransactionsReport(headers: string[]): boolean {
  return (
    findCol(headers, ["transaction id"]) >= 0 &&
    findCol(headers, ["transaction item type"]) >= 0 &&
    findCol(headers, ["product name"]) >= 0
  );
}

export function parseTransactionsReportCsv(text: string): ParsedLastTxnCsv {
  const grid = parseCsvRows(text);
  const warnings: LastTxnParseWarning[] = [];
  const empty = (msg: string): ParsedLastTxnCsv => ({
    report: "unknown",
    displayName: "Unrecognized report",
    manufacturer: "allergan",
    rows: [],
    dataRowCount: Math.max(0, grid.length - 1),
    skippedLoyaltyRows: 0,
    warnings: [{ sourceRow: 0, message: msg }],
  });
  if (grid.length === 0) return empty("Empty file.");

  const headers = grid[0].map((h) => h.trim());
  if (!detectTransactionsReport(headers)) {
    return empty("Not an Allergan TransactionsReport (missing Transaction ID / Item Type / Product Name).");
  }

  const idIdx = findCol(headers, ["transaction id"]);
  const typeIdx = findCol(headers, ["transaction item type"]);
  const dateIdx = findCol(headers, ["date"]);
  const nameIdx = findCol(headers, ["patient name"]);
  const emailIdx = findCol(headers, ["patient email", "email"]);
  const phoneIdx = findCol(headers, ["patient phone number", "phone"]);
  const productIdx = findCol(headers, ["product name"]);

  const rows: LastTreatmentRow[] = [];
  let dataRowCount = 0;
  let skippedLoyaltyRows = 0;

  for (let r = 1; r < grid.length; r++) {
    const row = grid[r];
    if (row.every((c) => !c || !c.trim())) continue;
    dataRowCount++;
    const sourceRow = r;

    const itemType = (cell(row, typeIdx) ?? "").toLowerCase();
    if (itemType !== TREATMENT_ITEM_TYPE) {
      skippedLoyaltyRows++;
      continue;
    }
    const productName = cell(row, productIdx);
    if (!productName) {
      warnings.push({ sourceRow, message: "Product Purchased row with no Product Name." });
      continue;
    }
    const iso = parseDotOrSlashDate(cell(row, dateIdx));
    if (!iso) {
      warnings.push({
        sourceRow,
        message: `Couldn't parse date "${cell(row, dateIdx) ?? ""}" for ${productName}.`,
      });
      continue;
    }

    const resolved = resolveProduct(stripAccents(productName));
    rows.push({
      contactName: cell(row, nameIdx),
      contactEmail: cell(row, emailIdx),
      contactPhone: cell(row, phoneIdx),
      productName,
      // Allergan = AbbVie; fall back to that when the classifier can't tell.
      productManufacturer: resolved.manufacturer ?? "abbvie",
      productKind: resolved.kind,
      transactionDate: iso,
      transactionId: cell(row, idIdx),
      sourceRow,
    });
  }

  return {
    report: "allergan-transactions-history",
    displayName: REPORT_DISPLAY["allergan-transactions-history"],
    manufacturer: "allergan",
    rows,
    dataRowCount,
    skippedLoyaltyRows,
    warnings,
  };
}

// ─── Shape-dispatching entry points (used by the ingest fn + email-drop) ────

/** Detect any supported manufacturer-transaction shape from raw CSV text. */
export function detectManufacturerTxnFromCsv(text: string): string | null {
  const rows = parseCsvRows(text);
  if (rows.length === 0) return null;
  const headers = rows[0].map((h) => h.trim());
  if (detectTransactionsReport(headers)) return "allergan-transactions-history";
  return detectLastTxnReport(headers);
}

/** Parse any supported manufacturer-transaction shape (wide or long). */
export function parseManufacturerTxnCsv(text: string): ParsedLastTxnCsv {
  const rows = parseCsvRows(text);
  if (rows.length > 0 && detectTransactionsReport(rows[0].map((h) => h.trim()))) {
    return parseTransactionsReportCsv(text);
  }
  return parseLastTransactionCsv(text);
}
