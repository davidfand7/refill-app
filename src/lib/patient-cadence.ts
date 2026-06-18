/**
 * Patient cadence rules — Patient Architecture P3.
 *
 * Maps product-kind → expected retreatment interval in days. This is the
 * heuristic that turns "she last got Jeuveau on Feb 27" into "she's two
 * weeks overdue for a touchup."
 *
 * The default windows are clinical industry conventions (~4mo toxin,
 * ~12mo HA filler, ~18mo biostimulator). They're tuned to be conservative
 * — we'd rather surface a patient a little early than skip her. The
 * design doc's deferred open question ("Cadence definition per manufacturer")
 * tracks the future per-rep / per-manufacturer override path.
 *
 * Established 2026-05-15 (Patient Architecture P3).
 */

import type { ProductKind } from "@/lib/product-manufacturer-map";

/** Days after the last purchase of this kind when a patient is "overdue." */
export type CadenceWindow = {
  /**
   * v1.31.3: Industry/clinical TYPICAL retreatment interval. This is the
   * baseline Karen / rewards programs / FDA labels target. Used as the
   * &ldquo;typical&rdquo; norm in CadenceMetrics so Refill can flag &ldquo;due for an
   * Alle-eligible Botox treatment&rdquo; even when the patient&rsquo;s personal
   * cadence has drifted.
   */
  expectedDays: number;
  /** Soft-overdue: appears in the Today card. */
  overdueDays: number;
  /**
   * Hard-overdue: surfaces as "lapsed" — included even when the toggle is
   * "only recent overdue" off. Useful in Phase 5+ for "reactivate" promos.
   */
  lapsedDays: number;
};

/**
 * The window doesn't have a clean answer for `payment` / `discount` / `note`
 * lines — those don't represent a clinical visit. Same with `retail`
 * (a patient buying a $40 sunscreen tells you nothing about toxin cadence).
 * Only kinds with a return-visit signal get an entry here.
 */
export const KIND_CADENCE: Partial<Record<ProductKind, CadenceWindow>> = {
  toxin: { expectedDays: 90, overdueDays: 120, lapsedDays: 240 }, // 3mo expected / 4mo soft / 8mo lapsed
  filler: { expectedDays: 270, overdueDays: 365, lapsedDays: 730 }, // 9mo expected (6-24mo range) / 12mo soft / 24mo lapsed
  biostimulator: { expectedDays: 540, overdueDays: 540, lapsedDays: 1095 }, // 18mo / 18mo soft / 36mo lapsed
  // Device + service + retail intentionally absent — too treatment-specific
  // to bake into a single number. Defer until a real customer asks.
};

/**
 * Days between today (UTC) and an ISO date string. Returns null if the
 * input doesn't parse. Floors to whole days — same calendar day is 0.
 */
export function daysSince(isoDate: string | null): number | null {
  if (!isoDate) return null;
  const [y, m, d] = isoDate.split("-").map(Number);
  if (!y || !m || !d) return null;
  const then = Date.UTC(y, m - 1, d);
  const now = Date.now();
  return Math.floor((now - then) / 86_400_000);
}

/**
 * Compute the overdue status for a patient's primary-kind cadence given
 * the days since their last visit. Returns null when there's no policy
 * for that kind, no last-visit date, or the patient is still within
 * window.
 */
export type OverdueStatus = {
  /** The kind whose cadence triggered the overdue. */
  kind: ProductKind;
  /** Whole days past the soft window. Always > 0. */
  daysOverdue: number;
  /** True when lapsedDays threshold is crossed too. */
  isLapsed: boolean;
};

export function computeOverdue(
  kind: ProductKind | null | undefined,
  daysSinceLastVisit: number | null,
): OverdueStatus | null {
  if (!kind) return null;
  if (daysSinceLastVisit === null) return null;
  const win = KIND_CADENCE[kind];
  if (!win) return null;
  if (daysSinceLastVisit <= win.overdueDays) return null;
  return {
    kind,
    daysOverdue: daysSinceLastVisit - win.overdueDays,
    isLapsed: daysSinceLastVisit > win.lapsedDays,
  };
}
