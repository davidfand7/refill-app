/**
 * POST /api/cron/recall-digest — the weekly Recall Digest routine (v2.22.0).
 *
 * The honest "Auto-Recall" Skill. Fired by pg_cron once a week, it walks every
 * spa that has turned the digest on (noshow_policies.recall_digest_enabled
 * = true — the Skill's adopt/On flips it), computes that spa's recall view
 * (computeRecallView — the SAME math the Recall page renders), and emails the
 * owner a heads-up: "$X on the table across N patients due."
 *
 * What it does NOT do: send a single message to a patient. The digest is a
 * nudge to come review; sending stays one-click and consented on the Recall
 * page. Autonomous patient outreach is the Tier-2 line (project_trusted_
 * onboarding) and is deliberately not crossed here.
 *
 * Honest by construction:
 *   • a spa with nobody to recall gets NO email (no noise),
 *   • a spa with no owner email on file is skipped + logged,
 *   • a 6-day dedup guard (recall_digest_last_sent_at) makes re-runs safe.
 *
 * Auth: x-scheduler-secret header — same gate as the other crons.
 * Manual verify: POST with ?force=1 to bypass the dedup guard (re-send to all
 * enabled spas now), or ?userId=<uuid> to target a single spa.
 *
 * Established 2026-06-13 (Skill Funnel — Recall Digest).
 */

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { sendRecallDigestForUser } from "@/server/refill-recall.functions";

function jsonResp(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// recall_digest_* columns aren't in types.ts yet (loose posture, same as the
// skills tables). Read the enable flag + last-sent through a narrow cast.
type DigestPolicyRow = {
  user_id: string;
  recall_digest_last_sent_at: string | null;
};

const DEDUP_DAYS = 6;

export const Route = createFileRoute("/api/cron/recall-digest")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
        const SCHEDULER_SECRET = process.env.SCHEDULER_SECRET;
        const PUBLIC_ORIGIN =
          process.env.REFILL_PUBLIC_ORIGIN ?? "https://getrefill.app";
        if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
          return jsonResp(500, { error: "Server not configured." });
        }
        const cronSecret = request.headers.get("x-scheduler-secret");
        if (!SCHEDULER_SECRET || cronSecret !== SCHEDULER_SECRET) {
          return jsonResp(401, { error: "Unauthorized." });
        }

        const sb = createClient<Database>(
          SUPABASE_URL,
          SUPABASE_SERVICE_ROLE_KEY,
          { auth: { persistSession: false, autoRefreshToken: false } },
        );

        const url = new URL(request.url);
        const force = url.searchParams.get("force") === "1";
        const onlyUserId = url.searchParams.get("userId");

        // Pull every spa with the digest turned on. recall_digest_enabled isn't
        // in the generated types — reach the filter through a loose view.
        const loose = sb as unknown as {
          from(t: string): {
            select(c: string): {
              eq(
                col: string,
                val: unknown,
              ): Promise<{ data: unknown; error: { message: string } | null }>;
            };
          };
        };
        const { data: rawRows, error } = await loose
          .from("noshow_policies")
          .select("user_id, recall_digest_last_sent_at")
          .eq("recall_digest_enabled", true);
        if (error) return jsonResp(500, { error: `pull: ${error.message}` });

        let rows = (rawRows as DigestPolicyRow[] | null) ?? [];
        if (onlyUserId) rows = rows.filter((r) => r.user_id === onlyUserId);

        // Dedup: skip spas digested within the last DEDUP_DAYS unless forced.
        const cutoff = Date.now() - DEDUP_DAYS * 24 * 60 * 60 * 1000;
        const due = force
          ? rows
          : rows.filter((r) => {
              if (!r.recall_digest_last_sent_at) return true;
              const t = Date.parse(r.recall_digest_last_sent_at);
              return Number.isNaN(t) || t < cutoff;
            });

        let sent = 0;
        let empty = 0;
        let skippedNoEmail = 0;
        let skippedPaused = 0;
        const errors: string[] = [];

        for (const r of due) {
          try {
            const result = await sendRecallDigestForUser(
              sb,
              r.user_id,
              PUBLIC_ORIGIN,
            );
            if (result.status === "sent") sent += 1;
            else if (result.status === "empty") empty += 1;
            else if (result.status === "no_email") skippedNoEmail += 1;
            else if (result.status === "paused") skippedPaused += 1;
            else errors.push(`${r.user_id}: ${result.error}`);
          } catch (e) {
            errors.push(
              `${r.user_id}: ${e instanceof Error ? e.message : "unknown"}`,
            );
          }
        }

        return jsonResp(200, {
          ok: true,
          enabled_spas: rows.length,
          due_this_run: due.length,
          digests_sent: sent,
          nothing_to_recall: empty,
          skipped_no_owner_email: skippedNoEmail,
          skipped_paused: skippedPaused,
          errors: errors.slice(0, 20),
        });
      },
    },
  },
});
