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
 * tenant, aggregates verified emma_recovery_events, applies the plan's
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
 * What is NOT in this route: Stripe push for draft invoices (deferred
 * to a later ship — flip draft → sent + finalize Stripe invoice once
 * the spa has stripe_customer_id_live populated). For now the cron
 * fills the table; spa owners see invoices in /app/billing history.
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

        try {
          const result = await generateMonthlyInvoicesForAll({ sb });
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
