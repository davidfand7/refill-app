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
  type DateOverrideRow,
  type ExistingAppointment,
  type ProviderHoursRow,
  type Slot,
  type SlotEngineSettings,
} from "@/lib/scheduling-slots";
import { sendBookingConfirmation } from "@/server/scheduling-email";
import {
  asResourceType,
  assignFreeResource,
  loadResourcePool,
  resourceFreeAt,
  type ResourceType,
} from "@/server/scheduling-resources";

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

// ── Shared loaders (multi-provider, v1.53.0) ─────────────────────────────────

/** Tenant settings + the requested service's catalog base, with the public
 *  gates (online booking on, service bookable). Provider-independent. */
interface BaseContext {
  tenantId: string;
  settings: SlotEngineSettings;
  holdMinutes: number;
  service: {
    id: string;
    durationMin: number;
    bufferMin: number;
    price: number;
    onlineBookable: boolean;
    requiredResourceType: ResourceType | null;
  };
}

async function loadBaseContext(
  sb: Sb,
  tenantId: string,
  serviceId: string,
): Promise<{ ok: true; base: BaseContext } | { ok: false; reason: string }> {
  const [{ data: settingsRow }, { data: svc }] = await Promise.all([
    sb.from("scheduling_settings").select("*").eq("tenant_id", tenantId).maybeSingle(),
    sb
      .from("services")
      .select(
        "id, duration_min, buffer_min, service_price, online_bookable, required_resource_type, tenant_id, hidden_at",
      )
      .eq("id", serviceId)
      .maybeSingle(),
  ]);

  if (!settingsRow) return { ok: false, reason: "Scheduling is not set up for this practice yet." };
  if (!settingsRow.online_booking_enabled) {
    return { ok: false, reason: "Online booking is currently turned off." };
  }
  if (!svc || svc.tenant_id !== tenantId || svc.hidden_at) {
    return { ok: false, reason: "That service isn't available." };
  }
  if (!svc.online_bookable) return { ok: false, reason: "That service can't be booked online." };

  return {
    ok: true,
    base: {
      tenantId,
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
        price: svc.service_price,
        onlineBookable: svc.online_bookable,
        requiredResourceType: asResourceType(svc.required_resource_type),
      },
    },
  };
}

interface ActiveProvider {
  id: string;
  name: string;
  userId: string | null;
}

/** Active providers for a tenant, ordered by created_at. (v1 rule: every active
 *  provider offers every online-bookable service; per-service opt-out is a later
 *  refinement.) */
async function loadActiveProviders(sb: Sb, tenantId: string): Promise<ActiveProvider[]> {
  const { data } = await sb
    .from("scheduling_providers")
    .select("id, name, user_id, created_at")
    .eq("tenant_id", tenantId)
    .eq("is_active", true)
    .order("created_at", { ascending: true });
  return (data ?? []).map((p) => ({ id: p.id, name: p.name, userId: p.user_id }));
}

type Override = {
  offered: boolean;
  durationMin: number | null;
  bufferMin: number | null;
  price: number | null;
};

/** providerId → override row for the given service (NULL fields = inherit;
 *  offered=false = provider does not perform the service). */
async function loadOverrideMap(
  sb: Sb,
  providerIds: string[],
  serviceId: string,
): Promise<Map<string, Override>> {
  const m = new Map<string, Override>();
  if (!providerIds.length) return m;
  const { data } = await sb
    .from("scheduling_provider_services")
    .select("provider_id, offered, duration_min, buffer_min, price")
    .eq("service_id", serviceId)
    .in("provider_id", providerIds);
  for (const r of data ?? []) {
    m.set(r.provider_id, {
      offered: r.offered,
      durationMin: r.duration_min,
      bufferMin: r.buffer_min,
      price: r.price,
    });
  }
  return m;
}

/** A provider offers a service unless an explicit row says offered=false. */
function offersService(ov: Override | undefined): boolean {
  return ov ? ov.offered : true;
}

/** effective = override ?? base, for one provider. */
function effective(base: BaseContext, ov?: Override): { durationMin: number; bufferMin: number; price: number } {
  return {
    durationMin: ov?.durationMin ?? base.service.durationMin,
    bufferMin: ov?.bufferMin ?? base.service.bufferMin,
    price: ov?.price ?? base.service.price,
  };
}

/** Load one provider's hours, overlapping blocks, and busy set for [from,to].
 *  bufferMin is the EFFECTIVE buffer for this provider×service. */
async function loadEngineInputs(
  sb: Sb,
  providerId: string,
  bufferMin: number,
  fromIso: string,
  toIso: string,
): Promise<{
  hours: ProviderHoursRow[];
  dateOverrides: DateOverrideRow[];
  blocks: BlockInterval[];
  busy: ExistingAppointment[];
}> {
  // Widen the date-override window by a day each side so tz-edge dates are covered.
  const fromDate = new Date(new Date(fromIso).getTime() - 24 * 60 * 60_000).toISOString().slice(0, 10);
  const toDate = new Date(new Date(toIso).getTime() + 24 * 60 * 60_000).toISOString().slice(0, 10);
  const [{ data: hoursRows }, { data: overrideRows }, { data: blockRows }, { data: busyRows }] =
    await Promise.all([
      sb.from("scheduling_hours").select("*").eq("provider_id", providerId),
      sb
        .from("scheduling_date_overrides")
        .select("the_date, is_closed, open_time, close_time")
        .eq("provider_id", providerId)
        .gte("the_date", fromDate)
        .lte("the_date", toDate),
      // Whole-practice blocks (provider_id null) OR this provider's blocks.
      sb
        .from("scheduling_blocks")
        .select("during, provider_id")
        .or(`provider_id.is.null,provider_id.eq.${providerId}`),
      sb
        .from("emma_appointments")
        .select("scheduled_at, duration_min, status, slot_held_until")
        .eq("provider_id", providerId)
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

  const dateOverrides: DateOverrideRow[] = (overrideRows ?? []).map((o) => ({
    date: o.the_date,
    isClosed: o.is_closed,
    openTime: o.open_time,
    closeTime: o.close_time,
  }));

  const blocks: BlockInterval[] = (blockRows ?? [])
    .map((b) => parseTstzRange(b.during))
    .filter((x): x is BlockInterval => x !== null);

  const nowMs = Date.now();
  const busy: ExistingAppointment[] = (busyRows ?? [])
    .filter((a) => {
      if (a.status !== "held") return true;
      return a.slot_held_until != null && new Date(a.slot_held_until).getTime() > nowMs;
    })
    .map((a) => ({
      startMs: new Date(a.scheduled_at).getTime(),
      durationMin: a.duration_min,
      bufferMin,
    }));

  return { hours, dateOverrides, blocks, busy };
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

// ── getPublicBookingContext (slug → tenant + bookable services) ──────────────

const slugInput = z.object({ slug: z.string().min(1).max(80) });

/** A provider a patient can choose for a service, with their effective price. */
export interface PublicProviderOption {
  id: string;
  name: string;
  price: number;
  durationMin: number;
}

export interface PublicServiceOption {
  id: string;
  name: string;
  /** Catalog base duration (display fallback). */
  durationMin: number;
  /** Lowest effective price across offering providers (the "from $X"). */
  fromPrice: number;
  /** Service category (for grouping the picker). */
  category: string;
  /** Freeform patient-facing notes/description (what makes us unique). */
  notes: string | null;
  /** Active providers who offer this service (v1: all active), with effective price/duration. */
  providers: PublicProviderOption[];
}

export type PublicBookingContext =
  | {
      ok: true;
      tenantId: string;
      spaName: string;
      timezone: string;
      /** Which smart option leads when a service is priced differently by provider. */
      leadOption: "best_deal" | "first_available";
      services: PublicServiceOption[];
    }
  | { ok: false; reason: string };

export const getPublicBookingContextFn = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => slugInput.parse(input))
  .handler(async ({ data }): Promise<PublicBookingContext> => {
    const sb = admin();
    const { data: tenant } = await sb
      .from("tenants")
      .select("id, name")
      .ilike("slug", data.slug) // slug charset is [a-z0-9-]; case-insensitive exact
      .maybeSingle();
    if (!tenant) return { ok: false, reason: "We couldn't find that practice." };

    const { data: settings } = await sb
      .from("scheduling_settings")
      .select("timezone, online_booking_enabled, booking_lead_option")
      .eq("tenant_id", tenant.id)
      .maybeSingle();
    if (!settings || !settings.online_booking_enabled) {
      return { ok: false, reason: "Online booking isn't available for this practice right now." };
    }
    const leadOption = settings.booking_lead_option === "first_available" ? "first_available" : "best_deal";

    const [{ data: services }, providers] = await Promise.all([
      sb
        .from("services")
        .select("id, name, duration_min, buffer_min, service_price, online_bookable, hidden_at, category, notes")
        .eq("tenant_id", tenant.id)
        .eq("online_bookable", true)
        .is("hidden_at", null)
        .order("name"),
      loadActiveProviders(sb, tenant.id),
    ]);

    // Every active provider is bookable — a provider needn't have their own login
    // (their appointments stamp the tenant owner's user_id; see holdSlot).
    const bookableProviders = providers;
    const providerIds = bookableProviders.map((p) => p.id);

    // All overrides for these providers across the bookable services, in one read.
    const serviceIds = (services ?? []).map((s) => s.id);
    const overridesByService = new Map<string, Map<string, Override>>();
    if (providerIds.length && serviceIds.length) {
      const { data: ovRows } = await sb
        .from("scheduling_provider_services")
        .select("provider_id, service_id, offered, duration_min, buffer_min, price")
        .in("provider_id", providerIds)
        .in("service_id", serviceIds);
      for (const r of ovRows ?? []) {
        let m = overridesByService.get(r.service_id);
        if (!m) {
          m = new Map();
          overridesByService.set(r.service_id, m);
        }
        m.set(r.provider_id, {
          offered: r.offered,
          durationMin: r.duration_min,
          bufferMin: r.buffer_min,
          price: r.price,
        });
      }
    }

    const serviceOptions: PublicServiceOption[] = (services ?? [])
      .map((s) => {
        const ovMap = overridesByService.get(s.id);
        // Only providers who actually offer this service (no row OR offered=true).
        const providerOpts: PublicProviderOption[] = bookableProviders
          .filter((p) => offersService(ovMap?.get(p.id)))
          .map((p) => {
            const ov = ovMap?.get(p.id);
            return {
              id: p.id,
              name: p.name,
              price: ov?.price ?? s.service_price,
              durationMin: ov?.durationMin ?? s.duration_min,
            };
          });
        const fromPrice = providerOpts.length
          ? Math.min(...providerOpts.map((p) => p.price))
          : s.service_price;
        return {
          id: s.id,
          name: s.name,
          durationMin: s.duration_min,
          fromPrice,
          category: s.category,
          notes: s.notes,
          providers: providerOpts,
        };
      })
      // Hide a service no active provider performs.
      .filter((s) => s.providers.length > 0);

    return {
      ok: true,
      tenantId: tenant.id,
      spaName: tenant.name,
      timezone: settings.timezone,
      leadOption,
      services: serviceOptions,
    };
  });

// ── listAvailableSlots ───────────────────────────────────────────────────────

const listInput = z.object({
  tenantId: z.string().uuid(),
  serviceId: z.string().uuid(),
  /** Omit for "first available" (union across the team). */
  providerId: z.string().uuid().optional(),
  /** "Best deal": union only across the lowest-priced provider(s). */
  cheapestOnly: z.boolean().optional(),
  fromIso: z.string().min(10),
  toIso: z.string().min(10),
});

/** A bookable slot tagged with the provider it belongs to. */
export interface PublicSlot {
  startIso: string;
  endIso: string;
  startMs: number;
  providerId: string;
}

export type ListSlotsResult =
  | { ok: true; slots: PublicSlot[]; timezone: string }
  | { ok: false; reason: string };

export const listAvailableSlots = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => listInput.parse(input))
  .handler(async ({ data }): Promise<ListSlotsResult> => {
    const sb = admin();
    const loaded = await loadBaseContext(sb, data.tenantId, data.serviceId);
    if (!loaded.ok) return { ok: false, reason: loaded.reason };
    const { base } = loaded;

    const providers = await loadActiveProviders(sb, data.tenantId);
    let targets = providers;
    if (data.providerId) {
      targets = targets.filter((p) => p.id === data.providerId);
      if (!targets.length) return { ok: false, reason: "That provider isn't available." };
    }
    if (!targets.length) return { ok: false, reason: "No bookable provider is configured." };

    const overrides = await loadOverrideMap(
      sb,
      targets.map((p) => p.id),
      data.serviceId,
    );

    // Drop providers who don't perform this service (explicit offered=false).
    targets = targets.filter((p) => offersService(overrides.get(p.id)));
    if (!targets.length) {
      return { ok: false, reason: "No provider offers this service right now." };
    }

    // "Best deal": restrict to the lowest effective-price provider(s) (price is
    // resolved server-side — never trust a client-supplied price). Ties union.
    if (data.cheapestOnly && !data.providerId && targets.length > 1) {
      const priceOf = (id: string) => effective(base, overrides.get(id)).price;
      const minPrice = Math.min(...targets.map((p) => priceOf(p.id)));
      targets = targets.filter((p) => priceOf(p.id) === minPrice);
    }

    // Shared resource pool (rooms are tenant-wide, contended across providers).
    const reqType = base.service.requiredResourceType;
    const pool = reqType
      ? await loadResourcePool(sb, data.tenantId, reqType, data.fromIso, data.toIso)
      : null;
    // A required type with zero active resources can never be fulfilled.
    if (pool && pool.capacity === 0) {
      return { ok: false, reason: "This service needs a room that isn't set up yet." };
    }

    // Compute each provider's slots with THEIR effective duration/buffer, then
    // drop any slot where no resource of the required type is free.
    const perProvider = await Promise.all(
      targets.map(async (p) => {
        const eff = effective(base, overrides.get(p.id));
        const { hours, dateOverrides, blocks, busy } = await loadEngineInputs(
          sb,
          p.id,
          eff.bufferMin,
          data.fromIso,
          data.toIso,
        );
        let slots = availableSlots({
          settings: base.settings,
          hours,
          dateOverrides,
          blocks,
          busy,
          service: { durationMin: eff.durationMin, bufferMin: eff.bufferMin },
          rangeStart: new Date(data.fromIso),
          rangeEnd: new Date(data.toIso),
          now: new Date(),
        });
        if (pool) {
          slots = slots.filter((s) => resourceFreeAt(pool, s.startMs, eff.durationMin));
        }
        return { providerId: p.id, slots };
      }),
    );

    // Merge. For "first available" (multiple providers), dedupe by start time —
    // keep the first provider in provider order (the spa's listed seniority) so
    // assignment is deterministic; a single-provider/specific query is 1:1.
    const byStart = new Map<number, PublicSlot>();
    for (const { providerId, slots } of perProvider) {
      for (const s of slots) {
        if (!byStart.has(s.startMs)) {
          byStart.set(s.startMs, {
            startIso: s.startIso,
            endIso: s.endIso,
            startMs: s.startMs,
            providerId,
          });
        }
      }
    }
    const merged = Array.from(byStart.values()).sort((a, b) => a.startMs - b.startMs);
    return { ok: true, slots: merged, timezone: base.settings.timezone };
  });

// ── holdSlot ─────────────────────────────────────────────────────────────────

const holdInput = z.object({
  tenantId: z.string().uuid(),
  serviceId: z.string().uuid(),
  /** The provider that owns the chosen slot (carried from listAvailableSlots). */
  providerId: z.string().uuid(),
  startIso: z.string().min(10),
});

export type HoldResult =
  | { ok: true; token: string; heldUntilIso: string }
  | { ok: false; reason: string; code?: "taken" | "stale" | "invalid" };

export const holdSlot = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => holdInput.parse(input))
  .handler(async ({ data }): Promise<HoldResult> => {
    const sb = admin();
    const loaded = await loadBaseContext(sb, data.tenantId, data.serviceId);
    if (!loaded.ok) return { ok: false, reason: loaded.reason, code: "invalid" };
    const { base } = loaded;

    // Validate the target provider belongs to the tenant and is active.
    const activeProviders = await loadActiveProviders(sb, data.tenantId);
    const provider = activeProviders.find((p) => p.id === data.providerId);
    if (!provider) return { ok: false, reason: "That provider isn't available.", code: "invalid" };
    // Native bookings stamp emma_appointments.user_id with the TENANT OWNER's
    // auth user (the account that owns the calendar). A provider needn't have
    // their own login — provider_id identifies the person; user_id is the tenant
    // linkage. Fall back to the owner when this provider has no user_id.
    const ownerUserId = provider.userId ?? activeProviders.find((p) => p.userId)?.userId ?? null;
    if (!ownerUserId) {
      return { ok: false, reason: "This practice isn't set up to take bookings yet.", code: "invalid" };
    }
    const ov = (await loadOverrideMap(sb, [provider.id], data.serviceId)).get(provider.id);
    if (!offersService(ov)) {
      return { ok: false, reason: "That provider doesn't offer this service.", code: "invalid" };
    }
    const eff = effective(base, ov);

    const startMs = new Date(data.startIso).getTime();
    if (Number.isNaN(startMs)) return { ok: false, reason: "Invalid time.", code: "invalid" };

    // 1. Release this provider's expired holds so a stale row can't block a slot
    //    the engine considers free.
    await sb
      .from("emma_appointments")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .eq("provider_id", provider.id)
      .eq("status", "held")
      .lt("slot_held_until", new Date().toISOString());

    // 2. Re-validate the requested start against the LIVE engine for THIS provider
    //    — never trust the client.
    const dayStart = new Date(startMs - 12 * 60 * 60_000);
    const dayEnd = new Date(startMs + 12 * 60 * 60_000);
    const { hours, dateOverrides, blocks, busy } = await loadEngineInputs(
      sb,
      provider.id,
      eff.bufferMin,
      dayStart.toISOString(),
      dayEnd.toISOString(),
    );
    const slots = availableSlots({
      settings: base.settings,
      hours,
      dateOverrides,
      blocks,
      busy,
      service: { durationMin: eff.durationMin, bufferMin: eff.bufferMin },
      rangeStart: dayStart,
      rangeEnd: dayEnd,
      now: new Date(),
    });
    if (!slots.some((s) => s.startMs === startMs)) {
      return { ok: false, reason: "That time is no longer available.", code: "taken" };
    }

    // 3a. If the service needs a room/resource, claim a free one of that type.
    let resourceId: string | null = null;
    if (base.service.requiredResourceType) {
      resourceId = await assignFreeResource(
        sb,
        data.tenantId,
        base.service.requiredResourceType,
        startMs,
        eff.durationMin,
      );
      if (!resourceId) {
        return { ok: false, reason: "No room is free at that time.", code: "taken" };
      }
    }

    // 3b. Insert the hold. The EXCLUDE constraints (per provider AND per resource)
    //    are the real concurrency arbiters — a simultaneous overlapping hold makes
    //    exactly one insert fail with 23P01.
    const token = crypto.randomUUID();
    const heldUntilIso = new Date(Date.now() + base.holdMinutes * 60_000).toISOString();

    const { error: insErr } = await sb.from("emma_appointments").insert({
      user_id: ownerUserId,
      provider_id: provider.id,
      resource_id: resourceId,
      scheduled_at: data.startIso,
      duration_min: eff.durationMin,
      status: "held",
      source: "native-online",
      slot_held_until: heldUntilIso,
      booking_token: token,
    });

    if (insErr) {
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
      .select("id, scheduled_at, provider_id")
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

    // Confirmation email (best-effort — never fails the booking). Resolve the
    // spa display name + timezone from the appointment's provider → tenant.
    let spaName = "Your appointment";
    let timezone = "America/Los_Angeles";
    if (updated.provider_id) {
      const { data: prov } = await sb
        .from("scheduling_providers")
        .select("tenant_id")
        .eq("id", updated.provider_id)
        .maybeSingle();
      if (prov) {
        const [{ data: t }, { data: st }] = await Promise.all([
          sb.from("tenants").select("name").eq("id", prov.tenant_id).maybeSingle(),
          sb.from("scheduling_settings").select("timezone").eq("tenant_id", prov.tenant_id).maybeSingle(),
        ]);
        if (t?.name) spaName = t.name;
        if (st?.timezone) timezone = st.timezone;
      }
    }
    // Awaited, not fire-and-forget: the Worker isolate dies at response.
    await sendBookingConfirmation({
      to: data.email,
      spaName,
      startIso: updated.scheduled_at,
      timezone,
    });

    // TODO(next ship — $5/$5 billing meter): classify the booking → write a
    // scheduling_billable_events row (slot_fill if a rescue token was consumed,
    // campaign_booking if a campaign token was present, else free).

    return { ok: true, appointmentId: updated.id, startIso: updated.scheduled_at };
  });
