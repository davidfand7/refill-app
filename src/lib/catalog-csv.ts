/**
 * catalog-csv.ts — service-list CSV parser (v1.29.4).
 *
 * Hand-rolled CSV parser (no dependency) mirroring the patient-csv /
 * appointment-csv style. Targets Acuity Scheduling service-list exports
 * first per feedback_validate_against_real_exports; other platforms get
 * added incrementally as real exports surface.
 *
 * Header detection is fuzzy: we look for common name variants for each
 * field. If a category column isn't present, we fall back to name-based
 * inference (botox/dysport/etc → tox, juvederm/restylane → filler, etc).
 *
 * Pattern: client parses for preview, then on commit POSTs the raw CSV
 * to ingestServicesCsvFn which re-parses server-side and upserts by
 * name (case-insensitive within tenant scope).
 */

import type { ServiceCategory } from "@/server/refill-catalog";

export type ParsedServiceRow = {
  rowIndex: number; // 1-based, header is row 1
  rawName: string;
  rawCategory: string | null;
  rawPrice: string;
  rawDuration: string | null;
  rawDescription: string | null;
  parsedName: string;
  parsedCategory: ServiceCategory;
  categorySource: "csv" | "name-inferred" | "default";
  parsedPrice: number | null;
  parsedDescription: string | null;
  warnings: string[];
};

export type ParsedCatalogCsv = {
  headers: string[];
  rows: ParsedServiceRow[];
  fieldMapping: {
    name: string | null;
    category: string | null;
    price: string | null;
    duration: string | null;
    description: string | null;
  };
  unmappedHeaders: string[];
  totalRows: number;
  parseableRows: number;
  skippedRows: number;
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

const NAME_HEADER_CANDIDATES = [
  "service name", "name", "title", "service", "treatment", "appointment type",
];
const CATEGORY_HEADER_CANDIDATES = [
  "category", "service category", "type", "service type", "group", "appointment category",
];
const PRICE_HEADER_CANDIDATES = [
  "price", "service price", "rate", "fee", "cost", "amount",
];
const DURATION_HEADER_CANDIDATES = [
  "duration", "service duration", "duration (minutes)", "minutes", "length",
];
const DESCRIPTION_HEADER_CANDIDATES = [
  "description", "service description", "notes", "details",
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

// ─── Main parser ──────────────────────────────────────────────────────────

export function parseServiceListCsv(text: string): ParsedCatalogCsv {
  const lines = splitCsvRows(text);
  if (lines.length === 0) {
    return {
      headers: [],
      rows: [],
      fieldMapping: { name: null, category: null, price: null, duration: null, description: null },
      unmappedHeaders: [],
      totalRows: 0,
      parseableRows: 0,
      skippedRows: 0,
      parseErrors: [{ rowIndex: 0, reason: "Empty file." }],
    };
  }

  const headers = parseCsvLine(lines[0]);
  const nameHeader = findHeader(headers, NAME_HEADER_CANDIDATES);
  const categoryHeader = findHeader(headers, CATEGORY_HEADER_CANDIDATES);
  const priceHeader = findHeader(headers, PRICE_HEADER_CANDIDATES);
  const durationHeader = findHeader(headers, DURATION_HEADER_CANDIDATES);
  const descriptionHeader = findHeader(headers, DESCRIPTION_HEADER_CANDIDATES);

  const mappedHeaders = new Set(
    [nameHeader, categoryHeader, priceHeader, durationHeader, descriptionHeader].filter(
      (h): h is string => h !== null,
    ),
  );
  const unmappedHeaders = headers.filter((h) => !mappedHeaders.has(h));

  const headerIndex = (h: string | null) => (h ? headers.indexOf(h) : -1);
  const nameIdx = headerIndex(nameHeader);
  const categoryIdx = headerIndex(categoryHeader);
  const priceIdx = headerIndex(priceHeader);
  const durationIdx = headerIndex(durationHeader);
  const descriptionIdx = headerIndex(descriptionHeader);

  const rows: ParsedServiceRow[] = [];
  const parseErrors: Array<{ rowIndex: number; reason: string }> = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const rawName = nameIdx >= 0 ? (cols[nameIdx] ?? "") : "";
    const rawCategory = categoryIdx >= 0 ? (cols[categoryIdx] ?? "") : "";
    const rawPrice = priceIdx >= 0 ? (cols[priceIdx] ?? "") : "";
    const rawDuration = durationIdx >= 0 ? (cols[durationIdx] ?? "") : "";
    const rawDescription = descriptionIdx >= 0 ? (cols[descriptionIdx] ?? "") : "";

    const parsedName = rawName.trim();
    if (!parsedName) {
      parseErrors.push({ rowIndex: i + 1, reason: "Missing service name." });
      continue;
    }

    const warnings: string[] = [];
    const parsedPrice = parsePriceString(rawPrice);
    if (parsedPrice === null) {
      warnings.push(rawPrice ? `Couldn't parse price "${rawPrice}".` : "No price found; will land at $0.");
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
      rawCategory: rawCategory || null,
      rawPrice,
      rawDuration: rawDuration || null,
      rawDescription: rawDescription || null,
      parsedName,
      parsedCategory,
      categorySource,
      parsedPrice: parsedPrice ?? 0,
      parsedDescription,
      warnings,
    });
  }

  return {
    headers,
    rows,
    fieldMapping: {
      name: nameHeader,
      category: categoryHeader,
      price: priceHeader,
      duration: durationHeader,
      description: descriptionHeader,
    },
    unmappedHeaders,
    totalRows: lines.length - 1,
    parseableRows: rows.length,
    skippedRows: lines.length - 1 - rows.length,
    parseErrors,
  };
}
