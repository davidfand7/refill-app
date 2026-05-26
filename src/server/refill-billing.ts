/**
 * Refill billing — v391 backend foundation.
 *
 * Tenant-scoped clone of emma-billing.functions.ts. Where Emma is
 * user-scoped (1 user = 1 spa), Refill is tenant-scoped (1 user may own
 * multiple spas in the future — currently capped at one by the v387 wizard
 * but the schema + auth gate are tenant-first so the future-lift is free).
 *
 * Surfaces:
 *   getActivePlan             — for /app/billing (v391.1)
 *   applyPricingPlan          — spa picks/changes plan
 *   listInvoices              — invoice history for /app/billing
 *   getInvoicePreview         — MTD math for the billing dashboard preview
 *   generateMonthlyInvoiceForTenant — cron helper (v391.2)
 *   generateMonthlyInvoicesForAll   — cron entry (v391.2)
 *   getPlanEconomics          — UI helper
 *
 * Auth pattern: verifyAuth → getTenantIdForUser membership gate. A user with
 * NO tenant membership cannot read or write any pricing/invoice rows. A user
 * with multiple memberships gets the first row (deterministic by created_at);
 * future-multi-tenant work will need a tenantId parameter on each fn.
 *
 * Plan economics per [[project_pricing_killshot]]:
 *   starter — free + 12% of recovered revenue (the killshot default)
 *   pro     — $99/mo + 8% of recovered (commitment + shared upside)
 *
 * Established 2026-05-20 (v391).
 */

import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import {
  REFILL_PLAN_PREDICTABLE_MONTHLY_USD,
  REFILL_PLAN_PREDICTABLE_REV_SHARE,
  REFILL_PLAN_PRO_MONTHLY_USD,
  REFILL_PLAN_PRO_REV_SHARE,
  REFILL_PLAN_STARTER_MONTHLY_USD,
  REFILL_PLAN_STARTER_REV_SHARE,
} from "@/lib/rep-economics";
import {
  detectStripeMode,
  readTenantStripeCustomerId,
  type StripeMode,
} from "@/lib/stripe-mode";
import { verifyAuth } from "@/server/auth-helpers";

// ─── Public types ─────────────────────────────────────────────────────────

export type RefillPricingPlan = "starter" | "predictable" | "pro";

export type RefillActivePlan = {
  id: string;
  tenantId: string;
  plan: RefillPricingPlan;
  revenueSharePct: number;
  monthlyFlatUsd: number;
  planStartedAt: string;
  stripeCustomerId: string | null;
} | null;

export type RefillInvoice = {
  id: string;
  periodStart: string;
  periodEnd: string;
  planAtInvoice: RefillPricingPlan;
  revenueSharePct: number;
  monthlyFlatUsd: number;
  recoveredRevenueCount: number;
  recoveredRevenueUsd: number;
  shareDueUsd: number;
  totalDueUsd: number;
  status: "draft" | "sent" | "paid" | "failed" | "void";
  generatedAt: string;
  paidAt: string | null;
};

// ─── Plan economics ──────────────────────────────────────────────────────

/**
 * Canonical Refill plan economics. Snapshotted into refill_pricing_plans at
 * selection so future price changes don't retroactively alter past invoices.
 * Mid-flight-mutable per [[project_refill_spinout]] — edits here apply only
 * to NEW plan selections, never to historical ones.
 *
 * !!! DRIFT WARNING !!!
 * supabase/functions/stripe-webhook/index.ts has a Deno-side copy of this
 * map (REFILL_PLAN_ECONOMICS). If you add/remove a plan OR change a value
 * here, MIRROR THE CHANGE THERE. The webhook can't import from this bundle.
 * scripts/audit-refill-plan-economics.ts runs in CI on every push and
 * fails the deploy if the two diverge. See v411.3 + v411.4 changelogs.
 */
const PLAN_ECONOMICS: Record<
  RefillPricingPlan,
  { revenue_share_pct: number; monthly_flat_usd: number }
> = {
  starter:     { revenue_share_pct: REFILL_PLAN_STARTER_REV_SHARE,     monthly_flat_usd: REFILL_PLAN_STARTER_MONTHLY_USD },
  predictable: { revenue_share_pct: REFILL_PLAN_PREDICTABLE_REV_SHARE, monthly_flat_usd: REFILL_PLAN_PREDICTABLE_MONTHLY_USD },
  pro:         { revenue_share_pct: REFILL_PLAN_PRO_REV_SHARE,         monthly_flat_usd: REFILL_PLAN_PRO_MONTHLY_USD },
};

// ─── Admin client ─────────────────────────────────────────────────────────

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

type SupabaseAdmin = ReturnType<typeof admin>;

// ─── Tenant resolution ────────────────────────────────────────────────────

/**
 * Resolve the single tenant a user owns. v391 assumes 1 user → 1 tenant per
 * the v387 wizard's single-tenant-per-user rule. If the user has multiple
 * memberships, returns the oldest (created_at ASC) — this is a defensive
 * fallback; the wizard guards against this state at claim time.
 *
 * Throws if the user has NO tenant membership (UI must drive them through
 * the onboarding wizard first; billing is post-trial).
 */
async function getTenantIdForUser(sb: SupabaseAdmin, userId: string): Promise<string> {
  const { data, error } = await sb
    .from("tenant_memberships")
    .select("tenant_id, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Tenant lookup failed: ${error.message}`);
  if (!data) {
    throw new Error("No Refill tenant — finish onboarding before viewing billing.");
  }
  return data.tenant_id;
}

// ─── Zod ──────────────────────────────────────────────────────────────────

const accessTokenOnly = z.object({
  accessToken: z.string().min(1),
});

const applyPlanInput = z.object({
  accessToken: z.string().min(1),
  plan: z.enum(["starter", "predictable", "pro"]),
});

// ─── applyPricingPlan (spa picks/changes plan) ───────────────────────────

export const applyPricingPlan = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => applyPlanInput.parse(input))
  .handler(async ({ data }): Promise<RefillActivePlan> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, userId);
    const econ = PLAN_ECONOMICS[data.plan];

    // Close any existing active plan for this tenant.
    await sb
      .from("refill_pricing_plans")
      .update({ plan_ended_at: new Date().toISOString() })
      .eq("tenant_id", tenantId)
      .is("plan_ended_at", null);

    // Insert the new active plan row.
    const { data: row, error } = await sb
      .from("refill_pricing_plans")
      .insert({
        tenant_id: tenantId,
        plan: data.plan,
        revenue_share_pct: econ.revenue_share_pct,
        monthly_flat_usd: econ.monthly_flat_usd,
      })
      .select("*")
      .single();
    if (error || !row) {
      throw new Error(`Couldn't apply plan: ${error?.message ?? "no row"}`);
    }

    // Mirror the plan name onto tenants.plan so the rest of the app can
    // read the tenant's current plan in one round-trip (consistent with
    // the v387 'trial' → 'starter'/'pro' transition the migration anticipates).
    await sb
      .from("tenants")
      .update({ plan: data.plan })
      .eq("id", tenantId);

    return {
      id: row.id,
      tenantId: row.tenant_id,
      plan: row.plan as RefillPricingPlan,
      revenueSharePct: Number(row.revenue_share_pct),
      monthlyFlatUsd: Number(row.monthly_flat_usd),
      planStartedAt: row.plan_started_at,
      stripeCustomerId: row.stripe_customer_id,
    };
  });

// ─── getActivePlan ────────────────────────────────────────────────────────

export const getActivePlan = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => accessTokenOnly.parse(input))
  .handler(async ({ data }): Promise<RefillActivePlan> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, userId);

    const { data: row } = await sb
      .from("refill_pricing_plans")
      .select("*")
      .eq("tenant_id", tenantId)
      .is("plan_ended_at", null)
      .order("plan_started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!row) return null;

    return {
      id: row.id,
      tenantId: row.tenant_id,
      plan: row.plan as RefillPricingPlan,
      revenueSharePct: Number(row.revenue_share_pct),
      monthlyFlatUsd: Number(row.monthly_flat_usd),
      planStartedAt: row.plan_started_at,
      stripeCustomerId: row.stripe_customer_id,
    };
  });

// ─── listInvoices ─────────────────────────────────────────────────────────

export const listInvoices = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => accessTokenOnly.parse(input))
  .handler(async ({ data }): Promise<RefillInvoice[]> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, userId);

    const { data: rows, error } = await sb
      .from("refill_invoices")
      .select(
        "id, period_start, period_end, plan_at_invoice, revenue_share_pct, monthly_flat_usd, recovered_revenue_count, recovered_revenue_usd, share_due_usd, total_due_usd, status, generated_at, paid_at",
      )
      .eq("tenant_id", tenantId)
      .order("period_start", { ascending: false })
      .limit(24);
    if (error) throw new Error(`Couldn't load invoices: ${error.message}`);

    return (rows ?? []).map((r) => ({
      id: r.id,
      periodStart: r.period_start,
      periodEnd: r.period_end,
      planAtInvoice: r.plan_at_invoice as RefillPricingPlan,
      revenueSharePct: Number(r.revenue_share_pct),
      monthlyFlatUsd: Number(r.monthly_flat_usd),
      recoveredRevenueCount: r.recovered_revenue_count,
      recoveredRevenueUsd: Number(r.recovered_revenue_usd),
      shareDueUsd: Number(r.share_due_usd),
      totalDueUsd: Number(r.total_due_usd),
      status: r.status as RefillInvoice["status"],
      generatedAt: r.generated_at,
      paidAt: r.paid_at,
    }));
  });

// ─── getPaymentMethodStatus (v1.6) ────────────────────────────────────────

export type RefillPaymentMethodStatus = {
  hasCardOnFile: boolean;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  stripeMode: StripeMode;
};

/**
 * Resolve whether this spa has a Stripe card on file in the CURRENT
 * Stripe mode. Reads the mode-aware stripe_customer_id column off tenants,
 * then asks Stripe for the customer's payment methods.
 *
 * Returns the first card we find (most spas will only ever attach one).
 * If the tenant has no customer id yet OR Stripe returns zero cards,
 * hasCardOnFile=false — the UI uses that to show the "Add payment method"
 * CTA instead of the "Card on file" affordance.
 *
 * Failure modes are surfaced as thrown errors so the UI's catch block can
 * render a useful toast instead of silently treating "Stripe down" as
 * "no card on file."
 */
export const getPaymentMethodStatus = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => accessTokenOnly.parse(input))
  .handler(async ({ data }): Promise<RefillPaymentMethodStatus> => {
    const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
    if (!STRIPE_SECRET_KEY) {
      throw new Error("Stripe not configured on server.");
    }
    const mode = detectStripeMode(STRIPE_SECRET_KEY);

    const userId = await verifyAuth(data.accessToken);
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, userId);

    const { data: tenant } = await sb
      .from("tenants")
      .select("stripe_customer_id_test, stripe_customer_id_live")
      .eq("id", tenantId)
      .maybeSingle();
    const customerId = tenant
      ? readTenantStripeCustomerId(tenant, mode)
      : null;

    if (!customerId) {
      return {
        hasCardOnFile: false,
        brand: null,
        last4: null,
        expMonth: null,
        expYear: null,
        stripeMode: mode,
      };
    }

    const stripe = new Stripe(STRIPE_SECRET_KEY, {
      apiVersion: "2026-04-22.dahlia",
    });

    const pms = await stripe.customers.listPaymentMethods(customerId, {
      type: "card",
      limit: 1,
    });
    const pm = pms.data[0];
    if (!pm || !pm.card) {
      return {
        hasCardOnFile: false,
        brand: null,
        last4: null,
        expMonth: null,
        expYear: null,
        stripeMode: mode,
      };
    }

    return {
      hasCardOnFile: true,
      brand: pm.card.brand,
      last4: pm.card.last4,
      expMonth: pm.card.exp_month,
      expYear: pm.card.exp_year,
      stripeMode: mode,
    };
  });

// ─── generateMonthlyInvoiceForTenant (cron helper, exported) ─────────────

/**
 * Generate the invoice for ONE tenant for the PRIOR calendar month.
 * Idempotent on (tenant_id, period_start). Wired into a v391.2 cron.
 *
 * Recovery revenue is sourced from emma_recovery_events for any user_id
 * with a membership in this tenant — the recovery engine writes user-scoped
 * rows because it predates the tenant model, but billing rolls up to the
 * tenant. Future ship: tenant_id column directly on emma_recovery_events
 * to avoid the membership fan-out.
 */
export async function generateMonthlyInvoiceForTenant(args: {
  sb: SupabaseAdmin;
  tenantId: string;
  periodStart: Date;
  periodEnd: Date;
}): Promise<{ created: boolean; reason?: string }> {
  const { sb, tenantId, periodStart, periodEnd } = args;

  // Active plan AS OF period_end (mid-period plan switch invoices under
  // the plan that was active when the month closed).
  const { data: plan } = await sb
    .from("refill_pricing_plans")
    .select("plan, revenue_share_pct, monthly_flat_usd")
    .eq("tenant_id", tenantId)
    .lte("plan_started_at", periodEnd.toISOString())
    .or(`plan_ended_at.is.null,plan_ended_at.gte.${periodEnd.toISOString()}`)
    .order("plan_started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!plan) {
    return { created: false, reason: "No active paid plan for this period." };
  }

  // Fan-out: every user_id with a membership in this tenant.
  const { data: memberships } = await sb
    .from("tenant_memberships")
    .select("user_id")
    .eq("tenant_id", tenantId);
  const userIds = (memberships ?? []).map((m) => m.user_id);
  if (userIds.length === 0) {
    return { created: false, reason: "No memberships on this tenant." };
  }

  // Aggregate verified recovery events for those users in the period.
  const { data: recs } = await sb
    .from("emma_recovery_events")
    .select("attributed_revenue_usd")
    .in("user_id", userIds)
    .gte("verified_at", periodStart.toISOString())
    .lt("verified_at", periodEnd.toISOString())
    .not("verified_at", "is", null);

  const rows = recs ?? [];
  const recoveredRevenueUsd = rows.reduce(
    (sum, r) => sum + Number(r.attributed_revenue_usd ?? 0),
    0,
  );
  const recoveredRevenueCount = rows.length;

  const sharePct = Number(plan.revenue_share_pct);
  const flat = Number(plan.monthly_flat_usd);
  const shareDueUsd = +(recoveredRevenueUsd * sharePct).toFixed(2);
  const totalDueUsd = +(shareDueUsd + flat).toFixed(2);

  // Idempotent upsert (tenant_id, period_start) — Stripe push is v391.x.
  const { error } = await sb
    .from("refill_invoices")
    .upsert(
      {
        tenant_id: tenantId,
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
      { onConflict: "tenant_id,period_start" },
    );
  if (error) {
    throw new Error(`Couldn't write invoice: ${error.message}`);
  }
  return { created: true };
}

// ─── generateMonthlyInvoicesForAll (cron entry, v391.2) ──────────────────

export async function generateMonthlyInvoicesForAll(args: {
  sb: SupabaseAdmin;
}): Promise<{ tenants: number; invoiced: number; errors: string[] }> {
  const { sb } = args;

  const now = new Date();
  const periodEnd = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  );
  const periodStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1),
  );

  const { data: plans } = await sb
    .from("refill_pricing_plans")
    .select("tenant_id")
    .is("plan_ended_at", null);
  const tenantIds = Array.from(new Set((plans ?? []).map((p) => p.tenant_id)));

  let invoiced = 0;
  const errors: string[] = [];
  for (const tenantId of tenantIds) {
    try {
      const r = await generateMonthlyInvoiceForTenant({
        sb,
        tenantId,
        periodStart,
        periodEnd,
      });
      if (r.created) invoiced++;
    } catch (e) {
      errors.push(`${tenantId}: ${e instanceof Error ? e.message : "unknown"}`);
    }
  }

  return { tenants: tenantIds.length, invoiced, errors };
}

// ─── getPlanEconomics (UI helper) ────────────────────────────────────────

export function getPlanEconomics(plan: RefillPricingPlan) {
  return PLAN_ECONOMICS[plan];
}

// ─── getInvoicePreview (MTD math for /app/billing dashboard) ─────────────

export type RefillInvoicePreview = {
  /** null when the tenant hasn't picked a paid plan yet (still on trial). */
  plan: RefillPricingPlan | null;
  revenueSharePct: number;
  monthlyFlatUsd: number;
  periodStart: string;
  periodEnd: string;
  mtdRecoveredUsd: number;
  mtdRecoveredCount: number;
  shareDueUsd: number;
  totalDueUsd: number;
};

export const getInvoicePreview = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => accessTokenOnly.parse(input))
  .handler(async ({ data }): Promise<RefillInvoicePreview> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, userId);

    const now = new Date();
    const periodStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    const periodEnd = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
    );

    const { data: memberships } = await sb
      .from("tenant_memberships")
      .select("user_id")
      .eq("tenant_id", tenantId);
    const userIds = (memberships ?? []).map((m) => m.user_id);

    const [planRes, recRes] = await Promise.all([
      sb
        .from("refill_pricing_plans")
        .select("plan, revenue_share_pct, monthly_flat_usd")
        .eq("tenant_id", tenantId)
        .is("plan_ended_at", null)
        .order("plan_started_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      userIds.length > 0
        ? sb
            .from("emma_recovery_events")
            .select("attributed_revenue_usd")
            .in("user_id", userIds)
            .gte("verified_at", periodStart.toISOString())
            .lt("verified_at", periodEnd.toISOString())
            .not("verified_at", "is", null)
        : Promise.resolve({ data: [] as { attributed_revenue_usd: number | null }[] }),
    ]);

    const recRows = recRes.data ?? [];
    const mtdRecoveredUsd = +recRows
      .reduce((s, r) => s + Number(r.attributed_revenue_usd ?? 0), 0)
      .toFixed(2);
    const mtdRecoveredCount = recRows.length;

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

    const plan = planRes.data.plan as RefillPricingPlan;
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
