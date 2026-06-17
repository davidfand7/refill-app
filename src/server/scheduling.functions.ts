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
import { fetchAllRows } from "@/server/paginate";
import {
  todayIsoInTz,
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
  loadTenantPromoOffers,
  recordCrossSellWin,
} from "@/server/refill-promo-calendar.functions";
import { recordRescheduleWinIfNudged } from "@/server/reschedule.functions";
import { getTenantOwnerUserId } from "@/server/scheduling-settings.functions";
import { resolveBrand, toPublicBrand, type PublicBrand } from "@/server/brand-resolver";
import { REFILL_BRAND, mergeBrand } from "@/lib/brand";
import { bestActiveOfferForName, badgeableOffers, type AddOnOffer } from "@/lib/promo-calendar";
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
    name: string;
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
        "id, name, duration_min, buffer_min, service_price, online_bookable, required_resource_type, tenant_id, hidden_at",
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
        name: svc.name,
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
  // display_name (sticky owner rename, v2.55.0) isn't in generated types yet →
  // loose-cast the select. Effective label = display_name override ?? Acuity name.
  const anySb = sb as unknown as { from(t: string): ReturnType<typeof sb.from> };
  const { data } = await anySb
    .from("scheduling_providers")
    .select("id, name, display_name, user_id, created_at")
    .eq("tenant_id", tenantId)
    .eq("is_active", true)
    .order("created_at", { ascending: true });
  const rows = (data ?? []) as unknown as Array<{
    id: string;
    name: string;
    display_name: string | null;
    user_id: string | null;
  }>;
  return rows.map((p) => ({
    id: p.id,
    name: p.display_name?.trim() || p.name,
    userId: p.user_id,
  }));
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
  const [{ data: hoursRows }, { data: overrideRows }, blockRows, { data: busyRows }] =
    await Promise.all([
      sb.from("scheduling_hours").select("*").eq("provider_id", providerId),
      sb
        .from("scheduling_date_overrides")
        .select("the_date, is_closed, open_time, close_time")
        .eq("provider_id", providerId)
        .gte("the_date", fromDate)
        .lte("the_date", toDate),
      // Whole-practice blocks (provider_id null) OR this provider's blocks.
      // Paginated: a long-lived spa accrues >1,000 block rows (a daily lunch
      // block alone is ~365/yr); an unpaginated read silently caps at 1,000 →
      // older blocks drop out → the slot engine offers BOOKABLE slots over
      // blocked time. The per-day overlap filter still happens in JS downstream.
      fetchAllRows<{ during: string | null; provider_id: string | null }>((from, to) =>
        sb
          .from("scheduling_blocks")
          .select("during, provider_id")
          .or(`provider_id.is.null,provider_id.eq.${providerId}`)
          .order("id")
          .range(from, to),
      ),
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
  /** Manual position within its category (lower first; null = unordered). */
  sortOrder: number | null;
  /** Intentionally free / no-charge → shows "Free". */
  isFree: boolean;
  /** Paid service whose fee is applied toward a treatment (e.g. a consult). */
  feeCredit: boolean;
  /** Add-ons a patient can tack onto this service (each extends time + price). */
  addOns: PublicAddOn[];
  /** Active providers who offer this service (v1: all active), with effective price/duration. */
  providers: PublicProviderOption[];
  /** Active manufacturer promo on this service, if any (Cross-Sell badge). */
  activeOffer?: AddOnOffer | null;
}

/** An add-on offered with a service (its own price + duration). */
export interface PublicAddOn {
  id: string;
  name: string;
  price: number;
  durationMin: number;
  isFree: boolean;
  /** Active manufacturer promo on this add-on, if any (Cross-Sell badge). */
  activeOffer?: AddOnOffer | null;
}

export type PublicBookingContext =
  | {
      ok: true;
      tenantId: string;
      spaName: string;
      timezone: string;
      /** Which smart option leads when a service is priced differently by provider. */
      leadOption: "best_deal" | "first_available";
      /** Tenant's manual category order (names; unlisted fall back to default). */
      categoryOrder: string[];
      /** Whether to show prices on the public page (off → hide $, no "Best value"). */
      showPrices: boolean;
      services: PublicServiceOption[];
      /** v2.66.0 — "Your Brand" white-label (project_your_brand_white_label).
       * Plain SmartSpa unless the tenant owner is entitled + active. */
      brand: PublicBrand;
    }
  | { ok: false; reason: string };

// v2.66.0 — lightweight brand-only lookup for the booking route's <head> loader,
// so link previews show the spa's brand name (og:site_name) when white-labeled.
// Mirrors getRescueOfferBrand / getWaitlistOptInBrand.
export const getPublicBookingBrandFn = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => slugInput.parse(input))
  .handler(async ({ data }): Promise<{ name: string } | null> => {
    const sb = admin();
    const { data: tenant } = await sb
      .from("tenants")
      .select("id")
      .ilike("slug", data.slug)
      .maybeSingle();
    if (!tenant) return null;
    const ownerUserId = await getTenantOwnerUserId(sb, tenant.id);
    if (!ownerUserId) return null;
    const resolved = await resolveBrand(sb, ownerUserId);
    return { name: resolved.name };
  });

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
      .select("timezone, online_booking_enabled, booking_lead_option, category_order, show_prices")
      .eq("tenant_id", tenant.id)
      .maybeSingle();
    if (!settings || !settings.online_booking_enabled) {
      return { ok: false, reason: "Online booking isn't available for this practice right now." };
    }
    const leadOption = settings.booking_lead_option === "first_available" ? "first_available" : "best_deal";
    const categoryOrder = settings.category_order ?? [];
    const showPrices = settings.show_prices !== false;

    const [{ data: services }, providers] = await Promise.all([
      sb
        .from("services")
        .select("id, name, duration_min, buffer_min, service_price, online_bookable, hidden_at, category, notes, sort_order, is_free, fee_credit")
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

    // Add-on eligibility per base service + add-on details. Add-ons may be
    // add-on-only (not online_bookable), so fetch their details separately.
    const addonsByService = new Map<string, PublicAddOn[]>();
    if (serviceIds.length) {
      const { data: saRows } = await sb
        .from("service_addons")
        .select("service_id, addon_service_id, sort_order")
        .eq("tenant_id", tenant.id)
        .order("sort_order");
      const wantedAddonIds = [...new Set((saRows ?? []).map((r) => r.addon_service_id))];
      const addonById = new Map<string, PublicAddOn>();
      if (wantedAddonIds.length) {
        const { data: addonRows } = await sb
          .from("services")
          .select("id, name, service_price, duration_min, is_free")
          .in("id", wantedAddonIds)
          .is("hidden_at", null);
        for (const a of addonRows ?? [])
          addonById.set(a.id, {
            id: a.id,
            name: a.name,
            price: a.service_price,
            durationMin: a.duration_min,
            isFree: a.is_free ?? false,
          });
      }
      for (const r of saRows ?? []) {
        const a = addonById.get(r.addon_service_id);
        if (!a) continue;
        const arr = addonsByService.get(r.service_id) ?? [];
        arr.push(a);
        addonsByService.set(r.service_id, arr);
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
          sortOrder: s.sort_order,
          isFree: s.is_free ?? false,
          feeCredit: s.fee_credit ?? false,
          addOns: addonsByService.get(s.id) ?? [],
          providers: providerOpts,
        };
      })
      // Hide a service no active provider performs; and, when prices are shown,
      // hide any still at $0 UNLESS it's intentionally free (so nothing goes
      // live mispriced, but free services still show).
      .filter((s) => s.providers.length > 0 && (!showPrices || s.fromPrice > 0 || s.isFree));

    // Cross-Sell: badge each add-on with the best currently-active offer
    // (matched by product keyword in the name). Cohort-targeted offers are
    // filtered out here — they don't badge to anonymous booking visitors;
    // they reach their patients via push (slice 4) and earn only in-cohort.
    const promoOffers = badgeableOffers(await loadTenantPromoOffers(sb, tenant.id));
    if (promoOffers.length > 0) {
      // Spa-local date so promo start/end boundaries don't fire hours early
      // (a UTC date rolls to "tomorrow" in the evening for US timezones).
      const today = todayIsoInTz(settings.timezone);
      for (const so of serviceOptions) {
        const svcOffer = bestActiveOfferForName(promoOffers, so.name, today);
        if (svcOffer) so.activeOffer = svcOffer;
        for (const ao of so.addOns) {
          const offer = bestActiveOfferForName(promoOffers, ao.name, today);
          if (offer) ao.activeOffer = offer;
        }
      }
    }

    // v2.66.0 — resolve the tenant owner's brand for the booking page.
    // Brand is keyed by user_id, booking by tenant_id, so map via the same
    // owner lookup native bookings use. Degrades to SmartSpa on any miss.
    const ownerUserId = await getTenantOwnerUserId(sb, tenant.id);
    const resolvedBrand = ownerUserId
      ? await resolveBrand(sb, ownerUserId)
      : null;

    return {
      ok: true,
      tenantId: tenant.id,
      spaName: tenant.name,
      timezone: settings.timezone,
      leadOption,
      categoryOrder,
      showPrices,
      services: serviceOptions,
      brand: resolvedBrand
        ? toPublicBrand(resolvedBrand)
        : toPublicBrand(mergeBrand(REFILL_BRAND, null)),
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
  /** Combined duration of chosen add-ons (min), added to the base service. */
  extraMinutes: z.number().int().min(0).optional(),
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
    const extraMinutes = Math.max(0, data.extraMinutes ?? 0);
    const perProvider = await Promise.all(
      targets.map(async (p) => {
        const eff = effective(base, overrides.get(p.id));
        const totalDuration = eff.durationMin + extraMinutes;
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
          service: { durationMin: totalDuration, bufferMin: eff.bufferMin },
          rangeStart: new Date(data.fromIso),
          rangeEnd: new Date(data.toIso),
          now: new Date(),
        });
        if (pool) {
          slots = slots.filter((s) => resourceFreeAt(pool, s.startMs, totalDuration));
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
  /** Chosen add-on service ids (validated server-side against eligibility). */
  addonServiceIds: z.array(z.string().uuid()).optional().default([]),
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
    if (!provider) {
      return { ok: false, reason: "That provider isn't available.", code: "invalid" };
    }
    // Native bookings stamp emma_appointments.user_id with the TENANT OWNER's
    // auth user (the account that owns the calendar). A provider needn't have
    // their own login — provider_id identifies the person; user_id is the tenant
    // linkage. Prefer a provider's own user_id, else fall back to the tenant
    // owner (providers are often created without a linked auth user).
    const ownerUserId =
      provider.userId ??
      activeProviders.find((p) => p.userId)?.userId ??
      (await getTenantOwnerUserId(sb, data.tenantId));
    if (!ownerUserId) {
      return { ok: false, reason: "This practice isn't set up to take bookings yet.", code: "invalid" };
    }
    const ov = (await loadOverrideMap(sb, [provider.id], data.serviceId)).get(provider.id);
    if (!offersService(ov)) {
      return { ok: false, reason: "That provider doesn't offer this service.", code: "invalid" };
    }
    const eff = effective(base, ov);

    // Resolve chosen add-ons against eligibility (never trust client price/min).
    // Each add-on extends the visit; the snapshot freezes price/min at hold time.
    type ChosenAddon = { id: string; name: string; price: number; durationMin: number };
    let chosenAddons: ChosenAddon[] = [];
    const requestedAddonIds = [...new Set(data.addonServiceIds)];
    if (requestedAddonIds.length) {
      const { data: eligRows } = await sb
        .from("service_addons")
        .select("addon_service_id")
        .eq("tenant_id", data.tenantId)
        .eq("service_id", data.serviceId)
        .in("addon_service_id", requestedAddonIds);
      const eligible = new Set((eligRows ?? []).map((r) => r.addon_service_id));
      const validIds = requestedAddonIds.filter((id) => eligible.has(id));
      if (validIds.length !== requestedAddonIds.length) {
        return { ok: false, reason: "An add-on isn't available for this service.", code: "invalid" };
      }
      if (validIds.length) {
        const { data: addonRows } = await sb
          .from("services")
          .select("id, name, service_price, duration_min, is_free")
          .in("id", validIds)
          .is("hidden_at", null);
        chosenAddons = (addonRows ?? []).map((a) => ({
          id: a.id,
          name: a.name,
          price: a.is_free ? 0 : a.service_price,
          durationMin: a.duration_min,
        }));
      }
    }
    const extraMinutes = chosenAddons.reduce((sum, a) => sum + a.durationMin, 0);
    const totalDuration = eff.durationMin + extraMinutes;

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
      service: { durationMin: totalDuration, bufferMin: eff.bufferMin },
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
        totalDuration,
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

    const { data: held, error: insErr } = await sb
      .from("emma_appointments")
      .insert({
        user_id: ownerUserId,
        provider_id: provider.id,
        resource_id: resourceId,
        scheduled_at: data.startIso,
        duration_min: totalDuration,
        status: "held",
        source: "native-online",
        slot_held_until: heldUntilIso,
        booking_token: token,
        // Snapshot the booked service so confirmBooking (which only has the
        // token) can resolve the cross-sell win + so attribution/waitlist
        // reads see what was booked. Native bookings left this null before.
        treatment_type: base.service.name,
      })
      .select("id")
      .single();

    if (insErr) {
      if (insErr.code === "23P01") {
        return { ok: false, reason: "That time was just taken.", code: "taken" };
      }
      return { ok: false, reason: `Couldn't hold the slot: ${insErr.message}`, code: "invalid" };
    }

    // Snapshot chosen add-ons onto the held appointment (price/min frozen now).
    if (held && chosenAddons.length) {
      await sb.from("appointment_addons").insert(
        chosenAddons.map((a) => ({
          appointment_id: held.id,
          addon_service_id: a.id,
          name: a.name,
          price: a.price,
          duration_min: a.durationMin,
        })),
      );
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
      .select("id, scheduled_at, provider_id, user_id, treatment_type, duration_min")
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
    let tenantId: string | null = null;
    let providerName: string | null = null;
    if (updated.provider_id) {
      const { data: prov } = await sb
        .from("scheduling_providers")
        .select("tenant_id, name")
        .eq("id", updated.provider_id)
        .maybeSingle();
      if (prov) {
        tenantId = prov.tenant_id;
        providerName = prov.name ?? null;
        const [{ data: t }, { data: st }] = await Promise.all([
          sb.from("tenants").select("name").eq("id", prov.tenant_id).maybeSingle(),
          sb.from("scheduling_settings").select("timezone").eq("tenant_id", prov.tenant_id).maybeSingle(),
        ]);
        if (t?.name) spaName = t.name;
        if (st?.timezone) timezone = st.timezone;
      }
    }
    // Load the snapshotted add-ons once — shared by the confirmation email
    // (itemization) and the cross-sell win below.
    const { data: apptAddonRows } = await sb
      .from("appointment_addons")
      .select("name, duration_min")
      .eq("appointment_id", updated.id);
    const apptAddons = (apptAddonRows ?? []).map((a) => ({
      name: a.name,
      durationMin: a.duration_min ?? 0,
    }));

    // Awaited (the Worker isolate dies at response) but best-effort: the
    // booking is already committed, so a send failure must NOT crash the
    // handler and show the patient an error for a booking that succeeded.
    try {
      await sendBookingConfirmation({
        to: data.email,
        spaName,
        startIso: updated.scheduled_at,
        timezone,
        serviceName: updated.treatment_type ?? undefined,
        providerName,
        durationMin: updated.duration_min ?? undefined,
        addOns: apptAddons,
      });
    } catch (e) {
      console.error("[scheduling-email] confirmation send failed:", e);
    }

    // Cross-Sell: if the booked service (or a chosen add-on) carried an active
    // promo and this patient resolves in the graph, record a $5 cross_sell win.
    // Mirrors the owner path — best-effort, never blocks the booking. The
    // service name was snapshotted onto treatment_type at hold time; add-on
    // names live on appointment_addons.
    if (tenantId && updated.user_id) {
      try {
        await recordCrossSellWin({
          sb,
          userId: updated.user_id,
          tenantId,
          appointmentId: updated.id,
          serviceName: updated.treatment_type ?? "",
          addOnNames: apptAddons.map((a) => a.name).filter(Boolean) as string[],
          email: data.email,
          phone: data.phone || null,
        });
      } catch (e) {
        console.error("[cross-sell] public self-book win failed:", e);
      }
      // Reschedule: a recently-nudged patient self-booking is a $5
      // reschedule_booking win (after cross-sell so a promo'd rebook stays one
      // win). Best-effort.
      try {
        await recordRescheduleWinIfNudged({
          sb,
          userId: updated.user_id,
          appointmentId: updated.id,
          email: data.email,
          phone: data.phone || null,
        });
      } catch (e) {
        console.error("[reschedule] public self-book win failed:", e);
      }
    }

    return { ok: true, appointmentId: updated.id, startIso: updated.scheduled_at };
  });
