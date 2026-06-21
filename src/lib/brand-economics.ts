/**
 * Brand Economics — Pillar 2.1 of the Patient-Profitability OS (the data spine
 * the tier-aware Brand-Substitution Recommender weights on).
 *
 * The provider re-solves the brand choice at the moment of treatment to
 * maximize `margin_now × patient value-feel × good-enough outcome`. This lib
 * supplies the first two terms as DATA:
 *
 *   margin_now        = base catalog margin (price − cost) + active SPA-side
 *                       per-unit incentives (manufacturer rebates / free
 *                       samples that lower the spa's effective cost).
 *   patient value-feel = active PATIENT-side incentives (manufacturer vouchers
 *                       / loyalty rewards the patient experiences as a better
 *                       price) — the number that, combined with any spa
 *                       discount, reads to the patient as "best price."
 *
 * The base margin already exists in the products catalog (cost_per_unit /
 * sales_price_per_unit). What's NEW is the time-variant Manufacturer Incentive
 * Ledger — the "hidden lever" turned into owner-maintained data. This module is
 * PURE (no I/O, no Date.now() — `todayIso` is injected) so the math is
 * deterministic + unit-testable, and it does NOT import the server catalog
 * module; callers map their rows into the minimal shapes below.
 *
 * NOTE on framing: margin_now is the SPA's margin (theirs). It is unrelated to
 * the $5 cross_sell_addon, which is SmartSpa's revenue — never conflate.
 *
 * `manufacturer` is a plain string here (not a ProductManufacturer enum) — two
 * same-named enums exist (the catalog's includes generic/in_house, the map's
 * doesn't), so the pure lib stays decoupled from both.
 */

/**
 * Who an incentive accrues to. SPA-side lowers the spa's effective cost (lifts
 * margin_now); PATIENT-side is value the patient feels (lifts value-feel). The
 * owner sets this per entry; defaults are suggested by `defaultBeneficiary`.
 */
export type IncentiveBeneficiary = "spa" | "patient";

export type IncentiveType =
  | "rebate" // manufacturer pays the spa back per unit → spa-side
  | "sample" // free units from the manufacturer → spa-side (lowers effective cost)
  | "voucher" // manufacturer coupon the patient redeems → patient-side
  | "patient_reward" // loyalty reward to the patient → patient-side
  | "instant"; // instant savings at POS → owner picks beneficiary

/** Sensible default beneficiary for an incentive type (owner can override). */
export function defaultBeneficiary(t: IncentiveType): IncentiveBeneficiary {
  return t === "rebate" || t === "sample" ? "spa" : "patient";
}

/**
 * One owner-maintained incentive on a brand for a date window. Stored as a
 * `node_type='incentive_ledger_entry'` knowledge_node (jsonb, no migration —
 * mirrors allocation_settings / manufacturer_profile). `perUnit` distinguishes
 * a $/unit rebate from a flat $/treatment voucher — we never fake-convert a
 * flat amount into a per-unit one (that would corrupt margin_now).
 */
export type IncentiveLedgerEntry = {
  id: string;
  /** Brand display name — matches Product.brand / canonical_brands. */
  brand: string;
  manufacturer: string | null;
  /** Category for substitutability grouping (e.g. "tox", "filler"). */
  category: string;
  incentiveType: IncentiveType;
  beneficiary: IncentiveBeneficiary;
  amountUsd: number;
  /** true = $ per unit (folds into per-unit margin); false = flat $ per treatment. */
  perUnit: boolean;
  /** ISO yyyy-mm-dd; null = open-ended on that side. */
  startsOn: string | null;
  endsOn: string | null;
  notes: string | null;
  /** Sample-only metadata so the entry stays editable: how many free units +
   *  which unit. amountUsd is the derived value (count × brand cost). */
  freeUnits?: number | null;
  sampleUnit?: string | null;
};

/** Minimal product shape this lib needs (decoupled from the server catalog). */
export type BrandCostInput = {
  brand: string;
  manufacturer: string | null;
  category: string;
  /** vial / syringe / bottle / session / other — drives $/unit display. */
  unitType: string;
  /** Sub-category tags (Mid-face / Lips / Biostim …) — the substitution group. */
  subcategories: string[];
  /** Manual position within category (mirrors the Products page drag order). */
  sortOrder: number | null;
  costPerUnit: number;
  salesPricePerUnit: number;
};

export type BrandEconomics = {
  brand: string;
  manufacturer: string | null;
  category: string;
  unitType: string;
  subcategories: string[];
  sortOrder: number | null;
  /** Patient-facing sales price per unit (premium-positioning signal). */
  pricePerUnit: number;
  /** price − cost, straight from the catalog (the unchanging baseline). */
  baseMarginPerUnit: number;
  /** Active SPA-side per-unit incentive total (rebates / samples). */
  spaIncentivePerUnit: number;
  /** Active SPA-side FLAT incentive total ($/treatment, not per unit). */
  spaIncentiveFlat: number;
  /** baseMarginPerUnit + spaIncentivePerUnit — the effective per-unit margin now. */
  marginNowPerUnit: number;
  /** marginNowPerUnit / price, or null when price is 0. */
  marginNowPct: number | null;
  /** Active PATIENT-side incentive total (per-unit + flat), the value-feel number. */
  patientValueFeel: number;
  /** The active entries that fed this snapshot (for explainability/UI). */
  activeIncentives: IncentiveLedgerEntry[];
};

// ─── Active-window predicate ──────────────────────────────────────────────

/** Is an entry in effect on `todayIso` (yyyy-mm-dd)? Null bounds are open. */
export function isIncentiveActive(e: IncentiveLedgerEntry, todayIso: string): boolean {
  if (e.startsOn && todayIso < e.startsOn) return false;
  if (e.endsOn && todayIso > e.endsOn) return false;
  return true;
}

/** Active incentives for one brand (case-insensitive match on brand name). */
export function activeIncentivesForBrand(
  entries: IncentiveLedgerEntry[],
  brand: string,
  todayIso: string,
): IncentiveLedgerEntry[] {
  const key = brand.trim().toLowerCase();
  return entries.filter(
    (e) => e.brand.trim().toLowerCase() === key && isIncentiveActive(e, todayIso),
  );
}

// ─── Economics ──────────────────────────────────────────────────────────────

/**
 * Fuse a brand's catalog cost/price with its active incentives into the
 * margin_now + value-feel snapshot. Spa-side per-unit incentives lift the
 * effective margin; patient-side incentives become the value-feel the patient
 * experiences. Flat ($/treatment) incentives are kept SEPARATE from per-unit
 * margin so the per-unit number stays honest.
 */
export function computeBrandEconomics(
  product: BrandCostInput,
  entries: IncentiveLedgerEntry[],
  todayIso: string,
): BrandEconomics {
  const active = activeIncentivesForBrand(entries, product.brand, todayIso);
  const baseMargin = product.salesPricePerUnit - product.costPerUnit;

  let spaPerUnit = 0;
  let spaFlat = 0;
  let patientFeel = 0;
  for (const e of active) {
    if (e.beneficiary === "spa") {
      if (e.perUnit) spaPerUnit += e.amountUsd;
      else spaFlat += e.amountUsd;
    } else {
      // Patient-side value-feel pools per-unit + flat into one number the
      // patient experiences as "best price."
      patientFeel += e.amountUsd;
    }
  }

  const marginNow = baseMargin + spaPerUnit;
  return {
    brand: product.brand,
    manufacturer: product.manufacturer,
    category: product.category,
    unitType: product.unitType,
    subcategories: product.subcategories,
    sortOrder: product.sortOrder,
    pricePerUnit: product.salesPricePerUnit,
    baseMarginPerUnit: baseMargin,
    spaIncentivePerUnit: spaPerUnit,
    spaIncentiveFlat: spaFlat,
    marginNowPerUnit: marginNow,
    marginNowPct: product.salesPricePerUnit > 0 ? marginNow / product.salesPricePerUnit : null,
    patientValueFeel: patientFeel,
    activeIncentives: active,
  };
}

/**
 * Economics for every product, ordered within each category by the owner's
 * manual product order (sort_order, nulls last → brand) so the Brand Economics
 * panel mirrors the Products page drag order exactly. The "best margin" is
 * surfaced by a badge in the UI rather than by position, so manual order and
 * margin visibility coexist. (The recommender re-sorts internally, so this
 * order doesn't affect recommendations.)
 */
export function rankBrandEconomics(
  products: BrandCostInput[],
  entries: IncentiveLedgerEntry[],
  todayIso: string,
): BrandEconomics[] {
  return products
    .map((p) => computeBrandEconomics(p, entries, todayIso))
    .sort((a, b) => {
      if (a.category !== b.category) return a.category.localeCompare(b.category);
      const ao = a.sortOrder ?? Infinity;
      const bo = b.sortOrder ?? Infinity;
      if (ao !== bo) return ao - bo;
      return a.brand.localeCompare(b.brand);
    });
}
