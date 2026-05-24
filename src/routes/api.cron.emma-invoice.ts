/**
 * POST /api/cron/emma-invoice — monthly invoice generation (v366).
 *
 * Fires on the 1st of each month at 09:00 UTC. Iterates every spa with
 * an active pricing plan and generates the prior month's invoice.
 *
 * v366 invoices land in 'draft' status — no Stripe push, no payment
 * collection. v366.x flips draft → sent + activates the Stripe flow
 * when a real spa adds a payment method.
 *
 * Auth: SCHEDULER_SECRET.
 *
 * Established 2026-05-17 (Promotions Engine v366 — engine complete).
 */

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { generateMonthlyInvoicesForAll } from "@/server/emma-billing.functions";

function jsonResp(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const Route = createFileRoute("/api/cron/emma-invoice")({
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

        const sb = createClient<Database>(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
          auth: { persistSession: false, autoRefreshToken: false },
        });

        try {
          const r = await generateMonthlyInvoicesForAll({ sb });
          return jsonResp(200, {
            ok: true,
            spas: r.spas,
            invoiced: r.invoiced,
            errors: r.errors.slice(0, 20),
          });
        } catch (e) {
          return jsonResp(500, {
            error: e instanceof Error ? e.message : "unknown",
          });
        }
      },
    },
  },
});
