/**
 * POST /api/refill-checkout
 *
 * Creates a Stripe Checkout Session for the Refill product. Mirrors
 * api.subscription.ts but tenant-scoped (not user-scoped) and uses two
 * different modes depending on the plan:
 *
 *   starter — mode:"setup". The free plan only needs a payment method on
 *             file; the 12% revenue share is billed monthly via Stripe
 *             Invoices created by the v391.2 cron (no recurring $0
 *             subscription, which would be ergonomically weird in
 *             Stripe's UI and runs into a historical $0.50 minimum).
 *
 *   pro     — mode:"subscription". $99/mo recurring base. The 8% revenue
 *             share gets layered on top via monthly Stripe Invoices the
 *             same way starter does (the recurring sub handles the flat
 *             portion; the cron handles the variable portion).
 *
 * Both flows attach metadata { product:"refill", tenant_id, plan } to the
 * Checkout session AND (for pro) to subscription_data, so the v391 webhook
 * router fires on both checkout.session.completed and the downstream
 * customer.subscription.* events with the metadata propagated.
 *
 * Customer identity is sourced from tenants.stripe_customer_id_{test|live}
 * (mode-aware per v391.2) when the spa has been here before in this mode;
 * otherwise we create a new Stripe Customer with tenant_id pinned in
 * metadata and stamp the matching column. Test-mode and live-mode ids are
 * stored in separate columns so flipping modes during development doesn't
 * destroy the other mode's customer history.
 *
 * Errors from the Stripe SDK are caught and surfaced as
 * { error: message, code? } with the Stripe statusCode (default 502) so
 * client toasts show the real upstream message instead of "HTTPError".
 *
 * Input: { plan: "starter" | "pro" }
 * Output: { url }  — redirect the browser to this URL
 * Auth: Authorization: Bearer <supabase-session-token>
 */

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";

import type { Database } from "@/integrations/supabase/types";
import {
  detectStripeMode,
  readTenantStripeCustomerId,
  tenantStripeCustomerColumn,
} from "@/lib/stripe-mode";

type RefillPlan = "starter" | "predictable" | "pro";

const PLAN_CONFIG: Record<
  RefillPlan,
  {
    label: string;
    description: string;
    mode: "setup" | "subscription";
    monthly_amount_cents: number; // 0 for setup mode
  }
> = {
  starter: {
    label: "Refill Performance",
    description: "Free base — 12% of recovered revenue billed monthly.",
    mode: "setup",
    monthly_amount_cents: 0,
  },
  predictable: {
    label: "Refill Predictable",
    description: "$299/mo flat — no revenue share, everything included.",
    mode: "subscription",
    monthly_amount_cents: 29900,
  },
  pro: {
    label: "Refill Hybrid",
    description: "$99/mo base — 8% of recovered revenue billed monthly.",
    mode: "subscription",
    monthly_amount_cents: 9900,
  },
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const Route = createFileRoute("/api/refill-checkout")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!STRIPE_SECRET_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
          return json(500, { error: "Server not configured" });
        }

        const token = request.headers.get("authorization")?.slice(7);
        if (!token) return json(401, { error: "Missing Bearer token" });

        const admin = createClient<Database>(
          SUPABASE_URL,
          SUPABASE_SERVICE_ROLE_KEY,
          {
            auth: {
              storage: undefined,
              persistSession: false,
              autoRefreshToken: false,
            },
          },
        );

        const { data: { user }, error: authErr } = await admin.auth.getUser(token);
        if (authErr || !user) return json(401, { error: "Invalid session" });

        let body: { plan?: string } = {};
        try {
          body = await request.json();
        } catch {
          /* empty */
        }

        const planKey = body.plan as RefillPlan;
        if (!PLAN_CONFIG[planKey]) {
          return json(400, {
            error: "plan must be 'starter', 'predictable', or 'pro'",
          });
        }
        const planCfg = PLAN_CONFIG[planKey];

        // Resolve tenant via membership. v391 enforces 1 user → 1 tenant in
        // the wizard, but the DB allows multiple; pick the oldest deterministically.
        const { data: membership } = await admin
          .from("tenant_memberships")
          .select("tenant_id, created_at")
          .eq("user_id", user.id)
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();
        if (!membership) {
          return json(400, {
            error:
              "No Refill spa found for this account. Finish onboarding before viewing billing.",
          });
        }
        const tenantId = membership.tenant_id;

        const { data: tenant } = await admin
          .from("tenants")
          .select(
            "id, slug, name, stripe_customer_id_test, stripe_customer_id_live",
          )
          .eq("id", tenantId)
          .maybeSingle();
        if (!tenant) {
          return json(500, { error: "Tenant row not found." });
        }

        // Mode is derived from the Stripe secret key in use right now.
        // The matching tenants column is the only one we read/write so that
        // flipping modes never reuses the wrong-universe customer id.
        const mode = detectStripeMode(STRIPE_SECRET_KEY);
        const customerColumn = tenantStripeCustomerColumn(mode);

        const stripe = new Stripe(STRIPE_SECRET_KEY, {
          apiVersion: "2026-04-22.dahlia",
        });

        try {
          // Reuse the existing Stripe customer for this tenant + mode if we
          // have one (preserves history across plan changes within the same
          // mode), otherwise create + stamp the mode-matching column.
          let customerId = readTenantStripeCustomerId(tenant, mode) ?? undefined;
          if (!customerId) {
            const customer = await stripe.customers.create({
              email: user.email ?? undefined,
              name: tenant.name,
              metadata: {
                tenant_id: tenant.id,
                tenant_slug: tenant.slug,
                owner_user_id: user.id,
                product: "refill",
                stripe_mode: mode,
              },
            });
            customerId = customer.id;
            await admin
              .from("tenants")
              .update({ [customerColumn]: customerId })
              .eq("id", tenant.id);
          }

          const origin =
            request.headers.get("origin") ??
            `https://${tenant.slug}.getrefill.app`;
          const successUrl = `${origin}/app/billing?upgrade=success&plan=${planKey}`;
          const cancelUrl = `${origin}/app/billing?upgrade=cancelled`;

          // metadata is the contract with the v391 webhook router — must
          // include product:"refill" AND tenant_id so handleRefillEvent in
          // supabase/functions/stripe-webhook/index.ts can resolve the spa.
          const sharedMetadata = {
            product: "refill",
            tenant_id: tenant.id,
            plan: planKey,
          };

          if (planCfg.mode === "setup") {
            const session = await stripe.checkout.sessions.create({
              mode: "setup",
              customer: customerId,
              payment_method_types: ["card"],
              metadata: sharedMetadata,
              setup_intent_data: { metadata: sharedMetadata },
              success_url: successUrl,
              cancel_url: cancelUrl,
            });
            return json(200, { url: session.url });
          }

          // pro: recurring $99/mo. price_data inline so no Stripe Dashboard
          // price setup is required — Stripe creates the price on the fly.
          const session = await stripe.checkout.sessions.create({
            mode: "subscription",
            customer: customerId,
            line_items: [
              {
                price_data: {
                  currency: "usd",
                  unit_amount: planCfg.monthly_amount_cents,
                  recurring: { interval: "month" },
                  product_data: {
                    name: planCfg.label,
                    description: planCfg.description,
                  },
                },
                quantity: 1,
              },
            ],
            metadata: sharedMetadata,
            subscription_data: { metadata: sharedMetadata },
            success_url: successUrl,
            cancel_url: cancelUrl,
            allow_promotion_codes: true,
          });

          return json(200, { url: session.url });
        } catch (err) {
          if (err instanceof Stripe.errors.StripeError) {
            return json(err.statusCode ?? 502, {
              error: err.message,
              code: err.code,
              type: err.type,
            });
          }
          const message = err instanceof Error ? err.message : String(err);
          return json(500, { error: message });
        }
      },
    },
  },
});
