/**
 * verify-switch-math.ts — runnable spec for the promotional-pricing layer.
 *
 * Run: bun run scripts/verify-switch-math.ts
 *
 * Proves: effective cost = price − marginNow; best = lowest effective cost;
 * break-even free-per-paid (Botox $656 vs Jeuveau $375 → ~3 per 4); durability
 * (sample/dated = one-time, open-ended rebate = sustained); substitution
 * grouping (filler by sub-category; ≥2-brand groups only); unpriced handling.
 */

import type { BrandEconomics, IncentiveLedgerEntry } from "../src/lib/brand-economics";
import {
  groupBrandEconomics,
  computeSwitchMath,
  rationalizeRatio,
} from "../src/lib/switch-math";

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    failures++;
    console.error(`✗ ${label}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
  } else {
    console.log(`✓ ${label}`);
  }
}

function eco(p: Partial<BrandEconomics>): BrandEconomics {
  return {
    brand: "X",
    manufacturer: null,
    category: "tox",
    unitType: "vial",
    subcategories: [],
    sortOrder: null,
    costSource: "tier_estimate",
    pricePerUnit: 0,
    baseMarginPerUnit: 0,
    spaIncentivePerUnit: 0,
    spaIncentiveFlat: 0,
    marginNowPerUnit: 0,
    marginNowPct: null,
    patientValueFeel: 0,
    activeIncentives: [],
    ...p,
  };
}
function incentive(p: Partial<IncentiveLedgerEntry>): IncentiveLedgerEntry {
  return {
    id: "i",
    brand: "X",
    manufacturer: null,
    category: "tox",
    incentiveType: "rebate",
    beneficiary: "spa",
    amountUsd: 0,
    perUnit: true,
    startsOn: null,
    endsOn: null,
    notes: null,
    ...p,
  };
}

// ── The headline case: Botox $656 (no incentive) vs Jeuveau $375 ──
// retail $1150 both; baseMargin = price − cost; no incentives → marginNow = baseMargin.
const botox = eco({
  brand: "Botox",
  pricePerUnit: 1150,
  baseMarginPerUnit: 494, // cost 656
  marginNowPerUnit: 494,
});
const jeuveau = eco({
  brand: "Jeuveau",
  pricePerUnit: 1150,
  baseMarginPerUnit: 775, // cost 375
  marginNowPerUnit: 775,
});
const v = computeSwitchMath({ key: "tox", label: "Tox", economics: [botox, jeuveau] });

check("Botox effective cost = 656", v.brands.find((b) => b.brand === "Botox")?.effectiveCostPerUnit, 656);
check("Jeuveau effective cost = 375", v.brands.find((b) => b.brand === "Jeuveau")?.effectiveCostPerUnit, 375);
check("best = Jeuveau", v.best?.brand, "Jeuveau");
check("Jeuveau isBest", v.brands.find((b) => b.brand === "Jeuveau")?.isBest, true);
check("one matchup (Botox)", v.matchups.map((m) => m.brand), ["Botox"]);
check("Botox gap = 281", v.matchups[0]?.gapPerUnit, 281);
check("Botox break-even ≈ 3 free per 4 bought", v.matchups[0]?.rationalized, { free: 3, paid: 4 });

// ── rationalizeRatio ──
check("rationalize 0.749 → 3/4", rationalizeRatio((656 - 375) / 375), { free: 3, paid: 4 });
check("rationalize 0.5 → 1/2", rationalizeRatio(0.5), { free: 1, paid: 2 });
check("rationalize 0 → 0/1", rationalizeRatio(0), { free: 0, paid: 1 });

// ── Durability ──
const oneTime = eco({
  brand: "SampleBrand",
  pricePerUnit: 1000,
  baseMarginPerUnit: 400,
  spaIncentivePerUnit: 100,
  marginNowPerUnit: 500,
  activeIncentives: [incentive({ brand: "SampleBrand", incentiveType: "sample", perUnit: true, amountUsd: 100 })],
});
const sustained = eco({
  brand: "RebateBrand",
  pricePerUnit: 1000,
  baseMarginPerUnit: 400,
  spaIncentivePerUnit: 100,
  marginNowPerUnit: 500,
  activeIncentives: [incentive({ brand: "RebateBrand", incentiveType: "rebate", perUnit: true, endsOn: null, amountUsd: 100 })],
});
const dv = computeSwitchMath({ key: "tox", label: "Tox", economics: [oneTime, sustained] });
check("sample incentive → one-time", dv.brands.find((b) => b.brand === "SampleBrand")?.durability, "one-time");
check("one-time relies-on-one-time", dv.brands.find((b) => b.brand === "SampleBrand")?.reliesOnOneTime, true);
check("open-ended rebate → sustained", dv.brands.find((b) => b.brand === "RebateBrand")?.durability, "sustained");
check("no incentive → none", botox && computeSwitchMath({ key: "t", label: "T", economics: [botox, jeuveau] }).brands[0].durability, "none");

// ── Unpriced retail is excluded from best/matchups ──
const unpriced = eco({ brand: "Unpriced", pricePerUnit: 0, baseMarginPerUnit: -500, marginNowPerUnit: -500 });
const uv = computeSwitchMath({ key: "tox", label: "Tox", economics: [jeuveau, unpriced] });
check("unpriced not priced", uv.brands.find((b) => b.brand === "Unpriced")?.priced, false);
check("best ignores unpriced", uv.best?.brand, "Jeuveau");
check("no matchup vs unpriced", uv.matchups.length, 0);

// ── Grouping ──
check("single-brand group filtered out", groupBrandEconomics([botox]).length, 0);
check("two tox → one group", groupBrandEconomics([botox, jeuveau]).map((g) => g.key), ["tox"]);
const lipA = eco({ brand: "A", category: "filler", subcategories: ["Lips"], pricePerUnit: 600, baseMarginPerUnit: 300, marginNowPerUnit: 300 });
const lipB = eco({ brand: "B", category: "filler", subcategories: ["Lips"], pricePerUnit: 600, baseMarginPerUnit: 350, marginNowPerUnit: 350 });
const cheek = eco({ brand: "C", category: "filler", subcategories: ["Mid-face"], pricePerUnit: 600, baseMarginPerUnit: 300, marginNowPerUnit: 300 });
check(
  "fillers group by sub-category (Lips has 2, Mid-face has 1 → filtered)",
  groupBrandEconomics([lipA, lipB, cheek]).map((g) => g.key),
  ["filler:Lips"],
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll switch-math checks passed.");
