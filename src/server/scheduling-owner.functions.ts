/**
 * Smart Scheduling — owner calendar (day view) server functions (v1.48.0).
 *
 * Authenticated, tenant-scoped. Powers /app/refill/schedule:
 *   - getDayScheduleFn       — one day's appointments + blocks + the open band
 *                              + the service list (for manual booking).
 *   - ownerCreateAppointmentFn — owner books a patient in directly
 *                              (source 'native-manual', EXCLUDE-guarded).
 *   - ownerCreateBlockFn     — block off time (lunch, vacation, meeting).
 *   - ownerCancelAppointmentFn — cancel an appointment (frees the slot; the
 *                              vacated native slot is what the rescue engine
 *                              can later fill).
 *
 * Reuses ensureSetup + getTenantIdForUser from scheduling-settings, and the
 * tz helpers from the slot engine so day boundaries are DST-correct.
 */

import { createClient } from "@supabase/supabase-js";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";
import { resolveEffectiveUserId } from "@/server/auth-helpers";
import { ensureSetup, getTenantIdForUser } from "@/server/scheduling-settings.functions";
import { zonedWallClockToUtc, zonedDateParts } from "@/lib/scheduling-slots";
import { sendBookingConfirmation } from "@/server/scheduling-email";

function admin() {
  const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw new Error("Server is missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  }
  return createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Parse a Postgres tstzrange literal ["lo","hi") → {startMs,endMs}. */
function parseRange(lit: string | null): { startMs: number; endMs: number } | null {
  if (!lit) return null;
  const m = lit.match(/^[\[(]"?([^"]+?)"?,"?([^"]+?)"?[\])]$/);
  if (!m) return null;
  const s = new Date(m[1]).getTime();
  const e = new Date(m[2]).getTime();
  if (Number.isNaN(s) || Number.isNaN(e)) return null;
  return { startMs: s, endMs: e };
}

/** "HH:MM:SS"/"HH:MM" → minutes from midnight. */
function toMinutes(t: string): number {
  const [h, m] = t.split(":");
  return parseInt(h, 10) * 60 + parseInt(m ?? "0", 10);
}

/** UTC bounds [start,end) of a local calendar day (DST-correct). */
function localDayBounds(dateIso: string, tz: string): { startUtc: Date; endUtc: Date; weekday: number } {
  const [y, m, d] = dateIso.split("-").map((n) => parseInt(n, 10));
  const startUtc = zonedWallClockToUtc(y, m, d, 0, 0, tz);
  // Advance one local day via a noon anchor + 24h, then snap to local midnight.
  const nextNoon = new Date(zonedWallClockToUtc(y, m, d, 12, 0, tz).getTime() + 24 * 60 * 60_000);
  const np = zonedDateParts(nextNoon, tz);
  const endUtc = zonedWallClockToUtc(np.year, np.month, np.day, 0, 0, tz);
  return { startUtc, endUtc, weekday: zonedDateParts(startUtc, tz).weekday };
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface DayAppointment {
  id: string;
  startIso: string;
  endIso: string;
  durationMin: number;
  status: string;
  patientName: string | null;
  source: string;
}

export interface DayBlock {
  id: string;
  startIso: string;
  endIso: string;
  reason: string | null;
}

export interface DaySchedule {
  timezone: string;
  providerId: string;
  dateIso: string;
  /** Open band for the day, minutes-from-midnight (local). */
  open: { isOpen: boolean; openMin: number; closeMin: number };
  appointments: DayAppointment[];
  blocks: DayBlock[];
  services: Array<{ id: string; name: string; durationMin: number }>;
}

type ApptRow = {
  id: string;
  scheduled_at: string;
  duration_min: number;
  status: string;
  source: string;
  booking_name: string | null;
  patient_node_id: string | null;
};

/** Map raw appointment rows → DayAppointment[], resolving display names. */
async function hydrateAppointments(
  sb: ReturnType<typeof admin>,
  rows: ApptRow[],
): Promise<DayAppointment[]> {
  const nodeIds = Array.from(
    new Set(rows.map((a) => a.patient_node_id).filter((x): x is string => !!x)),
  );
  const titleById = new Map<string, string>();
  if (nodeIds.length) {
    const { data: nodes } = await sb.from("knowledge_nodes").select("id, title").in("id", nodeIds);
    for (const n of nodes ?? []) titleById.set(n.id, n.title ?? "");
  }
  return rows.map((a) => ({
    id: a.id,
    startIso: a.scheduled_at,
    endIso: new Date(new Date(a.scheduled_at).getTime() + a.duration_min * 60_000).toISOString(),
    durationMin: a.duration_min,
    status: a.status,
    patientName: a.booking_name ?? (a.patient_node_id ? titleById.get(a.patient_node_id) ?? null : null),
    source: a.source,
  }));
}

// ── getDayScheduleFn ─────────────────────────────────────────────────────────

const dayInput = z.object({
  accessToken: z.string().min(10),
  viewAsUserId: z.string().uuid().optional(),
  dateIso: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const getDayScheduleFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => dayInput.parse(raw))
  .handler(async ({ data }): Promise<DaySchedule> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);
    const providerId = await ensureSetup(sb, tenantId, effectiveUserId);

    const { data: settingsRow } = await sb
      .from("scheduling_settings")
      .select("timezone")
      .eq("tenant_id", tenantId)
      .maybeSingle();
    const timezone = settingsRow?.timezone ?? "America/Los_Angeles";

    const { startUtc, endUtc, weekday } = localDayBounds(data.dateIso, timezone);

    const [{ data: apptRows }, { data: hoursRow }, { data: blockRows }, { data: serviceRows }] =
      await Promise.all([
        sb
          .from("emma_appointments")
          .select("id, scheduled_at, duration_min, status, source, booking_name, patient_node_id")
          .eq("provider_id", providerId)
          .neq("status", "cancelled")
          .gte("scheduled_at", startUtc.toISOString())
          .lt("scheduled_at", endUtc.toISOString())
          .order("scheduled_at"),
        sb
          .from("scheduling_hours")
          .select("open_time, close_time, is_closed")
          .eq("provider_id", providerId)
          .eq("day_of_week", weekday)
          .maybeSingle(),
        sb
          .from("scheduling_blocks")
          .select("id, during, reason, provider_id")
          .or(`provider_id.is.null,provider_id.eq.${providerId}`),
        sb
          .from("services")
          .select("id, name, duration_min, hidden_at, online_bookable")
          .eq("tenant_id", tenantId)
          .eq("online_bookable", true)
          .is("hidden_at", null)
          .order("name"),
      ]);

    // Native bookings carry booking_name; matched ones resolve via knowledge_nodes.
    const appointments = await hydrateAppointments(sb, apptRows ?? []);

    const blocks: DayBlock[] = (blockRows ?? [])
      .map((b) => {
        const r = parseRange(b.during);
        if (!r) return null;
        // Only blocks overlapping this day.
        if (r.endMs <= startUtc.getTime() || r.startMs >= endUtc.getTime()) return null;
        return {
          id: b.id,
          startIso: new Date(r.startMs).toISOString(),
          endIso: new Date(r.endMs).toISOString(),
          reason: b.reason,
        };
      })
      .filter((x): x is DayBlock => x !== null);

    const open = hoursRow
      ? {
          isOpen: !hoursRow.is_closed,
          openMin: toMinutes(hoursRow.open_time),
          closeMin: toMinutes(hoursRow.close_time),
        }
      : { isOpen: false, openMin: 9 * 60, closeMin: 17 * 60 };

    return {
      timezone,
      providerId,
      dateIso: data.dateIso,
      open,
      appointments,
      blocks,
      services: (serviceRows ?? []).map((s) => ({
        id: s.id,
        name: s.name,
        durationMin: s.duration_min,
      })),
    };
  });

// ── getRangeScheduleFn (week / month) ────────────────────────────────────────

export interface WeeklyHoursRow {
  dayOfWeek: number;
  openMin: number;
  closeMin: number;
  isClosed: boolean;
}

export interface RangeSchedule {
  timezone: string;
  providerId: string;
  appointments: DayAppointment[];
  blocks: DayBlock[];
  /** The provider's weekly availability pattern (0..6). */
  weeklyHours: WeeklyHoursRow[];
  services: Array<{ id: string; name: string; durationMin: number }>;
}

const rangeInput = z.object({
  accessToken: z.string().min(10),
  viewAsUserId: z.string().uuid().optional(),
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  toDateExclusive: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const getRangeScheduleFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => rangeInput.parse(raw))
  .handler(async ({ data }): Promise<RangeSchedule> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);
    const providerId = await ensureSetup(sb, tenantId, effectiveUserId);

    const { data: settingsRow } = await sb
      .from("scheduling_settings")
      .select("timezone")
      .eq("tenant_id", tenantId)
      .maybeSingle();
    const timezone = settingsRow?.timezone ?? "America/Los_Angeles";

    const startUtc = localDayBounds(data.fromDate, timezone).startUtc;
    const endUtc = localDayBounds(data.toDateExclusive, timezone).startUtc;

    const [{ data: apptRows }, { data: hoursRows }, { data: blockRows }, { data: serviceRows }] =
      await Promise.all([
        sb
          .from("emma_appointments")
          .select("id, scheduled_at, duration_min, status, source, booking_name, patient_node_id")
          .eq("provider_id", providerId)
          .neq("status", "cancelled")
          .gte("scheduled_at", startUtc.toISOString())
          .lt("scheduled_at", endUtc.toISOString())
          .order("scheduled_at"),
        sb
          .from("scheduling_hours")
          .select("day_of_week, open_time, close_time, is_closed")
          .eq("provider_id", providerId),
        sb
          .from("scheduling_blocks")
          .select("id, during, reason, provider_id")
          .or(`provider_id.is.null,provider_id.eq.${providerId}`),
        sb
          .from("services")
          .select("id, name, duration_min, hidden_at, online_bookable")
          .eq("tenant_id", tenantId)
          .eq("online_bookable", true)
          .is("hidden_at", null)
          .order("name"),
      ]);

    const appointments = await hydrateAppointments(sb, apptRows ?? []);
    const blocks: DayBlock[] = (blockRows ?? [])
      .map((b) => {
        const r = parseRange(b.during);
        if (!r) return null;
        if (r.endMs <= startUtc.getTime() || r.startMs >= endUtc.getTime()) return null;
        return {
          id: b.id,
          startIso: new Date(r.startMs).toISOString(),
          endIso: new Date(r.endMs).toISOString(),
          reason: b.reason,
        };
      })
      .filter((x): x is DayBlock => x !== null);
    const weeklyHours: WeeklyHoursRow[] = (hoursRows ?? []).map((h) => ({
      dayOfWeek: h.day_of_week,
      openMin: toMinutes(h.open_time),
      closeMin: toMinutes(h.close_time),
      isClosed: h.is_closed,
    }));

    return {
      timezone,
      providerId,
      appointments,
      blocks,
      weeklyHours,
      services: (serviceRows ?? []).map((s) => ({
        id: s.id,
        name: s.name,
        durationMin: s.duration_min,
      })),
    };
  });

// ── ownerCreateAppointmentFn ─────────────────────────────────────────────────

const createApptInput = z.object({
  accessToken: z.string().min(10),
  viewAsUserId: z.string().uuid().optional(),
  serviceId: z.string().uuid(),
  startIso: z.string().min(10),
  patientName: z.string().min(1).max(120),
  patientEmail: z.string().email().max(200).optional(),
  patientPhone: z.string().max(40).optional(),
});

export type OwnerCreateResult =
  | { ok: true; id: string }
  | { ok: false; reason: string; code?: "conflict" | "invalid" };

export const ownerCreateAppointmentFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => createApptInput.parse(raw))
  .handler(async ({ data }): Promise<OwnerCreateResult> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);
    const providerId = await ensureSetup(sb, tenantId, effectiveUserId);

    const { data: svc } = await sb
      .from("services")
      .select("id, duration_min, tenant_id")
      .eq("id", data.serviceId)
      .maybeSingle();
    if (!svc || svc.tenant_id !== tenantId) {
      return { ok: false, reason: "That service isn't available.", code: "invalid" };
    }

    const { data: created, error } = await sb
      .from("emma_appointments")
      .insert({
        user_id: effectiveUserId,
        provider_id: providerId,
        scheduled_at: data.startIso,
        duration_min: svc.duration_min,
        status: "confirmed",
        source: "native-manual",
        booking_name: data.patientName,
        booking_email: data.patientEmail ?? null,
        booking_phone: data.patientPhone ?? null,
      })
      .select("id")
      .single();

    if (error) {
      if (error.code === "23P01") {
        return { ok: false, reason: "That time overlaps an existing appointment.", code: "conflict" };
      }
      return { ok: false, reason: `Couldn't book: ${error.message}`, code: "invalid" };
    }

    // Confirmation email when the owner supplied a patient email (best-effort).
    if (data.patientEmail) {
      const [{ data: t }, { data: st }] = await Promise.all([
        sb.from("tenants").select("name").eq("id", tenantId).maybeSingle(),
        sb.from("scheduling_settings").select("timezone").eq("tenant_id", tenantId).maybeSingle(),
      ]);
      await sendBookingConfirmation({
        to: data.patientEmail,
        spaName: t?.name ?? "Your appointment",
        startIso: data.startIso,
        timezone: st?.timezone ?? "America/Los_Angeles",
      });
    }

    return { ok: true, id: created.id };
  });

// ── ownerCreateBlockFn ───────────────────────────────────────────────────────

const blockInput = z.object({
  accessToken: z.string().min(10),
  viewAsUserId: z.string().uuid().optional(),
  startIso: z.string().min(10),
  endIso: z.string().min(10),
  reason: z.string().max(200).optional(),
});

export const ownerCreateBlockFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => blockInput.parse(raw))
  .handler(async ({ data }): Promise<{ ok: true } | { ok: false; reason: string }> => {
    if (new Date(data.startIso).getTime() >= new Date(data.endIso).getTime()) {
      return { ok: false, reason: "Block end must be after its start." };
    }
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);
    const providerId = await ensureSetup(sb, tenantId, effectiveUserId);

    const { error } = await sb.from("scheduling_blocks").insert({
      tenant_id: tenantId,
      provider_id: providerId,
      during: `[${data.startIso},${data.endIso})`,
      reason: data.reason ?? null,
    });
    if (error) return { ok: false, reason: `Couldn't block time: ${error.message}` };
    return { ok: true };
  });

// ── ownerCancelAppointmentFn ─────────────────────────────────────────────────

const cancelInput = z.object({
  accessToken: z.string().min(10),
  viewAsUserId: z.string().uuid().optional(),
  appointmentId: z.string().uuid(),
});

export const ownerCancelAppointmentFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => cancelInput.parse(raw))
  .handler(async ({ data }): Promise<{ ok: true } | { ok: false; reason: string }> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);
    const providerId = await ensureSetup(sb, tenantId, effectiveUserId);

    const { error } = await sb
      .from("emma_appointments")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .eq("id", data.appointmentId)
      .eq("provider_id", providerId); // ownership guard (tenantId resolves the provider)
    if (error) return { ok: false, reason: `Couldn't cancel: ${error.message}` };
    return { ok: true };
  });
