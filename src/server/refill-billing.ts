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
 *   generateMonthlyInvoiceForTenant — cron helper (v391.2)
 *   generateMonthlyInvoicesForAll   — cron entry (v391.2)
 *   getPlanEconomics          — UI helper
 *
 * v1.26.14 removed getInvoicePreview here — the only consumer
 * (app.refill.recovery.tsx) imports it from emma-billing.functions
 * instead. The legacy emma-billing surface had been kept on its tenant-
 * untranslated form anyway, so the refill-billing variant was dead.
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
import { resolveEffectiveUserId, verifyAuth } from "@/server/auth-helpers";

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

// v1.20 admin viewing-as variant. Distinct from accessTokenOnly because
// not every fn that uses accessTokenOnly opts in to viewAs-userId — only
// the read paths surfaced on /app/billing for now (getActivePlan +
// listInvoices). Write paths and Stripe-mutating fns are intentionally
// not viewable-as for safety; admin shouldn't be inadvertently mutating
// the impersonated tenant's plan or payment method.
const readWithViewAsInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
});

const applyPlanInput = z.object({
  accessToken: z.string().min(1),
  plan: z.enum(["starter", "predictable", "pro"]),
  viewAsUserId: z.string().uuid().optional(),
});

// ─── applyPricingPlan (spa picks/changes plan) ───────────────────────────

export const applyPricingPlan = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => applyPlanInput.parse(input))
  .handler(async ({ data }): Promise<RefillActivePlan> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);
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
  .inputValidator((input: unknown) => readWithViewAsInput.parse(input))
  .handler(async ({ data }): Promise<RefillActivePlan> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);

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
  .inputValidator((input: unknown) => readWithViewAsInput.parse(input))
  .handler(async ({ data }): Promise<RefillInvoice[]> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);

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

// ─── aggregateRecoveryForTenant (v1.26.23 shared helper) ────────────────
//
// Locks math parity between the cron (generateMonthlyInvoiceForTenant —
// closed-month billing) and the dashboard preview (getInvoicePreview —
// open-month MTD). Pre-v1.26.23 the cron had its own aggregation inline
// and the preview lived in emma-billing.functions.ts reading the legacy
// emma_pricing_plans + user-scoped emma_recovery_events. That left the
// Recovery dashboard structurally stale: tenants on a refill_pricing_plans
// plan saw "no active plan" on /app/refill/recovery while /app/billing
// showed the real plan. Phase 1 of the billing unification extracts this
// aggregation step so both paths roll up the same way.
//
// Membership fan-out caveat: emma_recovery_events still rides user_id
// (predates the tenant model). Direct tenant_id on emma_recovery_events
// is Phase 5 of the unification (project_billing_unification_plan).

async function aggregateRecoveryForTenant(args: {
  sb: SupabaseAdmin;
  tenantId: string;
  periodStart: Date;
  periodEnd: Date;
}): Promise<{ recoveredRevenueUsd: number; recoveredRevenueCount: number }> {
  const { sb, tenantId, periodStart, periodEnd } = args;
  const { data: memberships } = await sb
    .from("tenant_memberships")
    .select("user_id")
    .eq("tenant_id", tenantId);
  const userIds = (memberships ?? []).map((m) => m.user_id);
  if (userIds.length === 0) {
    return { recoveredRevenueUsd: 0, recoveredRevenueCount: 0 };
  }
  const { data: recs } = await sb
    .from("emma_recovery_events")
    .select("attributed_revenue_usd")
    .in("user_id", userIds)
    .gte("verified_at", periodStart.toISOString())
    .lt("verified_at", periodEnd.toISOString())
    .not("verified_at", "is", null);
  const rows = recs ?? [];
  const recoveredRevenueUsd = +rows
    .reduce((sum, r) => sum + Number(r.attributed_revenue_usd ?? 0), 0)
    .toFixed(2);
  return {
    recoveredRevenueUsd,
    recoveredRevenueCount: rows.length,
  };
}

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
 *
 * v1.26.23 — aggregation step extracted into aggregateRecoveryForTenant
 * so the dashboard preview can share math parity.
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

  // v1.26.23: aggregation step delegated to the shared helper above so the
  // dashboard preview locks math parity against this path. Note: no-membership
  // tenants will silently aggregate to 0/0 here rather than returning the
  // earlier "No memberships on this tenant" reason — but the `if (!plan)`
  // guard above already short-circuits no-membership tenants in practice
  // (they can't have picked a plan), so the reason-message regression is
  // theoretical only.
  const { recoveredRevenueUsd, recoveredRevenueCount } =
    await aggregateRecoveryForTenant({
      sb,
      tenantId,
      periodStart,
      periodEnd,
    });

  const sharePct = Number(plan.revenue_share_pct);
  const flat = Number(plan.monthly_flat_usd);
  const shareDueUsd = +(recoveredRevenueUsd * sharePct).toFixed(2);
  const totalDueUsd = +(shareDueUsd + flat).toFixed(2);

  // Idempotent upsert on (tenant_id, period_start). Status starts at "draft"
  // and gets bumped to "sent" below if the Stripe push succeeds. The select
  // returns the resulting row so we can read stripe_invoice_id (already-pushed
  // periods skip the Stripe call below).
  const { data: invRow, error } = await sb
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
    )
    .select("id, stripe_invoice_id, status")
    .single();
  if (error || !invRow) {
    throw new Error(`Couldn't write invoice: ${error?.message ?? "no row"}`);
  }

  // v1.7 Phase B-lite: push to Stripe + finalize → Stripe auto-charges the
  // saved card. Skip when:
  //   - total is $0 (nothing to charge)
  //   - already pushed (idempotent on stripe_invoice_id)
  //   - Stripe not configured at all on this server
  //   - tenant has no customer in the current Stripe mode
  //   - customer has no card on file (graceful — drafts pile up until card added)
  // Any push failure is non-fatal: the DB row stays at "draft" and the next
  // cron run (or manual retry) tries again.
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  if (
    totalDueUsd > 0 &&
    !invRow.stripe_invoice_id &&
    STRIPE_SECRET_KEY
  ) {
    const mode = detectStripeMode(STRIPE_SECRET_KEY);
    const { data: tenant } = await sb
      .from("tenants")
      .select(
        "name, stripe_customer_id_test, stripe_customer_id_live",
      )
      .eq("id", tenantId)
      .maybeSingle();
    const customerId = tenant
      ? readTenantStripeCustomerId(tenant, mode)
      : null;

    if (customerId) {
      try {
        const stripe = new Stripe(STRIPE_SECRET_KEY, {
          apiVersion: "2026-04-22.dahlia",
        });

        const pms = await stripe.customers.listPaymentMethods(customerId, {
          type: "card",
          limit: 1,
        });
        const paymentMethodId = pms.data[0]?.id;

        if (paymentMethodId) {
          const periodLabel = periodStart.toLocaleString("en-US", {
            month: "long",
            year: "numeric",
            timeZone: "UTC",
          });
          const description =
            plan.plan === "starter"
              ? `Refill recovery share — ${periodLabel} (${(sharePct * 100).toFixed(0)}% of $${recoveredRevenueUsd.toLocaleString()} recovered)`
              : `Refill ${plan.plan} plan — ${periodLabel}`;

          // v1.7.1 — switched to invoice-scoped-items pattern. v1.7 used
          // the "pending pool" pattern (create InvoiceItem with no invoice,
          // then create Invoice expecting it to auto-pull pending items),
          // but the Invoice was created empty ($0 total, immediately
          // auto-marked paid). Diagnosis: pending pool semantics aren't
          // reliable on the apiVersion in use here. Approach 2 fix:
          //   (1) create Invoice as DRAFT (auto_advance:false)
          //   (2) create InvoiceItem with `invoice: invoice.id` so it's
          //       scoped to that specific invoice
          //   (3) finalize → triggers charge synchronously
          // pending_invoice_items_behavior:"exclude" prevents v1.7's
          // orphaned pending item (still on the customer in test mode)
          // from being double-pulled into new invoices. The _v2 suffix
          // on idempotency keys ensures Stripe doesn't replay v1.7's
          // cached (bad) responses within the 24h idempotency window.
          const idempotencyKey = `refill_inv_${tenantId}_${periodStart.toISOString().slice(0, 10)}_v3`;

          // 1. Create the invoice as a draft, scoped to no items yet.
          const stripeInvoice = await stripe.invoices.create(
            {
              customer: customerId,
              auto_advance: false,
              collection_method: "charge_automatically",
              default_payment_method: paymentMethodId,
              description: `Refill — ${periodLabel}`,
              pending_invoice_items_behavior: "exclude",
              metadata: {
                product: "refill",
                tenant_id: tenantId,
                period_start: periodStart.toISOString(),
              },
            },
            { idempotencyKey: `${idempotencyKey}_invoice` },
          );

          // 2. Attach the InvoiceItem to that specific invoice.
          await stripe.invoiceItems.create(
            {
              customer: customerId,
              invoice: stripeInvoice.id,
              amount: Math.round(totalDueUsd * 100),
              currency: "usd",
              description,
              metadata: {
                product: "refill",
                tenant_id: tenantId,
                period_start: periodStart.toISOString(),
              },
            },
            { idempotencyKey: `${idempotencyKey}_item` },
          );

          // 3. Finalize → "open" status. Does NOT auto-charge on its own
          //    because we created the invoice with auto_advance:false (so
          //    we could control item-add timing without Stripe racing us
          //    on an empty $0 invoice). The actual charge attempt is the
          //    explicit pay() call below.
          await stripe.invoices.finalizeInvoice(stripeInvoice.id);

          // 4. v1.7.2 fix: explicitly attempt the charge. Without this,
          //    the invoice sits at "open" + "past due" because
          //    auto_advance:false told Stripe NOT to advance automatically.
          //    pay() pulls from default_payment_method synchronously and
          //    returns the resulting invoice — "paid" on success, throws
          //    on hard card decline (caught by outer try/catch; DB stays
          //    at draft, next cron retries).
          const paid = await stripe.invoices.pay(stripeInvoice.id);

          // 5. Stamp back on the DB row using paid.status, the truthful
          //    result of the charge attempt. Webhook-driven flips for any
          //    edge case (e.g. delayed-confirmation payment methods) are
          //    Phase B-full's job; for card-on-file flow, pay() returns
          //    "paid" synchronously when the charge clears.
          await sb
            .from("refill_invoices")
            .update({
              stripe_invoice_id: paid.id,
              status: paid.status === "paid" ? "paid" : "sent",
              sent_at: new Date().toISOString(),
              paid_at:
                paid.status === "paid" ? new Date().toISOString() : null,
            })
            .eq("id", invRow.id);
        }
      } catch (e) {
        // Non-fatal. Leave DB at "draft" so the next run retries.
        console.error(
          `[refill-billing] Stripe push failed for tenant ${tenantId}:`,
          e instanceof Error ? e.message : e,
        );
      }
    }
  }

  return { created: true };
}

// ─── generateMonthlyInvoicesForAll (cron entry, v391.2) ──────────────────

export async function generateMonthlyInvoicesForAll(args: {
  sb: SupabaseAdmin;
  /**
   * Optional period override (YYYY-MM). When omitted, computes for the PRIOR
   * calendar month (production cron behavior on the 1st of each month).
   * Used by the manual-trigger path with ?period=YYYY-MM for testing Stripe
   * push against the current month's verified events.
   */
  periodMonth?: string;
}): Promise<{
  tenants: number;
  invoiced: number;
  errors: string[];
  periodStart: string;
  periodEnd: string;
}> {
  const { sb, periodMonth } = args;

  let periodStart: Date;
  let periodEnd: Date;
  if (periodMonth) {
    const m = /^(\d{4})-(\d{2})$/.exec(periodMonth);
    if (!m) {
      throw new Error(
        `periodMonth must be YYYY-MM (got "${periodMonth}").`,
      );
    }
    const y = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    periodStart = new Date(Date.UTC(y, mo - 1, 1));
    periodEnd = new Date(Date.UTC(y, mo, 1));
  } else {
    const now = new Date();
    periodEnd = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    periodStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1),
    );
  }

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

  return {
    tenants: tenantIds.length,
    invoiced,
    errors,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
  };
}

// ─── getPlanEconomics (UI helper) ────────────────────────────────────────

export function getPlanEconomics(plan: RefillPricingPlan) {
  return PLAN_ECONOMICS[plan];
}

// ─── getInvoicePreview (v1.26.23 — tenant-aware, restored) ───────────────

/**
 * In-progress month MTD preview for the Recovery dashboard.
 *
 * v1.26.14 removed the original tenant-aware preview here on the (wrong)
 * read that the recovery page wanted the emma-side variant. The emma side
 * reads emma_pricing_plans which is now structurally stale — any tenant
 * who picked a Refill plan via applyPricingPlan writes to
 * refill_pricing_plans, so the emma-side preview returns plan=null on
 * the dashboard. v1.26.23 restores this surface against the live tables
 * and the recovery page swaps its import.
 *
 * Math parity vs. the cron (generateMonthlyInvoiceForTenant) is locked by
 * aggregateRecoveryForTenant — both paths roll up the same memberships
 * fan-out + same emma_recovery_events filter.
 *
 * Plan-lookup shape: the cron uses "active AS OF period_end" (handles
 * mid-month plan switches — invoices under the plan that was active when
 * the month closed). The preview uses "currently active" (plan_ended_at
 * IS NULL) — the dashboard wants to show the spa owner what their
 * CURRENT plan would charge them, not what last month's plan would have.
 */

export type RefillInvoicePreview = {
  /** null when the tenant hasn't selected a plan yet — UI prompts them to. */
  plan: RefillPricingPlan | null;
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

export const getInvoicePreview = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => readWithViewAsInput.parse(input))
  .handler(async ({ data }): Promise<RefillInvoicePreview> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);

    const now = new Date();
    const periodStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    const periodEnd = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
    );

    const [planRes, agg] = await Promise.all([
      sb
        .from("refill_pricing_plans")
        .select("plan, revenue_share_pct, monthly_flat_usd")
        .eq("tenant_id", tenantId)
        .is("plan_ended_at", null)
        .order("plan_started_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      aggregateRecoveryForTenant({ sb, tenantId, periodStart, periodEnd }),
    ]);

    const periodStartIso = periodStart.toISOString();
    const periodEndIso = periodEnd.toISOString();
    const { recoveredRevenueUsd: mtdRecoveredUsd, recoveredRevenueCount: mtdRecoveredCount } = agg;

    if (!planRes.data) {
      return {
        plan: null,
        revenueSharePct: 0,
        monthlyFlatUsd: 0,
        periodStart: periodStartIso,
        periodEnd: periodEndIso,
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
      periodStart: periodStartIso,
      periodEnd: periodEndIso,
      mtdRecoveredUsd,
      mtdRecoveredCount,
      shareDueUsd,
      totalDueUsd,
    };
  });
