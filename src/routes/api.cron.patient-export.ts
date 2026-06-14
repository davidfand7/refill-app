/**
 * POST /api/cron/patient-export — the Monthly Patient-Book Export routine (v2.31.0).
 *
 * Fired by pg_cron once a month, it walks every spa that turned the export on
 * (emma_noshow_policies.patient_export_enabled = true — the Skill's adopt/On
 * flips it) and emails the OWNER a CSV of their patient book for bookkeeping.
 *
 * What it does NOT do: send anything to a patient. This is the owner's own data
 * delivered to the owner's own inbox (the honest-exit category, project_trusted_
 * onboarding) — never patient outreach.
 *
 * Honest by construction:
 *   • a spa with an empty book gets NO email (no noise),
 *   • a spa with no owner email on file is skipped + logged,
 *   • a 25-day dedup guard (patient_export_last_sent_at) makes re-runs safe.
 *
 * Auth: x-scheduler-secret header — same gate as the other crons.
 * Manual verify: POST with ?force=1 to bypass the dedup guard, or ?userId=<uuid>
 * to target a single spa.
 *
 * Established 2026-06-14 (Skill Funnel — Monthly Patient-Book Export).
 */

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { sendPatientBookExportForUser } from "@/server/data-export.functions";

function jsonResp(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// patient_export_* columns aren't in types.ts yet (loose posture, same as the
// recall-digest stamp). Read the enable flag + last-sent through a narrow cast.
type ExportPolicyRow = {
  user_id: string;
  patient_export_last_sent_at: string | null;
};

// Monthly cadence — a 25-day floor keeps a re-run inside the same month from
// double-sending while never blocking the next month's run.
const DEDUP_DAYS = 25;

export const Route = createFileRoute("/api/cron/patient-export")({
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

        // Pull every spa with the export turned on. patient_export_enabled isn't
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
          .from("emma_noshow_policies")
          .select("user_id, patient_export_last_sent_at")
          .eq("patient_export_enabled", true);
        if (error) return jsonResp(500, { error: `pull: ${error.message}` });

        let rows = (rawRows as ExportPolicyRow[] | null) ?? [];
        if (onlyUserId) rows = rows.filter((r) => r.user_id === onlyUserId);

        // Dedup: skip spas exported within the last DEDUP_DAYS unless forced.
        const cutoff = Date.now() - DEDUP_DAYS * 24 * 60 * 60 * 1000;
        const due = force
          ? rows
          : rows.filter((r) => {
              if (!r.patient_export_last_sent_at) return true;
              const t = Date.parse(r.patient_export_last_sent_at);
              return Number.isNaN(t) || t < cutoff;
            });

        let sent = 0;
        let empty = 0;
        let skippedNoEmail = 0;
        const errors: string[] = [];

        for (const r of due) {
          try {
            const result = await sendPatientBookExportForUser(
              sb,
              r.user_id,
              PUBLIC_ORIGIN,
            );
            if (result.status === "sent") sent += 1;
            else if (result.status === "empty") empty += 1;
            else if (result.status === "no_email") skippedNoEmail += 1;
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
          exports_sent: sent,
          empty_book: empty,
          skipped_no_owner_email: skippedNoEmail,
          errors: errors.slice(0, 20),
        });
      },
    },
  },
});
