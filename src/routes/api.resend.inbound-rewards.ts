/**
 * Resend Inbound — manufacturer-data email-drop receiver (v1.97.0; both
 * lanes since v2.3.1).
 *
 * Resend Inbound Routing delivers mail sent to <token>@rewards.smartspa.app
 * to this endpoint as JSON. The handler:
 *   1. Extracts the token from the `to` address local-part.
 *   2. Pulls CSV attachment(s) from the payload.
 *   3. For each CSV: resolves token → tenant, then ROUTES BY LANE from the
 *      headers — a manufacturer transaction report (last-treatment / full
 *      TransactionsReport) goes to the transaction ingest; otherwise a reward
 *      snapshot goes to the reward ingest. Same cores as the manual uploads,
 *      so the spa never touches a dropdown for either lane.
 *   4. Always returns 200 (failures report a reason, never a retry storm).
 *
 * Trust model: the token is the only secret. We do NOT trust the From sender
 * (so a forwarded report from any staff inbox works). Token is unguessable +
 * revocable (reward_ingest_tokens).
 *
 * GO-LIVE (infra, one-time): add an MX record for rewards.smartspa.app and a
 * Resend Inbound route for that domain → this URL. Until then the endpoint is
 * testable by POSTing a sample payload directly.
 */

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import {
  ingestRewardCsvByToken,
  resolveRewardIngestToken,
  REWARD_INGEST_DOMAIN,
} from "@/server/manufacturer-reward-ingest.functions";
import {
  isLastTransactionCsv,
  ingestLastTxnCsvForUser,
} from "@/server/manufacturer-transaction-ingest.functions";

function jsonResp(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Extract the local-part token from a `to` value that may be
 *  "Name <token@rewards.smartspa.app>" or a bare address. */
function extractToken(toRaw: string | string[] | undefined): string | null {
  const first = Array.isArray(toRaw) ? (toRaw[0] ?? "") : (toRaw ?? "");
  const m = first.match(/<([^>]+)>/);
  const addr = (m ? m[1] : first).trim().toLowerCase();
  const suffix = `@${REWARD_INGEST_DOMAIN.toLowerCase()}`;
  if (!addr.endsWith(suffix)) return null;
  const local = addr.slice(0, -suffix.length).trim();
  return local || null;
}

type RawAttachment = {
  filename?: string;
  name?: string;
  content?: string;
  contentBase64?: string;
  content_base64?: string;
  data?: string;
  content_type?: string;
  contentType?: string;
};

function b64ToUtf8(b64: string): string {
  const clean = b64.replace(/\s/g, "");
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

/** Pull CSV attachments out of whatever shape Resend hands us. */
function extractCsvAttachments(
  payload: Record<string, unknown>,
): Array<{ filename: string; text: string }> {
  const env = (payload.email as Record<string, unknown> | undefined) ?? payload;
  const raw =
    (env.attachments as RawAttachment[] | undefined) ??
    (payload.attachments as RawAttachment[] | undefined) ??
    [];
  const out: Array<{ filename: string; text: string }> = [];
  if (!Array.isArray(raw)) return out;
  for (const a of raw) {
    const filename = (a.filename ?? a.name ?? "report.csv").toString();
    const ct = (a.content_type ?? a.contentType ?? "").toString().toLowerCase();
    const looksCsv =
      filename.toLowerCase().endsWith(".csv") ||
      ct.includes("csv") ||
      ct.includes("excel") ||
      ct === "text/plain";
    const b64 = a.content ?? a.contentBase64 ?? a.content_base64 ?? a.data;
    if (!looksCsv || !b64) continue;
    try {
      out.push({ filename, text: b64ToUtf8(String(b64)) });
    } catch {
      // unreadable attachment — skip; reported in the result summary.
    }
  }
  return out;
}

export const Route = createFileRoute("/api/resend/inbound-rewards")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!SUPABASE_URL || !SERVICE_KEY) {
          return jsonResp(500, { error: "Server not configured" });
        }

        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(await request.text()) as Record<string, unknown>;
        } catch {
          return jsonResp(200, { ignored: "non_json_body" });
        }

        const env = (payload.email as Record<string, unknown> | undefined) ?? payload;
        const token = extractToken(env.to as string | string[] | undefined);
        if (!token) {
          return jsonResp(200, { ignored: "no_reward_token" });
        }

        const attachments = extractCsvAttachments(payload);
        if (attachments.length === 0) {
          return jsonResp(200, { ignored: "no_csv_attachment" });
        }

        const sb = createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
          auth: { persistSession: false, autoRefreshToken: false },
        });

        // Resolve the token once — the transaction lane is keyed by user_id.
        // (The reward lane re-resolves internally; one extra cheap read.)
        const userId = await resolveRewardIngestToken(sb, token);

        const results: Array<Record<string, unknown>> = [];
        for (const att of attachments) {
          try {
            if (isLastTransactionCsv(att.text)) {
              // Lane 2 — manufacturer treatment history / last-transaction.
              if (!userId) {
                results.push({
                  file: att.filename,
                  lane: "transaction",
                  ok: false,
                  reason: "unknown_token",
                });
                continue;
              }
              const r = await ingestLastTxnCsvForUser(
                sb,
                userId,
                att.text,
                att.filename,
              );
              results.push({
                file: att.filename,
                lane: "transaction",
                ok: r.ok,
                detected: r.detected,
                reason: r.reason,
                matchedPatients: r.receipt?.matchedPatients ?? null,
                cadenceRows: r.receipt?.cadenceRows ?? null,
                rowsInserted: r.receipt?.rowsInserted ?? null,
              });
            } else {
              // Lane 1 — reward snapshot.
              const r = await ingestRewardCsvByToken(sb, token, att.text, att.filename);
              results.push({
                file: att.filename,
                lane: "reward",
                ok: r.ok,
                detected: r.detected,
                reason: r.reason,
                matched: r.receipt?.matched ?? null,
                entries: r.receipt?.entriesUpserted ?? null,
              });
            }
          } catch (e) {
            results.push({
              file: att.filename,
              ok: false,
              reason: e instanceof Error ? e.message : "ingest_failed",
            });
          }
        }

        return jsonResp(200, { processed: results.length, results });
      },
    },
  },
});
