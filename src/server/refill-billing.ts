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
import { admin } from "./admin-client";
import Stripe from "stripe";
import { z } from "zod";

import type { Database, Json } from "@/integrations/supabase/types";
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
import { WHITE_LABEL_PRICING } from "@/lib/brand";
import { resolveEffectiveUserId, verifyAuth } from "@/server/auth-helpers";
import { fetchAllRows } from "@/server/paginate";
import {
  loadEffectiveFeeConfig,
  aggregateMetricsForTenant,
  computeInvoiceTotal,
  loadPriorChargedThisYear,
  type LedgerLine,
} from "@/server/billing-fee-core";

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
export async function getTenantIdForUser(sb: SupabaseAdmin, userId: string): Promise<string> {
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
// pricing_plans + user-scoped recovery_events. That left the
// Recovery dashboard structurally stale: tenants on a refill_pricing_plans
// plan saw "no active plan" on /app/refill/recovery while /app/billing
// showed the real plan. Phase 1 of the billing unification extracts this
// aggregation step so both paths roll up the same way.
//
// Membership fan-out caveat: recovery_events still rides user_id
// (predates the tenant model). Direct tenant_id on recovery_events
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
    .from("recovery_events")
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
 * Recovery revenue is sourced from recovery_events for any user_id
 * with a membership in this tenant — the recovery engine writes user-scoped
 * rows because it predates the tenant model, but billing rolls up to the
 * tenant. Future ship: tenant_id column directly on recovery_events
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

  // v1.93.0: fee-rules model. Bill any tenant from its configured rules
  // (defaults = $0 base + $5/win) — no plan row required. Aggregate verified
  // wins per metric_key and price by the rules. Tiered plans retired as the
  // rate-source; refill_pricing_plans is kept only for historical snapshots.
  const cfg = await loadEffectiveFeeConfig(sb, tenantId);
  const agg = await aggregateMetricsForTenant({ sb, tenantId, periodStart, periodEnd });
  // Annual caps need YTD-already-charged for this metric (from closed invoices
  // earlier this calendar year). Strictly-before periodStart → idempotent.
  const priorChargedThisYearByMetric = await loadPriorChargedThisYear(sb, tenantId, periodStart);
  // totalDueUsd already includes the white-label add-on (loadEffectiveFeeConfig
  // resolves cfg.whiteLabelAddonUsd; computeInvoiceTotal folds it into the total),
  // so the cron, the billing ledger, and the dashboard preview can't drift.
  const { totalDueUsd, lines } = computeInvoiceTotal(cfg, agg, { priorChargedThisYearByMetric });

  // v2.68.0 — record the "Your Brand" white-label add-on as its own fee_breakdown
  // entry for the invoice's historical itemization (the charge already rides the
  // single Stripe line via totalDueUsd). Stored loosely (Json column) since it
  // isn't a typed recovered-revenue LedgerLine.
  const whiteLabelUsd = cfg.whiteLabelAddonUsd ?? 0;
  const feeBreakdown: unknown[] = [...lines];
  if (whiteLabelUsd > 0) {
    feeBreakdown.push({
      metricKey: "white_label_addon",
      label: "Your Brand — white-label",
      mode: "flat",
      charge: whiteLabelUsd,
      count: 1,
      enabled: true,
    });
  }

  // Back-compat rollups for the legacy invoice columns + the metric-charge
  // subtotal (total minus the flat fees — base + add-on — leaving the
  // recovered-revenue share only).
  let recoveredRevenueUsd = 0;
  let recoveredRevenueCount = 0;
  for (const a of agg.values()) {
    recoveredRevenueUsd += a.revenueUsd;
    recoveredRevenueCount += a.count;
  }
  recoveredRevenueUsd = +recoveredRevenueUsd.toFixed(2);
  const metricChargesUsd = +(totalDueUsd - cfg.monthlyBaseUsd - whiteLabelUsd).toFixed(2);

  // Nothing billable this period → skip (no empty draft rows). The white-label
  // add-on counts as billable, so a subscribed spa with zero wins still invoices.
  if (totalDueUsd <= 0 && recoveredRevenueCount === 0 && whiteLabelUsd <= 0) {
    return { created: false, reason: "No billable wins this period." };
  }

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
        plan_at_invoice: "fee_rules",
        revenue_share_pct: null,
        monthly_flat_usd: null,
        monthly_base_usd: cfg.monthlyBaseUsd,
        fee_breakdown: feeBreakdown as unknown as Json,
        recovered_revenue_count: recoveredRevenueCount,
        recovered_revenue_usd: recoveredRevenueUsd,
        share_due_usd: metricChargesUsd,
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
          const addonNote = whiteLabelUsd > 0 ? ` + Your Brand $${whiteLabelUsd}` : "";
          const description = `Refill — ${periodLabel} (${recoveredRevenueCount} win${
            recoveredRevenueCount === 1 ? "" : "s"
          }${addonNote} → $${totalDueUsd.toLocaleString()})`;

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

  // v1.92.0: page past the 1,000-row cap so the invoice cron never silently
  // skips active tenants once Refill scales past 1,000 of them.
  const plans = await fetchAllRows<{ tenant_id: string }>((from, to) =>
    sb
      .from("refill_pricing_plans")
      .select("tenant_id")
      .is("plan_ended_at", null)
      .order("tenant_id", { ascending: true })
      .range(from, to),
  );
  const tenantIdSet = new Set(plans.map((p) => p.tenant_id));

  // v2.68.0 — also invoice spas subscribed to the "Your Brand" white-label
  // add-on even if they have NO active pricing-plan row, so the $29/mo never
  // silently goes uncharged (feedback_silent_truncation_audit). brand_settings
  // is keyed by user_id → map to tenant_id via tenant_memberships. Loose cast
  // (table not in generated types); paginated.
  if (WHITE_LABEL_PRICING.amount && WHITE_LABEL_PRICING.amount > 0) {
    const entitledRows = await fetchAllRows<{ user_id: string }>((from, to) =>
      (sb as unknown as { from(t: string): any })
        .from("brand_settings")
        .select("user_id")
        .eq("entitled", true)
        .order("user_id", { ascending: true })
        .range(from, to),
    );
    const entitledUserIds = entitledRows.map((r) => r.user_id);
    if (entitledUserIds.length) {
      const memberships = await fetchAllRows<{ tenant_id: string }>((from, to) =>
        sb
          .from("tenant_memberships")
          .select("tenant_id")
          .in("user_id", entitledUserIds)
          .order("tenant_id", { ascending: true })
          .range(from, to),
      );
      for (const m of memberships) tenantIdSet.add(m.tenant_id);
    }
  }

  const tenantIds = Array.from(tenantIdSet);

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
 * reads pricing_plans which is now structurally stale — any tenant
 * who picked a Refill plan via applyPricingPlan writes to
 * refill_pricing_plans, so the emma-side preview returns plan=null on
 * the dashboard. v1.26.23 restores this surface against the live tables
 * and the recovery page swaps its import.
 *
 * Math parity vs. the cron (generateMonthlyInvoiceForTenant) is locked by
 * aggregateRecoveryForTenant — both paths roll up the same memberships
 * fan-out + same recovery_events filter.
 *
 * Plan-lookup shape: the cron uses "active AS OF period_end" (handles
 * mid-month plan switches — invoices under the plan that was active when
 * the month closed). The preview uses "currently active" (plan_ended_at
 * IS NULL) — the dashboard wants to show the spa owner what their
 * CURRENT plan would charge them, not what last month's plan would have.
 */

export type RefillInvoicePreview = {
  /** UTC start of the current calendar month (the period being previewed). */
  periodStart: string;
  /** UTC start of the next calendar month — the period closes here. */
  periodEnd: string;
  /** Per-tenant monthly base ($0 on the default free plan). */
  monthlyBaseUsd: number;
  /** Per-metric breakdown (count / revenue / charge) for the period. */
  lines: LedgerLine[];
  /** Total verified attributed revenue across metrics (display only). */
  mtdRecoveredUsd: number;
  /** Total verified wins across metrics. */
  mtdRecoveredCount: number;
  /** v2.68.0 — "Your Brand" white-label flat add-on this period ($0 unless the
   *  spa is subscribed). Included in totalDueUsd. */
  whiteLabelAddonUsd: number;
  /** monthly_base + white-label add-on + Σ(metric charges) — what the spa would
   *  owe if the period closed today. Anchored in code (fee-rules model), not the UI. */
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

    // Fee-rules model — same math as the cron invoice + the billing ledger,
    // so the dashboard preview can never drift from what we actually bill.
    const cfg = await loadEffectiveFeeConfig(sb, tenantId);
    const agg = await aggregateMetricsForTenant({ sb, tenantId, periodStart, periodEnd });
    const priorChargedThisYearByMetric = await loadPriorChargedThisYear(sb, tenantId, periodStart);
    const { totalDueUsd, lines } = computeInvoiceTotal(cfg, agg, { priorChargedThisYearByMetric });
    let mtdRecoveredUsd = 0;
    let mtdRecoveredCount = 0;
    for (const a of agg.values()) {
      mtdRecoveredUsd += a.revenueUsd;
      mtdRecoveredCount += a.count;
    }

    return {
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      monthlyBaseUsd: cfg.monthlyBaseUsd,
      lines,
      mtdRecoveredUsd: +mtdRecoveredUsd.toFixed(2),
      mtdRecoveredCount,
      whiteLabelAddonUsd: cfg.whiteLabelAddonUsd ?? 0,
      totalDueUsd,
    };
  });
