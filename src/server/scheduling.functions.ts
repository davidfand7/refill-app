/**
 * Smart Scheduling — public booking server functions (v1.48.0).
 *
 * Three public, token/id-addressed server fns that drive the native scheduler.
 * They mirror the established emma-booking.functions.ts shape (service-role
 * `admin()` client, createServerFn + zod inputValidator, race-safe guarded
 * writes) and sit ON TOP of the v1.48.0 schema spine:
 *
 *   - listAvailableSlots({ tenantId, serviceId, fromIso, toIso })
 *       Loads settings / provider / hours / blocks / busy from the DB and runs
 *       the PURE slot engine (src/lib/scheduling-slots.ts). Computed on read —
 *       no materialized slot table, no stale-slot bugs.
 *
 *   - holdSlot({ tenantId, serviceId, startIso })
 *       Phase 1 of HOLD → CONFIRM. Re-validates the requested start against the
 *       live engine (never trust the client), releases any expired holds that
 *       would falsely block it, then inserts a status='held' appointment with a
 *       booking_token + slot_held_until. The Postgres EXCLUDE constraint is the
 *       real race arbiter: two simultaneous holds for the same slot → exactly one
 *       wins, the loser gets 23P01 → "that time was just taken". Returns the token.
 *
 *   - confirmBooking({ token, name, email, phone })
 *       Phase 2. Race-safe flip held → confirmed (WHERE status='held' AND token
 *       match AND not expired). Stamps the booker's contact. Billing
 *       classification ($5 slot_fill / $5 campaign_booking) and the confirmation
 *       email are wired in the Sunday billing/notifications step — the hooks are
 *       marked TODO(v1.48 Sunday) below.
 *
 * Hold expiry is also swept by the scheduling-holds cron (clone of emma-sweep);
 * the inline release here just keeps the happy path correct between sweeps.
 */

import { createClient } from "@supabase/supabase-js";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";
import {
  availableSlots,
  type BlockInterval,
  type ExistingAppointment,
  type ProviderHoursRow,
  type Slot,
  type SlotEngineSettings,
} from "@/lib/scheduling-slots";

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

type Sb = ReturnType<typeof admin>;

// ── Shared loader ────────────────────────────────────────────────────────────

interface SchedulingContext {
  tenantId: string;
  providerId: string;
  /** The auth user the provider acts as (stamped as emma_appointments.user_id). */
  ownerUserId: string;
  settings: SlotEngineSettings;
  holdMinutes: number;
  service: { id: string; durationMin: number; bufferMin: number; onlineBookable: boolean };
}

/**
 * Resolve the tenant's single active provider + settings + the requested
 * service. MVP = one provider per tenant; multi-provider later picks by id.
 */
async function loadContext(
  sb: Sb,
  tenantId: string,
  serviceId: string,
): Promise<{ ok: true; ctx: SchedulingContext } | { ok: false; reason: string }> {
  const [{ data: settingsRow }, { data: provider }, { data: svc }] = await Promise.all([
    sb.from("scheduling_settings").select("*").eq("tenant_id", tenantId).maybeSingle(),
    sb
      .from("scheduling_providers")
      .select("id, user_id")
      .eq("tenant_id", tenantId)
      .eq("is_active", true)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle(),
    sb
      .from("services")
      .select("id, duration_min, buffer_min, online_bookable, tenant_id, hidden_at")
      .eq("id", serviceId)
      .maybeSingle(),
  ]);

  if (!settingsRow) return { ok: false, reason: "Scheduling is not set up for this practice yet." };
  if (!settingsRow.online_booking_enabled) {
    return { ok: false, reason: "Online booking is currently turned off." };
  }
  if (!provider) return { ok: false, reason: "No bookable provider is configured." };
  if (!provider.user_id) return { ok: false, reason: "Provider is not linked to an account." };
  if (!svc || svc.tenant_id !== tenantId || svc.hidden_at) {
    return { ok: false, reason: "That service isn't available." };
  }
  if (!svc.online_bookable) return { ok: false, reason: "That service can't be booked online." };

  return {
    ok: true,
    ctx: {
      tenantId,
      providerId: provider.id,
      ownerUserId: provider.user_id,
      settings: {
        timezone: settingsRow.timezone,
        slotGranularityMin: settingsRow.slot_granularity_min,
        minAdvanceNoticeMin: settingsRow.min_advance_notice_min,
        maxAdvanceDays: settingsRow.max_advance_days,
      },
      holdMinutes: settingsRow.hold_minutes,
      service: {
        id: svc.id,
        durationMin: svc.duration_min,
        bufferMin: svc.buffer_min,
        onlineBookable: svc.online_bookable,
      },
    },
  };
}

/** Load provider hours, blocks overlapping [from,to], and busy appointments. */
async function loadEngineInputs(
  sb: Sb,
  ctx: SchedulingContext,
  fromIso: string,
  toIso: string,
): Promise<{ hours: ProviderHoursRow[]; blocks: BlockInterval[]; busy: ExistingAppointment[] }> {
  const [{ data: hoursRows }, { data: blockRows }, { data: busyRows }] = await Promise.all([
    sb.from("scheduling_hours").select("*").eq("provider_id", ctx.providerId),
    // Whole-practice blocks (provider_id null) OR this provider's blocks, that
    // overlap the window. tstzrange && is expressed via the during column.
    sb
      .from("scheduling_blocks")
      .select("during, provider_id")
      .or(`provider_id.is.null,provider_id.eq.${ctx.providerId}`),
    // Non-cancelled appointments for this provider in/around the window. We pull
    // a generous margin (the column index is on scheduled_at) and let the engine
    // do exact interval math.
    sb
      .from("emma_appointments")
      .select("scheduled_at, duration_min, status, slot_held_until")
      .eq("provider_id", ctx.providerId)
      .neq("status", "cancelled")
      .gte("scheduled_at", new Date(new Date(fromIso).getTime() - 24 * 60 * 60_000).toISOString())
      .lt("scheduled_at", new Date(new Date(toIso).getTime() + 24 * 60 * 60_000).toISOString()),
  ]);

  const hours: ProviderHoursRow[] = (hoursRows ?? []).map((h) => ({
    dayOfWeek: h.day_of_week,
    openTime: h.open_time,
    closeTime: h.close_time,
    isClosed: h.is_closed,
  }));

  const blocks: BlockInterval[] = (blockRows ?? [])
    .map((b) => parseTstzRange(b.during))
    .filter((x): x is BlockInterval => x !== null);

  const nowMs = Date.now();
  // Busy = real appointments + LIVE holds. An expired hold (slot_held_until in
  // the past) is treated as free on the read side; the engine therefore offers
  // the slot, and the inline release in holdSlot clears the stale row so the
  // EXCLUDE insert succeeds. We approximate each existing appt's trailing buffer
  // with the service's buffer (emma_appointments doesn't snapshot per-appt
  // buffer in MVP) so back-to-back gaps stay symmetric for same-service books.
  const busy: ExistingAppointment[] = (busyRows ?? [])
    .filter((a) => {
      if (a.status !== "held") return true;
      return a.slot_held_until != null && new Date(a.slot_held_until).getTime() > nowMs;
    })
    .map((a) => ({
      startMs: new Date(a.scheduled_at).getTime(),
      durationMin: a.duration_min,
      bufferMin: ctx.service.bufferMin,
    }));

  return { hours, blocks, busy };
}

/** Parse a Postgres tstzrange literal like ["2026-08-10 11:00:00+00","...") to ms. */
function parseTstzRange(lit: string | null): BlockInterval | null {
  if (!lit) return null;
  // Forms: [lower,upper) — bounds are quoted timestamptz. Strip brackets, split
  // on the comma between the two quoted values.
  const m = lit.match(/^[\[(]"?([^"]+?)"?,"?([^"]+?)"?[\])]$/);
  if (!m) return null;
  const s = new Date(m[1]).getTime();
  const e = new Date(m[2]).getTime();
  if (Number.isNaN(s) || Number.isNaN(e)) return null;
  return { startMs: s, endMs: e };
}

// ── listAvailableSlots ───────────────────────────────────────────────────────

const listInput = z.object({
  tenantId: z.string().uuid(),
  serviceId: z.string().uuid(),
  fromIso: z.string().min(10),
  toIso: z.string().min(10),
});

export type ListSlotsResult =
  | { ok: true; slots: Slot[]; timezone: string }
  | { ok: false; reason: string };

export const listAvailableSlots = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => listInput.parse(input))
  .handler(async ({ data }): Promise<ListSlotsResult> => {
    const sb = admin();
    const loaded = await loadContext(sb, data.tenantId, data.serviceId);
    if (!loaded.ok) return { ok: false, reason: loaded.reason };
    const { ctx } = loaded;

    const { hours, blocks, busy } = await loadEngineInputs(sb, ctx, data.fromIso, data.toIso);
    const slots = availableSlots({
      settings: ctx.settings,
      hours,
      blocks,
      busy,
      service: { durationMin: ctx.service.durationMin, bufferMin: ctx.service.bufferMin },
      rangeStart: new Date(data.fromIso),
      rangeEnd: new Date(data.toIso),
      now: new Date(),
    });
    return { ok: true, slots, timezone: ctx.settings.timezone };
  });

// ── holdSlot ─────────────────────────────────────────────────────────────────

const holdInput = z.object({
  tenantId: z.string().uuid(),
  serviceId: z.string().uuid(),
  startIso: z.string().min(10),
});

export type HoldResult =
  | { ok: true; token: string; heldUntilIso: string }
  | { ok: false; reason: string; code?: "taken" | "stale" | "invalid" };

export const holdSlot = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => holdInput.parse(input))
  .handler(async ({ data }): Promise<HoldResult> => {
    const sb = admin();
    const loaded = await loadContext(sb, data.tenantId, data.serviceId);
    if (!loaded.ok) return { ok: false, reason: loaded.reason, code: "invalid" };
    const { ctx } = loaded;

    const startMs = new Date(data.startIso).getTime();
    if (Number.isNaN(startMs)) return { ok: false, reason: "Invalid time.", code: "invalid" };

    // 1. Release expired holds for this provider so a stale row can't block a
    //    slot the engine considers free. Targeted, race-safe: only flips rows
    //    that are STILL held and already past their expiry.
    await sb
      .from("emma_appointments")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .eq("provider_id", ctx.providerId)
      .eq("status", "held")
      .lt("slot_held_until", new Date().toISOString());

    // 2. Re-validate the requested start against the LIVE engine — never trust
    //    the client. Generate slots for the day containing startIso and require
    //    an exact match (guards off-grid / out-of-hours / too-soon requests).
    const dayStart = new Date(startMs - 12 * 60 * 60_000); // wide enough to catch the day in any tz
    const dayEnd = new Date(startMs + 12 * 60 * 60_000);
    const { hours, blocks, busy } = await loadEngineInputs(
      sb,
      ctx,
      dayStart.toISOString(),
      dayEnd.toISOString(),
    );
    const slots = availableSlots({
      settings: ctx.settings,
      hours,
      blocks,
      busy,
      service: { durationMin: ctx.service.durationMin, bufferMin: ctx.service.bufferMin },
      rangeStart: dayStart,
      rangeEnd: dayEnd,
      now: new Date(),
    });
    if (!slots.some((s) => s.startMs === startMs)) {
      return { ok: false, reason: "That time is no longer available.", code: "taken" };
    }

    // 3. Insert the hold. The EXCLUDE constraint is the real concurrency arbiter:
    //    a simultaneous hold for an overlapping slot makes exactly one of the two
    //    inserts fail with 23P01.
    const token = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    const heldUntilIso = new Date(Date.now() + ctx.holdMinutes * 60_000).toISOString();

    const { error: insErr } = await sb.from("emma_appointments").insert({
      user_id: ctx.ownerUserId,
      provider_id: ctx.providerId,
      scheduled_at: data.startIso,
      duration_min: ctx.service.durationMin,
      status: "held",
      source: "native-online",
      slot_held_until: heldUntilIso,
      booking_token: token,
    });

    if (insErr) {
      // 23P01 = exclusion_violation = the slot was taken in the race.
      if (insErr.code === "23P01") {
        return { ok: false, reason: "That time was just taken.", code: "taken" };
      }
      return { ok: false, reason: `Couldn't hold the slot: ${insErr.message}`, code: "invalid" };
    }

    return { ok: true, token, heldUntilIso };
  });

// ── confirmBooking ───────────────────────────────────────────────────────────

const confirmInput = z.object({
  token: z.string().uuid(),
  name: z.string().min(1).max(120),
  email: z.string().email().max(200),
  phone: z.string().max(40).optional().default(""),
});

export type ConfirmResult =
  | { ok: true; appointmentId: string; startIso: string }
  | { ok: false; reason: string; code?: "expired" | "notfound" | "error" };

export const confirmBooking = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => confirmInput.parse(input))
  .handler(async ({ data }): Promise<ConfirmResult> => {
    const sb = admin();
    const nowIso = new Date().toISOString();

    // Race-safe flip: only a row that is STILL held and NOT past expiry confirms.
    const { data: updated, error } = await sb
      .from("emma_appointments")
      .update({
        status: "confirmed",
        booking_name: data.name,
        booking_email: data.email,
        booking_phone: data.phone || null,
        slot_held_until: null,
        updated_at: nowIso,
      })
      .eq("booking_token", data.token)
      .eq("status", "held")
      .gt("slot_held_until", nowIso)
      .select("id, scheduled_at")
      .maybeSingle();

    if (error) return { ok: false, reason: `Confirm failed: ${error.message}`, code: "error" };
    if (!updated) {
      // Either already confirmed, expired, or never existed. Disambiguate for copy.
      const { data: existing } = await sb
        .from("emma_appointments")
        .select("id, status, scheduled_at")
        .eq("booking_token", data.token)
        .maybeSingle();
      if (existing?.status === "confirmed") {
        return { ok: true, appointmentId: existing.id, startIso: existing.scheduled_at };
      }
      if (existing) {
        return { ok: false, reason: "That hold expired — please pick a time again.", code: "expired" };
      }
      return { ok: false, reason: "Booking not found.", code: "notfound" };
    }

    // TODO(v1.48 Sunday — billing + notifications step):
    //   1. Classify the booking → write a scheduling_billable_events row:
    //        rescue-offer token consumed  → type 'slot_fill'       ($5)
    //        campaign token present       → type 'campaign_booking'($5)
    //        else organic                 → no billable row (free)
    //   2. Send the confirmation email via the Resend rails (booking_email).
    //   3. The reminder cron (24h + same-day) is a separate emma-sweep clone.

    return { ok: true, appointmentId: updated.id, startIso: updated.scheduled_at };
  });
