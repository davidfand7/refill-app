/**
 * Local delivery agent heartbeat ingest (v2.58.0).
 *
 * The blind leg made visible. A tiny pinger on the spa owner's Mac (scripts/
 * local-agent/) POSTs here on a fixed ~5-minute cadence carrying the spa's
 * per-agent secret. We stamp last_seen_at + whatever the agent could verify
 * (capabilities), and Connection Health ages that timestamp into a Live / Quiet
 * / Silent verdict (the 'presence' tier). The ABSENCE of recent pings is the
 * signal: a heartbeat fires regardless of workload, so silence unambiguously
 * means the local iMessage relay is offline.
 *
 * Auth: x-agent-secret (per-spa, unique). We identify the spa BY the secret —
 * no user id is sent. An unknown/missing secret → 401 (don't leak which exist).
 *
 *   POST /api/agent/heartbeat
 *     headers: x-agent-secret: <48-hex>
 *     body (all optional JSON):
 *       { "version": "pinger-1.0",
 *         "capabilities": { "messages_app": true },
 *         "status": "ok" }
 */

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";

function jsonResp(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const Route = createFileRoute("/api/agent/heartbeat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
          return jsonResp(500, { error: "Server not configured." });
        }

        const secret = request.headers.get("x-agent-secret");
        if (!secret) return jsonResp(401, { error: "Unauthorized." });

        const sb = createClient<Database>(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
          auth: { persistSession: false, autoRefreshToken: false },
        });

        // Identify the spa by its agent secret. local_agents isn't in the
        // generated types yet; loose view (mirrors the expected_sources cast).
        const agentTbl = (sb as unknown as { from(t: string): any }).from(
          "local_agents",
        );
        const { data: agent, error: lookupErr } = await agentTbl
          .select("id, capabilities")
          .eq("secret", secret)
          .maybeSingle();
        if (lookupErr) {
          return jsonResp(500, { error: "Lookup failed." });
        }
        if (!agent) return jsonResp(401, { error: "Unauthorized." });

        // Parse the (optional) body. A pinger that just wants to say "alive"
        // can POST nothing — we still stamp last_seen_at.
        let body: {
          version?: unknown;
          status?: unknown;
          capabilities?: unknown;
          label?: unknown;
        } = {};
        try {
          const raw = await request.text();
          if (raw) body = JSON.parse(raw);
        } catch {
          // Malformed body shouldn't drop the heartbeat — liveness still counts.
          body = {};
        }

        const nowIso = new Date().toISOString();
        const patch: Record<string, unknown> = {
          last_seen_at: nowIso,
          updated_at: nowIso,
        };
        // Only overwrite fields the agent actually sent — never clobber a known
        // capability snapshot to {} just because a ping omitted it.
        if (body.capabilities && typeof body.capabilities === "object") {
          patch.capabilities = body.capabilities;
        }
        if (typeof body.version === "string") patch.agent_version = body.version;
        if (typeof body.status === "string") patch.last_status = body.status;
        if (typeof body.label === "string" && body.label.trim()) {
          patch.label = body.label.trim();
        }

        const { error: updErr } = await agentTbl
          .update(patch)
          .eq("id", (agent as { id: string }).id);
        if (updErr) {
          return jsonResp(500, { error: "Could not record heartbeat." });
        }

        return jsonResp(200, { ok: true, seenAt: nowIso });
      },
    },
  },
});
