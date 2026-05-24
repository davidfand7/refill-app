/**
 * POST /api/refill-portal
 *
 * Creates a Stripe Customer Portal session for the spa's tenant. Mirrors
 * api.subscription.portal.ts but resolves the Stripe customer via the
 * mode-aware tenants.stripe_customer_id_{test|live} column (v391.2). The
 * id stamped during checkout in api.refill-checkout.ts lives in the column
 * matching the Stripe key mode at that time; this route reads the same
 * column for the current mode.
 *
 * From the portal the spa owner can:
 *   - Update their payment method
 *   - View past invoices (created by the v391.2 monthly cron)
 *   - Cancel their plan (fires customer.subscription.deleted → v391 webhook
 *     sets tenants.plan='cancelled' and closes the active refill_pricing_plans row)
 *
 * Errors from the Stripe SDK are caught and surfaced as
 * { error: message, code? } with the Stripe statusCode (default 502) so
 * client toasts show the real upstream message instead of "HTTPError".
 *
 * Returns { url } — redirect the browser to it.
 * Auth: Authorization: Bearer <supabase-session-token>
 */

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";

import type { Database } from "@/integrations/supabase/types";
import { detectStripeMode, readTenantStripeCustomerId } from "@/lib/stripe-mode";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const Route = createFileRoute("/api/refill-portal")({
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

        const { data: membership } = await admin
          .from("tenant_memberships")
          .select("tenant_id")
          .eq("user_id", user.id)
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();
        if (!membership) {
          return json(400, {
            error: "No Refill spa found for this account.",
          });
        }

        const { data: tenant } = await admin
          .from("tenants")
          .select("slug, stripe_customer_id_test, stripe_customer_id_live")
          .eq("id", membership.tenant_id)
          .maybeSingle();
        if (!tenant) {
          return json(500, { error: "Tenant row not found." });
        }

        const mode = detectStripeMode(STRIPE_SECRET_KEY);
        const customerId = readTenantStripeCustomerId(tenant, mode);
        if (!customerId) {
          return json(400, {
            error:
              "No payment method on file yet. Pick a plan first to set one up.",
          });
        }

        const stripe = new Stripe(STRIPE_SECRET_KEY, {
          apiVersion: "2026-04-22.dahlia",
        });

        const origin =
          request.headers.get("origin") ??
          `https://${tenant.slug}.getrefill.app`;

        try {
          const session = await stripe.billingPortal.sessions.create({
            customer: customerId,
            return_url: `${origin}/app/billing`,
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
