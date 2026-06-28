/**
 * switch-math.ts — "what you really pay" promotional-pricing layer (v2.203.0).
 *
 * Pure functions on top of the existing brand-economics engine
 * (project_buying_rewards_taxonomy, Phase 3). The official tier price hides the
 * real cost: a rep's samples amortize into a lower EFFECTIVE cost that's on no
 * sheet. This surfaces, per substitutable group:
 *   • effective cost (= official cost − amortized per-unit incentive),
 *   • the best-margin option,
 *   • the break-even on free units to make another brand match it, and
 *   • whether an advantage is sustained or one-time (a one-time dump reverts).
 *
 * No new margin math — BrandEconomics already gives baseMargin + marginNow
 * (effective margin). We derive cost from those and frame the switch decision.
 */

import type { BrandEconomics, IncentiveLedgerEntry } from "@/lib/brand-economics";

export type SwitchDurability = "sustained" | "one-time" | "none";

export type SwitchBrand = {
  brand: string;
  manufacturer: string | null;
  costSource: string;
  /** retail set (pricePerUnit > 0) — false ⇒ "pricing incomplete". */
  priced: boolean;
  officialCostPerUnit: number;
  effectiveCostPerUnit: number;
  retailPerUnit: number;
  spaIncentivePerUnit: number;
  marginNowPerUnit: number;
  marginNowPct: number | null;
  durability: SwitchDurability;
  /** This brand's current margin edge depends on a one-time incentive (reverts). */
  reliesOnOneTime: boolean;
  /** Lowest effective cost (best margin) among priced brands in the group. */
  isBest: boolean;
};

export type SwitchMatchup = {
  brand: string;
  /** How far this brand's effective cost sits above the best (>0). */
  gapPerUnit: number;
  /** Free units per paid the rep must give to drop this brand's OFFICIAL cost
   *  to the best brand's effective cost. null when it's already at/below. */
  freePerPaid: number | null;
  /** freePerPaid rationalized to a small "N free per M bought". */
  rationalized: { free: number; paid: number } | null;
};

export type SwitchGroup = {
  key: string;
  label: string;
  economics: BrandEconomics[];
};

export type SwitchVerdict = {
  key: string;
  label: string;
  brands: SwitchBrand[];
  best: SwitchBrand | null;
  matchups: SwitchMatchup[];
  /** The best brand's edge is one-time → a switch to it would revert. */
  bestReliesOnOneTime: boolean;
};

const CATEGORY_PRETTY: Record<string, string> = {
  tox: "Tox",
  filler: "Filler",
  biostimulator: "Biostim",
  skincare: "Skincare",
  laser_consumable: "Laser",
  other: "Other",
};

function prettyCategory(category: string): string {
  return (
    CATEGORY_PRETTY[category] ??
    category.charAt(0).toUpperCase() + category.slice(1)
  );
}

/**
 * Group economics into substitution groups — same rule the server recommender
 * uses: filler substitutes WITHIN sub-category (lip ≠ cheek), everything else
 * within category. A multi-subcategory filler competes in each of its groups.
 * Only groups with ≥2 brands are returned (a switch needs a choice).
 */
export function groupBrandEconomics(economics: BrandEconomics[]): SwitchGroup[] {
  const groups = new Map<string, SwitchGroup>();
  const add = (key: string, label: string, e: BrandEconomics) => {
    const g = groups.get(key);
    if (g) g.economics.push(e);
    else groups.set(key, { key, label, economics: [e] });
  };
  for (const e of economics) {
    if (e.category === "filler") {
      const subs = e.subcategories.length > 0 ? e.subcategories : ["(unsorted)"];
      for (const s of subs) {
        add(`filler:${s}`, s === "(unsorted)" ? "Filler" : `Filler · ${s}`, e);
      }
    } else {
      add(e.category, prettyCategory(e.category), e);
    }
  }
  return [...groups.values()].filter((g) => g.economics.length >= 2);
}

/** Classify a brand's spa-side per-unit incentive durability. */
function durabilityFor(active: IncentiveLedgerEntry[]): SwitchDurability {
  const perUnitSpa = active.filter((e) => e.perUnit && e.beneficiary === "spa");
  if (perUnitSpa.length === 0) return "none";
  // A sample is one-shot stock; a dated entry will expire. Only an open-ended
  // per-unit rebate is a standing advantage.
  const oneTime = perUnitSpa.some(
    (e) => e.incentiveType === "sample" || e.endsOn != null,
  );
  return oneTime ? "one-time" : "sustained";
}

function toSwitchBrand(e: BrandEconomics): SwitchBrand {
  const officialCostPerUnit = round2(e.pricePerUnit - e.baseMarginPerUnit);
  const effectiveCostPerUnit = round2(e.pricePerUnit - e.marginNowPerUnit);
  const durability = durabilityFor(e.activeIncentives);
  return {
    brand: e.brand,
    manufacturer: e.manufacturer,
    costSource: e.costSource,
    priced: e.pricePerUnit > 0,
    officialCostPerUnit,
    effectiveCostPerUnit,
    retailPerUnit: e.pricePerUnit,
    spaIncentivePerUnit: e.spaIncentivePerUnit,
    marginNowPerUnit: e.marginNowPerUnit,
    marginNowPct: e.marginNowPct,
    durability,
    reliesOnOneTime: durability === "one-time" && e.spaIncentivePerUnit > 0,
    isBest: false,
  };
}

/**
 * Compute the switch verdict for one substitution group: rank by effective cost
 * (lowest = best margin), then what incentive would make each other priced
 * brand match it.
 */
export function computeSwitchMath(group: SwitchGroup): SwitchVerdict {
  const brands = group.economics.map(toSwitchBrand);
  const priced = brands.filter((b) => b.priced);

  // Best = lowest effective cost; tie-break by higher margin-now.
  let best: SwitchBrand | null = null;
  for (const b of priced) {
    if (
      !best ||
      b.effectiveCostPerUnit < best.effectiveCostPerUnit ||
      (b.effectiveCostPerUnit === best.effectiveCostPerUnit &&
        b.marginNowPerUnit > best.marginNowPerUnit)
    ) {
      best = b;
    }
  }
  if (best) {
    for (const b of brands) b.isBest = b === best;
  }

  const matchups: SwitchMatchup[] = [];
  if (best) {
    for (const b of priced) {
      if (b === best) continue;
      const gap = round2(b.effectiveCostPerUnit - best.effectiveCostPerUnit);
      if (gap <= 0) continue;
      // Free per paid to drop b's OFFICIAL cost to best's EFFECTIVE cost.
      const denom = best.effectiveCostPerUnit;
      const freePerPaid =
        denom > 0 && b.officialCostPerUnit > denom
          ? (b.officialCostPerUnit - denom) / denom
          : null;
      matchups.push({
        brand: b.brand,
        gapPerUnit: gap,
        freePerPaid,
        rationalized: freePerPaid != null ? rationalizeRatio(freePerPaid) : null,
      });
    }
  }

  return {
    key: group.key,
    label: group.label,
    brands,
    best,
    matchups,
    bestReliesOnOneTime: best?.reliesOnOneTime ?? false,
  };
}

/**
 * Approximate a free-per-paid ratio as a small "N free per M bought" fraction.
 * Searches paid 1..8 for the closest integer free-unit count. e.g. 0.749 → 3/4.
 */
export function rationalizeRatio(r: number): { free: number; paid: number } {
  if (r <= 0) return { free: 0, paid: 1 };
  let best = { free: Math.round(r), paid: 1 };
  let bestErr = Math.abs(best.free - r);
  for (let paid = 2; paid <= 8; paid++) {
    const free = Math.max(1, Math.round(r * paid));
    const err = Math.abs(free / paid - r);
    if (err < bestErr - 1e-9) {
      best = { free, paid };
      bestErr = err;
    }
  }
  return best;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
