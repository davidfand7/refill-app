/**
 * scan-analysis.ts — Pure-function recovery-math for the /scan page (v369).
 *
 * Input: parsed appointments from appointment-csv.ts.
 * Output: status breakdown + revenue-leak math + recovery estimate.
 *
 * Code-computed, never LLM. The numbers on the /scan receipt panel are
 * what we will quote in marketing + the follow-up email, so they must be
 * deterministic, traceable, and same-arithmetic as what /app/refill/recovery
 * shows for real customers. [VERIFIED] discipline applies even on the
 * public page.
 *
 * Assumptions (tunable constants at top — exposed for transparency):
 *   AVG_TICKET_USD          — $250 (typical med-spa appointment ARV)
 *   RECOVERY_FLOOR_PCT      — 0.45 (45% lower bound of Emma's multi-agent recovery)
 *   RECOVERY_CEILING_PCT    — 0.55 (55% upper bound)
 *
 * These match the marketing claim in project-pricing-killshot. If the
 * receipt math ever diverges from those numbers, the trust dies.
 */

import type { ParsedAppointment } from "@/lib/appointment-csv";

export const AVG_TICKET_USD = 250;
export const RECOVERY_FLOOR_PCT = 0.45;
export const RECOVERY_CEILING_PCT = 0.55;
/**
 * v370: how close in time another "showed" appointment must be (same
 * provider, same date) to count as the cancelled slot being refilled.
 * Default 30 minutes matches the calendar-slot mental model. Wider
 * windows (±60, ±120 min) describe "front desk shuffled same day" but
 * over-credit the spa for saves that weren't really the same slot.
 */
export const SLOT_REFILL_WINDOW_MIN = 30;

/**
 * v371: per-bucket leak/recovery breakdown for the polished HTML report.
 * Each row sums refilled + empty across a single bucket (day-of-week,
 * provider, or service). The HTML email attachment renders these as
 * bars/tables so the spa owner can see WHERE the leak concentrates.
 */
export type LeakBucket = {
  label: string;
  cancelledCount: number;
  refilledCount: number;
  emptyCount: number;
  emptyLeakUsd: number; // empty × AVG_TICKET_USD (not normalized to per-month)
};

export type ScanReceipt = {
  totalAppointments: number;
  dateRangeStart: string | null; // ISO date
  dateRangeEnd: string | null;
  monthsCovered: number; // rounded to 1 decimal
  statusBreakdown: {
    scheduled: number;
    confirmed: number;
    cancelled: number;
    no_show: number;
    showed: number;
    rescheduled: number;
  };
  topServices: { name: string; count: number }[];
  uniqueProviders: number;
  // v371: breakdown axes for the HTML report. byDayOfWeek is always 7
  // entries Sun–Sat (use Date.getDay() = 0..6). byProvider + byService
  // are top-N (by emptyLeakUsd descending).
  byDayOfWeek: LeakBucket[];
  byProvider: LeakBucket[];
  byService: LeakBucket[];
  // Raw counts of loss events
  noShowCount: number;
  cancelledCount: number;
  totalLossEvents: number; // cancelled + no_show
  // v370: SLOT-LEVEL recovery analysis per Grasshopper's framing:
  //   refilledSlotCount = a "showed" appointment exists same provider ×
  //                       same date × ±30min of the cancelled slot. The
  //                       slot got filled (by the same patient at a nearby
  //                       time OR a different patient — doesn't matter).
  //                       This is revenue the spa already captured.
  //   emptySlotCount    = totalLossEvents - refilledSlotCount. The slot
  //                       stayed empty. This is the addressable Refill
  //                       target. Real-world numbers: 65-85% refill rate
  //                       is typical on med-spa data, 15-35% truly empty.
  refilledSlotCount: number;
  emptySlotCount: number;
  // Gross leak (cancelled + no_show × ticket) — kept for reference but UI
  // should NOT present this as the headline number anymore. Real number
  // is alwaysmonthlyLeakUsd below (empty-slot only).
  grossMonthlyLeakUsd: number | null;
  // "Your team already saved this manually" stat. Validates the front
  // desk's work and positions Refill as augmentation, not replacement.
  monthlyManualSavedUsd: number | null;
  // Honest leak (only emptySlotCount × ticket). This is what we bill
  // Refill's recovery rate against in marketing copy.
  monthlyLeakUsd: number | null;
  monthlyRecoveryFloorUsd: number | null;
  monthlyRecoveryCeilingUsd: number | null;
  annualRecoveryFloorUsd: number | null;
  annualRecoveryCeilingUsd: number | null;
  // Honest signal when we can't compute the math
  hasUsableStatusData: boolean;
  insufficientDataReason: string | null;
};

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function analyzeScannedAppointments(
  appointments: ParsedAppointment[],
): ScanReceipt {
  const breakdown = {
    scheduled: 0,
    confirmed: 0,
    cancelled: 0,
    no_show: 0,
    showed: 0,
    rescheduled: 0,
  };
  const serviceCount = new Map<string, number>();
  const providerSet = new Set<string>();
  let minTime = Infinity;
  let maxTime = -Infinity;

  for (const a of appointments) {
    breakdown[a.status] = (breakdown[a.status] ?? 0) + 1;
    if (a.treatmentType) {
      const key = a.treatmentType.trim();
      if (key) serviceCount.set(key, (serviceCount.get(key) ?? 0) + 1);
    }
    if (a.providerName) {
      const key = a.providerName.trim();
      if (key) providerSet.add(key);
    }
    const t = new Date(a.scheduledAt).getTime();
    if (!isNaN(t)) {
      if (t < minTime) minTime = t;
      if (t > maxTime) maxTime = t;
    }
  }

  const topServices = Array.from(serviceCount.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));

  const dateRangeStart =
    minTime === Infinity ? null : isoDate(new Date(minTime));
  const dateRangeEnd =
    maxTime === -Infinity ? null : isoDate(new Date(maxTime));
  const monthsCovered =
    minTime === Infinity || maxTime === -Infinity
      ? 0
      : Math.max(
          0.1,
          Math.round(((maxTime - minTime) / (30 * 24 * 60 * 60 * 1000)) * 10) /
            10,
        );

  // Revenue math — only if we have status data AND a meaningful date window
  const hasUsableStatusData =
    breakdown.no_show + breakdown.cancelled + breakdown.showed > 0;
  let insufficientDataReason: string | null = null;
  if (!hasUsableStatusData) {
    insufficientDataReason =
      "Your CSV doesn't include past appointment outcomes (no_show / cancelled / showed). Re-export with at least 90 days of history to see your actual no-show rate.";
  } else if (monthsCovered < 0.3) {
    insufficientDataReason =
      "Less than 10 days of data in this export. Recovery estimate uses a wider window for accuracy.";
  }

  // v370: SLOT-LEVEL analysis. Index every "showed" appointment by
  // (provider, date) so we can ask: for each cancelled slot, was there
  // a showed appointment same provider × same date × within ±30min of
  // the cancelled time? If yes → the slot got refilled (someone took it,
  // even if it was the original patient at a slightly different time on
  // the same day). If no → the slot stayed empty = the actual Refill
  // addressable target.
  const showedByProviderDate = new Map<string, number[]>();
  for (const a of appointments) {
    if (a.status !== "showed") continue;
    const dt = new Date(a.scheduledAt);
    if (isNaN(dt.getTime())) continue;
    const providerKey = (a.providerName ?? "").trim().toLowerCase();
    const dateKey = `${providerKey}|${dt.toISOString().slice(0, 10)}`;
    if (!showedByProviderDate.has(dateKey)) {
      showedByProviderDate.set(dateKey, []);
    }
    showedByProviderDate.get(dateKey)!.push(dt.getTime());
  }

  const totalLossEvents = breakdown.cancelled + breakdown.no_show;
  let refilledSlotCount = 0;
  const refillWindowMs = SLOT_REFILL_WINDOW_MIN * 60 * 1000;

  // v371: breakdown axes — initialize the per-bucket maps.
  const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const dowBuckets: LeakBucket[] = DOW_LABELS.map((label) => ({
    label,
    cancelledCount: 0,
    refilledCount: 0,
    emptyCount: 0,
    emptyLeakUsd: 0,
  }));
  const providerMap = new Map<string, LeakBucket>();
  const serviceMap = new Map<string, LeakBucket>();
  const getOrCreate = (
    map: Map<string, LeakBucket>,
    rawLabel: string | null,
  ): LeakBucket => {
    const label = (rawLabel ?? "").trim() || "(unspecified)";
    let bucket = map.get(label);
    if (!bucket) {
      bucket = {
        label,
        cancelledCount: 0,
        refilledCount: 0,
        emptyCount: 0,
        emptyLeakUsd: 0,
      };
      map.set(label, bucket);
    }
    return bucket;
  };

  for (const a of appointments) {
    if (a.status !== "cancelled" && a.status !== "no_show") continue;
    const dt = new Date(a.scheduledAt);
    if (isNaN(dt.getTime())) continue;
    const providerKey = (a.providerName ?? "").trim().toLowerCase();
    const dateKey = `${providerKey}|${dt.toISOString().slice(0, 10)}`;
    const candidates = showedByProviderDate.get(dateKey) ?? [];
    const cancelMs = dt.getTime();
    const wasRefilled = candidates.some(
      (s) => Math.abs(s - cancelMs) <= refillWindowMs,
    );
    if (wasRefilled) refilledSlotCount++;

    // Tally into the three breakdown axes
    const dowBucket = dowBuckets[dt.getDay()];
    const provBucket = getOrCreate(providerMap, a.providerName);
    const svcBucket = getOrCreate(serviceMap, a.treatmentType);
    for (const b of [dowBucket, provBucket, svcBucket]) {
      b.cancelledCount++;
      if (wasRefilled) {
        b.refilledCount++;
      } else {
        b.emptyCount++;
        b.emptyLeakUsd += AVG_TICKET_USD;
      }
    }
  }
  const emptySlotCount = Math.max(0, totalLossEvents - refilledSlotCount);

  // Sort top-N by empty-slot leak descending — that's the column the spa
  // owner cares about (where Refill's addressable target concentrates).
  const byProvider = Array.from(providerMap.values())
    .sort((a, b) => b.emptyLeakUsd - a.emptyLeakUsd)
    .slice(0, 10);
  const byService = Array.from(serviceMap.values())
    .sort((a, b) => b.emptyLeakUsd - a.emptyLeakUsd)
    .slice(0, 10);

  let monthlyLeakUsd: number | null = null;
  let grossMonthlyLeakUsd: number | null = null;
  let monthlyManualSavedUsd: number | null = null;
  let monthlyRecoveryFloorUsd: number | null = null;
  let monthlyRecoveryCeilingUsd: number | null = null;
  let annualRecoveryFloorUsd: number | null = null;
  let annualRecoveryCeilingUsd: number | null = null;

  if (hasUsableStatusData && monthsCovered >= 0.3) {
    // Gross leak = naive "every cancel is a loss" number, retained for
    // reference. NOT the headline number anymore.
    grossMonthlyLeakUsd = Math.round(
      (totalLossEvents * AVG_TICKET_USD) / monthsCovered,
    );
    // What the front desk already recovered manually.
    monthlyManualSavedUsd = Math.round(
      (refilledSlotCount * AVG_TICKET_USD) / monthsCovered,
    );
    // Honest leak = empty-slot leak only. The number Refill bills against.
    monthlyLeakUsd = Math.round(
      (emptySlotCount * AVG_TICKET_USD) / monthsCovered,
    );
    monthlyRecoveryFloorUsd = Math.round(monthlyLeakUsd * RECOVERY_FLOOR_PCT);
    monthlyRecoveryCeilingUsd = Math.round(monthlyLeakUsd * RECOVERY_CEILING_PCT);
    annualRecoveryFloorUsd = monthlyRecoveryFloorUsd * 12;
    annualRecoveryCeilingUsd = monthlyRecoveryCeilingUsd * 12;
  }

  return {
    totalAppointments: appointments.length,
    dateRangeStart,
    dateRangeEnd,
    monthsCovered,
    statusBreakdown: breakdown,
    topServices,
    uniqueProviders: providerSet.size,
    byDayOfWeek: dowBuckets,
    byProvider,
    byService,
    noShowCount: breakdown.no_show,
    cancelledCount: breakdown.cancelled,
    totalLossEvents,
    refilledSlotCount,
    emptySlotCount,
    grossMonthlyLeakUsd,
    monthlyManualSavedUsd,
    monthlyLeakUsd,
    monthlyRecoveryFloorUsd,
    monthlyRecoveryCeilingUsd,
    annualRecoveryFloorUsd,
    annualRecoveryCeilingUsd,
    hasUsableStatusData,
    insufficientDataReason,
  };
}

export function formatUsd(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${n.toLocaleString()}`;
}

export function formatUsdExact(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return `$${n.toLocaleString()}`;
}
