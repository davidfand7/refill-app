/**
 * Tier-Aware Brand-Substitution Recommender — Pillar 2.2 of the Patient-
 * Profitability OS. The synthesis of everything: it answers, for ONE patient's
 * next treatment in a category, *which brand should the provider use* — and
 * makes that call RIGHT (not just greedy) by reading the patient's value tier.
 *
 * The provider's per-visit objective is `margin_now × patient value-feel ×
 * good-enough outcome`. Tier is the input that decides which term dominates:
 *
 *   - Top value + reliable → maximize the RELATIONSHIP. Recommend the premium
 *     brand they associate with the best result, even at thinner margin —
 *     lifetime value ≫ this visit's margin. (premium_ltv)
 *   - Core / reliable → maximize MARGIN with a value-feel they love. Recommend
 *     the high-margin clinically-equivalent substitute + the patient incentive
 *     so it reads as "best price." (margin_substitute)
 *   - Emerging (new) → ACQUISITION. A great result + a value-feel that earns the
 *     second visit; lean to the high-margin brand carrying a patient reward.
 *     (acquisition)
 *   - Watch (chronic no-show / discount-only) → PROTECT margin. Don't burn the
 *     premium-margin sacrifice or scarce incentive here. (margin_protect)
 *
 * Pure + deterministic (no I/O). Reads BrandEconomics (Pillar 2.1) so the
 * margin_now / value-feel numbers are already fused from catalog + the live
 * incentive ledger. Internal-only; never patient-facing.
 */

import type { ValueTier, ReliabilityFlag } from "@/lib/patient-value";
import type { BrandEconomics } from "@/lib/brand-economics";

export type RecStrategy =
  | "premium_ltv"
  | "margin_substitute"
  | "acquisition"
  | "margin_protect";

export type BrandRecommendation = {
  category: string;
  recommendedBrand: string;
  manufacturer: string | null;
  strategy: RecStrategy;
  /** One-line internal rationale for the provider. */
  rationale: string;
  marginNowPerUnit: number;
  patientValueFeel: number;
  /** The highest-margin option in the category (the margin benchmark). */
  bestMarginBrand: string;
  bestMarginPerUnit: number;
  /** recommended − best margin (≤ 0; what you trade for a premium pick). */
  marginDeltaVsBest: number;
};

function fmtUsd(n: number): string {
  const r = Math.round(n * 100) / 100;
  return `$${r.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

/**
 * Recommend a brand for one patient's next treatment in one category.
 * `economics` should be the BrandEconomics for a SINGLE category (2+ brands
 * makes it a real substitution choice; with 1 brand there's nothing to weigh).
 * Returns null when there are no priced brands to reason over.
 */
export function recommendBrand(args: {
  category: string;
  valueTier: ValueTier | null;
  reliabilityFlag: ReliabilityFlag | null;
  economics: BrandEconomics[];
}): BrandRecommendation | null {
  const { category, valueTier, reliabilityFlag, economics } = args;
  if (economics.length === 0) return null;

  // Margin benchmark: highest margin_now. Premium proxy: highest patient price
  // (premium positioning is what the top cohort associates with "the best").
  const byMargin = [...economics].sort((a, b) => b.marginNowPerUnit - a.marginNowPerUnit);
  const byPrice = [...economics].sort((a, b) => b.pricePerUnit - a.pricePerUnit);
  const bestMargin = byMargin[0]!;
  const premium = byPrice[0]!;

  const isWatch = reliabilityFlag === "watch";
  // Spend the premium-margin sacrifice only on a top, reliable patient.
  const premiumStrategy = valueTier === "top" && !isWatch;

  const pick = premiumStrategy ? premium : bestMargin;
  const marginDeltaVsBest = pick.marginNowPerUnit - bestMargin.marginNowPerUnit;

  let strategy: RecStrategy;
  let rationale: string;

  if (premiumStrategy) {
    strategy = "premium_ltv";
    const tradeoff =
      marginDeltaVsBest < 0
        ? ` Costs ${fmtUsd(Math.abs(marginDeltaVsBest))}/unit vs your highest-margin option — justified: their lifetime value outweighs one visit's margin.`
        : " — and it's also your strongest-margin choice here.";
    rationale = `Top-value, reliable patient — protect the relationship with the premium brand they trust.${tradeoff}`;
  } else if (isWatch) {
    strategy = "margin_protect";
    rationale = `Watch flag (reliability) — protect margin: recommend ${pick.brand}, your highest-margin option here. Don't spend premium incentive on this patient.`;
  } else if (valueTier === "emerging") {
    strategy = "acquisition";
    const feel = pick.patientValueFeel > 0 ? ` Pair the ${fmtUsd(pick.patientValueFeel)} patient value-feel to earn the second visit.` : "";
    rationale = `New patient — win the relationship: ${pick.brand} delivers a great result at strong margin.${feel}`;
  } else {
    strategy = "margin_substitute";
    const feel = pick.patientValueFeel > 0 ? ` plus a ${fmtUsd(pick.patientValueFeel)} value-feel they experience as a great price` : "";
    rationale = `Core patient — recommend ${pick.brand}: clinically equivalent, your best margin here${feel}.`;
  }

  return {
    category,
    recommendedBrand: pick.brand,
    manufacturer: pick.manufacturer,
    strategy,
    rationale,
    marginNowPerUnit: pick.marginNowPerUnit,
    patientValueFeel: pick.patientValueFeel,
    bestMarginBrand: bestMargin.brand,
    bestMarginPerUnit: bestMargin.marginNowPerUnit,
    marginDeltaVsBest,
  };
}
