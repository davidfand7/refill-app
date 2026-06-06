// Shared service-category source (v1.67.0).
// ─────────────────────────────────────────────────────────────────────────
// Service categories used to be a fixed 6-value enum locked at the DB layer.
// They're now FREE TEXT per tenant: the 6 built-ins below stay as canonical
// slugs with pretty labels, and a tenant can type any additional category.
//
// This module is the ONE source both surfaces (Catalog and Booking) import,
// so the two stay mirrored. It is pure (no server/client deps) and safe to
// import from server functions and React components alike.

export interface CategoryOption {
  /** Stored value. Built-ins are canonical slugs; custom is the typed text. */
  value: string;
  /** Human label. Built-ins get a pretty label; custom shows verbatim. */
  label: string;
}

/** The 6 canonical categories, in display order. */
export const BUILTIN_SERVICE_CATEGORIES: readonly CategoryOption[] = [
  { value: "tox", label: "Tox" },
  { value: "filler", label: "Filler" },
  { value: "laser", label: "Laser" },
  { value: "facial", label: "Facial" },
  { value: "skincare", label: "Skincare" },
  { value: "other", label: "Other" },
] as const;

export const BUILTIN_CATEGORY_VALUES: readonly string[] = BUILTIN_SERVICE_CATEGORIES.map(
  (c) => c.value,
);

/** Default category for a brand-new service when none is chosen. */
export const DEFAULT_SERVICE_CATEGORY = "other";

/**
 * Clean a raw category string and fold it onto a built-in slug when it
 * matches one (case-insensitively, by slug OR label) — so typing "Tox"
 * reuses the canonical "tox" rather than creating a near-duplicate. Anything
 * else is returned trimmed with internal whitespace collapsed, verbatim.
 */
export function normalizeCategory(raw: string): string {
  const cleaned = (raw ?? "").trim().replace(/\s+/g, " ");
  if (!cleaned) return "";
  const lower = cleaned.toLowerCase();
  const builtin = BUILTIN_SERVICE_CATEGORIES.find(
    (c) => c.value === lower || c.label.toLowerCase() === lower,
  );
  return builtin ? builtin.value : cleaned;
}

/** Display label for a stored category value. */
export function categoryLabel(value: string): string {
  const v = (value ?? "").trim();
  const builtin = BUILTIN_SERVICE_CATEGORIES.find((c) => c.value === v);
  return builtin ? builtin.label : v || "Other";
}

/**
 * Sort key for grouping: built-ins keep their canonical order, custom
 * categories sort after all built-ins (callers add a secondary label compare
 * to alphabetize the custom tail).
 */
export function categoryRank(value: string): number {
  const i = BUILTIN_CATEGORY_VALUES.indexOf((value ?? "").trim());
  return i < 0 ? BUILTIN_SERVICE_CATEGORIES.length : i;
}

/**
 * Build the full option list for a tenant: the built-ins (canonical order)
 * followed by any distinct custom categories already in use (alphabetized).
 * `existing` is the set of category values across that tenant's services.
 */
export function buildCategoryList(existing: Iterable<string>): CategoryOption[] {
  const seen = new Set(BUILTIN_CATEGORY_VALUES);
  const custom: string[] = [];
  for (const raw of existing) {
    const v = normalizeCategory(raw);
    if (!v || seen.has(v)) continue;
    seen.add(v);
    custom.push(v);
  }
  custom.sort((a, b) => a.localeCompare(b));
  return [
    ...BUILTIN_SERVICE_CATEGORIES,
    ...custom.map((value) => ({ value, label: value })),
  ];
}
