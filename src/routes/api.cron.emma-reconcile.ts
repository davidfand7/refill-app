/**
 * POST /api/cron/emma-reconcile — daily QBO reconciliation (v363).
 *
 * For each spa with unverified recovery events, attempts to match
 * each event to a patient_transactions row (by patient + date window
 * after the event). On match: stamp verified_at + 'qbo' + revenue.
 *
 * Manual confirmation always works as a fallback for any missed match
 * or non-QBO spas — see manualConfirmRecovery in
 * emma-attribution.functions.ts.
 *
 * Auth: SCHEDULER_SECRET (same secret v356, v360, v362 use).
 *
 * Established 2026-05-17 (Promotions Engine v363).
 */

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { reconcileRecoveryEventsForUser } from "@/server/emma-attribution.functions";

function jsonResp(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const Route = createFileRoute("/api/cron/emma-reconcile")({
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

        // Find spas with at least one unverified recovery event.
        const { data: rows, error } = await sb
          .from("emma_recovery_events")
          .select("user_id")
          .is("verified_at", null)
          .limit(10000);
        if (error) return jsonResp(500, { error: `scan: ${error.message}` });
        const userIds = Array.from(new Set((rows ?? []).map((r) => r.user_id)));

        let totalMatched = 0;
        let totalScanned = 0;
        const errors: string[] = [];

        for (const userId of userIds) {
          try {
            const r = await reconcileRecoveryEventsForUser({ sb, userId });
            totalMatched += r.matched;
            totalScanned += r.scanned;
          } catch (e) {
            errors.push(
              `${userId}: ${e instanceof Error ? e.message : "unknown"}`,
            );
          }
        }

        return jsonResp(200, {
          ok: true,
          spas_with_unverified: userIds.length,
          scanned: totalScanned,
          matched: totalMatched,
          errors: errors.slice(0, 20),
        });
      },
    },
  },
});
