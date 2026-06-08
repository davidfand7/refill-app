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
  type FeeMode,
} from "@/lib/billing-metrics";

type Sb = SupabaseClient<Database>;

export type EffectiveFeeConfig = {
  monthlyBaseUsd: number;
  rules: Map<string, { mode: FeeMode; amount: number; enabled: boolean }>;
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
};

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
    sb.from("billing_fee_rules").select("metric_key, mode, amount, enabled").eq("tenant_id", tenantId),
  ]);
  const byMetric = new Map<string, { mode: FeeMode; amount: number; enabled: boolean }>();
  for (const r of ruleRows ?? []) {
    byMetric.set(r.metric_key, {
      mode: (r.mode as FeeMode) ?? DEFAULT_FEE_MODE,
      amount: Number(r.amount),
      enabled: r.enabled,
    });
  }
  for (const m of BILLABLE_METRICS) {
    if (!byMetric.has(m.key)) {
      byMetric.set(m.key, { mode: DEFAULT_FEE_MODE, amount: m.defaultAmount, enabled: true });
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

/** Total due for a period given config + per-metric aggregation. */
export function computeInvoiceTotal(
  cfg: EffectiveFeeConfig,
  agg: Map<string, { count: number; revenueUsd: number }>,
): { totalDueUsd: number; lines: LedgerLine[] } {
  const lines: LedgerLine[] = [];
  let total = cfg.monthlyBaseUsd;
  for (const m of BILLABLE_METRICS) {
    const rule = cfg.rules.get(m.key)!;
    const a = agg.get(m.key) ?? { count: 0, revenueUsd: 0 };
    const revenueUsd = +a.revenueUsd.toFixed(2);
    const charge = rule.enabled ? priceMetric(rule.mode, rule.amount, a.count, revenueUsd) : 0;
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
    });
  }
  return { totalDueUsd: +total.toFixed(2), lines };
}
