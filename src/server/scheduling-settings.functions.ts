/**
 * Smart Scheduling — owner settings server functions (v1.48.0).
 *
 * Authenticated, tenant-scoped (NOT the public booking fns). Mirrors the
 * spa-profile / catalog owner-write pattern: resolveEffectiveUserId (token +
 * admin view-as) → getTenantIdForUser → tenant-scoped read/upsert.
 *
 *   - getSchedulingSetupFn  — loads (and idempotently SEEDS on first open) the
 *     tenant's one provider + scheduling_settings + 7 weekday hours rows +
 *     the bookable-service list. First open auto-creates the MVP single
 *     provider (mapped to the owner's auth user so native bookings can stamp
 *     emma_appointments.user_id), default settings, and a Mon–Fri 9–5 / weekend-
 *     closed week — so the page is immediately usable.
 *
 *   - saveSchedulingSetupFn — upserts settings + the 7 hours rows + per-service
 *     duration/buffer/online_bookable overrides in one call.
 */

import { createClient } from "@supabase/supabase-js";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";
import { resolveEffectiveUserId } from "@/server/auth-helpers";

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

type Sb = ReturnType<typeof admin>;

/** Resolve the caller's tenant (earliest membership = their Refill tenant). */
export async function getTenantIdForUser(sb: Sb, userId: string): Promise<string> {
  const { data, error } = await sb
    .from("tenant_memberships")
    .select("tenant_id, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Tenant lookup failed: ${error.message}`);
  if (!data) throw new Error("No Refill tenant — finish onboarding before opening scheduling.");
  return data.tenant_id;
}

// ── Shared shapes ────────────────────────────────────────────────────────────

export interface SchedulingHoursDraft {
  dayOfWeek: number; // 0 = Sunday … 6 = Saturday
  openTime: string; // "HH:MM"
  closeTime: string; // "HH:MM"
  isClosed: boolean;
}

export interface SchedulingSettingsDraft {
  timezone: string;
  onlineBookingEnabled: boolean;
  slotGranularityMin: number;
  minAdvanceNoticeMin: number;
  maxAdvanceDays: number;
  holdMinutes: number;
  reminderLeadHours: number;
  samedayReminderEnabled: boolean;
}

export interface BookableServiceDraft {
  id: string;
  name: string;
  durationMin: number;
  bufferMin: number;
  onlineBookable: boolean;
}

export interface ProviderRow {
  id: string;
  name: string;
  isActive: boolean;
}

export interface SchedulingSetupBundle {
  /** Primary (earliest active) provider — kept for back-compat / default selection. */
  providerId: string;
  /** All providers (active + inactive), ordered by created_at. */
  providers: ProviderRow[];
  /** Tenant slug — used to build the public booking link /s/<slug>. */
  slug: string;
  settings: SchedulingSettingsDraft;
  /** providerId → that provider's 7 weekday hours rows. */
  hoursByProvider: Record<string, SchedulingHoursDraft[]>;
  services: BookableServiceDraft[];
}

const DEFAULT_SETTINGS: SchedulingSettingsDraft = {
  timezone: "America/Los_Angeles",
  onlineBookingEnabled: false,
  slotGranularityMin: 15,
  minAdvanceNoticeMin: 120,
  maxAdvanceDays: 60,
  holdMinutes: 5,
  reminderLeadHours: 24,
  samedayReminderEnabled: true,
};

/** "HH:MM:SS" or "HH:MM" → "HH:MM". */
function hhmm(t: string): string {
  return t.slice(0, 5);
}

// ── Idempotent seed ──────────────────────────────────────────────────────────

/** Ensure a provider has all 7 weekday hours rows (Mon–Fri 9–5, weekends closed). */
export async function seedProviderHours(sb: Sb, providerId: string): Promise<void> {
  const { data: hoursRows } = await sb
    .from("scheduling_hours")
    .select("day_of_week")
    .eq("provider_id", providerId);
  const existing = new Set((hoursRows ?? []).map((r) => r.day_of_week));
  const toInsert = [];
  for (let d = 0; d < 7; d++) {
    if (existing.has(d)) continue;
    const weekend = d === 0 || d === 6;
    toInsert.push({
      provider_id: providerId,
      day_of_week: d,
      open_time: "09:00",
      close_time: "17:00",
      is_closed: weekend,
    });
  }
  if (toInsert.length) {
    const { error } = await sb.from("scheduling_hours").insert(toInsert);
    if (error) throw new Error(`Couldn't seed hours: ${error.message}`);
  }
}

export async function ensureSetup(sb: Sb, tenantId: string, ownerUserId: string): Promise<string> {
  // 1. Provider — the MVP single provider, mapped to the owner's auth user.
  let providerId: string | null = null;
  const { data: provider } = await sb
    .from("scheduling_providers")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("is_active", true)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (provider) {
    providerId = provider.id;
  } else {
    const { data: tenant } = await sb.from("tenants").select("name").eq("id", tenantId).maybeSingle();
    const { data: created, error } = await sb
      .from("scheduling_providers")
      .insert({ tenant_id: tenantId, user_id: ownerUserId, name: tenant?.name ?? "Provider" })
      .select("id")
      .single();
    if (error || !created) throw new Error(`Couldn't create provider: ${error?.message ?? "unknown"}`);
    providerId = created.id;
  }

  // 2. Settings — one row per tenant, schema defaults.
  const { data: settings } = await sb
    .from("scheduling_settings")
    .select("id")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (!settings) {
    const { error } = await sb.from("scheduling_settings").insert({ tenant_id: tenantId });
    if (error) throw new Error(`Couldn't create settings: ${error.message}`);
  }

  // 3. Hours — ensure all 7 weekdays exist (Mon–Fri open 9–5, weekends closed).
  await seedProviderHours(sb, providerId);

  return providerId;
}

// ── getSchedulingSetupFn ─────────────────────────────────────────────────────

const authInput = z.object({
  accessToken: z.string().min(10),
  viewAsUserId: z.string().uuid().optional(),
});

export const getSchedulingSetupFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => authInput.parse(raw))
  .handler(async ({ data }): Promise<SchedulingSetupBundle> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);
    const providerId = await ensureSetup(sb, tenantId, effectiveUserId);

    // All providers (active + inactive) so the list can show/reactivate any.
    const { data: providerRows } = await sb
      .from("scheduling_providers")
      .select("id, name, is_active, created_at")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: true });
    const providers: ProviderRow[] = (providerRows ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      isActive: p.is_active,
    }));
    const providerIds = providers.map((p) => p.id);

    const [{ data: settingsRow }, { data: hoursRows }, { data: serviceRows }, { data: tenantRow }] =
      await Promise.all([
        sb.from("scheduling_settings").select("*").eq("tenant_id", tenantId).maybeSingle(),
        sb
          .from("scheduling_hours")
          .select("*")
          .in("provider_id", providerIds.length ? providerIds : [providerId])
          .order("day_of_week"),
        sb
          .from("services")
          .select("id, name, duration_min, buffer_min, online_bookable, hidden_at")
          .eq("tenant_id", tenantId)
          .is("hidden_at", null)
          .order("name"),
        sb.from("tenants").select("slug").eq("id", tenantId).maybeSingle(),
      ]);

    const settings: SchedulingSettingsDraft = settingsRow
      ? {
          timezone: settingsRow.timezone,
          onlineBookingEnabled: settingsRow.online_booking_enabled,
          slotGranularityMin: settingsRow.slot_granularity_min,
          minAdvanceNoticeMin: settingsRow.min_advance_notice_min,
          maxAdvanceDays: settingsRow.max_advance_days,
          holdMinutes: settingsRow.hold_minutes,
          reminderLeadHours: settingsRow.reminder_lead_hours,
          samedayReminderEnabled: settingsRow.sameday_reminder_enabled,
        }
      : { ...DEFAULT_SETTINGS };

    const hoursByProvider: Record<string, SchedulingHoursDraft[]> = {};
    for (const pid of providerIds) hoursByProvider[pid] = [];
    for (const h of hoursRows ?? []) {
      (hoursByProvider[h.provider_id] ??= []).push({
        dayOfWeek: h.day_of_week,
        openTime: hhmm(h.open_time),
        closeTime: hhmm(h.close_time),
        isClosed: h.is_closed,
      });
    }

    const services: BookableServiceDraft[] = (serviceRows ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      durationMin: s.duration_min,
      bufferMin: s.buffer_min,
      onlineBookable: s.online_bookable,
    }));

    return { providerId, providers, slug: tenantRow?.slug ?? "", settings, hoursByProvider, services };
  });

// ── saveSchedulingSetupFn ────────────────────────────────────────────────────

const hoursDraftSchema = z.object({
  providerId: z.string().uuid(),
  dayOfWeek: z.number().int().min(0).max(6),
  openTime: z.string().regex(/^\d{2}:\d{2}$/),
  closeTime: z.string().regex(/^\d{2}:\d{2}$/),
  isClosed: z.boolean(),
});

const settingsDraftSchema = z.object({
  timezone: z.string().min(1).max(64),
  onlineBookingEnabled: z.boolean(),
  slotGranularityMin: z.number().int().positive().max(240),
  minAdvanceNoticeMin: z.number().int().min(0).max(100000),
  maxAdvanceDays: z.number().int().positive().max(730),
  holdMinutes: z.number().int().positive().max(120),
  reminderLeadHours: z.number().int().min(0).max(336),
  samedayReminderEnabled: z.boolean(),
});

const serviceDraftSchema = z.object({
  id: z.string().uuid(),
  durationMin: z.number().int().positive().max(1440),
  bufferMin: z.number().int().min(0).max(1440),
  onlineBookable: z.boolean(),
});

const saveInput = z.object({
  accessToken: z.string().min(10),
  viewAsUserId: z.string().uuid().optional(),
  settings: settingsDraftSchema,
  // Provider-keyed: up to 7 rows × a reasonable provider count.
  hours: z.array(hoursDraftSchema).max(7 * 50),
  services: z.array(serviceDraftSchema).max(200),
});

export const saveSchedulingSetupFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => saveInput.parse(raw))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    // Validate hours before any write — friendlier than the DB CHECK.
    for (const h of data.hours) {
      if (!h.isClosed && h.openTime >= h.closeTime) {
        throw new Error(
          `Open time must be before close time on day ${h.dayOfWeek} (got ${h.openTime}–${h.closeTime}).`,
        );
      }
    }

    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);
    await ensureSetup(sb, tenantId, effectiveUserId);
    const nowIso = new Date().toISOString();

    // Guard: every hours row's providerId must belong to this tenant.
    if (data.hours.length) {
      const { data: ownProviders } = await sb
        .from("scheduling_providers")
        .select("id")
        .eq("tenant_id", tenantId);
      const ownIds = new Set((ownProviders ?? []).map((p) => p.id));
      for (const h of data.hours) {
        if (!ownIds.has(h.providerId)) {
          throw new Error("Hours reference a provider that isn't part of this spa.");
        }
      }
    }

    // 1. Settings — upsert on the unique tenant_id.
    const { error: sErr } = await sb.from("scheduling_settings").upsert(
      {
        tenant_id: tenantId,
        timezone: data.settings.timezone,
        online_booking_enabled: data.settings.onlineBookingEnabled,
        slot_granularity_min: data.settings.slotGranularityMin,
        min_advance_notice_min: data.settings.minAdvanceNoticeMin,
        max_advance_days: data.settings.maxAdvanceDays,
        hold_minutes: data.settings.holdMinutes,
        reminder_lead_hours: data.settings.reminderLeadHours,
        sameday_reminder_enabled: data.settings.samedayReminderEnabled,
        updated_at: nowIso,
      },
      { onConflict: "tenant_id" },
    );
    if (sErr) throw new Error(`Couldn't save settings: ${sErr.message}`);

    // 2. Hours — upsert on the unique (provider_id, day_of_week), per provider.
    if (data.hours.length) {
      const { error: hErr } = await sb.from("scheduling_hours").upsert(
        data.hours.map((h) => ({
          provider_id: h.providerId,
          day_of_week: h.dayOfWeek,
          open_time: h.openTime,
          close_time: h.closeTime,
          is_closed: h.isClosed,
          updated_at: nowIso,
        })),
        { onConflict: "provider_id,day_of_week" },
      );
      if (hErr) throw new Error(`Couldn't save hours: ${hErr.message}`);
    }

    // 3. Per-service scheduling overrides — guarded by tenant_id ownership.
    for (const s of data.services) {
      const { error: svcErr } = await sb
        .from("services")
        .update({
          duration_min: s.durationMin,
          buffer_min: s.bufferMin,
          online_bookable: s.onlineBookable,
          updated_at: nowIso,
        })
        .eq("id", s.id)
        .eq("tenant_id", tenantId);
      if (svcErr) throw new Error(`Couldn't save service ${s.id}: ${svcErr.message}`);
    }

    return { ok: true };
  });

// ── createProviderFn ─────────────────────────────────────────────────────────
// Provider management is persisted immediately (separate from the batched Save),
// so adding a provider never collides with unsaved hours/settings edits. The new
// provider seeds a default Mon–Fri 9–5 week so its hours grid is usable at once.

const createProviderInput = z.object({
  accessToken: z.string().min(10),
  viewAsUserId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(80),
});

export const createProviderFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => createProviderInput.parse(raw))
  .handler(
    async ({ data }): Promise<{ provider: ProviderRow; hours: SchedulingHoursDraft[] }> => {
      const { effectiveUserId } = await resolveEffectiveUserId({
        accessToken: data.accessToken,
        viewAsUserId: data.viewAsUserId,
      });
      const sb = admin();
      const tenantId = await getTenantIdForUser(sb, effectiveUserId);
      await ensureSetup(sb, tenantId, effectiveUserId);

      const { data: created, error } = await sb
        .from("scheduling_providers")
        .insert({ tenant_id: tenantId, name: data.name })
        .select("id, name, is_active")
        .single();
      if (error || !created) {
        throw new Error(`Couldn't add provider: ${error?.message ?? "unknown"}`);
      }

      await seedProviderHours(sb, created.id);
      const { data: hoursRows } = await sb
        .from("scheduling_hours")
        .select("day_of_week, open_time, close_time, is_closed")
        .eq("provider_id", created.id)
        .order("day_of_week");

      return {
        provider: { id: created.id, name: created.name, isActive: created.is_active },
        hours: (hoursRows ?? []).map((h) => ({
          dayOfWeek: h.day_of_week,
          openTime: hhmm(h.open_time),
          closeTime: hhmm(h.close_time),
          isClosed: h.is_closed,
        })),
      };
    },
  );

// ── updateProviderFn ─────────────────────────────────────────────────────────
// Rename and/or activate-deactivate. Never hard-deletes (preserves appointment
// history). Refuses to deactivate the last active provider — a spa must always
// have at least one bookable provider.

const updateProviderInput = z.object({
  accessToken: z.string().min(10),
  viewAsUserId: z.string().uuid().optional(),
  providerId: z.string().uuid(),
  name: z.string().trim().min(1).max(80).optional(),
  isActive: z.boolean().optional(),
});

export const updateProviderFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => updateProviderInput.parse(raw))
  .handler(async ({ data }): Promise<{ provider: ProviderRow }> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);

    // Ownership guard + last-active-provider guard.
    const { data: providers } = await sb
      .from("scheduling_providers")
      .select("id, is_active")
      .eq("tenant_id", tenantId);
    const target = (providers ?? []).find((p) => p.id === data.providerId);
    if (!target) throw new Error("That provider isn't part of this spa.");
    if (data.isActive === false && target.is_active) {
      const activeCount = (providers ?? []).filter((p) => p.is_active).length;
      if (activeCount <= 1) {
        throw new Error("You need at least one active provider. Add another before deactivating this one.");
      }
    }

    const patch: { name?: string; is_active?: boolean; updated_at: string } = {
      updated_at: new Date().toISOString(),
    };
    if (data.name !== undefined) patch.name = data.name;
    if (data.isActive !== undefined) patch.is_active = data.isActive;

    const { data: updated, error } = await sb
      .from("scheduling_providers")
      .update(patch)
      .eq("id", data.providerId)
      .eq("tenant_id", tenantId)
      .select("id, name, is_active")
      .single();
    if (error || !updated) {
      throw new Error(`Couldn't update provider: ${error?.message ?? "unknown"}`);
    }
    return { provider: { id: updated.id, name: updated.name, isActive: updated.is_active } };
  });
