/**
 * /api/cron/scheduling-reminders — native-scheduler maintenance cron (v1.48.5).
 *
 * Triggered by Supabase pg_cron (net.http_post with the X-Scheduler-Secret
 * header), same mechanism as emma-sweep. Each tick:
 *   1. Releases expired holds (status='held' past slot_held_until → cancelled),
 *      so a stale hold can't keep blocking an otherwise-free slot.
 *   2. Sends the per-tenant "N hours before" reminder for confirmed bookings
 *      that have entered the lead window. Dedupe is race-safe via a UNIQUE
 *      insert into scheduling_reminder_sends (claim-then-send) — two ticks can
 *      never double-remind.
 *
 * MVP sends ONE reminder (the configured reminder_lead_hours, default 24h);
 * same-day is reserved (kind='sameday') for a later ship.
 */

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { sendBookingReminder } from "@/server/scheduling-email";
import {
  resolveBrandForTenant,
  toPublicBrand,
  type PublicBrand,
} from "@/server/brand-resolver";

const CANDIDATE_HORIZON_HOURS = 72; // covers any reasonable per-tenant lead
const MIN_LEAD_MINUTES = 60; // don't "remind" for near-imminent bookings
const BATCH = 500;

function jsonResp(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const Route = createFileRoute("/api/cron/scheduling-reminders")({
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

        const now = new Date();
        const nowIso = now.toISOString();
        const errors: string[] = [];

        // 1) Release expired holds (idempotent).
        let releasedHolds = 0;
        {
          const { data, error } = await sb
            .from("appointments")
            .update({ status: "cancelled", updated_at: nowIso })
            .eq("status", "held")
            .lt("slot_held_until", nowIso)
            .select("id");
          if (error) errors.push(`release-holds: ${error.message}`);
          else releasedHolds = data?.length ?? 0;
        }

        // 2) Candidate confirmed bookings within the horizon.
        const horizonIso = new Date(now.getTime() + CANDIDATE_HORIZON_HOURS * 3600_000).toISOString();
        const { data: appts, error: apptErr } = await sb
          .from("appointments")
          .select("id, scheduled_at, booking_email, provider_id, treatment_type, duration_min")
          .eq("status", "confirmed")
          .not("booking_email", "is", null)
          .not("provider_id", "is", null)
          .gt("scheduled_at", nowIso)
          .lte("scheduled_at", horizonIso)
          .order("scheduled_at")
          .limit(BATCH);
        if (apptErr) {
          return jsonResp(500, { error: `candidate query: ${apptErr.message}`, releasedHolds });
        }

        const rows = appts ?? [];
        // Resolve provider → tenant, then tenant settings + names.
        const provIds = Array.from(
          new Set(rows.map((r) => r.provider_id).filter((x): x is string => !!x)),
        );
        const provTenant = new Map<string, string>();
        const provName = new Map<string, string>();
        if (provIds.length) {
          const { data: provs } = await sb
            .from("scheduling_providers")
            .select("id, tenant_id, name")
            .in("id", provIds);
          for (const p of provs ?? []) {
            provTenant.set(p.id, p.tenant_id);
            if (p.name) provName.set(p.id, p.name);
          }
        }

        // Snapshotted add-ons for this batch (appointmentId → add-on lines).
        const addonsByAppt = new Map<string, { name: string; durationMin: number }[]>();
        if (rows.length) {
          const { data: addonRows } = await sb
            .from("appointment_addons")
            .select("appointment_id, name, duration_min")
            .in("appointment_id", rows.map((r) => r.id));
          for (const ar of addonRows ?? []) {
            const arr = addonsByAppt.get(ar.appointment_id) ?? [];
            arr.push({ name: ar.name, durationMin: ar.duration_min ?? 0 });
            addonsByAppt.set(ar.appointment_id, arr);
          }
        }
        const tenantIds = Array.from(new Set([...provTenant.values()]));
        const settByTenant = new Map<string, { lead: number; timezone: string }>();
        const nameByTenant = new Map<string, string>();
        if (tenantIds.length) {
          const [{ data: setts }, { data: tens }] = await Promise.all([
            sb
              .from("scheduling_settings")
              .select("tenant_id, reminder_lead_hours, timezone")
              .in("tenant_id", tenantIds),
            sb.from("tenants").select("id, name").in("id", tenantIds),
          ]);
          for (const s of setts ?? [])
            settByTenant.set(s.tenant_id, { lead: s.reminder_lead_hours, timezone: s.timezone });
          for (const t of tens ?? []) nameByTenant.set(t.id, t.name);
        }

        // v2.69.0 — resolve each tenant's white-label brand ONCE for this batch
        // (not per-appointment) so reminders carry the spa's brand when entitled.
        const brandByTenant = new Map<string, PublicBrand>();
        await Promise.all(
          tenantIds.map(async (tid) => {
            brandByTenant.set(tid, toPublicBrand(await resolveBrandForTenant(sb, tid)));
          }),
        );

        let dispatched = 0;
        let skipped = 0;
        let retryQueued = 0; // sends that failed + had their claim released to retry next run
        for (const a of rows) {
          if (!a.provider_id || !a.booking_email) {
            skipped++;
            continue;
          }
          const tenantId = provTenant.get(a.provider_id);
          if (!tenantId) {
            skipped++;
            continue;
          }
          const sett = settByTenant.get(tenantId);
          const lead = sett?.lead ?? 24;
          if (lead <= 0) {
            skipped++;
            continue;
          }
          const apptMs = new Date(a.scheduled_at).getTime();
          const withinLead = apptMs <= now.getTime() + lead * 3600_000;
          const notImminent = apptMs > now.getTime() + MIN_LEAD_MINUTES * 60_000;
          if (!withinLead || !notImminent) {
            skipped++;
            continue;
          }

          // Claim FIRST so two overlapping cron runs can't double-send
          // (race-safe via UNIQUE(appointment_id, kind)). If the send then
          // fails, we RELEASE the claim below so a later run retries — a
          // failed send must never be mistaken for a delivered one.
          const { error: claimErr } = await sb
            .from("scheduling_reminder_sends")
            .insert({ appointment_id: a.id, kind: "lead" });
          if (claimErr) {
            if (claimErr.code !== "23505") errors.push(`claim ${a.id}: ${claimErr.message}`);
            skipped++; // 23505 = already reminded
            continue;
          }

          // Per-iteration guard: a throw (e.g. a bad timezone hitting Intl)
          // must not abort the rest of the batch.
          let sent = false;
          let sendErr: string | null = null;
          try {
            const r = await sendBookingReminder({
              to: a.booking_email,
              spaName: nameByTenant.get(tenantId) ?? "Your appointment",
              startIso: a.scheduled_at,
              timezone: sett?.timezone ?? "America/Los_Angeles",
              serviceName: a.treatment_type ?? undefined,
              providerName: provName.get(a.provider_id) ?? null,
              durationMin: a.duration_min ?? undefined,
              addOns: addonsByAppt.get(a.id) ?? [],
              brand: brandByTenant.get(tenantId),
            });
            sent = r.ok;
            if (!r.ok) sendErr = r.error ?? "unknown";
          } catch (e) {
            sendErr = e instanceof Error ? e.message : String(e);
          }

          if (sent) {
            dispatched++;
          } else {
            // Release the claim so the next run retries this reminder.
            await sb
              .from("scheduling_reminder_sends")
              .delete()
              .eq("appointment_id", a.id)
              .eq("kind", "lead");
            errors.push(`send ${a.id}: ${sendErr ?? "unknown"}`);
            retryQueued++;
          }
        }

        return jsonResp(200, {
          ok: true,
          releasedHolds,
          candidates: rows.length,
          dispatched,
          skipped,
          retryQueued,
          errors: errors.slice(0, 20),
        });
      },
    },
  },
});
