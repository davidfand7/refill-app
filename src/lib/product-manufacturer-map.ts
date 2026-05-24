/**
 * Product → manufacturer/kind resolver for Emma(OS) patient transactions.
 *
 * Built from Rejuv Skin Spa's real CSV (1,126 patients, 17,521 lines) — the
 * map covers the long tail by category, not by brand-name exhaustion. Any
 * truly unknown product lands with `manufacturer: null, kind: null` and
 * surfaces in the import receipt's "flagged for review" count so the spa
 * owner sees the queue instead of silent gaps.
 *
 * Why a curated const and not a fuzzy match — the manufacturer assignment is
 * load-bearing for cohort targeting (Jeuveau patient → Evolus promo eligible)
 * and consent-gated rep-facing aggregates. A wrong assignment misroutes a
 * patient's loyalty bucket, so we'd rather flag than guess.
 *
 * Match strategy:
 *   1) Exact lowercase-trimmed match against the table.
 *   2) Substring match against the brand-name list (catches QuickBooks's
 *      "Restylane Kysse" vs "Kysse", "Voluma XC" vs "VOLUMA", etc.) — only
 *      runs when no exact match found, and only on the brand list where
 *      ambiguity is impossible.
 *   3) Category fallbacks for the practice-level line items that recur
 *      across spas (Promotional Discount, Cash Payment, Gift Card, etc.).
 *
 * Established 2026-05-15 (Patient Architecture P1).
 */

export type ProductManufacturer =
  | "evolus"
  | "abbvie" // Allergan products are now AbbVie post-2020
  | "merz"
  | "galderma"
  | "skinceuticals"
  | "eltamd"
  | "neocutis"
  | "obagi"
  | "revance"
  | "rha"
  | "sciton"
  | "abbvie-coolsculpting"; // Allergan device line; called out separately for
//                              cohort analysis (device patients ≠ injectable patients).

/**
 * The product-kind taxonomy from the Patient-Architecture-Design.html doc
 * (Decision 6). Distinguishes negative-amount loyalty redemptions from
 * refunds, devices from injectables, retail from in-room services.
 */
export type ProductKind =
  | "toxin"
  | "filler"
  | "biostimulator"
  | "device"
  | "retail"
  | "reward"
  | "payment"
  | "discount"
  | "service"
  | "note";

export type ProductResolution = {
  manufacturer: ProductManufacturer | null;
  kind: ProductKind | null;
};

// ─── Exact-match table (brand-name canonical entries) ─────────────────────

const EXACT: Readonly<Record<string, ProductResolution>> = {
  // Evolus
  jeuveau: { manufacturer: "evolus", kind: "toxin" },
  "evolus reward": { manufacturer: "evolus", kind: "reward" },

  // AbbVie / Allergan injectables
  botox: { manufacturer: "abbvie", kind: "toxin" },
  "voluma xc": { manufacturer: "abbvie", kind: "filler" },
  "juvederm ultra plus xc": { manufacturer: "abbvie", kind: "filler" },
  "juvederm ultra xc": { manufacturer: "abbvie", kind: "filler" },
  volux: { manufacturer: "abbvie", kind: "filler" },
  vollure: { manufacturer: "abbvie", kind: "filler" },
  volbella: { manufacturer: "abbvie", kind: "filler" },
  "volbella .1cc": { manufacturer: "abbvie", kind: "filler" },
  skinvive: { manufacturer: "abbvie", kind: "filler" },
  alle: { manufacturer: "abbvie", kind: "reward" },
  "latisse - 5ml": { manufacturer: "abbvie", kind: "retail" },

  // AbbVie / Allergan device
  "coolsculpting - small": { manufacturer: "abbvie-coolsculpting", kind: "device" },
  "coolsculpting - large": { manufacturer: "abbvie-coolsculpting", kind: "device" },
  "coolsculpting payment": { manufacturer: "abbvie-coolsculpting", kind: "device" },

  // Merz
  xeomin: { manufacturer: "merz", kind: "toxin" },
  "xeomin - 30 (deleted)": { manufacturer: "merz", kind: "toxin" },
  "xeomin - 40+ (deleted)": { manufacturer: "merz", kind: "toxin" },
  "xeomin - buddy": { manufacturer: "merz", kind: "toxin" },
  "belotero balance": { manufacturer: "merz", kind: "filler" },
  "radiesse 1.5cc": { manufacturer: "merz", kind: "biostimulator" },
  "merz rewards": { manufacturer: "merz", kind: "reward" },
  // QuickBooks emits the parent:child sub-account format on some exports.
  "merz rewards:merz rewards": { manufacturer: "merz", kind: "reward" },
  "merz rewards:merz rewards (deleted)": { manufacturer: "merz", kind: "reward" },

  // Galderma (Restylane family + Dysport + Sculptra + Aspire loyalty)
  dysport: { manufacturer: "galderma", kind: "toxin" },
  "restylane kysse": { manufacturer: "galderma", kind: "filler" },
  refyne: { manufacturer: "galderma", kind: "filler" },
  defyne: { manufacturer: "galderma", kind: "filler" },
  lyft: { manufacturer: "galderma", kind: "filler" },
  contour: { manufacturer: "galderma", kind: "filler" },
  sculptra: { manufacturer: "galderma", kind: "biostimulator" },
  aspire: { manufacturer: "galderma", kind: "reward" },

  // SkinCeuticals retail (AbbVie-owned but tracked separately — different rep)
  "ce ferulic": { manufacturer: "skinceuticals", kind: "retail" },
  "triple lipid": { manufacturer: "skinceuticals", kind: "retail" },
  "tns advanced + serum": { manufacturer: "skinceuticals", kind: "retail" },

  // Elta MD retail
  "elta- daily 40": { manufacturer: "eltamd", kind: "retail" },
  "elta- daily 40 tint": { manufacturer: "eltamd", kind: "retail" },
  "elta - physical 41": { manufacturer: "eltamd", kind: "retail" },
  "elta- sport 50": { manufacturer: "eltamd", kind: "retail" },
  "elta - uv clear 46": { manufacturer: "eltamd", kind: "retail" },
  "elta - restore": { manufacturer: "eltamd", kind: "retail" },
  "elta - sheer": { manufacturer: "eltamd", kind: "retail" },
  "am restore elta md moisturizer": { manufacturer: "eltamd", kind: "retail" },
  "pm restore elta md moisturizer": { manufacturer: "eltamd", kind: "retail" },
  "dup elta - restore tinted": { manufacturer: "eltamd", kind: "retail" },

  // Neocutis retail
  "lumiere - neocutis eye": { manufacturer: "neocutis", kind: "retail" },
  "neocutis - aftercare": { manufacturer: "neocutis", kind: "retail" },

  // Obagi retail
  "obagi clear": { manufacturer: "obagi", kind: "retail" },
  "obagi c -clarifying serum vit c 10% hq 4% normal to dry": {
    manufacturer: "obagi",
    kind: "retail",
  },
  "obagi tretinoin cream 0.1%": { manufacturer: "obagi", kind: "retail" },

  // Practice-level / non-product lines (manufacturer always null)
  "promotional discount": { manufacturer: null, kind: "discount" },
  "cash payment": { manufacturer: null, kind: "payment" },
  "gift card": { manufacturer: null, kind: "payment" },
  "gift card - credit": { manufacturer: null, kind: "payment" },
  "note venmo": { manufacturer: null, kind: "payment" },
  "custom amount": { manufacturer: null, kind: "payment" },
  services: { manufacturer: null, kind: "service" },
  note: { manufacturer: null, kind: "note" },
  "injection fee": { manufacturer: null, kind: "service" },

  // Generic retail / Rx (no canonical manufacturer mapping)
  // Upneeq is RVL Pharmaceuticals; not in the active rep-loyalty universe so
  // we tag it retail with no canonical manufacturer slug.
  upneeq: { manufacturer: null, kind: "retail" },
  arnicare: { manufacturer: null, kind: "retail" },
  "hydroquinone 10%": { manufacturer: null, kind: "retail" },
  "retinoic acid .1%": { manufacturer: null, kind: "retail" },
  "retinoic acid .05%": { manufacturer: null, kind: "retail" },
  "retinol complex .5": { manufacturer: null, kind: "retail" },
  "retinol complex .25": { manufacturer: null, kind: "retail" },
  "retinol complex 1.0": { manufacturer: null, kind: "retail" },
  exosomes: { manufacturer: null, kind: "retail" },
  intensifier: { manufacturer: null, kind: "retail" },
  "blt - 30g": { manufacturer: null, kind: "retail" },
  "advanced rgn-6": { manufacturer: null, kind: "retail" },
};

// ─── Substring-match fallback (brand-name partial matches) ────────────────
// Each entry is checked in order; first hit wins. Ordered most-specific first
// so "voluma" matches before a hypothetical retail "vol-something".
const SUBSTRING: ReadonlyArray<[RegExp, ProductResolution]> = [
  [/\bjeuveau\b/i, { manufacturer: "evolus", kind: "toxin" }],
  [/\bbotox\b/i, { manufacturer: "abbvie", kind: "toxin" }],
  [/\bxeomin\b/i, { manufacturer: "merz", kind: "toxin" }],
  [/\bdysport\b/i, { manufacturer: "galderma", kind: "toxin" }],
  [/\bvoluma\b/i, { manufacturer: "abbvie", kind: "filler" }],
  [/\bjuvederm\b/i, { manufacturer: "abbvie", kind: "filler" }],
  [/\bvollure\b/i, { manufacturer: "abbvie", kind: "filler" }],
  [/\bvolbella\b/i, { manufacturer: "abbvie", kind: "filler" }],
  [/\bvolux\b/i, { manufacturer: "abbvie", kind: "filler" }],
  [/\bskinvive\b/i, { manufacturer: "abbvie", kind: "filler" }],
  [/\brestylane\b/i, { manufacturer: "galderma", kind: "filler" }],
  [/\bbelotero\b/i, { manufacturer: "merz", kind: "filler" }],
  [/\bradiesse\b/i, { manufacturer: "merz", kind: "biostimulator" }],
  [/\bsculptra\b/i, { manufacturer: "galderma", kind: "biostimulator" }],
  [/\baspire\b/i, { manufacturer: "galderma", kind: "reward" }],
  [/\balle\b/i, { manufacturer: "abbvie", kind: "reward" }],
  [/\bevolus reward/i, { manufacturer: "evolus", kind: "reward" }],
  [/\bmerz reward/i, { manufacturer: "merz", kind: "reward" }],
  [/\bcoolsculpting\b/i, { manufacturer: "abbvie-coolsculpting", kind: "device" }],
  [/\blatisse\b/i, { manufacturer: "abbvie", kind: "retail" }],
  // Practice-level device categories — manufacturer-agnostic until we know more.
  [/\bbbl\b/i, { manufacturer: "sciton", kind: "device" }],
  [/\brf micro\b/i, { manufacturer: null, kind: "device" }],
  [/\blhr\b|\blaser hair\b/i, { manufacturer: null, kind: "device" }],
  [/\bhifu\b/i, { manufacturer: null, kind: "device" }],
  [/\bthulium\b/i, { manufacturer: null, kind: "device" }],
  [/\bco2\b/i, { manufacturer: null, kind: "device" }],
  [/\bpeel\b/i, { manufacturer: null, kind: "service" }],
  [/\bvi peel\b|\bvip peel\b/i, { manufacturer: null, kind: "service" }],
  [/\bgift card\b/i, { manufacturer: null, kind: "payment" }],
];

/**
 * Normalize a product name to its lookup key — lowercase, trimmed, internal
 * whitespace collapsed. Quirky QuickBooks quoting is stripped upstream by
 * the CSV parser; this function assumes a plain string.
 */
function normalizeKey(raw: string): string {
  return raw.toLowerCase().trim().replace(/\s+/g, " ");
}

/**
 * Resolve a raw product name from the QuickBooks export to manufacturer +
 * product-kind. Returns nulls for unrecognized products — never throws.
 *
 * Empty / whitespace-only input → both nulls.
 */
export function resolveProduct(rawName: string): ProductResolution {
  if (!rawName) return { manufacturer: null, kind: null };
  const key = normalizeKey(rawName);
  if (!key) return { manufacturer: null, kind: null };

  const exact = EXACT[key];
  if (exact) return exact;

  for (const [re, resolution] of SUBSTRING) {
    if (re.test(rawName)) return resolution;
  }

  return { manufacturer: null, kind: null };
}

/**
 * Predicate for "is this line a real product purchase" vs payment/discount/
 * note. Used by the summary materializer to count visits, lifetime spend,
 * and primary manufacturer without inflating those numbers with payment
 * lines or discount adjustments.
 */
export function isProductPurchase(kind: ProductKind | null): boolean {
  switch (kind) {
    case "toxin":
    case "filler":
    case "biostimulator":
    case "device":
    case "retail":
    case "service":
      return true;
    default:
      return false;
  }
}

/**
 * Predicate for loyalty-reward redemption lines. Negative-amount lines that
 * carry brand-aligned cohort signal even though they don't generate revenue.
 */
export function isLoyaltyRedemption(kind: ProductKind | null): boolean {
  return kind === "reward";
}
