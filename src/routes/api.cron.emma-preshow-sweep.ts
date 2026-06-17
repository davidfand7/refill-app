/**
 * POST /api/cron/emma-preshow-sweep — fires pre-show reminders for due
 * appointments every 15 minutes (v360).
 *
 * Per-spa: each spa's policy.preshow_cadence_hours array (default
 * [48, 24, 3]) defines the offsets at which a reminder should fire
 * before scheduled_at. The sweep finds appointments hitting an offset
 * within the current 15-min window and dispatches.
 *
 * Auth: SCHEDULER_SECRET (same secret the v356 emma-sweep uses).
 *
 * Idempotency: dispatchPreShowReminder checks for a prior send at the
 * same appointment×offset via a dedupe token in patient_outreach.subject.
 * Double-fires from overlapping ticks are no-ops.
 *
 * Established 2026-05-17 (Promotions Engine v360).
 */

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { dispatchPreShowReminder } from "@/server/emma-preshow.functions";

function jsonResp(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** ±7.5 min slack on either side of an offset threshold (matches 15-min cadence). */
const WINDOW_MIN = 8;

export const Route = createFileRoute("/api/cron/emma-preshow-sweep")({
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

        // 1) Pull all spas with preshow enabled. Most installations will be
        //    small (<100 spas) so a single full-scan is fine.
        const { data: policies, error: pErr } = await sb
          .from("noshow_policies")
          .select("user_id, preshow_cadence_hours")
          .eq("preshow_enabled", true);
        if (pErr) return jsonResp(500, { error: `policies: ${pErr.message}` });
        if (!policies || policies.length === 0) {
          return jsonResp(200, {
            ok: true,
            spas_with_preshow_enabled: 0,
            dispatched: 0,
            skipped: 0,
          });
        }

        let totalDispatched = 0;
        let totalSkipped = 0;
        const errors: string[] = [];

        // 2) For each spa, for each cadence offset across ALL profiles,
        //    find appointments whose scheduled_at - offset falls within
        //    the current window.
        //
        //    v1.34.3 / v1.34.3.1: profiles introduced + per-patient
        //    routing wired. Load union of cadence_hours across all of
        //    this spa's profiles (Default + Chronic + custom). Per-
        //    patient profile resolution happens inside
        //    dispatchPreShowReminder, which reads
        //    patient.softTags.preshowProfileId first and falls back to
        //    the spa's is_default=true profile. v1.34.4 also unions
        //    per-treatment-type override hours so the sweep catches any
        //    appointment that might be due. Falls back to
        //    policy.preshow_cadence_hours if no profile rows found —
        //    defense-in-depth for pre-backfill state.
        for (const policy of policies) {
          let offsets: number[] = policy.preshow_cadence_hours ?? [];
          const { data: profiles } = await sb
            .from("preshow_profiles")
            .select("cadence_hours, cadence_by_treatment_type")
            .eq("user_id", policy.user_id);
          if (profiles && profiles.length > 0) {
            // v1.34.3 + v1.34.4: union of (a) every profile's spa-wide
            // cadence_hours AND (b) every per-treatment-type override
            // hours, so the sweep catches ANY appointment that might be
            // due. dispatchPreShowReminder enforces per-treatment scoping
            // (skip-with-reason if offset not in this treatment's
            // override list).
            const unioned = new Set<number>();
            for (const p of profiles) {
              for (const h of (p.cadence_hours ?? []) as number[]) {
                unioned.add(h);
              }
              const byType = (p.cadence_by_treatment_type ?? {}) as Record<
                string,
                number[]
              >;
              for (const arr of Object.values(byType)) {
                for (const h of arr) unioned.add(h);
              }
            }
            offsets = Array.from(unioned);
          }
          for (const offsetHours of offsets) {
            const now = Date.now();
            // We want appointments where scheduled_at - offsetHours hits "now"
            // → scheduled_at = now + offsetHours
            const targetMs = now + offsetHours * 60 * 60 * 1000;
            const winStart = new Date(targetMs - WINDOW_MIN * 60 * 1000);
            const winEnd = new Date(targetMs + WINDOW_MIN * 60 * 1000);

            const { data: due, error: dueErr } = await sb
              .from("appointments")
              .select("id")
              .eq("user_id", policy.user_id)
              .in("status", ["scheduled", "confirmed"])
              .gte("scheduled_at", winStart.toISOString())
              .lte("scheduled_at", winEnd.toISOString())
              .limit(200);
            if (dueErr) {
              errors.push(
                `spa ${policy.user_id} offset ${offsetHours}h: ${dueErr.message}`,
              );
              continue;
            }
            if (!due || due.length === 0) continue;

            // 3) Dispatch serially per spa to avoid hammering Twilio/Resend
            for (const apt of due) {
              try {
                const r = await dispatchPreShowReminder({
                  sb,
                  userId: policy.user_id,
                  appointmentId: apt.id,
                  offsetHours,
                });
                if (r.ok) totalDispatched++;
                else totalSkipped++;
              } catch (e) {
                totalSkipped++;
                errors.push(
                  `dispatch ${apt.id} @T-${offsetHours}h: ${e instanceof Error ? e.message : "unknown"}`,
                );
              }
            }
          }
        }

        return jsonResp(200, {
          ok: true,
          spas_with_preshow_enabled: policies.length,
          dispatched: totalDispatched,
          skipped: totalSkipped,
          errors: errors.slice(0, 20),
        });
      },
    },
  },
});
