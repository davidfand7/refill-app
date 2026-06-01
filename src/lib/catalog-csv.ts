/**
 * catalog-csv.ts — service-list CSV parser (v1.29.4 / .1).
 *
 * Hand-rolled CSV parser (no dependency) mirroring the patient-csv /
 * appointment-csv style.
 *
 * v1.29.4.1 reframe (per Grasshopper 2026-06-01): the typical export
 * source for spa CATALOG data is the ACCOUNTING platform (QuickBooks),
 * NOT the scheduling platform (Acuity). Reason: cost-of-goods lives in
 * accounting. The original v1.29.4 led with Acuity columns; v1.29.4.1
 * leads with QB Item List columns (Item, Sales Price, Cost, Type,
 * Sales Description) and treats Acuity columns as a fallback. The QB
 * Cost column flows directly into cogs_per_service when present —
 * margin math is hot on first import.
 *
 * Header detection is fuzzy. If a category column isn't present, we
 * fall back to name-based inference (botox/dysport → tox,
 * juvederm/restylane → filler, etc).
 *
 * Pattern: client parses for preview, then on commit POSTs the raw CSV
 * to ingestServicesCsvFn which re-parses server-side and upserts by
 * name (case-insensitive within tenant scope).
 */

import type { ServiceCategory } from "@/server/refill-catalog";

export type ParsedServiceRow = {
  rowIndex: number; // 1-based, header is row 1
  rawName: string;
  rawType: string | null;
  rawCategory: string | null;
  rawPrice: string;
  rawCost: string | null;
  rawDuration: string | null;
  rawDescription: string | null;
  parsedName: string;
  parsedCategory: ServiceCategory;
  categorySource: "csv" | "name-inferred" | "default";
  parsedPrice: number | null;
  parsedCogs: number | null;
  parsedDescription: string | null;
  // v1.29.4.2 — QB Type filter. Non-inventory / Inventory rows are
  // actually products (retail items Karen resells), not services. They
  // get marked as non-service at preview + skipped at commit.
  isService: boolean;
  warnings: string[];
};

export type ParsedCatalogCsv = {
  headers: string[];
  rows: ParsedServiceRow[];
  // headerRowIndex (0-based) — the actual header row found in the file.
  // QB exports start with a company-name title row above the headers; we
  // search the first few rows for a name-looking header and skip preamble.
  headerRowIndex: number;
  fieldMapping: {
    name: string | null;
    type: string | null;
    category: string | null;
    price: string | null;
    cost: string | null;
    duration: string | null;
    description: string | null;
  };
  unmappedHeaders: string[];
  totalRows: number;
  parseableRows: number;
  skippedRows: number;
  nonServiceRows: number; // marked as Non-inventory / Inventory by Type column
  parseErrors: Array<{ rowIndex: number; reason: string }>;
};

// ─── CSV tokenizer (handles quoted fields + commas inside quotes) ─────────

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else {
      if (ch === ",") {
        out.push(cur);
        cur = "";
      } else if (ch === '"') {
        inQuotes = true;
      } else {
        cur += ch;
      }
    }
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

function splitCsvRows(text: string): string[] {
  // Normalize line endings + strip trailing empty lines.
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return normalized.split("\n").filter((line) => line.length > 0);
}

// ─── Header fuzzy matching ────────────────────────────────────────────────

// Order matters: QB-first because accounting platforms are the typical
// catalog source (cost-of-goods lives there). Acuity / Square / Vagaro
// service-list exports stay as fallback header shapes.
const NAME_HEADER_CANDIDATES = [
  "product/service full name", "product/service", "item", "item name",
  "service name", "name", "title", "service", "treatment",
  "appointment type",
];
// v1.29.4.2 — Type is the service-vs-product filter (QB values: Service,
// Non-inventory, Inventory). Distinct from Category (which is our
// taxonomy of tox/filler/laser/etc).
const TYPE_HEADER_CANDIDATES = [
  "type", "item type",
];
const CATEGORY_HEADER_CANDIDATES = [
  "category", "service category", "service type", "group", "class",
  "appointment category",
];
const PRICE_HEADER_CANDIDATES = [
  "sales price", "price", "service price", "rate", "fee", "amount",
  "unit price", "selling price",
];
// QB Item List has a separate Cost column — flows straight into
// services.cogs_per_service when present. v1.29.4 (Acuity-first) didn't
// look for this; v1.29.4.1 added it. v1.29.4.2 adds QB's actual column
// name "Purchase price" as the leading alias.
const COST_HEADER_CANDIDATES = [
  "purchase price", "cost", "item cost", "purchase cost", "cogs",
  "wholesale cost",
];
const DURATION_HEADER_CANDIDATES = [
  "duration", "service duration", "duration (minutes)", "minutes", "length",
];
const DESCRIPTION_HEADER_CANDIDATES = [
  "memo/description", "sales description", "description",
  "service description", "notes", "purchase description", "details",
];

function findHeader(headers: string[], candidates: string[]): string | null {
  const lower = headers.map((h) => h.toLowerCase().trim());
  for (const candidate of candidates) {
    const idx = lower.indexOf(candidate);
    if (idx >= 0) return headers[idx];
  }
  // Substring fallback — header contains any candidate
  for (let i = 0; i < lower.length; i++) {
    for (const candidate of candidates) {
      if (lower[i].includes(candidate)) return headers[i];
    }
  }
  return null;
}

// ─── Category inference from name ─────────────────────────────────────────

const CATEGORY_NAME_PATTERNS: Array<{ pattern: RegExp; category: ServiceCategory }> = [
  { pattern: /\b(botox|dysport|xeomin|jeuveau|daxxify|neurotoxin|tox)\b/i, category: "tox" },
  { pattern: /\b(juvederm|voluma|vollure|volbella|restylane|kysse|defyne|refyne|lyft|radiesse|sculptra|belotero|rha|filler)\b/i, category: "filler" },
  { pattern: /\b(bbl|ipl|moxi|halo|fraxel|laser|forever\s*young|nordlys|broadband)\b/i, category: "laser" },
  { pattern: /\b(hydrafacial|facial|peel|microderm|microdermabrasion|dermaplane|chemical\s*peel)\b/i, category: "facial" },
  { pattern: /\b(skincare|serum|cleanser|moisturizer|sunscreen|retinol|vitamin\s*c|product)\b/i, category: "skincare" },
];

function inferCategoryFromName(name: string): { category: ServiceCategory; source: "name-inferred" | "default" } {
  for (const { pattern, category } of CATEGORY_NAME_PATTERNS) {
    if (pattern.test(name)) return { category, source: "name-inferred" };
  }
  return { category: "other", source: "default" };
}

// ─── CSV category column normalization to our enum ────────────────────────

function normalizeCategoryString(raw: string): ServiceCategory | null {
  const lower = raw.toLowerCase().trim();
  if (!lower) return null;
  if (/\b(tox|botox|dysport|xeomin|jeuveau|daxxify|neurotoxin)\b/.test(lower)) return "tox";
  if (/\b(filler|juvederm|restylane|radiesse|sculptra)\b/.test(lower)) return "filler";
  if (/\b(laser|bbl|ipl|moxi|halo|fraxel|broadband)\b/.test(lower)) return "laser";
  if (/\b(facial|hydrafacial|peel|microderm|dermaplane)\b/.test(lower)) return "facial";
  if (/\b(skincare|product|retail)\b/.test(lower)) return "skincare";
  return null;
}

// ─── Price parsing ────────────────────────────────────────────────────────

function parsePriceString(raw: string): number | null {
  if (!raw) return null;
  // Strip currency symbols, commas, spaces. Keep digits + dot + minus.
  const cleaned = raw.replace(/[^0-9.\-]/g, "");
  if (!cleaned) return null;
  const num = Number.parseFloat(cleaned);
  if (!Number.isFinite(num) || num < 0) return null;
  return num;
}

// ─── Title-row skip (QB Quirk) ────────────────────────────────────────────

/**
 * QB exports prepend a company-name title row before the actual headers
 * (e.g. "REJUV SKIN SPA, LLC,,,,"). Look through the first few rows for
 * the row that actually contains a recognizable name-column header.
 */
function findHeaderRowIndex(lines: string[]): number {
  const limit = Math.min(8, lines.length);
  for (let i = 0; i < limit; i++) {
    const cells = parseCsvLine(lines[i]).map((c) => c.toLowerCase().trim());
    for (const candidate of NAME_HEADER_CANDIDATES) {
      if (cells.some((c) => c === candidate || c.includes(candidate))) {
        return i;
      }
    }
  }
  return 0;
}

// ─── Main parser ──────────────────────────────────────────────────────────

export function parseServiceListCsv(text: string): ParsedCatalogCsv {
  const lines = splitCsvRows(text);
  if (lines.length === 0) {
    return {
      headers: [],
      rows: [],
      headerRowIndex: 0,
      fieldMapping: { name: null, type: null, category: null, price: null, cost: null, duration: null, description: null },
      unmappedHeaders: [],
      totalRows: 0,
      parseableRows: 0,
      skippedRows: 0,
      nonServiceRows: 0,
      parseErrors: [{ rowIndex: 0, reason: "Empty file." }],
    };
  }

  const headerRowIndex = findHeaderRowIndex(lines);
  const headers = parseCsvLine(lines[headerRowIndex]);
  const nameHeader = findHeader(headers, NAME_HEADER_CANDIDATES);
  const typeHeader = findHeader(headers, TYPE_HEADER_CANDIDATES);
  const categoryHeader = findHeader(
    // If a Type column was already claimed, don't double-map it as Category
    typeHeader ? headers.filter((h) => h !== typeHeader) : headers,
    CATEGORY_HEADER_CANDIDATES,
  );
  const priceHeader = findHeader(headers, PRICE_HEADER_CANDIDATES);
  const costHeader = findHeader(
    // Don't collide with the price column: if price already pointed at a
    // header that's also in the cost candidates (e.g. "Cost" used as sale
    // price by a small practice), skip cost.
    headers.filter((h) => h !== priceHeader),
    COST_HEADER_CANDIDATES,
  );
  const durationHeader = findHeader(headers, DURATION_HEADER_CANDIDATES);
  const descriptionHeader = findHeader(headers, DESCRIPTION_HEADER_CANDIDATES);

  const mappedHeaders = new Set(
    [nameHeader, typeHeader, categoryHeader, priceHeader, costHeader, durationHeader, descriptionHeader].filter(
      (h): h is string => h !== null,
    ),
  );
  const unmappedHeaders = headers.filter((h) => !mappedHeaders.has(h));

  const headerIndex = (h: string | null) => (h ? headers.indexOf(h) : -1);
  const nameIdx = headerIndex(nameHeader);
  const typeIdx = headerIndex(typeHeader);
  const categoryIdx = headerIndex(categoryHeader);
  const priceIdx = headerIndex(priceHeader);
  const costIdx = headerIndex(costHeader);
  const durationIdx = headerIndex(durationHeader);
  const descriptionIdx = headerIndex(descriptionHeader);

  const rows: ParsedServiceRow[] = [];
  const parseErrors: Array<{ rowIndex: number; reason: string }> = [];
  let nonServiceRows = 0;

  for (let i = headerRowIndex + 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const rawName = nameIdx >= 0 ? (cols[nameIdx] ?? "") : "";
    const rawType = typeIdx >= 0 ? (cols[typeIdx] ?? "") : "";
    const rawCategory = categoryIdx >= 0 ? (cols[categoryIdx] ?? "") : "";
    const rawPrice = priceIdx >= 0 ? (cols[priceIdx] ?? "") : "";
    const rawCost = costIdx >= 0 ? (cols[costIdx] ?? "") : "";
    const rawDuration = durationIdx >= 0 ? (cols[durationIdx] ?? "") : "";
    const rawDescription = descriptionIdx >= 0 ? (cols[descriptionIdx] ?? "") : "";

    const parsedName = rawName.trim();
    if (!parsedName) {
      parseErrors.push({ rowIndex: i + 1, reason: "Missing service name." });
      continue;
    }

    // QB Type filter: rows marked Non-inventory / Inventory are products
    // (retail items), not services. Mark them non-service so the import
    // path skips them. Blank Type = treat as service (Acuity / Square /
    // Vagaro exports don't have a Type column).
    const typeLower = rawType.trim().toLowerCase();
    const isService =
      typeLower === "" ||
      typeLower === "service" ||
      typeLower === "services" ||
      typeLower.includes("service");
    if (!isService) {
      nonServiceRows++;
    }

    const warnings: string[] = [];
    const parsedPrice = parsePriceString(rawPrice);
    if (parsedPrice === null) {
      warnings.push(rawPrice ? `Couldn't parse price "${rawPrice}".` : "No price found; will land at $0.");
    }
    const parsedCogs = rawCost ? parsePriceString(rawCost) : null;
    if (rawCost && parsedCogs === null) {
      warnings.push(`Couldn't parse cost "${rawCost}".`);
    }

    let parsedCategory: ServiceCategory;
    let categorySource: "csv" | "name-inferred" | "default";
    if (rawCategory) {
      const normalized = normalizeCategoryString(rawCategory);
      if (normalized) {
        parsedCategory = normalized;
        categorySource = "csv";
      } else {
        const inferred = inferCategoryFromName(parsedName);
        parsedCategory = inferred.category;
        categorySource = inferred.source;
        warnings.push(`Couldn't map category "${rawCategory}"; inferred from name.`);
      }
    } else {
      const inferred = inferCategoryFromName(parsedName);
      parsedCategory = inferred.category;
      categorySource = inferred.source;
    }

    const parsedDescription = rawDescription.trim() ? rawDescription.trim() : null;

    rows.push({
      rowIndex: i + 1,
      rawName,
      rawType: rawType || null,
      rawCategory: rawCategory || null,
      rawPrice,
      rawCost: rawCost || null,
      rawDuration: rawDuration || null,
      rawDescription: rawDescription || null,
      parsedName,
      parsedCategory,
      categorySource,
      parsedPrice: parsedPrice ?? 0,
      parsedCogs,
      parsedDescription,
      isService,
      warnings,
    });
  }

  const totalDataRows = lines.length - headerRowIndex - 1;
  return {
    headers,
    rows,
    headerRowIndex,
    fieldMapping: {
      name: nameHeader,
      type: typeHeader,
      category: categoryHeader,
      price: priceHeader,
      cost: costHeader,
      duration: durationHeader,
      description: descriptionHeader,
    },
    unmappedHeaders,
    totalRows: totalDataRows,
    parseableRows: rows.length,
    skippedRows: totalDataRows - rows.length,
    nonServiceRows,
    parseErrors,
  };
}
