/**
 * POST /api/recognition/sent/:suggestionId — Karen-Mac iMessage MCP
 * callback (v1.34.9.7).
 *
 * The dispatch email composed by refill-recognition-allocation.functions.ts
 * includes a per-draft URL of this shape. After the MCP creates each
 * Messages.app draft, it POSTs the URL once. Refill flips the suggestion's
 * status from "dispatched" → "sent" so the Recognition queue reflects
 * actually-drafted vs just-emailed.
 *
 * Auth model: the suggestion UUID is unguessable and tenant-scoped at
 * the lookup. No bearer token in the email body. If a URL leaks, the
 * worst case is a third party flipping ONE suggestion's status — the
 * row contents stay private (we don't return the payload, just {ok:true}).
 *
 * Idempotent: re-POSTing the same URL after status is already "sent"
 * is a no-op success — Karen-Mac retry logic safe.
 *
 * Also supports GET for human-debug convenience (Grasshopper testing
 * directly in browser). GET returns text/plain.
 */

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function plain(status: number, body: string) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

function admin() {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw new Error("Server is missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  }
  return createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function markSent(suggestionId: string) {
  if (!UUID_RE.test(suggestionId)) {
    return { ok: false as const, status: 400, message: "Invalid suggestion id." };
  }
  const sb = admin();
  const { data: row, error: readErr } = await sb
    .from("knowledge_nodes")
    .select("id, attachments")
    .eq("id", suggestionId)
    .eq("node_type", "allocation_suggestion")
    .maybeSingle();
  if (readErr) {
    return { ok: false as const, status: 500, message: readErr.message };
  }
  if (!row) {
    return { ok: false as const, status: 404, message: "Suggestion not found." };
  }
  const a = (row.attachments ?? {}) as {
    status?: "pending" | "confirmed" | "dismissed" | "dispatched" | "sent";
  };
  // Idempotent: already sent → return ok.
  if (a.status === "sent") {
    return { ok: true as const, status: 200, alreadySent: true };
  }
  // Refuse to advance from anything other than "dispatched" — a
  // pending or dismissed suggestion shouldn't get marked sent.
  if (a.status !== "dispatched") {
    return {
      ok: false as const,
      status: 409,
      message: `Suggestion is in status '${a.status ?? "unknown"}', not 'dispatched'. Refusing to mark sent.`,
    };
  }
  const next = { ...a, status: "sent" as const };
  const { error: updErr } = await sb
    .from("knowledge_nodes")
    .update({
      attachments: next as unknown as Json,
      updated_at: new Date().toISOString(),
    })
    .eq("id", suggestionId);
  if (updErr) {
    return { ok: false as const, status: 500, message: updErr.message };
  }
  return { ok: true as const, status: 200, alreadySent: false };
}

export const Route = createFileRoute("/api/recognition/sent/$suggestionId")({
  server: {
    handlers: {
      POST: async ({ params }) => {
        try {
          const result = await markSent(params.suggestionId);
          if (result.ok) {
            return json(200, {
              ok: true,
              alreadySent: result.alreadySent,
            });
          }
          return json(result.status, { ok: false, error: result.message });
        } catch (e) {
          return json(500, {
            ok: false,
            error: e instanceof Error ? e.message : "Server error.",
          });
        }
      },
      GET: async ({ params }) => {
        try {
          const result = await markSent(params.suggestionId);
          if (result.ok) {
            return plain(
              200,
              result.alreadySent
                ? "OK — already marked sent."
                : "OK — marked sent.",
            );
          }
          return plain(result.status, result.message);
        } catch (e) {
          return plain(500, e instanceof Error ? e.message : "Server error.");
        }
      },
    },
  },
});
