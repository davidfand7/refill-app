/**
 * Refill billing fee-rules engine — Patient-Profitability OS · P0 ship #2.
 *
 * Replaces the tiered starter/pro/predictable revenue-share model with one
 * configurable formula: Invoice = monthly_base + Σ over metrics (fee × wins).
 *
 * Public surface:
 *   getBillingSettings   — config (monthly base) + per-metric fee rules,
 *                          lazily defaulted to "$0 base + $5/win".
 *   updateBillingConfig  — set the monthly base.
 *   updateFeeRule        — set one metric's mode/amount/enabled.
 *   getBillingLedger     — the visible counterfactual ledger for the current
 *                          period: per-metric lines + recent priced wins.
 *
 * The shared math (loadEffectiveFeeConfig / aggregateMetricsForTenant /
 * computeInvoiceTotal) lives in billing-fee-core.ts so the invoice cron can
 * import it without a circular dependency.
 *
 * Established 2026-06-07.
 */

import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { resolveEffectiveUserId } from "@/server/auth-helpers";
import { getTenantIdForUser } from "@/server/refill-billing";
import {
  loadEffectiveFeeConfig,
  aggregateMetricsForTenant,
  computeInvoiceTotal,
  type LedgerLine,
} from "@/server/billing-fee-core";
import {
  BILLABLE_METRICS,
  DEFAULT_FEE_MODE,
  priceMetric,
  type BillableMetricKey,
  type FeeMode,
} from "@/lib/billing-metrics";

function admin() {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw new Error("Server is missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  }
  return createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ─── Public view types ─────────────────────────────────────────────────────

export type FeeRuleView = {
  metricKey: BillableMetricKey;
  label: string;
  description: string;
  live: boolean;
  mode: FeeMode;
  amount: number;
  enabled: boolean;
};

export type BillingSettings = {
  monthlyBaseUsd: number;
  rules: FeeRuleView[];
};

export type LedgerWin = {
  id: string;
  date: string;
  patientName: string | null;
  metricKey: string;
  label: string;
  revenueUsd: number;
  charge: number;
};

export type BillingLedger = {
  periodStart: string;
  periodEnd: string;
  monthlyBaseUsd: number;
  lines: LedgerLine[];
  wins: LedgerWin[];
  totalDueUsd: number;
};

// ─── Zod ────────────────────────────────────────────────────────────────────

const authInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
});

// ─── getBillingSettings ─────────────────────────────────────────────────────

export const getBillingSettings = createServerFn({ method: "POST" })
  .inputValidator((i: unknown) => authInput.parse(i))
  .handler(async ({ data }): Promise<BillingSettings> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);
    const cfg = await loadEffectiveFeeConfig(sb, tenantId);
    return {
      monthlyBaseUsd: cfg.monthlyBaseUsd,
      rules: BILLABLE_METRICS.map((m) => {
        const r = cfg.rules.get(m.key)!;
        return {
          metricKey: m.key,
          label: m.label,
          description: m.description,
          live: m.live,
          mode: r.mode,
          amount: r.amount,
          enabled: r.enabled,
        };
      }),
    };
  });

// ─── updateBillingConfig ────────────────────────────────────────────────────

export const updateBillingConfig = createServerFn({ method: "POST" })
  .inputValidator((i: unknown) =>
    authInput.extend({ monthlyBaseUsd: z.number().min(0).max(100000) }).parse(i),
  )
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);
    const { error } = await sb.from("billing_config").upsert(
      {
        tenant_id: tenantId,
        monthly_base_usd: data.monthlyBaseUsd,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "tenant_id" },
    );
    if (error) throw new Error(`Couldn't save billing config: ${error.message}`);
    return { ok: true };
  });

// ─── updateFeeRule ──────────────────────────────────────────────────────────

const METRIC_KEYS = BILLABLE_METRICS.map((m) => m.key) as [
  BillableMetricKey,
  ...BillableMetricKey[],
];

export const updateFeeRule = createServerFn({ method: "POST" })
  .inputValidator((i: unknown) =>
    authInput
      .extend({
        metricKey: z.enum(METRIC_KEYS),
        mode: z.enum(["flat", "percent"]),
        amount: z.number().min(0).max(100000),
        enabled: z.boolean(),
      })
      .parse(i),
  )
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);
    const { error } = await sb.from("billing_fee_rules").upsert(
      {
        tenant_id: tenantId,
        metric_key: data.metricKey,
        mode: data.mode,
        amount: data.amount,
        enabled: data.enabled,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "tenant_id,metric_key" },
    );
    if (error) throw new Error(`Couldn't save fee rule: ${error.message}`);
    return { ok: true };
  });

// ─── getBillingLedger ───────────────────────────────────────────────────────

export const getBillingLedger = createServerFn({ method: "POST" })
  .inputValidator((i: unknown) => authInput.parse(i))
  .handler(async ({ data }): Promise<BillingLedger> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);

    // Current calendar month (UTC), open-period MTD.
    const now = new Date();
    const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

    const cfg = await loadEffectiveFeeConfig(sb, tenantId);
    const agg = await aggregateMetricsForTenant({ sb, tenantId, periodStart, periodEnd });
    const { totalDueUsd, lines } = computeInvoiceTotal(cfg, agg);

    // Recent individual wins for the counterfactual ledger.
    const { data: memberships } = await sb
      .from("tenant_memberships")
      .select("user_id")
      .eq("tenant_id", tenantId);
    const userIds = (memberships ?? []).map((m) => m.user_id);
    const wins: LedgerWin[] = [];
    if (userIds.length > 0) {
      const { data: evRows } = await sb
        .from("emma_recovery_events")
        .select("id, metric_key, attributed_revenue_usd, verified_at, patient_node_id")
        .in("user_id", userIds)
        .gte("verified_at", periodStart.toISOString())
        .lt("verified_at", periodEnd.toISOString())
        .not("verified_at", "is", null)
        .order("verified_at", { ascending: false })
        .limit(100);
      const evs = evRows ?? [];
      const nodeIds = Array.from(
        new Set(evs.map((e) => e.patient_node_id).filter((x): x is string => !!x)),
      );
      const nameByNode = new Map<string, string>();
      for (let i = 0; i < nodeIds.length; i += 300) {
        const slice = nodeIds.slice(i, i + 300);
        const { data: nodes } = await sb.from("knowledge_nodes").select("id, title").in("id", slice);
        for (const n of nodes ?? []) nameByNode.set(n.id, n.title ?? "");
      }
      for (const e of evs) {
        const key = e.metric_key || "slot_fill";
        const rule = cfg.rules.get(key) ?? { mode: DEFAULT_FEE_MODE, amount: 0, enabled: false };
        const rev = Number(e.attributed_revenue_usd ?? 0);
        const charge = rule.enabled ? priceMetric(rule.mode, rule.amount, 1, rev) : 0;
        wins.push({
          id: e.id,
          date: e.verified_at ?? "",
          patientName: e.patient_node_id ? (nameByNode.get(e.patient_node_id) ?? null) : null,
          metricKey: key,
          label: BILLABLE_METRICS.find((m) => m.key === key)?.label ?? key,
          revenueUsd: +rev.toFixed(2),
          charge,
        });
      }
    }

    return {
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      monthlyBaseUsd: cfg.monthlyBaseUsd,
      lines,
      wins,
      totalDueUsd,
    };
  });
