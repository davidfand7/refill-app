/**
 * Runnable spec for src/lib/program-intel.ts — the Phase 2 brain.
 *   bun run scripts/verify-program-intel.ts
 *
 * The repo has no test runner (it verifies via tsc + live fresh-walks), so this
 * is a self-checking script grounded in the REAL ASPIRE/Rejuv dashboard numbers
 * from the 2026-06-11 screenshots. It proves three things solo, no portal/DB:
 *   1. moves are HONEST — an achieved rebate emits no "you're short" move;
 *   2. moves derive correctly when a rebate is in progress;
 *   3. the diff catches a RULE change (a minimum moved) + a price change.
 */

import {
  diffSnapshots,
  deriveRebateMoves,
  moveHeadline,
  changeHeadline,
  flywheelHeadline,
  type ProgramSnapshot,
  type FlywheelMove,
} from "../src/lib/program-intel";

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.log(`  ✗ ${label}${detail !== undefined ? `  →  ${JSON.stringify(detail)}` : ""}`);
  }
}

// ── Tier ladder (Membership Levels screenshot) ──────────────────────────────
const TIERS = [
  { name: "Member", minPoints: 0, maxPoints: 249 },
  { name: "Insider", minPoints: 250, maxPoints: 649 },
  { name: "Director", minPoints: 650, maxPoints: 1499 },
  { name: "Executive", minPoints: 1500, maxPoints: 2999 },
  { name: "President", minPoints: 3000, maxPoints: 5999 },
  { name: "Top 1%", minPoints: 6000, maxPoints: null },
];

// ── REAL Rejuv Q2 snapshot (Brand Adoption ACHIEVED, Rise NOT eligible) ──────
const rejuvQ2: ProgramSnapshot = {
  manufacturer: "galderma",
  pulledAt: "2026-06-11T00:00:00.000Z",
  currentTier: "Director",
  pointsCurrent: 250,
  pointsToNextTier: 1500 - 250,
  tiers: TIERS,
  rebates: [
    {
      key: "brand_adoption",
      label: "Brand Adoption Rebate",
      rebatePct: 3,
      status: "achieved", // dashboard says "3/3 BRANDS COMPLETED · 3% ACHIEVED"
      note: null,
      requirements: [
        { product: "dysport", label: "Dysport", required: 20, current: 20, unit: "vials" },
        { product: "restylane", label: "Restylane Lyft", required: 10, current: 20, unit: "syringes" },
        { product: "restylane", label: "Restylane Defyne", required: 10, current: 20, unit: "syringes" },
        { product: "restylane", label: "Restylane Refyne", required: 10, current: 0, unit: "syringes" },
        { product: "sculptra", label: "Sculptra", required: 8, current: 0, unit: "kits" },
      ],
    },
    {
      key: "rise",
      label: "Rise Rebate",
      rebatePct: 2,
      status: "not_eligible", // "$0 invoice in a baseline quarter → not eligible"
      note: "A $0 invoice in one of your baseline quarters makes you ineligible this quarter.",
      requirements: [],
    },
  ],
  pricing: [
    { product: "dysport", label: "Dysport 300IU", unitPriceUsd: 561.36 },
    { product: "sculptra", label: "Sculptra", unitPriceUsd: 780.52 },
  ],
};

console.log("\n1) Honesty — achieved + not_eligible rebates emit NO buy-moves:");
const realMoves = deriveRebateMoves(rejuvQ2);
check("no moves on the real Rejuv snapshot", realMoves.length === 0, realMoves);

// ── Synthetic: Brand Adoption IN PROGRESS (Dysport 14/20, Sculptra 0/8) ──────
const synthInProgress: ProgramSnapshot = {
  ...rejuvQ2,
  rebates: [
    {
      key: "brand_adoption",
      label: "Brand Adoption Rebate",
      rebatePct: 3,
      status: "in_progress",
      note: null,
      requirements: [
        { product: "dysport", label: "Dysport", required: 20, current: 14, unit: "vials" },
        { product: "sculptra", label: "Sculptra", required: 8, current: 0, unit: "kits" },
        { product: "restylane", label: "Restylane Lyft", required: 10, current: 10, unit: "syringes" }, // met → no move
      ],
    },
  ],
};

console.log("\n2) Moves derive + sort closest-gap-first when in progress:");
const moves = deriveRebateMoves(synthInProgress);
check("two moves (the met requirement is skipped)", moves.length === 2, moves.map((m) => m.productLabel));
check("Dysport first (gap 6 < Sculptra gap 8)", moves[0]?.product === "dysport", moves[0]);
check("Dysport short by 6", moves[0]?.unitsShort === 6, moves[0]?.unitsShort);
check("Sculptra short by 8", moves[1]?.unitsShort === 8, moves[1]?.unitsShort);
console.log(`     headline → ${moveHeadline(moves[0]!)}`);

console.log("\n3) Flywheel join (caller supplies the cohort count):");
const fw: FlywheelMove = { ...moves[0]!, lapsedInCohort: 14 };
const fwLine = flywheelHeadline(fw);
check("flywheel line names the gap + the lapsed cohort", /6 Dysport/.test(fwLine) && /14 lapsed/.test(fwLine), fwLine);
console.log(`     headline → ${fwLine}`);

// ── Diff: Q3 raises Sculptra min 8→10 and drops Dysport price ────────────────
const rejuvQ3: ProgramSnapshot = {
  ...rejuvQ2,
  pulledAt: "2026-09-15T00:00:00.000Z",
  rebates: rejuvQ2.rebates.map((r) =>
    r.key !== "brand_adoption"
      ? r
      : {
          ...r,
          requirements: r.requirements.map((q) =>
            q.label === "Sculptra" ? { ...q, required: 10 } : q,
          ),
        },
  ),
  pricing: [
    { product: "dysport", label: "Dysport 300IU", unitPriceUsd: 549.0 }, // changed
    { product: "sculptra", label: "Sculptra", unitPriceUsd: 780.52 }, // unchanged
  ],
};

console.log("\n4) Diff catches the RULE change + price change (the moat feature):");
const changes = diffSnapshots(rejuvQ2, rejuvQ3);
const reqChange = changes.find((c) => c.kind === "requirement_threshold_changed");
const priceChange = changes.find((c) => c.kind === "price_changed");
check("exactly two changes detected (no noise from unchanged progress)", changes.length === 2, changes.map((c) => c.kind));
check("Sculptra minimum 8 → 10 detected", !!reqChange, reqChange);
check("Dysport price change detected", !!priceChange, priceChange);
if (reqChange) console.log(`     headline → ${changeHeadline(reqChange)}`);
if (priceChange) console.log(`     headline → ${changeHeadline(priceChange)}`);

console.log(
  failures === 0
    ? "\n✅ program-intel: all checks passed.\n"
    : `\n❌ program-intel: ${failures} check(s) failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
