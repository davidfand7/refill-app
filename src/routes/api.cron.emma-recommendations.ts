/**
 * POST /api/cron/emma-recommendations — weekly recommendation regen (v365).
 *
 * Iterates every spa with an noshow_policies row + regenerates
 * setting recommendations. Foreground regen also fires on page-view
 * with a 1-hour debounce; this weekly cron is the safety net for
 * spas that haven't opened /app/refill/rescue recently.
 *
 * Auth: SCHEDULER_SECRET.
 *
 * Established 2026-05-17 (Promotions Engine v365).
 */

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  computeBenchmarks,
  generateRecommendationsForUser,
} from "@/server/emma-intelligence.functions";

function jsonResp(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const Route = createFileRoute("/api/cron/emma-recommendations")({
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

        // Pull every spa with a policy row (i.e. they've configured noshow at least once).
        const { data: rows, error } = await sb
          .from("noshow_policies")
          .select("user_id");
        if (error) return jsonResp(500, { error: `pull: ${error.message}` });
        const userIds = Array.from(new Set((rows ?? []).map((r) => r.user_id)));

        let totalGenerated = 0;
        let totalSkipped = 0;
        const errors: string[] = [];

        // First: try to refresh the benchmark aggregate (no-op below N=10).
        try {
          await computeBenchmarks({ sb });
        } catch (e) {
          errors.push(
            `benchmarks: ${e instanceof Error ? e.message : "unknown"}`,
          );
        }

        // Per-spa regen.
        for (const userId of userIds) {
          try {
            const r = await generateRecommendationsForUser({ sb, userId });
            totalGenerated += r.generated;
            totalSkipped += r.skipped;
          } catch (e) {
            errors.push(
              `${userId}: ${e instanceof Error ? e.message : "unknown"}`,
            );
          }
        }

        return jsonResp(200, {
          ok: true,
          spas: userIds.length,
          recommendations_generated: totalGenerated,
          recommendations_skipped: totalSkipped,
          errors: errors.slice(0, 20),
        });
      },
    },
  },
});
