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
import { fetchAllRows } from "@/server/paginate";
import { ensureSetup, getTenantIdForUser } from "@/server/scheduling-settings.functions";
import {
  loadTenantPromoOffers,
  recordCrossSellWin,
} from "@/server/refill-promo-calendar.functions";
import { recordRescheduleWinIfNudged } from "@/server/reschedule.functions";
import { bestActiveOfferForName, badgeableOffers, type AddOnOffer } from "@/lib/promo-calendar";
import { zonedWallClockToUtc, zonedDateParts, todayIsoInTz } from "@/lib/scheduling-slots";
import { sendBookingConfirmation } from "@/server/scheduling-email";
import { asResourceType, assignFreeResource } from "@/server/scheduling-resources";

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

export interface ProviderLite {
  id: string;
  name: string;
}

/** An add-on offered with a service (its own price + duration). */
export interface AddOnLite {
  id: string;
  name: string;
  price: number;
  durationMin: number;
  isFree: boolean;
  /** Active manufacturer promo on this add-on, if any (Cross-Sell badge). */
  activeOffer?: AddOnOffer | null;
}

/** A service in the owner booking picker, with its eligible add-ons. */
export interface OwnerServiceLite {
  id: string;
  name: string;
  durationMin: number;
  category: string;
  sortOrder: number | null;
  addOns: AddOnLite[];
  /** Active manufacturer promo on this service, if any (Cross-Sell badge). */
  activeOffer?: AddOnOffer | null;
}

/** An add-on snapshotted onto an appointment (price/min frozen at booking). */
export interface ApptAddon {
  name: string;
  price: number;
  durationMin: number;
}

/** Open band for one day, minutes-from-midnight (local). */
export interface DayBand {
  isOpen: boolean;
  openMin: number;
  closeMin: number;
}

export interface DayAppointment {
  id: string;
  providerId: string | null;
  startIso: string;
  endIso: string;
  durationMin: number;
  status: string;
  patientName: string | null;
  source: string;
  /** Add-ons chosen for this appointment (snapshot), if any. */
  addOns: ApptAddon[];
}

export interface DayBlock {
  id: string;
  /** null = whole-practice block (shown in every provider column). */
  providerId: string | null;
  startIso: string;
  endIso: string;
  reason: string | null;
}

export interface DaySchedule {
  tenantId: string;
  timezone: string;
  dateIso: string;
  /** Active, VISIBLE providers, ordered by created_at (the day-view columns). */
  providers: ProviderLite[];
  /** How many active providers are hidden from the grid (for the review note). */
  hiddenProviderCount: number;
  /** providerId → that provider's open band for this weekday. */
  openByProvider: Record<string, DayBand>;
  appointments: DayAppointment[];
  blocks: DayBlock[];
  services: OwnerServiceLite[];
  /** providerId → serviceIds that provider does NOT offer (opt-out). */
  providerUnoffered: Record<string, string[]>;
}

type ApptRow = {
  id: string;
  provider_id: string | null;
  scheduled_at: string;
  duration_min: number;
  status: string;
  source: string;
  booking_name: string | null;
  patient_node_id: string | null;
};

/**
 * Active, VISIBLE providers for a tenant, ordered by created_at (column order).
 * Hidden providers (hidden_at set — an owner choice or the empty-business-calendar
 * smart default from the mirror) are excluded from the grid columns. v2.46.0.
 */
async function loadActiveProviders(
  sb: ReturnType<typeof admin>,
  tenantId: string,
): Promise<ProviderLite[]> {
  const { data } = await sb
    .from("scheduling_providers")
    .select("id, name, created_at")
    .eq("tenant_id", tenantId)
    .eq("is_active", true)
    .is("hidden_at", null)
    .order("created_at", { ascending: true });
  return (data ?? []).map((p) => ({ id: p.id, name: p.name }));
}

/** How many active providers the owner has hidden from the grid — drives the
 *  "N hidden — review" note so a hidden column is never a silent drop. */
async function countHiddenProviders(
  sb: ReturnType<typeof admin>,
  tenantId: string,
): Promise<number> {
  const { count } = await sb
    .from("scheduling_providers")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("is_active", true)
    .not("hidden_at", "is", null);
  return count ?? 0;
}

/**
 * Per-provider set of services they DON'T offer (opt-out model — a provider
 * offers a service unless an explicit row says offered=false). Lets the booking
 * UI hide services the chosen provider can't perform. providerId → serviceId[].
 */
async function loadProviderUnoffered(
  sb: ReturnType<typeof admin>,
  idFilter: string[],
): Promise<Record<string, string[]>> {
  const { data } = await sb
    .from("scheduling_provider_services")
    .select("provider_id, service_id")
    .in("provider_id", idFilter)
    .eq("offered", false);
  const m: Record<string, string[]> = {};
  for (const r of data ?? []) (m[r.provider_id] ??= []).push(r.service_id);
  return m;
}

/**
 * Eligible add-ons per base service (serviceId → AddOnLite[]), in display order.
 * Add-on details come from the services table (add-ons may be add-on-only, i.e.
 * not online_bookable, so they're fetched by id rather than from a filtered list).
 */
async function loadServiceAddons(
  sb: ReturnType<typeof admin>,
  tenantId: string,
): Promise<Map<string, AddOnLite[]>> {
  const map = new Map<string, AddOnLite[]>();
  const { data: saRows } = await sb
    .from("service_addons")
    .select("service_id, addon_service_id, sort_order")
    .eq("tenant_id", tenantId)
    .order("sort_order");
  if (!saRows?.length) return map;
  const addonIds = [...new Set(saRows.map((r) => r.addon_service_id))];
  const { data: addonRows } = await sb
    .from("services")
    .select("id, name, service_price, duration_min, is_free")
    .in("id", addonIds)
    .is("hidden_at", null);
  const byId = new Map<string, AddOnLite>();
  for (const a of addonRows ?? [])
    byId.set(a.id, {
      id: a.id,
      name: a.name,
      price: a.is_free ? 0 : a.service_price,
      durationMin: a.duration_min,
      isFree: a.is_free ?? false,
    });
  for (const r of saRows) {
    const a = byId.get(r.addon_service_id);
    if (!a) continue;
    const arr = map.get(r.service_id) ?? [];
    arr.push(a);
    map.set(r.service_id, arr);
  }
  return map;
}

/** Snapshotted add-ons per appointment (appointmentId → ApptAddon[]). */
async function loadApptAddons(
  sb: ReturnType<typeof admin>,
  apptIds: string[],
): Promise<Map<string, ApptAddon[]>> {
  const map = new Map<string, ApptAddon[]>();
  if (!apptIds.length) return map;
  const { data } = await sb
    .from("appointment_addons")
    .select("appointment_id, name, price, duration_min")
    .in("appointment_id", apptIds);
  for (const r of data ?? []) {
    const arr = map.get(r.appointment_id) ?? [];
    arr.push({ name: r.name, price: Number(r.price), durationMin: r.duration_min });
    map.set(r.appointment_id, arr);
  }
  return map;
}

/** Map raw appointment rows → DayAppointment[], resolving display names + add-ons. */
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
  const addonsByAppt = await loadApptAddons(sb, rows.map((a) => a.id));
  return rows.map((a) => ({
    id: a.id,
    providerId: a.provider_id,
    startIso: a.scheduled_at,
    endIso: new Date(new Date(a.scheduled_at).getTime() + a.duration_min * 60_000).toISOString(),
    durationMin: a.duration_min,
    status: a.status,
    patientName: a.booking_name ?? (a.patient_node_id ? titleById.get(a.patient_node_id) ?? null : null),
    source: a.source,
    addOns: addonsByAppt.get(a.id) ?? [],
  }));
}

/** Load this tenant's promo offers, badge every eligible add-on (mutating the
 *  AddOnLite objects in place), and return the offers + today so the caller
 *  can also badge the primary services (Cross-Sell). */
async function hydratePromoOffers(
  sb: Parameters<typeof loadTenantPromoOffers>[0],
  tenantId: string,
  serviceAddons: Map<string, AddOnLite[]>,
  tz: string,
): Promise<{ offers: Awaited<ReturnType<typeof loadTenantPromoOffers>>; today: string }> {
  // Cohort-targeted offers don't passively badge (the patient isn't known at
  // dialog-open) — they're delivered via push. Only 'all' offers badge here.
  const offers = badgeableOffers(await loadTenantPromoOffers(sb, tenantId));
  // Spa-local date so promo boundaries don't fire hours early (UTC rolls over
  // in the evening for US timezones).
  const today = todayIsoInTz(tz);
  if (offers.length > 0) {
    for (const arr of serviceAddons.values()) {
      for (const ao of arr) {
        const offer = bestActiveOfferForName(offers, ao.name, today);
        if (offer) ao.activeOffer = offer;
      }
    }
  }
  return { offers, today };
}

/** Best active offer for a service name (undefined when none), for inline
 *  badging of the primary service in the schedule payloads. */
function serviceOffer(
  offers: Awaited<ReturnType<typeof loadTenantPromoOffers>>,
  today: string,
  name: string,
): AddOnOffer | undefined {
  if (offers.length === 0) return undefined;
  return bestActiveOfferForName(offers, name, today) ?? undefined;
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
    await ensureSetup(sb, tenantId, effectiveUserId);
    const providers = await loadActiveProviders(sb, tenantId);
    const providerIds = providers.map((p) => p.id);
    const idFilter = providerIds.length ? providerIds : ["00000000-0000-0000-0000-000000000000"];

    const { data: settingsRow } = await sb
      .from("scheduling_settings")
      .select("timezone")
      .eq("tenant_id", tenantId)
      .maybeSingle();
    const timezone = settingsRow?.timezone ?? "America/Los_Angeles";

    const { startUtc, endUtc, weekday } = localDayBounds(data.dateIso, timezone);

    const [{ data: apptRows }, { data: hoursRows }, blockRows, { data: serviceRows }] =
      await Promise.all([
        sb
          .from("emma_appointments")
          .select(
            "id, provider_id, scheduled_at, duration_min, status, source, booking_name, patient_node_id",
          )
          .in("provider_id", idFilter)
          .neq("status", "cancelled")
          .gte("scheduled_at", startUtc.toISOString())
          .lt("scheduled_at", endUtc.toISOString())
          .order("scheduled_at"),
        sb
          .from("scheduling_hours")
          .select("provider_id, open_time, close_time, is_closed")
          .in("provider_id", idFilter)
          .eq("day_of_week", weekday),
        // Paginated: a long-lived spa accrues >1,000 block rows (a daily lunch
        // block alone is ~365/yr); an unpaginated read silently caps at 1,000 →
        // older blocks drop out → blocked time renders as FREE on the calendar.
        // The per-day overlap filter still happens in JS downstream.
        fetchAllRows<{ id: string; during: string | null; reason: string | null; provider_id: string | null }>(
          (from, to) =>
            sb
              .from("scheduling_blocks")
              .select("id, during, reason, provider_id")
              .eq("tenant_id", tenantId)
              .order("id")
              .range(from, to),
        ),
        sb
          .from("services")
          .select("id, name, duration_min, hidden_at, online_bookable, category, sort_order")
          .eq("tenant_id", tenantId)
          .eq("online_bookable", true)
          .is("hidden_at", null)
          .order("name"),
      ]);

    // Native bookings carry booking_name; matched ones resolve via knowledge_nodes.
    const appointments = await hydrateAppointments(sb, apptRows ?? []);
    const serviceAddons = await loadServiceAddons(sb, tenantId);

    const blocks: DayBlock[] = (blockRows ?? [])
      .map((b) => {
        const r = parseRange(b.during);
        if (!r) return null;
        // Only blocks overlapping this day.
        if (r.endMs <= startUtc.getTime() || r.startMs >= endUtc.getTime()) return null;
        return {
          id: b.id,
          providerId: b.provider_id,
          startIso: new Date(r.startMs).toISOString(),
          endIso: new Date(r.endMs).toISOString(),
          reason: b.reason,
        };
      })
      .filter((x): x is DayBlock => x !== null);

    // Default every provider to closed; fill from their weekday hours row.
    const openByProvider: Record<string, DayBand> = {};
    for (const pid of providerIds) {
      openByProvider[pid] = { isOpen: false, openMin: 9 * 60, closeMin: 17 * 60 };
    }
    for (const h of hoursRows ?? []) {
      openByProvider[h.provider_id] = {
        isOpen: !h.is_closed,
        openMin: toMinutes(h.open_time),
        closeMin: toMinutes(h.close_time),
      };
    }

    const { offers: dayOffers, today: dayToday } = await hydratePromoOffers(
      sb,
      tenantId,
      serviceAddons,
      timezone,
    );

    return {
      tenantId,
      timezone,
      dateIso: data.dateIso,
      providers,
      hiddenProviderCount: await countHiddenProviders(sb, tenantId),
      openByProvider,
      appointments,
      blocks,
      services: (serviceRows ?? []).map((s) => ({
        id: s.id,
        name: s.name,
        durationMin: s.duration_min,
        category: s.category,
        sortOrder: s.sort_order,
        addOns: serviceAddons.get(s.id) ?? [],
        activeOffer: serviceOffer(dayOffers, dayToday, s.name),
      })),
      providerUnoffered: await loadProviderUnoffered(sb, idFilter),
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
  tenantId: string;
  timezone: string;
  /** Active, VISIBLE providers, ordered by created_at. */
  providers: ProviderLite[];
  /** How many active providers are hidden from the grid (for the review note). */
  hiddenProviderCount: number;
  appointments: DayAppointment[];
  blocks: DayBlock[];
  /** providerId → that provider's weekly availability pattern (0..6). */
  weeklyHoursByProvider: Record<string, WeeklyHoursRow[]>;
  services: OwnerServiceLite[];
  /** providerId → serviceIds that provider does NOT offer (opt-out). */
  providerUnoffered: Record<string, string[]>;
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
    await ensureSetup(sb, tenantId, effectiveUserId);
    const providers = await loadActiveProviders(sb, tenantId);
    const providerIds = providers.map((p) => p.id);
    const idFilter = providerIds.length ? providerIds : ["00000000-0000-0000-0000-000000000000"];

    const { data: settingsRow } = await sb
      .from("scheduling_settings")
      .select("timezone")
      .eq("tenant_id", tenantId)
      .maybeSingle();
    const timezone = settingsRow?.timezone ?? "America/Los_Angeles";

    const startUtc = localDayBounds(data.fromDate, timezone).startUtc;
    const endUtc = localDayBounds(data.toDateExclusive, timezone).startUtc;

    const [{ data: apptRows }, { data: hoursRows }, blockRows, { data: serviceRows }] =
      await Promise.all([
        sb
          .from("emma_appointments")
          .select(
            "id, provider_id, scheduled_at, duration_min, status, source, booking_name, patient_node_id",
          )
          .in("provider_id", idFilter)
          .neq("status", "cancelled")
          .gte("scheduled_at", startUtc.toISOString())
          .lt("scheduled_at", endUtc.toISOString())
          .order("scheduled_at"),
        sb
          .from("scheduling_hours")
          .select("provider_id, day_of_week, open_time, close_time, is_closed")
          .in("provider_id", idFilter),
        // Paginated: a long-lived spa accrues >1,000 block rows (a daily lunch
        // block alone is ~365/yr); an unpaginated read silently caps at 1,000 →
        // older blocks drop out → blocked time renders as FREE on the calendar.
        // The per-day overlap filter still happens in JS downstream.
        fetchAllRows<{ id: string; during: string | null; reason: string | null; provider_id: string | null }>(
          (from, to) =>
            sb
              .from("scheduling_blocks")
              .select("id, during, reason, provider_id")
              .eq("tenant_id", tenantId)
              .order("id")
              .range(from, to),
        ),
        sb
          .from("services")
          .select("id, name, duration_min, hidden_at, online_bookable, category, sort_order")
          .eq("tenant_id", tenantId)
          .eq("online_bookable", true)
          .is("hidden_at", null)
          .order("name"),
      ]);

    const appointments = await hydrateAppointments(sb, apptRows ?? []);
    const serviceAddons = await loadServiceAddons(sb, tenantId);
    const blocks: DayBlock[] = (blockRows ?? [])
      .map((b) => {
        const r = parseRange(b.during);
        if (!r) return null;
        if (r.endMs <= startUtc.getTime() || r.startMs >= endUtc.getTime()) return null;
        return {
          id: b.id,
          providerId: b.provider_id,
          startIso: new Date(r.startMs).toISOString(),
          endIso: new Date(r.endMs).toISOString(),
          reason: b.reason,
        };
      })
      .filter((x): x is DayBlock => x !== null);
    const weeklyHoursByProvider: Record<string, WeeklyHoursRow[]> = {};
    for (const pid of providerIds) weeklyHoursByProvider[pid] = [];
    for (const h of hoursRows ?? []) {
      (weeklyHoursByProvider[h.provider_id] ??= []).push({
        dayOfWeek: h.day_of_week,
        openMin: toMinutes(h.open_time),
        closeMin: toMinutes(h.close_time),
        isClosed: h.is_closed,
      });
    }

    const { offers: rangeOffers, today: rangeToday } = await hydratePromoOffers(
      sb,
      tenantId,
      serviceAddons,
      timezone,
    );

    return {
      tenantId,
      timezone,
      providers,
      hiddenProviderCount: await countHiddenProviders(sb, tenantId),
      appointments,
      blocks,
      weeklyHoursByProvider,
      services: (serviceRows ?? []).map((s) => ({
        id: s.id,
        name: s.name,
        durationMin: s.duration_min,
        category: s.category,
        sortOrder: s.sort_order,
        addOns: serviceAddons.get(s.id) ?? [],
        activeOffer: serviceOffer(rangeOffers, rangeToday, s.name),
      })),
      providerUnoffered: await loadProviderUnoffered(sb, idFilter),
    };
  });

// ── ownerCreateAppointmentFn ─────────────────────────────────────────────────

const createApptInput = z.object({
  accessToken: z.string().min(10),
  viewAsUserId: z.string().uuid().optional(),
  serviceId: z.string().uuid(),
  /** Which provider to book. Omitted → the primary provider (single-provider spas). */
  providerId: z.string().uuid().optional(),
  startIso: z.string().min(10),
  patientName: z.string().min(1).max(120),
  patientEmail: z.string().email().max(200).optional(),
  patientPhone: z.string().max(40).optional(),
  /** Chosen add-on service ids (validated + re-priced server-side). */
  addonServiceIds: z.array(z.string().uuid()).optional().default([]),
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
    const primaryProviderId = await ensureSetup(sb, tenantId, effectiveUserId);

    // Resolve + validate the target provider (must be an active provider of this tenant).
    let providerId = primaryProviderId;
    if (data.providerId && data.providerId !== primaryProviderId) {
      const { data: prov } = await sb
        .from("scheduling_providers")
        .select("id, is_active")
        .eq("id", data.providerId)
        .eq("tenant_id", tenantId)
        .maybeSingle();
      if (!prov || !prov.is_active) {
        return { ok: false, reason: "That provider isn't available.", code: "invalid" };
      }
      providerId = prov.id;
    }

    const { data: svc } = await sb
      .from("services")
      .select("id, name, duration_min, tenant_id, required_resource_type")
      .eq("id", data.serviceId)
      .maybeSingle();
    if (!svc || svc.tenant_id !== tenantId) {
      return { ok: false, reason: "That service isn't available.", code: "invalid" };
    }

    // Per-provider duration override (NULL ⇒ inherit the catalog duration).
    const { data: override } = await sb
      .from("scheduling_provider_services")
      .select("duration_min")
      .eq("provider_id", providerId)
      .eq("service_id", svc.id)
      .maybeSingle();
    const baseDuration = override?.duration_min ?? svc.duration_min;

    // Resolve chosen add-ons against eligibility (never trust client price/min).
    // Each add-on extends the visit; the snapshot freezes price/min at booking.
    type ChosenAddon = { id: string; name: string; price: number; durationMin: number };
    let chosenAddons: ChosenAddon[] = [];
    const requestedAddonIds = [...new Set(data.addonServiceIds)];
    if (requestedAddonIds.length) {
      const { data: eligRows } = await sb
        .from("service_addons")
        .select("addon_service_id")
        .eq("tenant_id", tenantId)
        .eq("service_id", svc.id)
        .in("addon_service_id", requestedAddonIds);
      const eligible = new Set((eligRows ?? []).map((r) => r.addon_service_id));
      if (requestedAddonIds.some((id) => !eligible.has(id))) {
        return { ok: false, reason: "An add-on isn't available for this service.", code: "invalid" };
      }
      const { data: addonRows } = await sb
        .from("services")
        .select("id, name, service_price, duration_min, is_free")
        .in("id", requestedAddonIds)
        .is("hidden_at", null);
      chosenAddons = (addonRows ?? []).map((a) => ({
        id: a.id,
        name: a.name,
        price: a.is_free ? 0 : a.service_price,
        durationMin: a.duration_min,
      }));
    }
    const effectiveDuration = baseDuration + chosenAddons.reduce((s, a) => s + a.durationMin, 0);

    // If the service needs a room/resource, claim a free one of that type.
    let resourceId: string | null = null;
    const requiredType = asResourceType(svc.required_resource_type);
    if (requiredType) {
      resourceId = await assignFreeResource(
        sb,
        tenantId,
        requiredType,
        new Date(data.startIso).getTime(),
        effectiveDuration,
      );
      if (!resourceId) {
        return { ok: false, reason: "No room of that type is free at that time.", code: "conflict" };
      }
    }

    const { data: created, error } = await sb
      .from("emma_appointments")
      .insert({
        user_id: effectiveUserId,
        provider_id: providerId,
        resource_id: resourceId,
        scheduled_at: data.startIso,
        duration_min: effectiveDuration,
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

    // Snapshot chosen add-ons onto the new appointment (price/min frozen now).
    if (chosenAddons.length) {
      await sb.from("appointment_addons").insert(
        chosenAddons.map((a) => ({
          appointment_id: created.id,
          addon_service_id: a.id,
          name: a.name,
          price: a.price,
          duration_min: a.durationMin,
        })),
      );
    }

    // Confirmation email when the owner supplied a patient email (best-effort).
    if (data.patientEmail) {
      const [{ data: t }, { data: st }, { data: prov }] = await Promise.all([
        sb.from("tenants").select("name").eq("id", tenantId).maybeSingle(),
        sb.from("scheduling_settings").select("timezone").eq("tenant_id", tenantId).maybeSingle(),
        sb.from("scheduling_providers").select("name").eq("id", providerId).maybeSingle(),
      ]);
      try {
        await sendBookingConfirmation({
          to: data.patientEmail,
          spaName: t?.name ?? "Your appointment",
          startIso: data.startIso,
          timezone: st?.timezone ?? "America/Los_Angeles",
          serviceName: svc.name,
          providerName: prov?.name ?? null,
          durationMin: effectiveDuration,
          addOns: chosenAddons.map((a) => ({ name: a.name, durationMin: a.durationMin })),
        });
      } catch (e) {
        console.error("[scheduling-email] owner-booking confirmation send failed:", e);
      }
    }

    // Cross-Sell: if the booked service/add-on carried an active promo and the
    // patient resolves in the graph, record a $5 cross_sell win (best-effort —
    // never block the booking on attribution).
    try {
      await recordCrossSellWin({
        sb,
        userId: effectiveUserId,
        tenantId,
        appointmentId: created.id,
        serviceName: svc.name,
        addOnNames: chosenAddons.map((a) => a.name),
        email: data.patientEmail ?? null,
        phone: data.patientPhone ?? null,
      });
    } catch (e) {
      console.error("[cross-sell] win record failed:", e);
    }

    // Reschedule: if this patient was recently nudged to rebook, credit a $5
    // reschedule_booking win (after cross-sell, so a promo'd rebook stays one
    // win). Best-effort — never blocks the booking.
    try {
      await recordRescheduleWinIfNudged({
        sb,
        userId: effectiveUserId,
        appointmentId: created.id,
        email: data.patientEmail ?? null,
        phone: data.patientPhone ?? null,
      });
    } catch (e) {
      console.error("[reschedule] win record failed:", e);
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

// ── ownerUpdateAppointmentFn ─────────────────────────────────────────────────
// Reschedule / reassign / rename an existing appointment. Partial update; the
// per-provider EXCLUDE constraint arbitrates conflicts (23P01 → friendly error).

const updateApptInput = z.object({
  accessToken: z.string().min(10),
  viewAsUserId: z.string().uuid().optional(),
  appointmentId: z.string().uuid(),
  startIso: z.string().min(10).optional(),
  providerId: z.string().uuid().optional(),
  durationMin: z.number().int().positive().max(1440).optional(),
  patientName: z.string().min(1).max(120).optional(),
  patientEmail: z.string().email().max(200).optional(),
  patientPhone: z.string().max(40).optional(),
});

export const ownerUpdateAppointmentFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => updateApptInput.parse(raw))
  .handler(async ({ data }): Promise<OwnerCreateResult> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);

    const { data: provs } = await sb
      .from("scheduling_providers")
      .select("id, is_active")
      .eq("tenant_id", tenantId);
    const tenantProviderIds = new Set((provs ?? []).map((p) => p.id));

    // Ownership: the appointment must belong to one of this tenant's providers.
    const { data: appt } = await sb
      .from("emma_appointments")
      .select("id, provider_id")
      .eq("id", data.appointmentId)
      .maybeSingle();
    if (!appt || !appt.provider_id || !tenantProviderIds.has(appt.provider_id)) {
      return { ok: false, reason: "That appointment isn't part of this spa.", code: "invalid" };
    }

    if (data.providerId && !tenantProviderIds.has(data.providerId)) {
      return { ok: false, reason: "That provider isn't available.", code: "invalid" };
    }

    const patch: {
      updated_at: string;
      scheduled_at?: string;
      provider_id?: string;
      duration_min?: number;
      booking_name?: string;
      booking_email?: string | null;
      booking_phone?: string | null;
    } = { updated_at: new Date().toISOString() };
    if (data.startIso !== undefined) patch.scheduled_at = data.startIso;
    if (data.providerId !== undefined) patch.provider_id = data.providerId;
    if (data.durationMin !== undefined) patch.duration_min = data.durationMin;
    if (data.patientName !== undefined) patch.booking_name = data.patientName;
    if (data.patientEmail !== undefined) patch.booking_email = data.patientEmail || null;
    if (data.patientPhone !== undefined) patch.booking_phone = data.patientPhone || null;

    const { data: updated, error } = await sb
      .from("emma_appointments")
      .update(patch)
      .eq("id", data.appointmentId)
      .select("id")
      .single();

    if (error) {
      if (error.code === "23P01") {
        return { ok: false, reason: "That time overlaps another appointment.", code: "conflict" };
      }
      return { ok: false, reason: `Couldn't update: ${error.message}`, code: "invalid" };
    }
    return { ok: true, id: updated.id };
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
    await ensureSetup(sb, tenantId, effectiveUserId);

    // Ownership guard: the appointment must belong to one of this tenant's providers.
    const { data: provs } = await sb
      .from("scheduling_providers")
      .select("id")
      .eq("tenant_id", tenantId);
    const tenantProviderIds = (provs ?? []).map((p) => p.id);

    const { error } = await sb
      .from("emma_appointments")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .eq("id", data.appointmentId)
      .in(
        "provider_id",
        tenantProviderIds.length ? tenantProviderIds : ["00000000-0000-0000-0000-000000000000"],
      );
    if (error) return { ok: false, reason: `Couldn't cancel: ${error.message}` };
    return { ok: true };
  });

// ── Provider visibility (manage which columns show) — v2.46.0 ─────────────────
//
// The Acuity mirror materializes a provider for every calendar, including the
// business/shared one. The owner — not a fragile auto-rule — decides which
// columns are real providers. listManagedProvidersFn shows ALL active providers
// (visible + hidden) with each one's appointment count, so hiding is informed
// (hiding a column hides its appointments too). setProviderVisibilityFn flips
// the hidden_at override (distinct from is_active so it survives a re-mirror).

export interface ManagedProvider {
  id: string;
  /** The canonical name — for a mirrored provider this tracks the Acuity
   *  calendar name (kept synced by the mirror). */
  name: string;
  /** Owner's sticky rename override (survives re-mirror), or null to use `name`. */
  displayName: string | null;
  /** Hidden from the calendar grid (owner choice or the empty-business smart default). */
  hidden: boolean;
  /** Non-cancelled appointments on this provider — the honest consequence of hiding. */
  apptCount: number;
  /** Mirrored from an external scheduler (Acuity) vs a native provider. */
  isMirrored: boolean;
  /** The native primary (a login row) — hiding it removes the native booking column. */
  isPrimary: boolean;
}

export const listManagedProvidersFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) =>
    z
      .object({ accessToken: z.string().min(10), viewAsUserId: z.string().uuid().optional() })
      .parse(raw),
  )
  .handler(async ({ data }): Promise<ManagedProvider[]> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);

    // external_source isn't in the generated types yet → loose-cast the select.
    const anySb = sb as unknown as { from(t: string): ReturnType<typeof sb.from> };
    const { data: rows } = await anySb
      .from("scheduling_providers")
      .select("id, name, display_name, hidden_at, user_id, external_source, created_at")
      .eq("tenant_id", tenantId)
      .eq("is_active", true)
      .order("created_at", { ascending: true });
    const provs = (rows ?? []) as unknown as Array<{
      id: string;
      name: string;
      display_name: string | null;
      hidden_at: string | null;
      user_id: string | null;
      external_source: string | null;
    }>;

    // Appointment count per provider (non-cancelled). Small N of providers, so
    // per-provider head counts in parallel are fine.
    const counts = await Promise.all(
      provs.map(async (p) => {
        const { count } = await sb
          .from("emma_appointments")
          .select("id", { count: "exact", head: true })
          .eq("provider_id", p.id)
          .neq("status", "cancelled");
        return count ?? 0;
      }),
    );

    return provs.map((p, i) => ({
      id: p.id,
      name: p.name,
      displayName: p.display_name?.trim() || null,
      hidden: p.hidden_at != null,
      apptCount: counts[i],
      isMirrored: p.external_source === "acuity",
      isPrimary: p.user_id != null,
    }));
  });

export const setProviderVisibilityFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) =>
    z
      .object({
        accessToken: z.string().min(10),
        viewAsUserId: z.string().uuid().optional(),
        providerId: z.string().uuid(),
        hidden: z.boolean(),
      })
      .parse(raw),
  )
  .handler(async ({ data }): Promise<{ ok: true } | { ok: false; reason: string }> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);

    // Ownership guard: the provider must belong to this tenant.
    const { data: prov } = await sb
      .from("scheduling_providers")
      .select("id")
      .eq("id", data.providerId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (!prov) return { ok: false, reason: "That provider isn't part of this spa." };

    const { error } = await sb
      .from("scheduling_providers")
      .update({ hidden_at: data.hidden ? new Date().toISOString() : null, updated_at: new Date().toISOString() })
      .eq("id", data.providerId);
    if (error) return { ok: false, reason: `Couldn't update: ${error.message}` };
    return { ok: true };
  });

// Sticky rename: an owner override on the column label that survives a
// re-mirror. The Acuity mirror keeps `name` synced to the calendar (and matches
// appointments on it), so the rename lives in a DISTINCT `display_name` column
// the mirror never touches — mirroring the hidden_at pattern. Empty/blank =
// clear the override (revert to the Acuity name).
export const setProviderDisplayNameFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) =>
    z
      .object({
        accessToken: z.string().min(10),
        viewAsUserId: z.string().uuid().optional(),
        providerId: z.string().uuid(),
        displayName: z.string().max(80),
      })
      .parse(raw),
  )
  .handler(async ({ data }): Promise<{ ok: true } | { ok: false; reason: string }> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);

    // Ownership guard: the provider must belong to this tenant.
    const { data: prov } = await sb
      .from("scheduling_providers")
      .select("id")
      .eq("id", data.providerId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (!prov) return { ok: false, reason: "That provider isn't part of this spa." };

    const trimmed = data.displayName.trim();
    const anySb = sb as unknown as { from(t: string): ReturnType<typeof sb.from> };
    const { error } = await anySb
      .from("scheduling_providers")
      .update({ display_name: trimmed || null, updated_at: new Date().toISOString() })
      .eq("id", data.providerId);
    if (error) return { ok: false, reason: `Couldn't rename: ${error.message}` };
    return { ok: true };
  });
