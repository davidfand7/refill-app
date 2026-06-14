/**
 * Billable-metric taxonomy + pricing math (Patient-Profitability OS · P0).
 *
 * One formula bills the whole product:
 *
 *     Invoice = monthly_base + Σ over metrics ( fee × wins )
 *
 * Each metric has a per-tenant rule: mode flat ($X per win) or percent
 * (X% of the win's attributed revenue), and an on/off switch. The default
 * config — base $0, every metric flat $5, enabled — IS the marketed
 * "Free + $5 per win." Pure (no I/O) so the server and the admin UI share
 * one source of truth.
 *
 * Established 2026-06-07 (P0 ship #2 — billing config + ledger).
 */

export type BillableMetricKey =
  | "slot_fill"
  | "recall_booking"
  | "cross_sell_addon"
  | "reschedule_booking"
  | "lead_conversion";

export type FeeMode = "flat" | "percent";

export type BillableMetricDef = {
  key: BillableMetricKey;
  label: string;
  description: string;
  /** Default fee when a tenant's rule is first seeded. */
  defaultAmount: number;
  /**
   * Whether this metric actually produces billable events TODAY. Only
   * slot_fill (Recover) is wired now; the rest light up as Recall /
   * Cross-Sell / Acquire ship. Configurable now so the model is future-ready;
   * the UI flags the not-yet-live ones so the owner isn't misled.
   */
  live: boolean;
};

export const BILLABLE_METRICS: BillableMetricDef[] = [
  {
    key: "slot_fill",
    label: "Filled slot",
    description: "A cancelled or no-show slot filled by a different patient (Recover).",
    defaultAmount: 5,
    live: true,
  },
  {
    key: "recall_booking",
    label: "Recall booking",
    description: "A lapsed or expiring-reward patient books from our outreach (Recall).",
    defaultAmount: 5,
    // Live as of v2.12.0 — the Recall engine is fully shipped (lapsed/expiring
    // targeting, iMessage dispatch, recordRecallBookingFn writing a
    // metric_key='recall_booking' recovery event per booking). The billing math
    // already charged it (computeInvoiceTotal ignores `live` — it bills on the
    // enabled toggle × verified wins), so this flag was the display gate: a
    // "Coming soon" badge on an already-armed meter, which misled in the unsafe
    // direction (looked free while wired to bill). Flipped to match reality.
    live: true,
  },
  {
    key: "cross_sell_addon",
    label: "Cross-sell add-on",
    description: "An add-on taken from a surfaced promo step at booking (Cross-Sell).",
    defaultAmount: 5,
    // Live as of v2.4.8 — the Cross-Sell offer engine (manufacturer + spa
    // offers, both booking paths, cohort targeting + push) is fully shipped.
    live: true,
  },
  {
    key: "reschedule_booking",
    label: "Reschedule booking",
    description:
      "A patient who cancelled or no-showed rebooks after a Reschedule Reminders nudge.",
    defaultAmount: 5,
    // Live as of v2.37.0 — Reschedule Reminders drafts the nudge and the booking
    // paths credit a reschedule_booking win when a recently-nudged patient
    // rebooks (verified-only on reconcile, like cross-sell / recall).
    live: true,
  },
  {
    key: "lead_conversion",
    label: "Lead conversion",
    description: "An inbound lead booked through speed-to-lead (Acquire).",
    defaultAmount: 5,
    live: false,
  },
];

export const DEFAULT_FEE_MODE: FeeMode = "flat";

export function metricLabel(key: string): string {
  return BILLABLE_METRICS.find((m) => m.key === key)?.label ?? key;
}

/**
 * Price one metric's wins. flat → amount × count; percent → amount (a
 * fraction, 0.12 = 12%) × the metric's attributed revenue.
 */
export function priceMetric(
  mode: FeeMode | string,
  amount: number,
  count: number,
  revenueUsd: number,
): number {
  if (mode === "percent") return +(amount * revenueUsd).toFixed(2);
  return +(amount * count).toFixed(2);
}

/** Human-readable rate, e.g. "$5 / win" or "12% of revenue". */
export function describeRate(mode: FeeMode | string, amount: number): string {
  if (mode === "percent") return `${+(amount * 100).toFixed(2)}% of revenue`;
  return `$${amount.toFixed(2)} / win`;
}
