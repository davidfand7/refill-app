/**
 * Acuity provider wide-relink (v2.47.0) — one-time historical backlink.
 *
 * The reconcile cron only re-links a recent window (7d back / 45d fwd), so an
 * Acuity connection with deep history keeps weaker BY-NAME provider links on
 * its older appointments (the one-shot staging mirror can only match by
 * provider_name; calendarID — the authoritative link — rides a live Acuity
 * pull). This endpoint re-pulls a WIDE window purely to learn each
 * appointment's calendarID and surgically corrects provider_id (and nothing
 * else — never status or patient links). Idempotent: safe to re-run.
 *
 * NOT a recurring cron — it's a fire-once-per-connection onboarding/repair
 * primitive. Auth: x-scheduler-secret (same gate as the cron fleet).
 *
 *   POST /api/cron/acuity-provider-relink
 *     ?userId=<uuid>      scope to one tenant (recommended for a manual run)
 *     ?daysBack=<n>       override the look-back window (default 730)
 *     ?daysForward=<n>    override the look-ahead window (default 365)
 */

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import { wideRelinkAcuityProviders } from "@/server/emma-scheduler.functions";

function jsonResp(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const Route = createFileRoute("/api/cron/acuity-provider-relink")({
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

        const url = new URL(request.url);
        const onlyUserId = url.searchParams.get("userId");
        const daysBackParam = url.searchParams.get("daysBack");
        const daysForwardParam = url.searchParams.get("daysForward");
        const daysBack = daysBackParam ? Number(daysBackParam) : undefined;
        const daysForward = daysForwardParam ? Number(daysForwardParam) : undefined;

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
        let resolvable = 0;
        let relinked = 0;
        let relinkedConnections = 0;
        let failed = 0;
        let apiCapHit = false;
        const perConnection: Array<{
          userId: string;
          pulled: number;
          resolvable: number;
          relinked: number;
          apiCapHit: boolean;
        }> = [];
        for (const conn of connections) {
          if (!conn.access_token) continue;
          try {
            const r = await wideRelinkAcuityProviders({
              sb,
              userId: conn.user_id,
              accessToken: conn.access_token,
              daysBack,
              daysForward,
            });
            relinkedConnections++;
            pulled += r.pulled;
            resolvable += r.resolvable;
            relinked += r.relinked;
            apiCapHit = apiCapHit || r.apiCapHit;
            perConnection.push({ userId: conn.user_id, ...r });
          } catch (e) {
            failed++;
            console.error(
              `[acuity-provider-relink] connection ${conn.id} failed:`,
              e instanceof Error ? e.message : e,
            );
          }
        }

        return jsonResp(200, {
          ok: true,
          connections: connections.length,
          relinkedConnections,
          failed,
          pulled,
          resolvable,
          relinked,
          apiCapHit,
          perConnection,
        });
      },
    },
  },
});
