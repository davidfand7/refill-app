/**
 * POST /api/cron/refill-trial-drip — Day-N drip sweep for Refill trial spas.
 *
 * v389: iterates the full five-message drip library (Day 3 / 7 / 14 / 21 / 28).
 * For each day-bucket: select tenants past that threshold who don't yet have
 * a matching `tenant_engagement_events` row with event_type='drip:dayN', then
 * fire sendTrialDripByDay per eligible tenant.
 *
 * Single daily cron run at 09:00 UTC handles the whole library. A tenant
 * created 21 days + 4 hours ago will receive Day-21 today and Day-28 a
 * week from now. Per-day dedup means re-running the cron in the same day
 * is a no-op for already-sent messages.
 *
 * Auth: x-scheduler-secret header — same gate as /api/cron/emma-invoice.
 *
 * Insert-on-success semantics: if Resend fails for a tenant we log + skip;
 * the next daily run picks them up again. Acceptable for v389's expected
 * tenant count (single digits → low hundreds).
 */

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import {
  DRIP_DAYS,
  dripEventTypeForDay,
  sendTrialDripByDay,
  type DripDay,
} from "@/server/refill-drip";

function jsonResp(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type DayTally = {
  day: DripDay;
  eligible: number;
  sent: number;
  skipped: number;
  failures: { tenantId: string; reason: string }[];
};

export const Route = createFileRoute("/api/cron/refill-trial-drip")({
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

        const sb = createClient<Database>(
          SUPABASE_URL,
          SUPABASE_SERVICE_ROLE_KEY,
          { auth: { persistSession: false, autoRefreshToken: false } },
        );

        const now = Date.now();
        const tallies: DayTally[] = [];

        for (const day of DRIP_DAYS) {
          const threshold = new Date(
            now - day * 24 * 60 * 60 * 1000,
          ).toISOString();
          const eventType = dripEventTypeForDay(day);

          const { data: tenants, error: tenantsErr } = await sb
            .from("tenants")
            .select("id, slug, created_at")
            .lt("created_at", threshold);
          if (tenantsErr) {
            console.error(
              "[refill-trial-drip] tenants query failed for day",
              day,
              tenantsErr.message,
            );
            tallies.push({
              day,
              eligible: 0,
              sent: 0,
              skipped: 0,
              failures: [
                { tenantId: "*", reason: `tenants query: ${tenantsErr.message}` },
              ],
            });
            continue;
          }
          if (!tenants || tenants.length === 0) {
            tallies.push({ day, eligible: 0, sent: 0, skipped: 0, failures: [] });
            continue;
          }

          const { data: alreadySent, error: sentErr } = await sb
            .from("tenant_engagement_events")
            .select("tenant_id")
            .eq("event_type", eventType)
            .in("tenant_id", tenants.map((t) => t.id));
          if (sentErr) {
            console.error(
              "[refill-trial-drip] event lookup failed for day",
              day,
              sentErr.message,
            );
            tallies.push({
              day,
              eligible: 0,
              sent: 0,
              skipped: 0,
              failures: [
                { tenantId: "*", reason: `event lookup: ${sentErr.message}` },
              ],
            });
            continue;
          }
          const sentSet = new Set((alreadySent ?? []).map((r) => r.tenant_id));
          const eligible = tenants.filter((t) => !sentSet.has(t.id));

          let sent = 0;
          let skipped = 0;
          const failures: { tenantId: string; reason: string }[] = [];

          for (const tenant of eligible) {
            const result = await sendTrialDripByDay(day, tenant.id);
            if (result.ok) {
              sent += 1;
            } else {
              skipped += 1;
              failures.push({ tenantId: tenant.id, reason: result.reason });
              console.warn(
                "[refill-trial-drip] send failed for tenant",
                tenant.slug,
                "day",
                day,
                result.reason,
              );
            }
          }

          tallies.push({
            day,
            eligible: eligible.length,
            sent,
            skipped,
            failures,
          });
        }

        const totals = tallies.reduce(
          (acc, t) => ({
            eligible: acc.eligible + t.eligible,
            sent: acc.sent + t.sent,
            skipped: acc.skipped + t.skipped,
          }),
          { eligible: 0, sent: 0, skipped: 0 },
        );

        return jsonResp(200, {
          ok: true,
          totals,
          byDay: tallies,
        });
      },
    },
  },
});
