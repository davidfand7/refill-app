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

        // Find spas with at least one LIVE unverified recovery event.
        // v2.29.0: skip expired ones — a spa whose only unverified rows are
        // expired no longer needs a reconcile pass (the rows are dead).
        // expired_at isn't in the generated types yet → loose-cast the filter.
        const { data: rows, error } = await (
          sb.from("recovery_events") as unknown as { select(c: string): any }
        )
          .select("user_id")
          .is("verified_at", null)
          .is("expired_at", null)
          .limit(10000);
        if (error) return jsonResp(500, { error: `scan: ${error.message}` });
        const userIds = Array.from(
          new Set(((rows ?? []) as { user_id: string }[]).map((r) => r.user_id)),
        );

        let totalMatched = 0;
        let totalScanned = 0;
        let totalQueuedForReview = 0;
        let totalExpired = 0;
        const errors: string[] = [];

        for (const userId of userIds) {
          try {
            const r = await reconcileRecoveryEventsForUser({ sb, userId });
            totalMatched += r.matched;
            totalScanned += r.scanned;
            totalQueuedForReview += r.queuedForReview;
            totalExpired += r.expired;
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
          // v1.34.9.5: matches at/above the spa's auto-confirm threshold
          // that got proposed amounts written but stayed unverified for
          // Karen to review on /app/refill/recovery.
          queued_for_review: totalQueuedForReview,
          // v2.29.0: provisionals retired unmatched-past-window this pass.
          expired: totalExpired,
          errors: errors.slice(0, 20),
        });
      },
    },
  },
});
