/**
 * POST /api/cron/emma-reliability-sweep — daily reliability recompute (v362).
 *
 * Iterates every spa and recomputes reliability_status for each patient
 * with appointment history. Tier transitions emit pattern_alerts.
 *
 * The foreground updateAppointmentStatus trigger covers real-time
 * recomputes; this cron is the safety net + the place to catch
 * "rolling 6mo window passed a no-show" passive transitions.
 *
 * Auth: SCHEDULER_SECRET (same secret v356 + v360 use).
 * Scope: optional ?userId= to recompute a single tenant (v2.51.0 — matches the
 *   reconcile/provider-relink crons; lets a manual run target one spa instead
 *   of recomputing every tenant + emitting collateral pattern_alerts).
 *
 * Established 2026-05-17 (Promotions Engine v362).
 */

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { recomputeReliabilityForUser } from "@/server/emma-reliability.functions";

function jsonResp(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const Route = createFileRoute("/api/cron/emma-reliability-sweep")({
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

        // Optional single-tenant scope (v2.51.0).
        const onlyUserId = new URL(request.url).searchParams.get("userId");

        // Pull every spa with at least one appointment. The reliability
        // engine only matters for spas using v360 appointment data.
        let spaQ = sb.from("emma_appointments").select("user_id").limit(10000);
        if (onlyUserId) spaQ = spaQ.eq("user_id", onlyUserId);
        const { data: spas, error } = await spaQ;
        if (error) return jsonResp(500, { error: `pull spas: ${error.message}` });
        const userIds = Array.from(
          new Set((spas ?? []).map((s) => s.user_id)),
        );

        let totalPatients = 0;
        let totalTransitions = 0;
        const errors: string[] = [];

        for (const userId of userIds) {
          try {
            const r = await recomputeReliabilityForUser({
              sb,
              userId,
              trigger: "cron",
            });
            totalPatients += r.patientsRecomputed;
            totalTransitions += r.transitions;
          } catch (e) {
            errors.push(
              `${userId}: ${e instanceof Error ? e.message : "unknown"}`,
            );
          }
        }

        return jsonResp(200, {
          ok: true,
          spas: userIds.length,
          patients_recomputed: totalPatients,
          transitions: totalTransitions,
          errors: errors.slice(0, 20),
        });
      },
    },
  },
});
