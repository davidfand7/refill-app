/**
 * Defined product sub-categories — the picklist for the catalog's sub-category
 * multi-select (replaces free text). These are the substitution-relevant
 * treatment areas/types (mostly filler injection areas + Biostim). A product
 * can belong to several (e.g. a versatile filler used mid-face AND jawline),
 * so the field is multi-select; stored comma-joined in `subcategory_area`.
 *
 * v2.122.0. "Start with" set — extend here as the catalog grows.
 */

export const PRODUCT_SUBCATEGORIES = [
  "Undereyes / Tear trough",
  "Mid-face",
  "NLF",
  "Lips",
  "Liplines",
  "Fine-lines",
  "Marionettes",
  "Jawline",
  "Chin",
  "Biostim",
] as const;

export type ProductSubcategory = (typeof PRODUCT_SUBCATEGORIES)[number];

/** Parse the comma-joined storage string into a clean list. */
export function parseSubcategories(csv: string | null | undefined): string[] {
  return (csv ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Join a list back into the storage string. */
export function joinSubcategories(values: string[]): string {
  return values.join(", ");
}

/** Toggle one value in a comma-joined string; preserves the canonical order. */
export function toggleSubcategory(csv: string, value: string): string {
  const cur = new Set(parseSubcategories(csv));
  if (cur.has(value)) cur.delete(value);
  else cur.add(value);
  // Keep the defined order; unknown (legacy free-text) values trail.
  const ordered = [
    ...PRODUCT_SUBCATEGORIES.filter((v) => cur.has(v)),
    ...[...cur].filter((v) => !(PRODUCT_SUBCATEGORIES as readonly string[]).includes(v)),
  ];
  return joinSubcategories(ordered);
}
