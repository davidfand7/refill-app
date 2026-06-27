/**
 * Outbound iMessage queue — ACK (v2.188.0).
 *
 * After the local helper sends (or fails to send) a claimed text via Messages.app,
 * it reports the outcome here. We close out the row ONLY if the presented
 * claim_token + spa match the lease — so a stale poll, a reclaimed row, or another
 * spa can't mark someone else's send done. A mismatch → 409 (the lease moved on).
 *
 * Auth: x-agent-secret — the SAME per-spa local_agents secret as claim/heartbeat.
 *
 *   POST /api/agent/queue/ack
 *     headers: x-agent-secret: <48-hex>
 *     body: { id, claimToken, status: "sent" | "failed", error?: string }
 *     200: { ok: true }   ·   409: stale/foreign claim   ·   400/401 on bad input
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

export const Route = createFileRoute("/api/agent/queue/ack")({
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

        const agentTbl = (sb as unknown as { from(t: string): any }).from(
          "local_agents",
        );
        const { data: agent, error: lookupErr } = await agentTbl
          .select("user_id")
          .eq("secret", secret)
          .maybeSingle();
        if (lookupErr) return jsonResp(500, { error: "Lookup failed." });
        if (!agent) return jsonResp(401, { error: "Unauthorized." });
        const userId = (agent as { user_id: string }).user_id;

        let body: {
          id?: unknown;
          claimToken?: unknown;
          status?: unknown;
          error?: unknown;
        } = {};
        try {
          const raw = await request.text();
          if (raw) body = JSON.parse(raw);
        } catch {
          return jsonResp(400, { error: "Malformed JSON body." });
        }

        const id = typeof body.id === "string" ? body.id : null;
        const claimToken =
          typeof body.claimToken === "string" ? body.claimToken : null;
        const status = body.status === "sent" || body.status === "failed"
          ? body.status
          : null;
        if (!id || !claimToken || !status) {
          return jsonResp(400, {
            error: "id, claimToken, and status (sent|failed) are required.",
          });
        }

        const nowIso = new Date().toISOString();
        const patch: Record<string, unknown> = {
          status,
          updated_at: nowIso,
          sent_at: status === "sent" ? nowIso : null,
          error:
            status === "failed" && typeof body.error === "string"
              ? body.error.slice(0, 500)
              : null,
        };

        // Guarded close-out: the row must belong to this spa, carry this lease,
        // and still be 'claimed'. .select() returns the affected rows so we can
        // tell a real close-out (1 row) from a stale/foreign ack (0 rows → 409).
        const queueTbl = (sb as unknown as { from(t: string): any }).from(
          "outbound_imessage_queue",
        );
        const { data: updated, error: updErr } = await queueTbl
          .update(patch)
          .eq("id", id)
          .eq("user_id", userId)
          .eq("claim_token", claimToken)
          .eq("status", "claimed")
          .select("id");
        if (updErr) return jsonResp(500, { error: "Could not record ack." });
        if (!Array.isArray(updated) || updated.length === 0) {
          return jsonResp(409, {
            error: "Claim is stale or not yours — nothing to ack.",
          });
        }

        return jsonResp(200, { ok: true });
      },
    },
  },
});
