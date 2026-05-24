/**
 * POST /api/cron/emma-sweep — fires scheduled Emma campaign sends (v356).
 *
 * The pg_cron job in supabase/migrations/20260516020000_emma_sweep_cron.sql
 * hits this endpoint every minute with the X-Scheduler-Secret header
 * (same secret the foreground agent scheduler uses — one secret, two
 * sweeps, simpler to manage). The endpoint scans
 * patient_outreach_state for rows where state='scheduled' AND
 * scheduled_at <= now(), race-safe-locks each, and dispatches through
 * the same dispatchOutreach helper that the foreground Send button
 * uses — so compliance rails (quiet hours, velocity cap, opted_out,
 * banned) run identically on scheduled sends.
 *
 * Race-safety: the lock is an UPDATE patient_outreach_state SET
 * state='targeted', scheduled_at=null WHERE id=$id AND state='scheduled'
 * RETURNING *. Two concurrent sweeps will race on that UPDATE; only
 * the winner sees the row returned. The loser sees an empty result
 * and skips. Postgres row-level locking handles the rest.
 *
 * Skip behavior: if dispatchOutreach refuses (quiet hours, no email
 * on file, etc.) the row sits in 'targeted' state with scheduled_at
 * already cleared. The skip is audited in patient_outreach with
 * skip_reason. The spa can re-schedule or send manually from the
 * composer; we don't auto-retry — silent retries hide a problem.
 *
 * Batch size: caps at 200 rows per sweep tick. A spa with 500 patients
 * who schedules a single 9am blast will be fully dispatched within
 * 2-3 minute ticks — well inside the practical "scheduled to land at 9"
 * tolerance. Future ship can lift the cap once we benchmark dispatch
 * latency under real load.
 */

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { dispatchOutreach } from "@/server/emma-blast.functions";

function jsonResp(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const BATCH_SIZE = 200;

export const Route = createFileRoute("/api/cron/emma-sweep")({
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

        // 1) Find candidate rows. ORDER BY scheduled_at so the oldest
        //    waiting row fires first if we hit the batch cap.
        const { data: due, error: pickErr } = await sb
          .from("patient_outreach_state")
          .select("id, user_id, campaign_node_id, patient_node_id, scheduled_at")
          .eq("state", "scheduled")
          .lte("scheduled_at", new Date().toISOString())
          .order("scheduled_at", { ascending: true })
          .limit(BATCH_SIZE);
        if (pickErr) {
          return jsonResp(500, { error: `pick: ${pickErr.message}` });
        }

        if (!due || due.length === 0) {
          return jsonResp(200, { ok: true, picked: 0, dispatched: 0, skipped: 0 });
        }

        let dispatched = 0;
        let skipped = 0;
        const errors: string[] = [];

        // 2) Race-safe lock + dispatch, serialized per row. We could
        //    parallelize but Resend / Twilio are rate-limited and the
        //    serial loop keeps the sweep predictable under bursty load.
        for (const row of due) {
          // Lock the row: only one sweep tick wins. The state guard
          // means a second concurrent sweep on the same row sees zero
          // rows returned and skips.
          const { data: locked, error: lockErr } = await sb
            .from("patient_outreach_state")
            .update({ state: "targeted", scheduled_at: null })
            .eq("id", row.id)
            .eq("state", "scheduled")
            .select("id")
            .maybeSingle();
          if (lockErr) {
            errors.push(`lock ${row.id}: ${lockErr.message}`);
            continue;
          }
          if (!locked) {
            // Another sweep won the race or the row state changed since
            // the SELECT. Either way, not our row to send.
            continue;
          }

          try {
            const result = await dispatchOutreach({
              sb,
              userId: row.user_id,
              campaignId: row.campaign_node_id,
              patientNodeId: row.patient_node_id,
            });
            if (result.ok) {
              dispatched++;
            } else {
              skipped++;
            }
          } catch (e) {
            // Dispatch threw — log and move on. The row is now in
            // 'targeted' state with no scheduled_at; the spa can
            // retry manually from the composer.
            errors.push(
              `dispatch ${row.id}: ${e instanceof Error ? e.message : "unknown"}`,
            );
            skipped++;
          }
        }

        return jsonResp(200, {
          ok: true,
          picked: due.length,
          dispatched,
          skipped,
          errors: errors.slice(0, 20),
        });
      },
    },
  },
});
