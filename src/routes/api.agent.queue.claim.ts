/**
 * Outbound iMessage queue — CLAIM (v2.188.0).
 *
 * The send half of the zero-setup sender (Build 2, Path B). The spa's local
 * menubar helper polls here on a cadence; we atomically lease up to `limit`
 * pending texts to THIS poll (FOR UPDATE SKIP LOCKED via the claim RPC, so two
 * polls never grab the same row) and hand back the bodies + the per-spa auto_send
 * flag. The helper sends each via Messages.app, then ACKs (api.agent.queue.ack).
 *
 * Auth: x-agent-secret — the SAME per-spa local_agents secret the heartbeat and
 * run-report use. We identify the spa BY the secret; unknown/missing → 401.
 *
 *   POST /api/agent/queue/claim
 *     headers: x-agent-secret: <48-hex>
 *     body (optional JSON): { "limit": 10 }   // capped at 50
 *     200: { items: [{ id, recipient, body, metadata }], claimToken, autoSend }
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

export const Route = createFileRoute("/api/agent/queue/claim")({
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

        // Identify the spa by its agent secret (same spine as heartbeat/run-report).
        const agentTbl = (sb as unknown as { from(t: string): any }).from(
          "local_agents",
        );
        const { data: agent, error: lookupErr } = await agentTbl
          .select("user_id, auto_send")
          .eq("secret", secret)
          .maybeSingle();
        if (lookupErr) return jsonResp(500, { error: "Lookup failed." });
        if (!agent) return jsonResp(401, { error: "Unauthorized." });
        const { user_id: userId, auto_send: autoSend } = agent as {
          user_id: string;
          auto_send: boolean | null;
        };

        // Optional limit (the RPC also clamps to [0,50]).
        let limit = 10;
        try {
          const raw = await request.text();
          if (raw) {
            const body = JSON.parse(raw) as { limit?: unknown };
            if (typeof body.limit === "number" && Number.isFinite(body.limit)) {
              limit = Math.max(1, Math.min(50, Math.trunc(body.limit)));
            }
          }
        } catch {
          // Malformed body → just use the default limit; don't drop the poll.
        }

        // One token leases this whole batch; the helper presents it on ack so a
        // stale/duplicate poll can't ack a row it doesn't own.
        const claimToken = crypto.randomUUID();

        const { data: rows, error: claimErr } = await (
          sb as unknown as {
            rpc(fn: string, args: Record<string, unknown>): any;
          }
        ).rpc("claim_outbound_imessages", {
          p_user_id: userId,
          p_limit: limit,
          p_claim_token: claimToken,
        });
        if (claimErr) {
          return jsonResp(500, { error: "Could not claim queue items." });
        }

        const items = (Array.isArray(rows) ? rows : []).map(
          (r: {
            id: string;
            recipient: string;
            body: string;
            metadata: unknown;
          }) => ({
            id: r.id,
            recipient: r.recipient,
            body: r.body,
            metadata: r.metadata ?? {},
          }),
        );

        return jsonResp(200, {
          items,
          claimToken,
          autoSend: autoSend === true,
        });
      },
    },
  },
});
