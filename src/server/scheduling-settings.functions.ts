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

export type BookingLeadOption = "best_deal" | "first_available";

export interface SchedulingSettingsDraft {
  timezone: string;
  onlineBookingEnabled: boolean;
  slotGranularityMin: number;
  minAdvanceNoticeMin: number;
  maxAdvanceDays: number;
  holdMinutes: number;
  reminderLeadHours: number;
  samedayReminderEnabled: boolean;
  /** Which smart option leads on the public page when prices vary. */
  bookingLeadOption: BookingLeadOption;
}

export interface BookableServiceDraft {
  id: string;
  name: string;
  category: string;
  durationMin: number;
  bufferMin: number;
  /** Catalog base price (read-only here; edited on the catalog page). Used as
   *  the inherited placeholder for per-provider price overrides. */
  price: number;
  onlineBookable: boolean;
  /** Resource type this service needs (room/chair/device), or null = none. */
  requiredResourceType: ResourceType | null;
}

export interface ProviderRow {
  id: string;
  name: string;
  isActive: boolean;
}

export type ResourceType = "room" | "chair" | "device";

export const SERVICE_CATEGORIES = ["tox", "filler", "laser", "facial", "skincare", "other"] as const;
export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number];

export interface ResourceRow {
  id: string;
  name: string;
  type: ResourceType;
  isActive: boolean;
}

/** A per-provider override row. NULL field = inherit the service's value.
 *  `offered=false` = this provider does not perform the service. */
export interface ProviderServiceOverrideRow {
  providerId: string;
  serviceId: string;
  offered: boolean;
  durationMin: number | null;
  bufferMin: number | null;
  price: number | null;
}

export interface SchedulingSetupBundle {
  /** Primary (earliest active) provider — kept for back-compat / default selection. */
  providerId: string;
  /** All providers (active + inactive), ordered by created_at. */
  providers: ProviderRow[];
  /** All rooms/resources (active + inactive), ordered by created_at. */
  resources: ResourceRow[];
  /** Tenant slug — used to build the public booking link /s/<slug>. */
  slug: string;
  settings: SchedulingSettingsDraft;
  /** providerId → that provider's 7 weekday hours rows. */
  hoursByProvider: Record<string, SchedulingHoursDraft[]>;
  services: BookableServiceDraft[];
  /** Per-provider duration/buffer/price overrides (only rows that exist). */
  providerServices: ProviderServiceOverrideRow[];
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
  bookingLeadOption: "best_deal",
};

/** "HH:MM:SS" or "HH:MM" → "HH:MM". */
function hhmm(t: string): string {
  return t.slice(0, 5);
}

/** Coerce a stored resource type to the known union (defaults to "room"). */
function normalizeResourceType(t: string): ResourceType {
  return t === "chair" || t === "device" ? t : "room";
}

/** Coerce a nullable required-resource-type to the union or null. */
function normalizeResourceTypeOrNull(t: string | null): ResourceType | null {
  return t === "room" || t === "chair" || t === "device" ? t : null;
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

    const { data: resourceRows } = await sb
      .from("scheduling_resources")
      .select("id, name, type, is_active, created_at")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: true });
    const resources: ResourceRow[] = (resourceRows ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      type: normalizeResourceType(r.type),
      isActive: r.is_active,
    }));

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
          .select(
            "id, name, category, duration_min, buffer_min, service_price, online_bookable, required_resource_type, hidden_at",
          )
          .eq("tenant_id", tenantId)
          .is("hidden_at", null)
          .order("name"),
        sb.from("tenants").select("slug").eq("id", tenantId).maybeSingle(),
      ]);

    const { data: psRows } = await sb
      .from("scheduling_provider_services")
      .select("provider_id, service_id, offered, duration_min, buffer_min, price")
      .in("provider_id", providerIds.length ? providerIds : [providerId]);
    const providerServices: ProviderServiceOverrideRow[] = (psRows ?? []).map((r) => ({
      providerId: r.provider_id,
      serviceId: r.service_id,
      offered: r.offered,
      durationMin: r.duration_min,
      bufferMin: r.buffer_min,
      price: r.price,
    }));

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
          bookingLeadOption:
            settingsRow.booking_lead_option === "first_available"
              ? "first_available"
              : "best_deal",
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
      category: s.category,
      durationMin: s.duration_min,
      bufferMin: s.buffer_min,
      price: s.service_price,
      onlineBookable: s.online_bookable,
      requiredResourceType: normalizeResourceTypeOrNull(s.required_resource_type),
    }));

    return {
      providerId,
      providers,
      resources,
      slug: tenantRow?.slug ?? "",
      settings,
      hoursByProvider,
      services,
      providerServices,
    };
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
  bookingLeadOption: z.enum(["best_deal", "first_available"]),
});

const serviceDraftSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(160),
  category: z.enum(SERVICE_CATEGORIES),
  price: z.number().nonnegative().max(1_000_000),
  durationMin: z.number().int().positive().max(1440),
  bufferMin: z.number().int().min(0).max(1440),
  onlineBookable: z.boolean(),
  requiredResourceType: z.enum(["room", "chair", "device"]).nullable(),
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
        booking_lead_option: data.settings.bookingLeadOption,
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
          name: s.name,
          category: s.category,
          service_price: s.price,
          duration_min: s.durationMin,
          buffer_min: s.bufferMin,
          online_bookable: s.onlineBookable,
          required_resource_type: s.requiredResourceType,
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

// ── createResourceFn / updateResourceFn ──────────────────────────────────────
// Rooms / chairs / devices. Unlike providers, a spa may have ZERO active
// resources (they're optional until a service requires one), so there is no
// last-active guard. Persisted immediately. Deactivate, never hard-delete.

const RESOURCE_TYPES = ["room", "chair", "device"] as const;

const createResourceInput = z.object({
  accessToken: z.string().min(10),
  viewAsUserId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(80),
  type: z.enum(RESOURCE_TYPES),
});

export const createResourceFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => createResourceInput.parse(raw))
  .handler(async ({ data }): Promise<{ resource: ResourceRow }> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);

    const { data: created, error } = await sb
      .from("scheduling_resources")
      .insert({ tenant_id: tenantId, name: data.name, type: data.type })
      .select("id, name, type, is_active")
      .single();
    if (error || !created) {
      throw new Error(`Couldn't add resource: ${error?.message ?? "unknown"}`);
    }
    return {
      resource: {
        id: created.id,
        name: created.name,
        type: normalizeResourceType(created.type),
        isActive: created.is_active,
      },
    };
  });

const updateResourceInput = z.object({
  accessToken: z.string().min(10),
  viewAsUserId: z.string().uuid().optional(),
  resourceId: z.string().uuid(),
  name: z.string().trim().min(1).max(80).optional(),
  type: z.enum(RESOURCE_TYPES).optional(),
  isActive: z.boolean().optional(),
});

export const updateResourceFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => updateResourceInput.parse(raw))
  .handler(async ({ data }): Promise<{ resource: ResourceRow }> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);

    const patch: { name?: string; type?: ResourceType; is_active?: boolean; updated_at: string } = {
      updated_at: new Date().toISOString(),
    };
    if (data.name !== undefined) patch.name = data.name;
    if (data.type !== undefined) patch.type = data.type;
    if (data.isActive !== undefined) patch.is_active = data.isActive;

    const { data: updated, error } = await sb
      .from("scheduling_resources")
      .update(patch)
      .eq("id", data.resourceId)
      .eq("tenant_id", tenantId)
      .select("id, name, type, is_active")
      .single();
    if (error || !updated) {
      throw new Error(`Couldn't update resource: ${error?.message ?? "unknown"}`);
    }
    return {
      resource: {
        id: updated.id,
        name: updated.name,
        type: normalizeResourceType(updated.type),
        isActive: updated.is_active,
      },
    };
  });

// ── setProviderServiceOverrideFn ─────────────────────────────────────────────
// Sets (or clears) a provider's per-service duration/buffer/price override.
// NULL on a field = inherit the service's catalog value. When ALL three become
// NULL the row is deleted (keeps the table to genuine overrides only). Persisted
// immediately, like the rest of provider management.

const psOverrideInput = z.object({
  accessToken: z.string().min(10),
  viewAsUserId: z.string().uuid().optional(),
  providerId: z.string().uuid(),
  serviceId: z.string().uuid(),
  offered: z.boolean(),
  durationMin: z.number().int().positive().max(1440).nullable(),
  bufferMin: z.number().int().min(0).max(1440).nullable(),
  price: z.number().min(0).max(1_000_000).nullable(),
});

export const setProviderServiceOverrideFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => psOverrideInput.parse(raw))
  .handler(async ({ data }): Promise<{ row: ProviderServiceOverrideRow | null }> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);

    // Ownership: provider + service must both belong to this tenant.
    const [{ data: prov }, { data: svc }] = await Promise.all([
      sb
        .from("scheduling_providers")
        .select("id")
        .eq("id", data.providerId)
        .eq("tenant_id", tenantId)
        .maybeSingle(),
      sb
        .from("services")
        .select("id")
        .eq("id", data.serviceId)
        .eq("tenant_id", tenantId)
        .maybeSingle(),
    ]);
    if (!prov) throw new Error("That provider isn't part of this spa.");
    if (!svc) throw new Error("That service isn't part of this spa.");

    const noOverride = data.durationMin === null && data.bufferMin === null && data.price === null;
    if (data.offered && noOverride) {
      // Pure default (offers it, all inherited) → drop the row entirely.
      const { error } = await sb
        .from("scheduling_provider_services")
        .delete()
        .eq("provider_id", data.providerId)
        .eq("service_id", data.serviceId);
      if (error) throw new Error(`Couldn't clear override: ${error.message}`);
      return { row: null };
    }

    const { data: row, error } = await sb
      .from("scheduling_provider_services")
      .upsert(
        {
          provider_id: data.providerId,
          service_id: data.serviceId,
          offered: data.offered,
          duration_min: data.durationMin,
          buffer_min: data.bufferMin,
          price: data.price,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "provider_id,service_id" },
      )
      .select("provider_id, service_id, offered, duration_min, buffer_min, price")
      .single();
    if (error || !row) throw new Error(`Couldn't save override: ${error?.message ?? "unknown"}`);
    return {
      row: {
        providerId: row.provider_id,
        serviceId: row.service_id,
        offered: row.offered,
        durationMin: row.duration_min,
        bufferMin: row.buffer_min,
        price: row.price,
      },
    };
  });

// ── assignProviderServiceFn ──────────────────────────────────────────────────
// The provider-centric view of the same offered map. Turning a service ON for a
// provider:
//   • If the service wasn't bookable yet → make it bookable AND opt every OTHER
//     active provider out, so it starts "bookable by THIS provider" (honoring
//     "add a service to a provider"). The owner can add others afterward.
//   • If it was already bookable → just ensure this provider performs it.
// Turning OFF = opt this provider out (offered=false). Opt-out semantics are
// unchanged, so the loved per-service view stays perfectly in sync.

export interface ServiceAssignmentResult {
  serviceId: string;
  onlineBookable: boolean;
  rows: ProviderServiceOverrideRow[];
}

/** Core assign/unassign for one (provider, service), shared by single + bulk. */
async function applyAssignment(
  sb: Sb,
  tenantId: string,
  providerId: string,
  serviceId: string,
  performs: boolean,
  activeProviderIds: string[],
  nowIso: string,
): Promise<void> {
  if (performs) {
    const { data: svc } = await sb
      .from("services")
      .select("online_bookable")
      .eq("id", serviceId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (!svc) return;
    if (!svc.online_bookable) {
      // Make bookable + opt every OTHER active provider out → bookable by this one.
      await sb
        .from("services")
        .update({ online_bookable: true, updated_at: nowIso })
        .eq("id", serviceId)
        .eq("tenant_id", tenantId);
      const others = activeProviderIds.filter((id) => id !== providerId);
      if (others.length) {
        await sb.from("scheduling_provider_services").upsert(
          others.map((id) => ({ provider_id: id, service_id: serviceId, offered: false })),
          { onConflict: "provider_id,service_id", ignoreDuplicates: true },
        );
      }
    }
    // Ensure THIS provider performs it: clear any explicit opt-out row.
    const { data: existing } = await sb
      .from("scheduling_provider_services")
      .select("id, offered")
      .eq("provider_id", providerId)
      .eq("service_id", serviceId)
      .maybeSingle();
    if (existing && existing.offered === false) {
      await sb
        .from("scheduling_provider_services")
        .update({ offered: true, updated_at: nowIso })
        .eq("id", existing.id);
    }
  } else {
    await sb.from("scheduling_provider_services").upsert(
      { provider_id: providerId, service_id: serviceId, offered: false, updated_at: nowIso },
      { onConflict: "provider_id,service_id" },
    );
  }
}

/** Re-read bookable + all rows for a set of services (post-assignment state). */
async function assignmentResults(sb: Sb, serviceIds: string[]): Promise<ServiceAssignmentResult[]> {
  if (!serviceIds.length) return [];
  const [{ data: svcs }, { data: rows }] = await Promise.all([
    sb.from("services").select("id, online_bookable").in("id", serviceIds),
    sb
      .from("scheduling_provider_services")
      .select("provider_id, service_id, offered, duration_min, buffer_min, price")
      .in("service_id", serviceIds),
  ]);
  const bookableById = new Map((svcs ?? []).map((s) => [s.id, s.online_bookable]));
  return serviceIds.map((sid) => ({
    serviceId: sid,
    onlineBookable: bookableById.get(sid) ?? false,
    rows: (rows ?? [])
      .filter((r) => r.service_id === sid)
      .map((r) => ({
        providerId: r.provider_id,
        serviceId: r.service_id,
        offered: r.offered,
        durationMin: r.duration_min,
        bufferMin: r.buffer_min,
        price: r.price,
      })),
  }));
}

// ── assignProviderServiceFn ──────────────────────────────────────────────────

const assignPSInput = z.object({
  accessToken: z.string().min(10),
  viewAsUserId: z.string().uuid().optional(),
  providerId: z.string().uuid(),
  serviceId: z.string().uuid(),
  performs: z.boolean(),
});

export const assignProviderServiceFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => assignPSInput.parse(raw))
  .handler(async ({ data }): Promise<ServiceAssignmentResult> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);
    const { data: prov } = await sb
      .from("scheduling_providers")
      .select("id")
      .eq("id", data.providerId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (!prov) throw new Error("That provider isn't part of this spa.");
    const { data: provs } = await sb
      .from("scheduling_providers")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("is_active", true);
    const activeIds = (provs ?? []).map((p) => p.id);

    await applyAssignment(
      sb,
      tenantId,
      data.providerId,
      data.serviceId,
      data.performs,
      activeIds,
      new Date().toISOString(),
    );
    return (await assignmentResults(sb, [data.serviceId]))[0];
  });

// ── assignProviderServicesBulkFn (category select/deselect) ──────────────────

const assignPSBulkInput = z.object({
  accessToken: z.string().min(10),
  viewAsUserId: z.string().uuid().optional(),
  providerId: z.string().uuid(),
  serviceIds: z.array(z.string().uuid()).min(1).max(500),
  performs: z.boolean(),
});

export const assignProviderServicesBulkFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => assignPSBulkInput.parse(raw))
  .handler(async ({ data }): Promise<{ services: ServiceAssignmentResult[] }> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);
    const { data: prov } = await sb
      .from("scheduling_providers")
      .select("id")
      .eq("id", data.providerId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (!prov) throw new Error("That provider isn't part of this spa.");

    // Only services belonging to this tenant.
    const { data: ownSvcs } = await sb
      .from("services")
      .select("id")
      .eq("tenant_id", tenantId)
      .in("id", data.serviceIds);
    const ids = (ownSvcs ?? []).map((s) => s.id);
    if (!ids.length) return { services: [] };

    const { data: provs } = await sb
      .from("scheduling_providers")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("is_active", true);
    const activeIds = (provs ?? []).map((p) => p.id);
    const nowIso = new Date().toISOString();
    for (const sid of ids) {
      await applyAssignment(sb, tenantId, data.providerId, sid, data.performs, activeIds, nowIso);
    }
    return { services: await assignmentResults(sb, ids) };
  });

// ── createBookableServiceFn / deleteBookableServiceFn ────────────────────────
// Lightweight create/delete over the services catalog, returning the booking
// draft shape. New services start NOT bookable (default off) with the catalog
// defaults (30 min, no buffer). Edits to name/category/price flow through the
// batched Save (saveSchedulingSetupFn). Delete cascades the provider×service
// rows via FK; appointments don't reference service_id, so they're unaffected.

const createBookableServiceInput = z.object({
  accessToken: z.string().min(10),
  viewAsUserId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(160),
  category: z.enum(SERVICE_CATEGORIES),
  price: z.number().nonnegative().max(1_000_000),
});

export const createBookableServiceFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => createBookableServiceInput.parse(raw))
  .handler(async ({ data }): Promise<{ service: BookableServiceDraft }> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);
    const { data: row, error } = await sb
      .from("services")
      .insert({
        tenant_id: tenantId,
        name: data.name,
        category: data.category,
        service_price: data.price,
        cogs_source: "manual",
      })
      .select(
        "id, name, category, duration_min, buffer_min, service_price, online_bookable, required_resource_type",
      )
      .single();
    if (error || !row) throw new Error(`Couldn't add service: ${error?.message ?? "unknown"}`);
    return {
      service: {
        id: row.id,
        name: row.name,
        category: row.category,
        durationMin: row.duration_min,
        bufferMin: row.buffer_min,
        price: row.service_price,
        onlineBookable: row.online_bookable,
        requiredResourceType: normalizeResourceTypeOrNull(row.required_resource_type),
      },
    };
  });

const deleteBookableServiceInput = z.object({
  accessToken: z.string().min(10),
  viewAsUserId: z.string().uuid().optional(),
  serviceId: z.string().uuid(),
});

export const deleteBookableServiceFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => deleteBookableServiceInput.parse(raw))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);
    const { error } = await sb
      .from("services")
      .delete()
      .eq("id", data.serviceId)
      .eq("tenant_id", tenantId);
    if (error) throw new Error(`Couldn't delete service: ${error.message}`);
    return { ok: true };
  });
