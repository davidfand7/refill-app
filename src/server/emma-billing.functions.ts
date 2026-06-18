/**
 * Emma(OS) pricing plan + monthly invoicing (v366 — the killshot).
 *
 * Where the $$ actually flows. Three pricing plans:
 *   performance — free + 12% of recovered revenue (default — aligns
 *                  incentives; the spa only pays when revenue arrives)
 *   predictable — $299/mo flat
 *   hybrid      — $99/mo + 8% of recovered
 *
 * v366 ships the schema + UI + math + draft-invoice cron. v366.x
 * activates Stripe (customer creation, payment method capture,
 * actual invoice push + collection) when a real spa explicitly opts
 * in. Same pattern as v364 — engine first, money flow later.
 *
 * Surfaces (v1.26.14 cleanup): file is now in maintenance-mode for the
 * legacy pricing_plans / invoices tables. The spa-facing
 * plan/invoice flow lives in refill-billing.ts as of the v1.7.2 fork;
 * this file retains only:
 *   getInvoicePreview         — MTD math for /app/refill/recovery
 *   generateMonthlyInvoiceForUser / generateMonthlyInvoicesForAll
 *                              — legacy invoices cron helpers
 *
 * The three formerly-exported plan/invoice fns
 * (applyPricingPlan, getActivePlan, listInvoices) were removed in
 * v1.26.14 — they had been orphaned since v1.9's emma→refill UI
 * unification routed app.billing.tsx to refill-billing.ts.
 *
 * Established 2026-05-17 (Promotions Engine v366 — engine complete).
 */

import { createServerFn } from "@tanstack/react-start";
import { admin } from "./admin-client";
import { z } from "zod";

import {
  REFILL_PLAN_PRO_MONTHLY_USD,
  REFILL_PLAN_PRO_REV_SHARE,
  REFILL_PLAN_STARTER_MONTHLY_USD,
  REFILL_PLAN_STARTER_REV_SHARE,
} from "@/lib/rep-economics";
import { resolveEffectiveUserId } from "@/server/auth-helpers";

// ─── Public types ─────────────────────────────────────────────────────────

export type PricingPlan = "performance" | "predictable" | "hybrid";

// v1.26.14 removed ActivePlan + Invoice types alongside their owning
// dead fns (applyPricingPlan, getActivePlan, listInvoices). The
// refill-billing.ts file owns the live equivalents
// (RefillActivePlan, RefillInvoice). PricingPlan stays because
// getInvoicePreview, getPlanEconomics, and PLAN_ECONOMICS still use it.

// ─── Plan economics ──────────────────────────────────────────────────────

/**
 * Canonical plan economics. Snapshotted into pricing_plans at
 * selection time so future price changes don't retroactively alter
 * past invoices.
 */
const PLAN_ECONOMICS: Record<
  PricingPlan,
  { revenue_share_pct: number; monthly_flat_usd: number }
> = {
  performance: { revenue_share_pct: REFILL_PLAN_STARTER_REV_SHARE, monthly_flat_usd: REFILL_PLAN_STARTER_MONTHLY_USD },
  // predictable: monthly-only, no rev share. 0 + 299 stay inline — 0 isn't
  // a rate-shaped literal and $299 is a tenant-pricing decision, not a
  // commission rate. Audit allows this; rate-ok by structural shape.
  predictable: { revenue_share_pct: 0, monthly_flat_usd: 299 },
  hybrid:      { revenue_share_pct: REFILL_PLAN_PRO_REV_SHARE,     monthly_flat_usd: REFILL_PLAN_PRO_MONTHLY_USD },
};

// ─── Admin client ─────────────────────────────────────────────────────────

type SupabaseAdmin = ReturnType<typeof admin>;

// ─── Zod ──────────────────────────────────────────────────────────────────

const invoicePreviewInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
});

// ─── generateMonthlyInvoiceForUser (cron helper, exported) ────────────────

/**
 * Generate the invoice for ONE spa for the PRIOR calendar month.
 * Idempotent on (user_id, period_start) — re-running for the same
 * period is a no-op.
 *
 * Caller is the cron sweep below. The spa never calls this directly;
 * they just see the resulting invoice on /app/refill/billing.
 */
export async function generateMonthlyInvoiceForUser(args: {
  sb: SupabaseAdmin;
  userId: string;
  periodStart: Date; // UTC start of the period (e.g. May 1)
  periodEnd: Date;   // UTC start of the next period (e.g. Jun 1)
}): Promise<{ created: boolean; reason?: string }> {
  const { sb, userId, periodStart, periodEnd } = args;

  // Find the active plan AS OF period_end (so a plan change mid-period
  // is invoiced under the plan that was active when the month closed).
  const { data: plan } = await sb
    .from("pricing_plans")
    .select("plan, revenue_share_pct, monthly_flat_usd")
    .eq("user_id", userId)
    .lte("plan_started_at", periodEnd.toISOString())
    .or(`plan_ended_at.is.null,plan_ended_at.gte.${periodEnd.toISOString()}`)
    .order("plan_started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!plan) {
    return { created: false, reason: "No active plan for this period." };
  }

  // Aggregate verified recovery events in the period.
  const { data: recs } = await sb
    .from("recovery_events")
    .select("attributed_revenue_usd")
    .eq("user_id", userId)
    .gte("verified_at", periodStart.toISOString())
    .lt("verified_at", periodEnd.toISOString())
    .not("verified_at", "is", null);

  const rows = recs ?? [];
  const recoveredRevenueUsd = rows.reduce(
    (sum, r) => sum + Number(r.attributed_revenue_usd ?? 0),
    0,
  );
  const recoveredRevenueCount = rows.length;

  // Math. Code-computed; [VERIFIED] discipline.
  const sharePct = Number(plan.revenue_share_pct);
  const flat = Number(plan.monthly_flat_usd);
  const shareDueUsd = +(recoveredRevenueUsd * sharePct).toFixed(2);
  const totalDueUsd = +(shareDueUsd + flat).toFixed(2);

  // Idempotent upsert
  const { error } = await sb
    .from("invoices")
    .upsert(
      {
        user_id: userId,
        period_start: periodStart.toISOString(),
        period_end: periodEnd.toISOString(),
        plan_at_invoice: plan.plan,
        revenue_share_pct: sharePct,
        monthly_flat_usd: flat,
        recovered_revenue_count: recoveredRevenueCount,
        recovered_revenue_usd: recoveredRevenueUsd,
        share_due_usd: shareDueUsd,
        total_due_usd: totalDueUsd,
        status: "draft",
        generated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,period_start" },
    );
  if (error) {
    throw new Error(`Couldn't write invoice: ${error.message}`);
  }
  return { created: true };
}

// ─── generateMonthlyInvoicesForAll (cron entry) ───────────────────────────

/**
 * Iterate every spa with an active pricing plan and generate the prior
 * month's invoice. Called by /api/cron/emma-invoice on the 1st of each
 * month at 09:00 UTC.
 */
export async function generateMonthlyInvoicesForAll(args: {
  sb: SupabaseAdmin;
}): Promise<{ spas: number; invoiced: number; errors: string[] }> {
  const { sb } = args;

  const now = new Date();
  const periodEnd = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  );
  const periodStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1),
  );

  const { data: plans } = await sb
    .from("pricing_plans")
    .select("user_id")
    .is("plan_ended_at", null);
  const userIds = Array.from(new Set((plans ?? []).map((p) => p.user_id)));

  let invoiced = 0;
  const errors: string[] = [];
  for (const userId of userIds) {
    try {
      const r = await generateMonthlyInvoiceForUser({
        sb,
        userId,
        periodStart,
        periodEnd,
      });
      if (r.created) invoiced++;
    } catch (e) {
      errors.push(
        `${userId}: ${e instanceof Error ? e.message : "unknown"}`,
      );
    }
  }

  return { spas: userIds.length, invoiced, errors };
}

// ─── Exposed plan economics for the UI ────────────────────────────────────

export function getPlanEconomics(plan: PricingPlan) {
  return PLAN_ECONOMICS[plan];
}

// ─── getInvoicePreview (v377 dashboard, DEPRECATED v1.26.23) ─────────────
//
// v1.26.23: zero callers remain after the recovery page was repointed to
// refill-billing.ts:getInvoicePreview (the tenant-aware, refill_pricing_plans
// variant). This emma-side fn reads the legacy pricing_plans table
// which no spa-facing surface writes to anymore — leaving it live would
// silently return plan=null for every modern tenant. Kept temporarily so
// the broader Phase 3 deletion of this whole file (post-cron-decommission)
// is a single atomic cleanup. New code MUST import getInvoicePreview from
// @/server/refill-billing.

export type InvoicePreview = {
  /** null when the spa hasn't selected a plan yet — UI prompts them to. */
  plan: PricingPlan | null;
  revenueSharePct: number;
  monthlyFlatUsd: number;
  /** UTC start of the current calendar month (the period being previewed). */
  periodStart: string;
  /** UTC start of the next calendar month — the period closes here. */
  periodEnd: string;
  /** Sum of verified attributed_revenue_usd in [periodStart, periodEnd). */
  mtdRecoveredUsd: number;
  mtdRecoveredCount: number;
  /** `mtdRecoveredUsd * revenueSharePct`, rounded to cents. */
  shareDueUsd: number;
  /** `shareDueUsd + monthlyFlatUsd`. The number the spa owner would see
   *  if the period closed today — anchored in code, not the UI. */
  totalDueUsd: number;
};

/**
 * Compute the in-progress month's invoice math for the dashboard preview.
 *
 * v377 surface — shows the spa owner exactly what they would be billed
 * if the month closed today. Math is byte-identical to
 * generateMonthlyInvoiceForUser (the cron that fires on the 1st), just
 * scoped to the open month. Both paths use Promise.all + the same
 * PLAN_ECONOMICS table, so the preview never diverges from the real
 * invoice generation.
 *
 * Returns `plan: null` when the spa has no active pricing plan yet —
 * dashboard renders a friendlier "choose a plan" affordance in that case.
 */
export const getInvoicePreview = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => invoicePreviewInput.parse(input))
  .handler(async ({ data }): Promise<InvoicePreview> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();

    const now = new Date();
    const periodStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    const periodEnd = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
    );

    const [planRes, recRes] = await Promise.all([
      sb
        .from("pricing_plans")
        .select("plan, revenue_share_pct, monthly_flat_usd")
        .eq("user_id", effectiveUserId)
        .is("plan_ended_at", null)
        .order("plan_started_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      sb
        .from("recovery_events")
        .select("attributed_revenue_usd")
        .eq("user_id", effectiveUserId)
        .gte("verified_at", periodStart.toISOString())
        .lt("verified_at", periodEnd.toISOString())
        .not("verified_at", "is", null),
    ]);

    const rows = recRes.data ?? [];
    const mtdRecoveredUsd = +rows
      .reduce((s, r) => s + Number(r.attributed_revenue_usd ?? 0), 0)
      .toFixed(2);
    const mtdRecoveredCount = rows.length;

    if (!planRes.data) {
      return {
        plan: null,
        revenueSharePct: 0,
        monthlyFlatUsd: 0,
        periodStart: periodStart.toISOString(),
        periodEnd: periodEnd.toISOString(),
        mtdRecoveredUsd,
        mtdRecoveredCount,
        shareDueUsd: 0,
        totalDueUsd: 0,
      };
    }

    const plan = planRes.data.plan as PricingPlan;
    const revenueSharePct = Number(planRes.data.revenue_share_pct);
    const monthlyFlatUsd = Number(planRes.data.monthly_flat_usd);
    const shareDueUsd = +(mtdRecoveredUsd * revenueSharePct).toFixed(2);
    const totalDueUsd = +(shareDueUsd + monthlyFlatUsd).toFixed(2);

    return {
      plan,
      revenueSharePct,
      monthlyFlatUsd,
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      mtdRecoveredUsd,
      mtdRecoveredCount,
      shareDueUsd,
      totalDueUsd,
    };
  });
