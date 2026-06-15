/**
 * Billing fee-rules CORE — the shared math, with no dependency on the
 * billing endpoints or tenant resolution. Lives in its own module so both
 * refill-billing.ts (the invoice cron) and refill-fee-rules.functions.ts
 * (the admin endpoints) can import it WITHOUT a circular dependency.
 *
 * Invoice = monthly_base + Σ over metrics ( fee × wins ).
 *
 * Established 2026-06-07 (P0 ship #2).
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import { fetchAllRows } from "@/server/paginate";
import {
  BILLABLE_METRICS,
  DEFAULT_FEE_MODE,
  priceMetric,
  type BillableMetricKey,
  type CapPeriod,
  type FeeMode,
} from "@/lib/billing-metrics";

type Sb = SupabaseClient<Database>;

/** One metric's effective billing rule, cap included. capUsd null = uncapped. */
export type FeeRule = {
  mode: FeeMode;
  amount: number;
  enabled: boolean;
  capUsd: number | null;
  capPeriod: CapPeriod | null;
};

export type EffectiveFeeConfig = {
  monthlyBaseUsd: number;
  rules: Map<string, FeeRule>;
};

export type LedgerLine = {
  metricKey: BillableMetricKey;
  label: string;
  mode: FeeMode;
  amount: number;
  count: number;
  revenueUsd: number;
  charge: number;
  enabled: boolean;
  /** Per-feature cap in effect for this period (null = uncapped). */
  capUsd: number | null;
  capPeriod: CapPeriod | null;
  /** True when the cap actually bit — the raw charge was reduced. */
  capped: boolean;
};

/**
 * Apply a per-feature cap to a metric's raw period charge.
 *
 * A cap bounds the metric's total for the period. An ANNUAL cap spans months,
 * so the caller passes how much was ALREADY charged for this metric earlier in
 * the same calendar year (priorChargedThisPeriodUsd); a MONTHLY cap never looks
 * across periods (one invoice per month) so prior-charged is ignored.
 *
 * remaining = max(0, cap − priorCharged); charge = min(rawCharge, remaining).
 * Returns the capped charge, whether the cap bit, and the headroom that was
 * available before this period's charge (for the UI's live preview).
 */
export function applyCap(
  rawCharge: number,
  rule: Pick<FeeRule, "capUsd" | "capPeriod">,
  priorChargedThisPeriodUsd: number,
): { charge: number; capped: boolean; capRemainingBefore: number | null } {
  if (rule.capUsd == null || rule.capUsd < 0) {
    return { charge: rawCharge, capped: false, capRemainingBefore: null };
  }
  const prior = rule.capPeriod === "annual" ? Math.max(0, priorChargedThisPeriodUsd) : 0;
  const remaining = Math.max(0, +(rule.capUsd - prior).toFixed(2));
  const charge = +Math.min(rawCharge, remaining).toFixed(2);
  return { charge, capped: charge < +rawCharge.toFixed(2), capRemainingBefore: remaining };
}

/**
 * Read a tenant's billing config + fee rules, filling defaults in-memory for
 * any metric without a persisted rule — so a tenant that never opened the
 * admin panel still bills at the "$0 base + $5/win" default.
 */
export async function loadEffectiveFeeConfig(
  sb: Sb,
  tenantId: string,
): Promise<EffectiveFeeConfig> {
  const [{ data: cfg }, { data: ruleRows }] = await Promise.all([
    sb.from("billing_config").select("monthly_base_usd").eq("tenant_id", tenantId).maybeSingle(),
    sb
      .from("billing_fee_rules")
      .select("metric_key, mode, amount, enabled, cap_usd, cap_period")
      .eq("tenant_id", tenantId),
  ]);
  const byMetric = new Map<string, FeeRule>();
  for (const r of ruleRows ?? []) {
    byMetric.set(r.metric_key, {
      mode: (r.mode as FeeMode) ?? DEFAULT_FEE_MODE,
      amount: Number(r.amount),
      enabled: r.enabled,
      capUsd: r.cap_usd == null ? null : Number(r.cap_usd),
      capPeriod: (r.cap_period as CapPeriod | null) ?? null,
    });
  }
  for (const m of BILLABLE_METRICS) {
    if (!byMetric.has(m.key)) {
      byMetric.set(m.key, {
        mode: DEFAULT_FEE_MODE,
        amount: m.defaultAmount,
        enabled: true,
        capUsd: null,
        capPeriod: null,
      });
    }
  }
  return {
    monthlyBaseUsd: cfg ? Number(cfg.monthly_base_usd) : 0,
    rules: byMetric,
  };
}

/**
 * Verified wins per metric_key in a period. Paginated — billing must read the
 * COMPLETE set, never a 1,000-row slice. emma_recovery_events rides user_id
 * (predates the tenant model), so we fan out via tenant_memberships.
 */
export async function aggregateMetricsForTenant(args: {
  sb: Sb;
  tenantId: string;
  periodStart: Date;
  periodEnd: Date;
}): Promise<Map<string, { count: number; revenueUsd: number }>> {
  const { sb, tenantId, periodStart, periodEnd } = args;
  const { data: memberships } = await sb
    .from("tenant_memberships")
    .select("user_id")
    .eq("tenant_id", tenantId);
  const userIds = (memberships ?? []).map((m) => m.user_id);
  const out = new Map<string, { count: number; revenueUsd: number }>();
  if (userIds.length === 0) return out;

  const rows = await fetchAllRows<{ metric_key: string; attributed_revenue_usd: number | null }>(
    (from, to) =>
      sb
        .from("emma_recovery_events")
        .select("id, metric_key, attributed_revenue_usd")
        .in("user_id", userIds)
        .gte("verified_at", periodStart.toISOString())
        .lt("verified_at", periodEnd.toISOString())
        .not("verified_at", "is", null)
        .order("id", { ascending: true })
        .range(from, to),
  );
  for (const r of rows) {
    const key = r.metric_key || "slot_fill";
    const acc = out.get(key) ?? { count: 0, revenueUsd: 0 };
    acc.count += 1;
    acc.revenueUsd += Number(r.attributed_revenue_usd ?? 0);
    out.set(key, acc);
  }
  return out;
}

/**
 * Total due for a period given config + per-metric aggregation.
 *
 * opts.priorChargedThisYearByMetric — for ANNUAL caps only: how much each
 * metric has already been charged earlier this calendar year (summed from
 * closed invoices). Omitted/0 → an annual cap behaves like the headroom is
 * the full cap (correct for the first billed month of the year). Monthly caps
 * never read this. Without any caps configured, the result is byte-identical
 * to the pre-v2.45.0 math.
 */
export function computeInvoiceTotal(
  cfg: EffectiveFeeConfig,
  agg: Map<string, { count: number; revenueUsd: number }>,
  opts?: { priorChargedThisYearByMetric?: Map<string, number> },
): { totalDueUsd: number; lines: LedgerLine[] } {
  const lines: LedgerLine[] = [];
  let total = cfg.monthlyBaseUsd;
  for (const m of BILLABLE_METRICS) {
    const rule = cfg.rules.get(m.key)!;
    const a = agg.get(m.key) ?? { count: 0, revenueUsd: 0 };
    const revenueUsd = +a.revenueUsd.toFixed(2);
    const rawCharge = rule.enabled ? priceMetric(rule.mode, rule.amount, a.count, revenueUsd) : 0;
    const priorYtd = opts?.priorChargedThisYearByMetric?.get(m.key) ?? 0;
    const { charge, capped } = applyCap(rawCharge, rule, priorYtd);
    total += charge;
    lines.push({
      metricKey: m.key,
      label: m.label,
      mode: rule.mode,
      amount: rule.amount,
      count: a.count,
      revenueUsd,
      charge,
      enabled: rule.enabled,
      capUsd: rule.capUsd,
      capPeriod: rule.capPeriod,
      capped,
    });
  }
  return { totalDueUsd: +total.toFixed(2), lines };
}

/**
 * Sum, per metric, how much has ALREADY been charged this calendar year in
 * CLOSED invoices strictly before `periodStart`. Drives annual-cap headroom
 * without a new ledger table — each invoice already persists its per-metric
 * `charge` in fee_breakdown. Strictly-before keeps it idempotent: regenerating
 * the same period never counts itself.
 */
export async function loadPriorChargedThisYear(
  sb: Sb,
  tenantId: string,
  periodStart: Date,
): Promise<Map<string, number>> {
  const yearStart = new Date(Date.UTC(periodStart.getUTCFullYear(), 0, 1));
  const out = new Map<string, number>();
  const { data } = await sb
    .from("refill_invoices")
    .select("fee_breakdown")
    .eq("tenant_id", tenantId)
    .gte("period_start", yearStart.toISOString())
    .lt("period_start", periodStart.toISOString());
  for (const row of data ?? []) {
    const lines = (row.fee_breakdown ?? []) as Array<{ metricKey?: string; charge?: number }>;
    if (!Array.isArray(lines)) continue;
    for (const ln of lines) {
      if (!ln?.metricKey) continue;
      out.set(ln.metricKey, +((out.get(ln.metricKey) ?? 0) + Number(ln.charge ?? 0)).toFixed(2));
    }
  }
  return out;
}
