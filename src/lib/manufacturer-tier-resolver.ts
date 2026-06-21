/**
 * Manufacturer tier-pricing resolver (v2.130.0).
 *
 * Pure functions that compute a product's effective COST from a manufacturer
 * loyalty program + the spa's selected tier. The seed/apply server fns call
 * this and WRITE the result to products.cost_per_unit (cost_source =
 * 'tier_estimate'); a real portal "Your Price" later overrides it. See
 * reference_allergan_app_tiers + the v2.130.0 migration.
 *
 * Two program shapes today:
 *   • portfolio_plus_brand_tier (Allergan APP): cost = list × (1 − brandTier%)
 *     × (1 − portfolio%) — brand tier applied FIRST, then portfolio.
 *   • volume_tier (Evolus): per-unit price comes straight from the product's
 *     own ladder at the selected tier — an absolute $/unit, not a % off list.
 * Stub manufacturers (no program) return list unchanged. list_price is per BOX;
 * resolvePerUnitCost divides by units_per_box for the per-unit catalog cost.
 */

export type PortfolioLevel = { key: string; points?: number; discountPct: number };

/** One rung of a volume-tier ladder: cumulative-units threshold → price PER UNIT. */
export type VolumeTierStep = { tier: number; minUnits?: number; price: number };
/** A product's volume ladder (volume_tier programs, e.g. Evolus). Keyed by brand_family. */
export type ProductLadder = { unitType?: string; tiers: VolumeTierStep[] };

export type ManufacturerProgramTiers = {
  /** Program shape: 'portfolio_plus_brand_tier' (Allergan) | 'volume_tier' (Evolus). */
  programType?: string;
  stacking?: string;
  dollarsPerPoint?: number;
  portfolioLevels?: PortfolioLevel[];
  brandTierThresholds?: { tier: number; points?: number }[];
  /** brand family → per-tier discount % array (index 0 = tier 1). */
  brandFamilies?: Record<string, number[]>;
  /** volume_tier: brand family → that product's price ladder. */
  productLadders?: Record<string, ProductLadder>;
};

export type TierSelection = {
  portfolioLevel?: string | null;
  /** brand family → selected tier (1-based). 0/undefined = no brand tier. */
  brandTiers?: Record<string, number | null | undefined>;
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Brand-tier discount % for a family under the current selection (0 if none). */
export function brandDiscountPct(
  brandFamily: string | null | undefined,
  selection: TierSelection | null | undefined,
  program: ManufacturerProgramTiers | null | undefined,
): number {
  if (!brandFamily || !program?.brandFamilies || !selection?.brandTiers) return 0;
  const schedule = program.brandFamilies[brandFamily];
  if (!schedule || schedule.length === 0) return 0;
  const tier = selection.brandTiers[brandFamily];
  if (!tier || tier < 1) return 0;
  const idx = Math.min(tier, schedule.length) - 1;
  return schedule[idx] ?? 0;
}

/**
 * volume_tier per-unit price: the ladder rung for the selected tier of this
 * product's brand family (absolute $/unit, not a discount). null if there's no
 * ladder for the family or no tier is picked.
 */
export function volumeTierUnitPrice(
  brandFamily: string | null | undefined,
  selection: TierSelection | null | undefined,
  program: ManufacturerProgramTiers | null | undefined,
): number | null {
  if (!brandFamily) return null;
  const ladder = program?.productLadders?.[brandFamily];
  if (!ladder?.tiers?.length) return null;
  const tier = selection?.brandTiers?.[brandFamily];
  if (!tier || tier < 1) return null;
  const step = ladder.tiers.find((s) => s.tier === tier);
  return step ? round2(step.price) : null;
}

/** Portfolio-level discount % under the current selection (0 if none). */
export function portfolioDiscountPct(
  selection: TierSelection | null | undefined,
  program: ManufacturerProgramTiers | null | undefined,
): number {
  const key = selection?.portfolioLevel;
  if (!key || !program?.portfolioLevels) return 0;
  const lvl = program.portfolioLevels.find((l) => l.key === key);
  return lvl?.discountPct ?? 0;
}

/**
 * Effective per-BOX cost from list price + selected tiers. Brand tier applied
 * first, then portfolio (multiplicative). No program/selection → list as-is.
 */
export function resolveEffectiveBoxCost(args: {
  listPrice: number; // per box
  brandFamily?: string | null;
  selection: TierSelection | null | undefined;
  program: ManufacturerProgramTiers | null | undefined;
}): number {
  const { listPrice, brandFamily, selection, program } = args;
  if (!program || !selection || !(listPrice > 0)) return round2(Math.max(0, listPrice));
  const brandPct = brandDiscountPct(brandFamily, selection, program);
  const portfolioPct = portfolioDiscountPct(selection, program);
  const cost = listPrice * (1 - brandPct / 100) * (1 - portfolioPct / 100);
  return round2(cost);
}

/**
 * Per-unit list + cost from a master-catalog row (list_price per box) + the
 * tenant's tier selection. Divides by units_per_box (Allergan filler box = 2
 * syringes) — the single place packaging conversion happens at preload.
 */
export function resolvePerUnitCost(args: {
  listPriceBox: number;
  unitsPerBox: number;
  brandFamily?: string | null;
  selection: TierSelection | null | undefined;
  program: ManufacturerProgramTiers | null | undefined;
}): { listPricePerUnit: number; costPerUnit: number } {
  const units = args.unitsPerBox > 0 ? args.unitsPerBox : 1;
  // Volume-tier (Evolus): per-unit price comes straight from the product's
  // ladder at the selected tier — an absolute $/unit, not a % off list. The
  // ladder is already per unit (1 box = 1 vial/syringe), so no box division.
  if (args.program?.programType === "volume_tier") {
    const listPerUnit = round2(args.listPriceBox / units);
    const price = volumeTierUnitPrice(args.brandFamily, args.selection, args.program);
    return { listPricePerUnit: listPerUnit, costPerUnit: price ?? listPerUnit };
  }
  const boxCost = resolveEffectiveBoxCost({
    listPrice: args.listPriceBox,
    brandFamily: args.brandFamily,
    selection: args.selection,
    program: args.program,
  });
  return {
    listPricePerUnit: round2(args.listPriceBox / units),
    costPerUnit: round2(boxCost / units),
  };
}
