/**
 * Canonical Refill Rep Platform economics — single source of truth.
 *
 * Per [[feedback-math-audit-subagent]] (hard rule 2026-05-22): every
 * rate-shaped number that appears in rep-facing OR customer-facing output
 * MUST resolve to a constant exported from this file. The companion
 * `scripts/audit-math.ts` AST scanner blocks pushes that leak literal
 * rate values anywhere else in the codebase.
 *
 * The split (per the architecture lock + Q2 v408 product decision):
 *   12¢ of every recovered dollar flows out as commission/take.
 *   Within that 12¢:
 *     8¢ Refill platform
 *     3¢ Tier-1 direct  (rep who introduced the spa)
 *     1¢ Tier-2 cascade (rep who recruited the Tier-1 rep)
 *     0¢ Tier-3+        (audit-only: row recorded, no payout; reversible)
 *
 * Lifetime, no decay. Hard cap at Tier-2 paid for FTC compliance optics.
 *
 * Why a runtime invariant check below: if anyone ever forks REFILL_TAKE_RATE
 * + DIRECT_COMMISSION_RATE + CASCADE_COMMISSION_RATE so they don't sum to
 * TOTAL_TAKE_RATE, the import fails at module load — fails noisily, not
 * silently with subtly-wrong numbers shipping to Kelly.
 */

// ─── Commission split (cascade tiers) ────────────────────────────────────

export const TOTAL_TAKE_RATE = 0.12;
export const REFILL_TAKE_RATE = 0.08;
export const DIRECT_COMMISSION_RATE = 0.03;
export const CASCADE_COMMISSION_RATE = 0.01;
export const TIER_3_AUDIT_ONLY_RATE = 0;

// ─── Refill billing plans (Emma + Refill tenant pricing) ─────────────────
// Same shape across products. Pulled here so the audit catches drift across
// emma-billing.functions.ts ↔ refill-billing.ts ↔ marketing copy.

export const REFILL_PLAN_STARTER_REV_SHARE = 0.12;
export const REFILL_PLAN_STARTER_MONTHLY_USD = 0;
export const REFILL_PLAN_PREDICTABLE_REV_SHARE = 0;
export const REFILL_PLAN_PREDICTABLE_MONTHLY_USD = 299;
export const REFILL_PLAN_PRO_REV_SHARE = 0.08;
export const REFILL_PLAN_PRO_MONTHLY_USD = 99;

// ─── Invariant: the cascade split sums to TOTAL_TAKE_RATE ────────────────

const _splitSum =
  REFILL_TAKE_RATE + DIRECT_COMMISSION_RATE + CASCADE_COMMISSION_RATE;
if (Math.abs(_splitSum - TOTAL_TAKE_RATE) > 1e-9) {
  throw new Error(
    `[rep-economics] Cascade split invariant violated: ` +
      `${REFILL_TAKE_RATE} + ${DIRECT_COMMISSION_RATE} + ${CASCADE_COMMISSION_RATE} = ${_splitSum}, ` +
      `expected ${TOTAL_TAKE_RATE}. Fix the constants in src/lib/rep-economics.ts.`,
  );
}

// ─── Formatters ──────────────────────────────────────────────────────────

/**
 * Render a decimal rate as a percent string. `0.03` → `"3%"`.
 * Whole percents drop the decimal; fractional percents render with 2 places.
 */
export function formatRate(rate: number): string {
  const pct = rate * 100;
  return Number.isInteger(pct) ? `${pct}%` : `${pct.toFixed(2)}%`;
}

/**
 * Render a decimal rate as a cents string for the per-dollar diagram.
 * `0.03` → `"3¢"`. Always whole cents (split values guarantee this today).
 */
export function formatRateCents(rate: number): string {
  return `${Math.round(rate * 100)}¢`;
}

/**
 * Render a USD number as `$1,234` with no decimal. Consolidates the half-
 * dozen `formatUsd` helpers scattered across the rep surfaces.
 */
export function formatUsd0(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

/**
 * Soft-round-down to thousands for headline framing. `11500` → `"11K+"`.
 * Used by the economics page narrative ("you clear $11K+/month").
 */
export function formatThousandsCeil(n: number): string {
  return `${Math.floor(n / 1000)}K+`;
}

// ─── Scenario math (worked-example table + audit reconciler) ─────────────

export interface RecoveryBreakdown {
  recoveredUsd: number;
  refillUsd: number;
  directCommissionUsd: number;
  cascadeCommissionUsd: number;
}

/**
 * Direct scenario: one rep introduces N spas, earns 3% on each. No cascade.
 * Used for "1 spa Kelly introduced" / "10 spas Kelly introduced" rows.
 */
export function computeDirectScenario(recoveredUsd: number): RecoveryBreakdown {
  return {
    recoveredUsd,
    refillUsd: recoveredUsd * REFILL_TAKE_RATE,
    directCommissionUsd: recoveredUsd * DIRECT_COMMISSION_RATE,
    cascadeCommissionUsd: 0,
  };
}

/**
 * Cascade scenario: a sub-rep introduces a spa, the recruiting rep earns
 * 1% upstream (sub-rep still earns 3% themselves). Used for the
 * "1 spa your sub-rep introduced" row.
 */
export function computeCascadeScenario(
  recoveredUsd: number,
): RecoveryBreakdown {
  return {
    recoveredUsd,
    refillUsd: recoveredUsd * REFILL_TAKE_RATE,
    // The sub-rep's 3% is still earned; the recruiting rep doesn't see it
    // — it goes to the sub-rep. Returned here for completeness so the
    // worked-example table can render the "(sub-rep gets $X)" caption.
    directCommissionUsd: recoveredUsd * DIRECT_COMMISSION_RATE,
    cascadeCommissionUsd: recoveredUsd * CASCADE_COMMISSION_RATE,
  };
}

/**
 * Mixed scenario: rep has N direct spas AND M cascade spas (through sub-reps).
 * Used for the highlight row "60 direct + 5 sub-reps each w/ 10 spas."
 * Returns the recruiting rep's slice (direct commission on direct spas +
 * cascade commission on sub-rep spas) plus Refill's total take across both.
 */
export interface MixedScenarioInput {
  directRecoveredUsd: number;
  cascadeRecoveredUsd: number;
}

export interface MixedScenarioOutput {
  totalRecoveredUsd: number;
  refillUsd: number;
  myDirectCommissionUsd: number;
  myCascadeCommissionUsd: number;
  myTotalCommissionUsd: number;
}

export function computeMixedScenario(
  input: MixedScenarioInput,
): MixedScenarioOutput {
  const totalRecoveredUsd = input.directRecoveredUsd + input.cascadeRecoveredUsd;
  const refillUsd = totalRecoveredUsd * REFILL_TAKE_RATE;
  const myDirectCommissionUsd = input.directRecoveredUsd * DIRECT_COMMISSION_RATE;
  const myCascadeCommissionUsd =
    input.cascadeRecoveredUsd * CASCADE_COMMISSION_RATE;
  const myTotalCommissionUsd = myDirectCommissionUsd + myCascadeCommissionUsd;
  return {
    totalRecoveredUsd,
    refillUsd,
    myDirectCommissionUsd,
    myCascadeCommissionUsd,
    myTotalCommissionUsd,
  };
}
