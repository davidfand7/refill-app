/**
 * Acuity reconcile cron (v2.41.0) — the calendar-mirror self-healing backstop.
 *
 * Acuity ingest is webhook-driven (realtime). This cron is the safety net: a
 * few-hour sweep that re-pulls a recent window per connected Acuity tenant and
 * upserts idempotently, so a dropped/missed webhook can't leave the calendar
 * SILENTLY stale (the #1 trust risk per the Connection-Health doctrine). It
 * fires the same rescue + reliability trigger graph as the webhook, but only on
 * a genuine status transition vs. the stored row — never double-acting on a
 * change the webhook already handled.
 *
 * Auth: x-scheduler-secret header — same gate as the rest of the cron fleet.
 * Callable manually for testing: POST with the secret (+ optional ?userId= to
 * scope to one tenant, ?force=1 is a no-op kept for symmetry).
 */

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import { reconcileAcuityForConnection } from "@/server/emma-scheduler.functions";

function jsonResp(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const Route = createFileRoute("/api/cron/acuity-reconcile")({
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

        const onlyUserId = new URL(request.url).searchParams.get("userId");

        let q = sb
          .from("emma_scheduler_connections")
          .select("id, user_id, access_token")
          .eq("platform", "acuity")
          .eq("status", "connected");
        if (onlyUserId) q = q.eq("user_id", onlyUserId);
        const { data: connections, error } = await q;
        if (error) {
          return jsonResp(500, { error: `Couldn't load connections: ${error.message}` });
        }
        if (!connections || connections.length === 0) {
          return jsonResp(200, { ok: true, connections: 0, note: "no connected Acuity calendars" });
        }

        let pulled = 0;
        let changed = 0;
        let rescued = 0;
        let reliabilityRecomputed = 0;
        let reconciled = 0;
        let failed = 0;
        let windowCapHit = 0;
        for (const conn of connections) {
          if (!conn.access_token) continue;
          try {
            const r = await reconcileAcuityForConnection({
              sb,
              userId: conn.user_id,
              accessToken: conn.access_token,
            });
            reconciled++;
            pulled += r.pulled;
            changed += r.changed;
            rescued += r.rescued;
            reliabilityRecomputed += r.reliabilityRecomputed;
            if (r.windowCapHit) windowCapHit++;
          } catch (e) {
            failed++;
            console.error(
              `[acuity-reconcile] connection ${conn.id} failed:`,
              e instanceof Error ? e.message : e,
            );
          }
        }

        return jsonResp(200, {
          ok: true,
          connections: connections.length,
          reconciled,
          failed,
          windowCapHit,
          pulled,
          changed,
          rescued,
          reliabilityRecomputed,
        });
      },
    },
  },
});
