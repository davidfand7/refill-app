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
import { admin } from "./admin-client";
import { z } from "zod";

import { getTenantIdForUser, resolveEffectiveUserId } from "@/server/auth-helpers";
import { fetchAllRows } from "@/server/paginate";
import {
  loadEffectiveFeeConfig,
  aggregateMetricsForTenant,
  computeInvoiceTotal,
  loadPriorChargedThisYear,
  applyCap,
  type LedgerLine,
} from "@/server/billing-fee-core";
import {
  BILLABLE_METRICS,
  DEFAULT_FEE_MODE,
  priceMetric,
  type BillableMetricKey,
  type CapPeriod,
  type FeeMode,
} from "@/lib/billing-metrics";

// ─── Public view types ─────────────────────────────────────────────────────

export type FeeRuleView = {
  metricKey: BillableMetricKey;
  label: string;
  description: string;
  live: boolean;
  mode: FeeMode;
  amount: number;
  enabled: boolean;
  /** Per-feature cap (null = uncapped). The v1 surface only sets annual. */
  capUsd: number | null;
  capPeriod: CapPeriod | null;
  /** Live preview, real data: charged for THIS metric so far this calendar
   *  year (closed invoices + the open month, capped) — "how close to the cap." */
  ytdBilledUsd: number;
  /** Live preview, real data: this metric's nominal (uncapped) charges over
   *  the trailing 90 days — "would a cap of $X bite?" */
  last90BilledUsd: number;
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
  /** v2.68.0 — "Your Brand" white-label flat add-on this period ($0 unless
   *  subscribed). A flat fee alongside monthlyBaseUsd; included in totalDueUsd. */
  whiteLabelAddonUsd: number;
  lines: LedgerLine[];
  wins: LedgerWin[];
  totalDueUsd: number;
  /** Wins recorded this period but NOT yet verified (the patient hasn't paid
   *  yet) — so they are NOT billed. The scoreboard shows this as the visible
   *  proof that SmartSpa never charges on a maybe (conservative-by-construction). */
  pendingCount: number;
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

    // ── Live cap-preview figures (real data) ────────────────────────────────
    // YTD billed per metric = closed invoices this year + the open month's
    // capped charge. 90-day billed = nominal (uncapped) charges over the
    // trailing window — the "would a cap of $X bite?" gauge. Both reuse the
    // exact billing math so the preview can never drift from the invoice.
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const window90Start = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

    const [priorYtd, openAgg, agg90] = await Promise.all([
      loadPriorChargedThisYear(sb, tenantId, monthStart),
      aggregateMetricsForTenant({ sb, tenantId, periodStart: monthStart, periodEnd: monthEnd }),
      aggregateMetricsForTenant({ sb, tenantId, periodStart: window90Start, periodEnd: now }),
    ]);
    const { lines: openLines } = computeInvoiceTotal(cfg, openAgg, {
      priorChargedThisYearByMetric: priorYtd,
    });
    const openChargeByMetric = new Map(openLines.map((l) => [l.metricKey as string, l.charge]));

    return {
      monthlyBaseUsd: cfg.monthlyBaseUsd,
      rules: BILLABLE_METRICS.map((m) => {
        const r = cfg.rules.get(m.key)!;
        const a90 = agg90.get(m.key) ?? { count: 0, revenueUsd: 0 };
        const last90BilledUsd = r.enabled
          ? priceMetric(r.mode, r.amount, a90.count, +a90.revenueUsd.toFixed(2))
          : 0;
        const ytdBilledUsd = +(
          (priorYtd.get(m.key) ?? 0) + (openChargeByMetric.get(m.key) ?? 0)
        ).toFixed(2);
        return {
          metricKey: m.key,
          label: m.label,
          description: m.description,
          live: m.live,
          mode: r.mode,
          amount: r.amount,
          enabled: r.enabled,
          capUsd: r.capUsd,
          capPeriod: r.capPeriod,
          ytdBilledUsd,
          last90BilledUsd,
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
        // Per-feature cap. null = uncapped (the default). Sending a number
        // with capPeriod sets the cap; null clears it.
        capUsd: z.number().min(0).max(10000000).nullable().optional(),
        capPeriod: z.enum(["annual", "monthly"]).nullable().optional(),
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
    // Normalize: a cap exists only when an amount is set. Clearing the amount
    // (or sending null) also clears the period, so the two never disagree.
    const capUsd = data.capUsd ?? null;
    const capPeriod = capUsd == null ? null : (data.capPeriod ?? "annual");
    const { error } = await sb.from("billing_fee_rules").upsert(
      {
        tenant_id: tenantId,
        metric_key: data.metricKey,
        mode: data.mode,
        amount: data.amount,
        enabled: data.enabled,
        cap_usd: capUsd,
        cap_period: capPeriod,
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
    const priorYtd = await loadPriorChargedThisYear(sb, tenantId, periodStart);
    const { totalDueUsd, lines } = computeInvoiceTotal(cfg, agg, {
      priorChargedThisYearByMetric: priorYtd,
    });

    // Headroom each capped metric has left for THIS open period — so the
    // per-win charges below consume the cap earliest-first and the win list
    // always sums to the capped line total (no audit mismatch). Uncapped
    // metrics get Infinity (no ceiling).
    const capRemaining = new Map<string, number>();
    for (const m of BILLABLE_METRICS) {
      const r = cfg.rules.get(m.key)!;
      if (r.capUsd == null) {
        capRemaining.set(m.key, Infinity);
      } else {
        const prior = r.capPeriod === "annual" ? (priorYtd.get(m.key) ?? 0) : 0;
        capRemaining.set(m.key, Math.max(0, +(r.capUsd - prior).toFixed(2)));
      }
    }

    // Recent individual wins for the counterfactual ledger.
    const { data: memberships } = await sb
      .from("tenant_memberships")
      .select("user_id")
      .eq("tenant_id", tenantId);
    const userIds = (memberships ?? []).map((m) => m.user_id);
    const wins: LedgerWin[] = [];
    // Recorded-but-unverified wins this period — counted, not charged (the
    // conservative-by-construction proof for the scoreboard). Uses the partial
    // index on (user_id, created_at) where verified_at is null.
    let pendingCount = 0;
    if (userIds.length > 0) {
      const { count } = await sb
        .from("recovery_events")
        .select("id", { count: "exact", head: true })
        .in("user_id", userIds)
        .is("verified_at", null)
        .gte("created_at", periodStart.toISOString())
        .lt("created_at", periodEnd.toISOString());
      pendingCount = count ?? 0;
    }
    if (userIds.length > 0) {
      // Full set for the period — paged past PostgREST's 1,000-row cap so a
      // high-volume month is shown complete (and exportable), never silently
      // truncated. The list IS the full ledger, so its count matches the
      // per-metric totals above.
      const evs = await fetchAllRows<{
        id: string;
        metric_key: string | null;
        attributed_revenue_usd: number | null;
        verified_at: string | null;
        patient_node_id: string | null;
      }>((from, to) =>
        sb
          .from("recovery_events")
          .select("id, metric_key, attributed_revenue_usd, verified_at, patient_node_id")
          .in("user_id", userIds)
          .gte("verified_at", periodStart.toISOString())
          .lt("verified_at", periodEnd.toISOString())
          .not("verified_at", "is", null)
          .order("verified_at", { ascending: false })
          .range(from, to),
      );
      const nodeIds = Array.from(
        new Set(evs.map((e) => e.patient_node_id).filter((x): x is string => !!x)),
      );
      const nameByNode = new Map<string, string>();
      for (let i = 0; i < nodeIds.length; i += 300) {
        const slice = nodeIds.slice(i, i + 300);
        const { data: nodes } = await sb.from("knowledge_nodes").select("id, title").in("id", slice);
        for (const n of nodes ?? []) nameByNode.set(n.id, n.title ?? "");
      }
      // Assign each win its charge, consuming any cap earliest-first (evs is
      // verified_at DESC; walk a chronological copy so the OLDEST wins fill the
      // cap and later ones go free once it's hit — mirrors how the month bills).
      const chargeByWinId = new Map<string, number>();
      const remaining = new Map(capRemaining);
      for (const e of [...evs].sort((a, b) => (a.verified_at ?? "").localeCompare(b.verified_at ?? ""))) {
        const key = e.metric_key || "slot_fill";
        const rule =
          cfg.rules.get(key) ??
          { mode: DEFAULT_FEE_MODE, amount: 0, enabled: false, capUsd: null, capPeriod: null };
        const rev = Number(e.attributed_revenue_usd ?? 0);
        const nominal = rule.enabled ? priceMetric(rule.mode, rule.amount, 1, rev) : 0;
        const rem = remaining.get(key) ?? Infinity;
        const charged = rem === Infinity ? nominal : +Math.min(nominal, rem).toFixed(2);
        if (rem !== Infinity) remaining.set(key, +(rem - charged).toFixed(2));
        chargeByWinId.set(e.id, charged);
      }
      for (const e of evs) {
        const key = e.metric_key || "slot_fill";
        const rev = Number(e.attributed_revenue_usd ?? 0);
        wins.push({
          id: e.id,
          date: e.verified_at ?? "",
          patientName: e.patient_node_id ? (nameByNode.get(e.patient_node_id) ?? null) : null,
          metricKey: key,
          label: BILLABLE_METRICS.find((m) => m.key === key)?.label ?? key,
          revenueUsd: +rev.toFixed(2),
          charge: chargeByWinId.get(e.id) ?? 0,
        });
      }
    }

    return {
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      monthlyBaseUsd: cfg.monthlyBaseUsd,
      whiteLabelAddonUsd: cfg.whiteLabelAddonUsd ?? 0,
      lines,
      wins,
      totalDueUsd,
      pendingCount,
    };
  });
