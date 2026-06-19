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
 * Sort key for category grouping that honors a tenant's MANUAL order list.
 * Categories present in `order` lead (in that order); the rest fall back to the
 * built-in canonical order, then alphabetical (caller adds a label tiebreak).
 */
export function orderedCategoryRank(value: string, order: string[]): number {
  const v = normalizeCategory(value);
  const i = order.findIndex((c) => normalizeCategory(c) === v);
  return i >= 0 ? i : order.length + categoryRank(value);
}

/**
 * Strip a provider baked into a service name for DISPLAY — "Tox w/ Karen" →
 * "Tox", "Filler with Karen" → "Filler". Many spas (esp. solo Acuity setups)
 * weld the provider into the catalog label; that pollutes every service picker.
 * Clean on render, never mutate the source (re-typing the catalog isn't on the
 * owner). PRECISION over recall: only strip a trailing connector + a KNOWN
 * provider/owner name (the candidates), so "Facial with Dermaplane" or
 * "Botox / Dysport" pass through untouched. Pure — same logic as the rescue
 * composers' stripProviderFromTreatment, shared here.
 */
export function stripProviderSuffix(name: string, candidates: string[]): string {
  if (!name) return name;
  const cands = candidates.map((c) => c?.trim()).filter((c): c is string => !!c && c.length > 1);
  if (cands.length === 0) return name;
  let out = name.trim();
  for (const c of cands) {
    const esc = c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`\\s*(?:w\\/\\s*|with\\s+|[-–—\\/:]\\s*)${esc}\\s*$`, "i"), "").trim();
  }
  return out || name;
}

/**
 * Group services into category buckets for a picker (<optgroup>) — so a flat
 * dump of "CoolSculpting · Defyne · HIFU NECK · BBL -Chest…" reads instead as
 * Tox ▸ … / Filler ▸ Defyne, Refyne… / Laser ▸ HIFU, BBL… — categories,
 * individual services, and brand-named services all flowing under their
 * category. Buckets follow the canonical category order (custom categories
 * after, alphabetized); within a bucket, sort_order then name. Pure.
 */
export function groupServicesByCategory<
  T extends { category: string; name: string; sortOrder?: number | null },
>(services: T[]): Array<{ value: string; label: string; items: T[] }> {
  const byCat = new Map<string, T[]>();
  for (const s of services) {
    const v = normalizeCategory(s.category) || DEFAULT_SERVICE_CATEGORY;
    const arr = byCat.get(v) ?? [];
    arr.push(s);
    byCat.set(v, arr);
  }
  return [...byCat.entries()]
    .sort(
      (a, b) =>
        categoryRank(a[0]) - categoryRank(b[0]) ||
        categoryLabel(a[0]).localeCompare(categoryLabel(b[0])),
    )
    .map(([value, items]) => ({
      value,
      label: categoryLabel(value),
      items: items
        .slice()
        .sort(
          (x, y) =>
            (x.sortOrder ?? Number.MAX_SAFE_INTEGER) - (y.sortOrder ?? Number.MAX_SAFE_INTEGER) ||
            x.name.localeCompare(y.name),
        ),
    }));
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
