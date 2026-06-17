/**
 * POST /api/cron/refill-invoice — Monthly invoice generation for Refill.
 *
 * Fired by pg_cron on the 1st of each month at 09:00 UTC (matches the
 * emma-invoice cadence so ops staff have a single mental model for
 * "billing runs"). Iterates every tenant with an active
 * refill_pricing_plans row and writes a draft refill_invoices row for the
 * PRIOR calendar month, idempotent on (tenant_id, period_start).
 *
 * The heavy lifting lives in src/server/refill-billing.ts —
 * generateMonthlyInvoicesForAll computes the period window from "now"
 * (1st of last month → 1st of this month), fans out memberships per
 * tenant, aggregates verified recovery_events, applies the plan's
 * revenue_share_pct + monthly_flat_usd, and upserts the invoice row.
 * Per-tenant failures are captured in the errors array; the cron
 * surfaces them in the response payload so Supabase Functions logs can
 * be inspected.
 *
 * Auth: x-scheduler-secret header — same gate as /api/cron/emma-invoice
 * and /api/cron/refill-trial-drip.
 *
 * Idempotent: re-running on the same day (or any day in the same month)
 * is a no-op for tenants whose invoice already exists. The
 * (tenant_id, period_start) unique constraint on refill_invoices
 * enforces this at the DB level — upsert with onConflict matches the
 * existing row.
 *
 * Stripe push (v1.7 Phase B-lite): when a draft row lands AND the tenant
 * has a Stripe customer + card on file AND the total is > $0, the cron
 * also creates a Stripe Invoice with auto_advance=true and finalizes it.
 * Stripe pulls from the saved card automatically; the DB row's status
 * flips draft → "sent" (or "paid" if the charge cleared synchronously)
 * and stripe_invoice_id stamps. Webhook-driven sent→paid flips are
 * Phase B-full's job.
 *
 * Manual trigger / testing: POST with ?period=YYYY-MM (e.g. ?period=2026-05)
 * overrides the prior-month default. Useful for verifying the Stripe push
 * path against the current month's verified events without waiting for
 * the cron's natural fire on the 1st of next month.
 */

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import { generateMonthlyInvoicesForAll } from "@/server/refill-billing";

function jsonResp(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const Route = createFileRoute("/api/cron/refill-invoice")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
        const SCHEDULER_SECRET = process.env.SCHEDULER_SECRET;
        if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
          return jsonResp(500, { error: "Server not configured." });
        }
        const cronSecret = request.headers.get("x-scheduler-secret");
        if (!SCHEDULER_SECRET || cronSecret !== SCHEDULER_SECRET) {
          return jsonResp(401, { error: "Unauthorized." });
        }

        const sb = createClient<Database>(
          SUPABASE_URL,
          SUPABASE_SERVICE_ROLE_KEY,
          { auth: { persistSession: false, autoRefreshToken: false } },
        );

        // Optional ?period=YYYY-MM override (manual-trigger / testing path).
        // Production cron leaves this off and gets the prior-month default.
        const url = new URL(request.url);
        const periodMonth = url.searchParams.get("period") ?? undefined;

        try {
          const result = await generateMonthlyInvoicesForAll({
            sb,
            periodMonth,
          });
          return jsonResp(200, {
            ok: true,
            ...result,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error("[refill-invoice] cron failed:", message);
          return jsonResp(500, { ok: false, error: message });
        }
      },
    },
  },
});
