/**
 * Drafting-routine run report ingest (v2.187.0).
 *
 * THE DARK LINK MADE VISIBLE. The heartbeat (api.agent.heartbeat) proves the
 * relay Mac is alive; this proves the DRAFTING actually worked. The spa owner's
 * Claude Desktop routine ("Refill rescue drafter") reads the proxy emails and
 * stages iMessage drafts — a leg inside Claude Desktop that SmartSpa cannot see.
 * After each run the routine POSTs its summary here (including the self-diagnosis
 * its run-log already produces, e.g. "Gmail connector not connected"). We stamp
 * the LATEST run onto the spa's local_agents row and Connection Health ages it
 * into a "Drafting in Messages" verdict — inferred health becomes observed.
 *
 * Auth: x-agent-secret — the SAME per-spa secret the heartbeat uses. We identify
 * the spa BY the secret; an unknown/missing secret → 401 (don't leak which exist).
 *
 *   POST /api/agent/run-report
 *     headers: x-agent-secret: <48-hex>
 *     body (JSON, all optional but send what the run knows):
 *       { "found": 3, "drafted": 3, "skipped": 0,
 *         "errors": ["..."],            // short strings; non-empty → broken
 *         "diagnosis": "ok" }           // the routine's own one-line self-report
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

/** Coerce an unknown to a non-negative integer, or undefined if not a number.
 *  Undefined → the column isn't touched (never clobber a known count to 0). */
function toCount(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return Math.max(0, Math.trunc(v));
}

export const Route = createFileRoute("/api/agent/run-report")({
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

        // Identify the spa by its agent secret (same spine as the heartbeat).
        // local_agents isn't in the generated types yet; loose view.
        const agentTbl = (sb as unknown as { from(t: string): any }).from(
          "local_agents",
        );
        const { data: agent, error: lookupErr } = await agentTbl
          .select("id")
          .eq("secret", secret)
          .maybeSingle();
        if (lookupErr) return jsonResp(500, { error: "Lookup failed." });
        if (!agent) return jsonResp(401, { error: "Unauthorized." });

        // Parse the body. Unlike the heartbeat (which counts even when empty),
        // a run-report with nothing to say is pointless — but we still stamp
        // last_run_at so "the routine ran" is recorded even on a quiet run.
        let body: {
          found?: unknown;
          drafted?: unknown;
          skipped?: unknown;
          errors?: unknown;
          diagnosis?: unknown;
        } = {};
        try {
          const raw = await request.text();
          if (raw) body = JSON.parse(raw);
        } catch {
          return jsonResp(400, { error: "Malformed JSON body." });
        }

        const nowIso = new Date().toISOString();
        const patch: Record<string, unknown> = {
          last_run_at: nowIso,
          updated_at: nowIso,
        };

        // Only overwrite a count the run actually reported — a run that omits
        // "drafted" shouldn't reset a prior known value to 0.
        const found = toCount(body.found);
        const drafted = toCount(body.drafted);
        const skipped = toCount(body.skipped);
        if (found !== undefined) patch.last_run_found = found;
        if (drafted !== undefined) patch.last_run_drafted = drafted;
        if (skipped !== undefined) patch.last_run_skipped = skipped;

        // errors → array of short strings. Always set (default []) so a clean
        // run CLEARS a prior run's errors rather than leaving a stale failure up.
        const errors = Array.isArray(body.errors)
          ? body.errors
              .map((e) => (typeof e === "string" ? e : String(e)))
              .filter((e) => e.trim().length > 0)
              .slice(0, 20)
              .map((e) => e.slice(0, 500))
          : [];
        patch.last_run_errors = errors;

        // diagnosis → the routine's verbatim one-liner. Always set (clear on a
        // clean run) so the card never shows a fixed-since-resolved diagnosis.
        patch.last_run_diagnosis =
          typeof body.diagnosis === "string" && body.diagnosis.trim()
            ? body.diagnosis.trim().slice(0, 500)
            : null;

        const { error: updErr } = await agentTbl
          .update(patch)
          .eq("id", (agent as { id: string }).id);
        if (updErr) {
          return jsonResp(500, { error: "Could not record run report." });
        }

        return jsonResp(200, { ok: true, reportedAt: nowIso });
      },
    },
  },
});
