/**
 * Promo-calendar ingest + offer loading — Cross-Sell · Slice A.
 *
 *   ingestPromoCalendar — owner uploads a manufacturer promo calendar; we
 *       parse the "Dollars Off" subset, map each to a product, and REPLACE
 *       the tenant's offers (a calendar upload is a full snapshot).
 *   listPromoOffers — the owner's current offers (for the upload UI).
 *   loadTenantPromoOffers — internal; the booking context fns call it to
 *       hydrate add-on badges (matched by service-name keyword).
 *
 * Offers are keyed by tenant_id so the public booking path (tenant_id, no
 * user_id) can hydrate with no owner lookup.
 */

import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { resolveEffectiveUserId } from "@/server/auth-helpers";
import { getTenantIdForUser } from "@/server/scheduling-settings.functions";
import { recordRecoveryEvent } from "@/server/emma-attribution.functions";
import {
  parsePromoCalendar,
  matchOfferForName,
  normalizeForMatch,
  publicDeals,
  dealHeadline,
  mondayOf,
  type PromoOffer,
  type OfferType,
  type OfferCohort,
} from "@/lib/promo-calendar";
import { daysSince, computeOverdue } from "@/lib/patient-cadence";
import type { ProductKind } from "@/lib/product-manufacturer-map";
import { doListOverdue } from "@/server/patient-ingest.functions";
import { fetchAllRows } from "@/server/paginate";
import { resolveSpaName } from "@/server/emma-spa-profile";
import { todayIsoInTz } from "@/lib/scheduling-slots";

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

type AnySb = ReturnType<typeof createClient<Database>>;

// manufacturer_promo_offers isn't in generated types yet — loose view.
function offersTbl(sb: AnySb) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (sb as unknown as { from(t: string): any }).from("manufacturer_promo_offers");
}

type OfferDbRow = {
  id: string;
  source: "manufacturer" | "spa" | null;
  manufacturer: string | null;
  product: string;
  title: string;
  discount_usd: number | string | null;
  starts_on: string | null;
  ends_on: string | null;
  landing_url: string | null;
  promotion_type: string | null;
  raw_title: string | null;
  offer_type: string | null;
  value_pct: number | string | null;
  addon_service_name: string | null;
  addon_label: string | null;
  is_active: boolean | null;
  target_cohort: string | null;
  show_on_deals: boolean | null;
  active_weekdays: number[] | null;
  quantity_cap: number | string | null;
  redeemed_count: number | string | null;
  cap_period: string | null;
  cap_period_start: string | null;
};

// Single source of truth for the columns we read, so the loader + insert
// selects never drift. New offer-engine columns land here (v2.4.2+).
const OFFER_COLS =
  "id, source, manufacturer, product, title, discount_usd, starts_on, ends_on, landing_url, promotion_type, raw_title, offer_type, value_pct, addon_service_name, addon_label, is_active, target_cohort, show_on_deals, active_weekdays, quantity_cap, redeemed_count, cap_period, cap_period_start";

function rowToOffer(r: OfferDbRow): PromoOffer {
  return {
    id: r.id,
    source: r.source ?? "manufacturer",
    manufacturer: r.manufacturer ?? "",
    product: r.product,
    title: r.title,
    discountUsd: r.discount_usd != null ? Number(r.discount_usd) : null,
    startsOn: r.starts_on,
    endsOn: r.ends_on,
    landingUrl: r.landing_url,
    promotionType: r.promotion_type,
    rawTitle: r.raw_title ?? r.title,
    offerType: (r.offer_type as OfferType | null) ?? "dollars_off",
    valuePct: r.value_pct != null ? Number(r.value_pct) : null,
    addonServiceName: r.addon_service_name,
    addonLabel: r.addon_label,
    isActive: r.is_active ?? true,
    targetCohort: (r.target_cohort as OfferCohort | null) ?? "all",
    showOnDeals: r.show_on_deals ?? true,
    activeWeekdays: r.active_weekdays ?? null,
    quantityCap: r.quantity_cap != null ? Number(r.quantity_cap) : null,
    redeemedCount: r.redeemed_count != null ? Number(r.redeemed_count) : 0,
    capPeriod: r.cap_period === "weekly" ? "weekly" : "total",
    capPeriodStart: r.cap_period_start,
  };
}

/** Internal: all promo offers for a tenant (matcher filters by date). */
export async function loadTenantPromoOffers(
  sb: AnySb,
  tenantId: string,
): Promise<PromoOffer[]> {
  const { data } = await offersTbl(sb).select(OFFER_COLS).eq("tenant_id", tenantId);
  return ((data as OfferDbRow[] | null) ?? []).map(rowToOffer);
}

/**
 * Master switch for a spa's RECURRING (weekly) offers — the engine wiring
 * behind the "Weekly Offer" Skill's On/Pause. Pausing flips is_active off on
 * every source='spa' offer whose cap is weekly, so they stop badging at
 * booking (matchOfferForName / publicDeals already honor is_active); resuming
 * flips them back on. Scoped to cap_period='weekly' so it never touches a
 * one-off spa offer or any manufacturer promo. Returns how many rows it moved.
 */
export async function setSpaWeeklyOffersActive(
  sb: AnySb,
  userId: string,
  enabled: boolean,
): Promise<number> {
  const tenantId = await getTenantIdForUser(sb, userId);
  const { data } = await offersTbl(sb)
    .update({ is_active: enabled })
    .eq("tenant_id", tenantId)
    .eq("source", "spa")
    .eq("cap_period", "weekly")
    .select("id");
  return ((data as { id: string }[] | null) ?? []).length;
}

export type PromoIngestReceipt = {
  offers: number;
  skipped: number;
  warnings: string[];
};

const ingestInput = z.object({
  accessToken: z.string(),
  viewAsUserId: z.string().optional(),
  csv: z.string(),
});

export const ingestPromoCalendar = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => ingestInput.parse(input))
  .handler(async ({ data }): Promise<PromoIngestReceipt> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);

    const year = new Date().getFullYear();
    const parsed = parsePromoCalendar(data.csv, year);
    if (parsed.offers.length === 0) {
      throw new Error(
        "No 'Dollars Off' offers found in that file. Is this the manufacturer's promotions calendar export?",
      );
    }

    // Full-snapshot replace, scoped to MANUFACTURER offers only — a calendar
    // upload is a fresh snapshot of the manufacturer's offers, but must not
    // touch the spa's own authored offers (source='spa') in the same table.
    await offersTbl(sb)
      .delete()
      .eq("tenant_id", tenantId)
      .eq("source", "manufacturer");
    const rows = parsed.offers.map((o) => ({
      tenant_id: tenantId,
      source: "manufacturer",
      manufacturer: o.manufacturer,
      product: o.product,
      title: o.title,
      discount_usd: o.discountUsd,
      starts_on: o.startsOn,
      ends_on: o.endsOn,
      landing_url: o.landingUrl,
      promotion_type: o.promotionType,
      raw_title: o.rawTitle,
    }));
    const { error } = await offersTbl(sb).insert(rows);
    if (error) {
      throw new Error(`Couldn't save offers: ${(error as { message?: string }).message ?? "insert failed"}`);
    }
    return {
      offers: parsed.offers.length,
      skipped: parsed.skipped,
      warnings: parsed.warnings,
    };
  });

const listInput = z.object({
  accessToken: z.string(),
  viewAsUserId: z.string().optional(),
});

export const listPromoOffers = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => listInput.parse(input))
  .handler(async ({ data }): Promise<PromoOffer[]> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);
    return loadTenantPromoOffers(sb, tenantId);
  });

// ─── Promo Intelligence (v2.6.0) ────────────────────────────────────────────
//
// The owner controls whether a given MANUFACTURER promo surfaces on their
// public Deals page (show_on_deals). Manufacturer offers default to visible
// (the ingest leaves the column default true); this lets the owner curate the
// pulled feed — hide the ones that don't fit, keep the ones that do — without
// touching their own spa-authored offers (scoped to source='manufacturer').
const setPromoOnDealsInput = z.object({
  accessToken: z.string(),
  viewAsUserId: z.string().optional(),
  offerId: z.string().uuid(),
  showOnDeals: z.boolean(),
});

export const setPromoOfferOnDeals = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => setPromoOnDealsInput.parse(input))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);
    const { error } = await offersTbl(sb)
      .update({ show_on_deals: data.showOnDeals })
      .eq("id", data.offerId)
      .eq("tenant_id", tenantId)
      .eq("source", "manufacturer");
    if (error) {
      throw new Error(
        `Couldn't update promo: ${(error as { message?: string }).message ?? "update failed"}`,
      );
    }
    return { ok: true };
  });

// ─── Public Deals page (v2.4.4) ────────────────────────────────────────────
//
// A no-auth, patient-facing list of a spa's currently-active public offers,
// resolved by the same tenant slug the booking page uses. Cohort-targeted
// offers are excluded (publicDeals filters to cohort 'all') — they reach their
// patients via push, not a public list.

export type PublicDeal = {
  headline: string;
  offerType: OfferType;
  endsOn: string | null;
  landingUrl: string | null;
  /** The offer's target service (the normalized `product` keyword offers link
   *  to services by — same field the at-booking badge matcher uses). Lets the
   *  Deals page deep-link a tapped Special straight into the booker with that
   *  service preselected. null = no mappable service, so the card stays static. */
  serviceName: string | null;
};

export type PublicDealsResult =
  | { ok: false; reason: string }
  | { ok: true; spaName: string; slug: string; deals: PublicDeal[] };

const publicDealsInput = z.object({ slug: z.string().min(1).max(120) });

export const getPublicDealsFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => publicDealsInput.parse(input))
  .handler(async ({ data }): Promise<PublicDealsResult> => {
    const sb = admin();
    const { data: tenant } = await sb
      .from("tenants")
      .select("id, name")
      .ilike("slug", data.slug)
      .maybeSingle();
    if (!tenant) return { ok: false, reason: "We couldn't find that practice." };

    const offers = await loadTenantPromoOffers(sb, tenant.id);
    const { data: tzRow } = await sb
      .from("scheduling_settings")
      .select("timezone")
      .eq("tenant_id", tenant.id)
      .maybeSingle();
    const today = todayIsoInTz(
      (tzRow as { timezone?: string } | null)?.timezone ?? "America/Los_Angeles",
    );

    const mapped: PublicDeal[] = publicDeals(offers, today).map((o) => ({
      headline: dealHeadline(o),
      offerType: o.offerType ?? "dollars_off",
      endsOn: o.endsOn,
      landingUrl: o.landingUrl,
      serviceName: o.product?.trim() || null,
    }));
    // Dedup on what the patient actually sees: a manufacturer calendar that
    // lists the same product across several rows (or a spa offer mirroring a
    // manufacturer promo) would otherwise render as identical-looking lines.
    // Collapse any rows indistinguishable in every visible field, keeping the
    // first. Display-only — badging and the $5 win path are untouched.
    const seen = new Set<string>();
    const deals: PublicDeal[] = mapped.filter((d) => {
      const key = [d.headline, d.offerType, d.endsOn ?? "", d.landingUrl ?? "", d.serviceName ?? ""].join("\u0000");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { ok: true, spaName: tenant.name as string, slug: data.slug, deals };
  });

// ─── Spa-authored offers (v2.0.0) ──────────────────────────────────────────
//
// The owner writes their OWN cross-sell offer ("add a HydraFacial — $50 off")
// against one of their services. It lands in the SAME table (source='spa',
// manufacturer null) so it flows through the identical at-booking badge + $5
// cross_sell_addon win pipeline as a manufacturer promo. Matching is by the
// service name: we store the normalized name as `product`, which the matcher
// substring-matches against the booked service's name.

// Slice 1 authors these four types; the rest (bundle/bogo/series/first_visit/
// spend_get) exist in the DB enum + matcher and get authoring UI in later slices.
const AUTHORED_OFFER_TYPES = [
  "dollars_off",
  "percent_off",
  "free_addon",
  "discount_addon",
] as const;

/** Type-aware auto-title when the owner doesn't set a custom label. */
function buildOfferTitle(args: {
  offerType: OfferType;
  serviceName: string;
  discountUsd: number | null;
  valuePct: number | null;
  addonLabel: string | null;
  custom?: string;
}): string {
  const c = args.custom?.trim();
  if (c) return c;
  const { serviceName: s, discountUsd: d, valuePct: p, addonLabel: a } = args;
  switch (args.offerType) {
    case "percent_off":
      return p != null ? `${p}% off ${s}` : `Offer on ${s}`;
    case "free_addon":
      return a ? `Free ${a} with ${s}` : `Free add-on with ${s}`;
    case "discount_addon":
      return d != null ? `$${Math.round(d)} off ${a ?? "add-on"} with ${s}` : `Add-on offer with ${s}`;
    case "dollars_off":
    default:
      return d != null ? `$${Math.round(d)} off ${s}` : `Offer on ${s}`;
  }
}

const createSpaOfferInput = z.object({
  accessToken: z.string(),
  viewAsUserId: z.string().optional(),
  /** The owner's own service this offer applies to (drives matching + title). */
  serviceName: z.string().min(1).max(160),
  offerType: z.enum(AUTHORED_OFFER_TYPES).default("dollars_off"),
  /** $ value for dollars_off / discount_addon. */
  discountUsd: z.number().positive().max(100000).nullable().optional(),
  /** % value for percent_off (0–100). */
  valuePct: z.number().positive().max(100).nullable().optional(),
  /** The add-on this offer rewards (free_addon / discount_addon). */
  addonLabel: z.string().max(160).nullable().optional(),
  /** Who the offer is for; non-'all' offers don't badge publicly + only earn
   *  for in-cohort patients. */
  targetCohort: z.enum(["all", "lapsed", "new", "expiring"]).default("all"),
  /** Days of week the offer is live (0=Sun…6=Sat). Empty/omitted = any day. */
  activeWeekdays: z.array(z.number().int().min(0).max(6)).max(7).nullable().optional(),
  /** Max redemptions; null = unlimited. */
  quantityCap: z.number().int().positive().max(100000).nullable().optional(),
  /** How the cap accrues: 'total' (lifetime, default) or 'weekly' (resets each
   *  week — for a recurring offer like "20 per Tox Tuesday"). */
  capPeriod: z.enum(["total", "weekly"]).default("total"),
  /** yyyy-mm-dd; null/omitted = no bound (starts now / ongoing). */
  startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  /** Optional custom label; defaults to a type-aware auto-title. */
  title: z.string().max(200).optional(),
  landingUrl: z.string().max(500).optional(),
});

export const createSpaOffer = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => createSpaOfferInput.parse(input))
  .handler(async ({ data }): Promise<PromoOffer> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);

    const product = normalizeForMatch(data.serviceName);
    if (!product) throw new Error("Pick a service for this offer.");

    // Per-type required-value validation (friendly, not zod refinement noise).
    const discountUsd = data.discountUsd ?? null;
    const valuePct = data.valuePct ?? null;
    const addonLabel = data.addonLabel?.trim() || null;
    if (data.offerType === "percent_off" && valuePct == null)
      throw new Error("Enter a percentage for a percent-off offer.");
    if (
      (data.offerType === "dollars_off" || data.offerType === "discount_addon") &&
      discountUsd == null
    )
      throw new Error("Enter a dollar amount for this offer.");
    if (
      (data.offerType === "free_addon" || data.offerType === "discount_addon") &&
      !addonLabel
    )
      throw new Error("Name the add-on this offer applies to.");

    const title = buildOfferTitle({
      offerType: data.offerType,
      serviceName: data.serviceName,
      discountUsd,
      valuePct,
      addonLabel,
      custom: data.title,
    });

    const row = {
      tenant_id: tenantId,
      source: "spa",
      manufacturer: null,
      product,
      title,
      discount_usd: discountUsd,
      starts_on: data.startsOn ?? null,
      ends_on: data.endsOn ?? null,
      landing_url: data.landingUrl?.trim() || null,
      promotion_type: "Spa offer",
      raw_title: data.serviceName,
      offer_type: data.offerType,
      value_pct: valuePct,
      addon_service_name: addonLabel ? normalizeForMatch(addonLabel) : null,
      addon_label: addonLabel,
      is_active: true,
      target_cohort: data.targetCohort,
      active_weekdays:
        data.activeWeekdays && data.activeWeekdays.length > 0 ? data.activeWeekdays : null,
      quantity_cap: data.quantityCap ?? null,
      // A new weekly offer starts with a fresh count; the first redemption's
      // RPC stamps cap_period_start, so we leave it null here.
      cap_period: data.capPeriod,
      cap_period_start: null,
    };
    const { data: inserted, error } = await offersTbl(sb)
      .insert(row)
      .select(OFFER_COLS)
      .single();
    if (error || !inserted) {
      throw new Error(
        `Couldn't save offer: ${(error as { message?: string } | null)?.message ?? "insert failed"}`,
      );
    }
    return rowToOffer(inserted as OfferDbRow);
  });

// Pause / resume a spa offer without deleting it (is_active toggle).
const setSpaOfferActiveInput = z.object({
  accessToken: z.string(),
  viewAsUserId: z.string().optional(),
  offerId: z.string().uuid(),
  isActive: z.boolean(),
});

export const setSpaOfferActive = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => setSpaOfferActiveInput.parse(input))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);
    const { error } = await offersTbl(sb)
      .update({ is_active: data.isActive })
      .eq("id", data.offerId)
      .eq("tenant_id", tenantId)
      .eq("source", "spa");
    if (error) {
      throw new Error(
        `Couldn't update offer: ${(error as { message?: string }).message ?? "update failed"}`,
      );
    }
    return { ok: true };
  });

const deleteSpaOfferInput = z.object({
  accessToken: z.string(),
  viewAsUserId: z.string().optional(),
  offerId: z.string().uuid(),
});

export const deleteSpaOffer = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => deleteSpaOfferInput.parse(input))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);
    // Scoped to this tenant's spa-authored rows — never a manufacturer row.
    const { error } = await offersTbl(sb)
      .delete()
      .eq("id", data.offerId)
      .eq("tenant_id", tenantId)
      .eq("source", "spa");
    if (error) {
      throw new Error(
        `Couldn't remove offer: ${(error as { message?: string }).message ?? "delete failed"}`,
      );
    }
    return { ok: true };
  });

// ─── Cross-Sell win (Slice B) ──────────────────────────────────────────────
//
// Resolve a booking to a patient node by contact (emails are stored
// lowercased; phone as last-10 digits) so the cross_sell win can attribute +
// later verify against a real transaction.
export async function resolvePatientNodeByContact(
  sb: AnySb,
  userId: string,
  email: string | null,
  phone: string | null,
): Promise<string | null> {
  const e = email?.trim().toLowerCase() || null;
  const p = phone ? phone.replace(/\D/g, "").slice(-10) : null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nodes = (sb as unknown as { from(t: string): any }).from("knowledge_nodes");
  const lookup = async (col: string, val: string): Promise<string | null> => {
    const { data } = await nodes
      .select("id")
      .eq("user_id", userId)
      .eq("node_type", "patient")
      .eq(col, val)
      .limit(1)
      .maybeSingle();
    return (data?.id as string | undefined) ?? null;
  };
  if (e) {
    const hit = await lookup("attachments->>email", e);
    if (hit) return hit;
  }
  if (p) {
    const hit = await lookup("attachments->>phone", p);
    if (hit) return hit;
  }
  return null;
}

/**
 * Which targeting cohorts a patient belongs to — reuses the Recall cadence
 * engine so "lapsed/new/expiring" mean exactly what they mean in Recall:
 *   • new      — first visit within the last 30 days (PatientSummary.firstVisit)
 *   • lapsed   — latest treatment is past its kind's lapse threshold (computeOverdue)
 *   • expiring — a manufacturer reward expires within the next 60 days
 * Best-effort; returns the cohorts we can prove. 'all' is implicit (every
 * patient qualifies) so it's not gated against this set.
 */
export async function resolvePatientCohorts(
  sb: AnySb,
  userId: string,
  patientNodeId: string,
): Promise<Set<OfferCohort>> {
  const out = new Set<OfferCohort>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const any = sb as unknown as { from(t: string): any };

  // NEW — first visit within 30 days (from the patient node's summary).
  const { data: node } = await any
    .from("knowledge_nodes")
    .select("attachments")
    .eq("id", patientNodeId)
    .eq("user_id", userId)
    .maybeSingle();
  const firstVisit = (node?.attachments as { firstVisit?: string | null } | null)?.firstVisit ?? null;
  if (firstVisit) {
    const d = daysSince(firstVisit);
    if (d != null && d <= 30) out.add("new");
  }

  // LAPSED — latest treatment vs its product-kind cadence.
  const { data: tx } = await any
    .from("patient_transactions")
    .select("transaction_date, product_kind")
    .eq("patient_node_id", patientNodeId)
    .order("transaction_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (tx?.transaction_date) {
    const overdue = computeOverdue(
      (tx.product_kind as ProductKind | null) ?? null,
      daysSince(tx.transaction_date),
    );
    if (overdue?.isLapsed) out.add("lapsed");
  }

  // EXPIRING — any non-expired reward whose expiration is within 60 days.
  const { data: rewards } = await any
    .from("patient_reward_entries")
    .select("expiration_date, status_norm")
    .eq("patient_node_id", patientNodeId)
    .eq("user_id", userId);
  for (const r of (rewards ?? []) as { expiration_date: string | null; status_norm: string | null }[]) {
    if (r.status_norm === "expired") continue;
    const sinceExp = daysSince(r.expiration_date);
    if (sinceExp == null) continue;
    const daysUntil = -sinceExp; // future expiration → positive
    if (daysUntil >= 0 && daysUntil <= 60) {
      out.add("expiring");
      break;
    }
  }
  return out;
}

/**
 * Record a $5 cross_sell win IF a booked service or add-on carried an active
 * offer AND we can attribute it to a patient in the graph. Cohort-targeted
 * offers additionally require the patient to be IN the cohort.
 * Best-effort: never throws into the booking flow (caller wraps in try/catch).
 */
export async function recordCrossSellWin(args: {
  sb: AnySb;
  userId: string;
  tenantId: string;
  appointmentId: string;
  serviceName: string;
  addOnNames: string[];
  email: string | null;
  phone: string | null;
}): Promise<{ recorded: boolean; reason?: string }> {
  const offers = await loadTenantPromoOffers(args.sb, args.tenantId);
  if (offers.length === 0) return { recorded: false, reason: "no_offers" };
  // Resolve "today" in the spa's own timezone — a UTC date rolls to tomorrow
  // in the evening (US timezones), which on an offer's last/first day would
  // mis-decide whether a $5 cross-sell win is active. Falls back to Pacific
  // (the slot-engine default) when no timezone is configured.
  const { data: tzRow } = await (
    args.sb as unknown as { from(t: string): any }
  )
    .from("scheduling_settings")
    .select("timezone")
    .eq("tenant_id", args.tenantId)
    .maybeSingle();
  const today = todayIsoInTz(tzRow?.timezone ?? "America/Los_Angeles");
  let matchedOffer: PromoOffer | null = null;
  for (const name of [args.serviceName, ...args.addOnNames]) {
    const o = matchOfferForName(offers, name, today);
    if (o) {
      matchedOffer = o;
      break;
    }
  }
  if (!matchedOffer) return { recorded: false, reason: "no_active_offer" };

  const patientNodeId = await resolvePatientNodeByContact(
    args.sb,
    args.userId,
    args.email,
    args.phone,
  );
  if (!patientNodeId) return { recorded: false, reason: "unmatched_patient" };

  // Targeting integrity: a cohort-targeted offer only earns its $5 if this
  // patient is actually in the cohort. 'all' offers skip the check.
  const cohort = matchedOffer.targetCohort ?? "all";
  if (cohort !== "all") {
    const cohorts = await resolvePatientCohorts(args.sb, args.userId, patientNodeId);
    if (!cohorts.has(cohort)) return { recorded: false, reason: "cohort_mismatch" };
  }

  await recordRecoveryEvent({
    sb: args.sb as unknown as Parameters<typeof recordRecoveryEvent>[0]["sb"],
    userId: args.userId,
    appointmentId: args.appointmentId,
    patientNodeId,
    recoveryAgent: "cross_sell",
    metricKey: "cross_sell_addon",
    attributionMethod: "direct",
    notes: `Cross-sell: ${matchedOffer.title}`,
  });

  // Recurrence: count the redemption against a capped offer via an ATOMIC
  // DB-side increment (a single UPDATE under a row lock) so concurrent bookings
  // can't lose updates the way a read-modify-write would. p_week_start (this
  // week's Monday in the spa's own timezone) lets a 'weekly' cap reset itself
  // lazily inside the lock; a 'total' cap ignores it. Best-effort.
  if (matchedOffer.quantityCap != null && matchedOffer.id) {
    await (
      args.sb as unknown as {
        rpc(fn: string, params: Record<string, unknown>): PromiseLike<unknown>;
      }
    ).rpc("increment_offer_redemption", {
      p_offer_id: matchedOffer.id,
      p_week_start: mondayOf(today),
    });
  }
  return { recorded: true };
}

// ─── Offer push (v2.4.5 · slice 4b) ─────────────────────────────────────────
//
// Deliver a COHORT-targeted offer to its matching patients. Draft-first +
// opt-out-filtered + human-gated, exactly like Recall: we compose one message
// per matching patient and email the BATCH to the spa's OWN proxy inbox; the
// human pastes it into Claude Desktop, the iMessage MCP drafts each into
// Messages.app, and the human reviews + taps Send (blue-bubble from the spa's
// own Apple ID). NOTHING is sent to a patient by the server.

export type OfferPushTarget = {
  patientNodeId: string;
  name: string;
  phone: string | null;
  email: string | null;
};

const firstNameOf = (full: string): string =>
  full.trim().split(/\s+/)[0] || "there";

/** Escape untrusted text before interpolating into the draft email HTML
 *  (patient names / offer titles can contain &, <, > and would corrupt the
 *  draft table or, in the spa's own inbox, render stray markup). */
function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Patients in a cohort WITH contact, opt-out-filtered. Reuses the Recall
 * cadence engine so cohorts mean the same everywhere.
 */
async function listOfferCohortTargets(
  sb: AnySb,
  userId: string,
  cohort: OfferCohort,
): Promise<OfferPushTarget[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const any = sb as unknown as { from(t: string): any };
  let raw: OfferPushTarget[] = [];

  if (cohort === "lapsed") {
    const overdue = await doListOverdue(
      sb as unknown as Parameters<typeof doListOverdue>[0],
      userId,
      2000,
      null,
    );
    raw = overdue
      .filter((o) => o.isLapsed)
      .map((o) => ({
        patientNodeId: o.patientId,
        name: o.displayName,
        phone: o.phone,
        email: o.email,
      }));
  } else if (cohort === "expiring") {
    type RewardRow = {
      patient_node_id: string | null;
      contact_name: string | null;
      contact_phone: string | null;
      contact_email: string | null;
      expiration_date: string | null;
      status_norm: string | null;
    };
    // Paginated — a large patient base has >1,000 reward entries; a fixed read
    // would silently drop expiring patients past the cap.
    const data = await fetchAllRows<RewardRow>((from, to) =>
      any
        .from("patient_reward_entries")
        .select("patient_node_id, contact_name, contact_phone, contact_email, expiration_date, status_norm")
        .eq("user_id", userId)
        .order("id", { ascending: true })
        .range(from, to),
    );
    const byNode = new Map<string, OfferPushTarget>();
    for (const r of data) {
      if (!r.patient_node_id || r.status_norm === "expired") continue;
      const since = daysSince(r.expiration_date);
      if (since == null) continue;
      const daysUntil = -since;
      if (daysUntil < 0 || daysUntil > 60) continue;
      if (!byNode.has(r.patient_node_id)) {
        byNode.set(r.patient_node_id, {
          patientNodeId: r.patient_node_id,
          name: r.contact_name ?? "",
          phone: r.contact_phone,
          email: r.contact_email,
        });
      }
    }
    raw = [...byNode.values()];
  } else if (cohort === "new") {
    const { data } = await any
      .from("knowledge_nodes")
      .select("id, title, attachments")
      .eq("user_id", userId)
      .eq("node_type", "patient")
      .limit(5000);
    for (const n of (data ?? []) as Array<{
      id: string;
      title: string | null;
      attachments: { firstVisit?: string | null; phone?: string | null; email?: string | null; displayName?: string | null } | null;
    }>) {
      const att = n.attachments ?? {};
      const fv = att.firstVisit ?? null;
      if (!fv) continue;
      const d = daysSince(fv);
      if (d == null || d < 0 || d > 30) continue;
      raw.push({
        patientNodeId: n.id,
        name: n.title ?? att.displayName ?? "",
        phone: att.phone ?? null,
        email: att.email ?? null,
      });
    }
  }

  if (raw.length === 0) return raw;
  // Opt-out filter — never message a patient who has opted out (any channel).
  // Chunk the id list: a large cohort would otherwise blow the .in() URL limit
  // and the query would FAIL SILENTLY (data null, error ignored) → opt-out
  // filtering disabled → we'd draft to opted-out patients. Each ≤200-id batch
  // also stays well under the 1,000-row read cap.
  const ids = raw.map((r) => r.patientNodeId);
  const optedSet = new Set<string>();
  const CHUNK = 200;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const { data: opted } = await any
      .from("patient_outreach_state")
      .select("patient_node_id")
      .eq("user_id", userId)
      .eq("state", "opted_out")
      .in("patient_node_id", slice);
    for (const r of (opted ?? []) as Array<{ patient_node_id: string }>) {
      optedSet.add(r.patient_node_id);
    }
  }
  return raw.filter((r) => !optedSet.has(r.patientNodeId));
}

async function loadSpaOfferById(
  sb: AnySb,
  tenantId: string,
  offerId: string,
): Promise<PromoOffer | null> {
  const { data } = await offersTbl(sb)
    .select(OFFER_COLS)
    .eq("id", offerId)
    .eq("tenant_id", tenantId)
    .eq("source", "spa")
    .maybeSingle();
  return data ? rowToOffer(data as OfferDbRow) : null;
}

const offerIdInput = z.object({
  accessToken: z.string(),
  viewAsUserId: z.string().optional(),
  offerId: z.string().uuid(),
});

export type OfferReach = {
  cohort: OfferCohort;
  /** Patients in the cohort (null when the offer targets 'all' — use Deals). */
  total: number | null;
  /** Of those, how many have a phone we can iMessage. */
  reachable: number;
};

/** How many patients a targeted offer would reach (for the authoring preview). */
export const getOfferReachFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => offerIdInput.parse(input))
  .handler(async ({ data }): Promise<OfferReach> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);
    const offer = await loadSpaOfferById(sb, tenantId, data.offerId);
    const cohort = offer?.targetCohort ?? "all";
    if (cohort === "all") return { cohort: "all", total: null, reachable: 0 };
    const targets = await listOfferCohortTargets(sb, effectiveUserId, cohort);
    return {
      cohort,
      total: targets.length,
      reachable: targets.filter((t) => (t.phone ?? "").trim()).length,
    };
  });

export type OfferPushResult = {
  drafted: number;
  skippedNoPhone: number;
  sentTo: string | null;
  error: string | null;
};

function composeOfferPushBody(
  firstName: string,
  spaName: string,
  offerTitle: string,
  slug: string,
): string {
  // Route the public booking link through the origin env so the smartspa.app
  // cutover is a one-switch flip (bare host for the SMS; identical today).
  const host = (process.env.REFILL_PUBLIC_ORIGIN ?? "https://getrefill.app")
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  const link = slug ? ` Book here: ${host}/s/${slug}` : "";
  return `Hi ${firstName}! It's ${spaName} — ${offerTitle}.${link} Reply and I'll get you on the calendar. 💛`;
}

/**
 * Draft an offer's cohort push: compose one message per matching patient and
 * email the batch to the spa's proxy inbox for human review + send (iMessage
 * MCP). Best-effort sends ONE email to the spa's own inbox; never messages a
 * patient directly.
 */
export const draftOfferPushFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => offerIdInput.parse(input))
  .handler(async ({ data }): Promise<OfferPushResult> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);

    const offer = await loadSpaOfferById(sb, tenantId, data.offerId);
    if (!offer) throw new Error("Offer not found.");
    const cohort = offer.targetCohort ?? "all";
    if (cohort === "all") {
      throw new Error(
        "This offer targets all patients — share its Deals page instead of pushing.",
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const any = sb as unknown as { from(t: string): any };
    const { data: policy } = await any
      .from("emma_noshow_policies")
      .select("rescue_proxy_email")
      .eq("user_id", effectiveUserId)
      .maybeSingle();
    const proxyEmail = (policy?.rescue_proxy_email as string | null)?.trim() || null;
    if (!proxyEmail) {
      throw new Error(
        "Set your iMessage proxy email first (Refill → no-show settings) so drafts have somewhere to land.",
      );
    }

    const spaName = await resolveSpaName(
      sb as unknown as Parameters<typeof resolveSpaName>[0],
      effectiveUserId,
    );
    const { data: tenantRow } = await sb
      .from("tenants")
      .select("slug")
      .eq("id", tenantId)
      .maybeSingle();
    const slug = (tenantRow as { slug?: string } | null)?.slug ?? "";

    const targets = await listOfferCohortTargets(sb, effectiveUserId, cohort);
    const built: Array<{ name: string; phone: string; body: string }> = [];
    let skippedNoPhone = 0;
    for (const t of targets) {
      const phone = (t.phone ?? "").trim();
      if (!phone) {
        skippedNoPhone += 1;
        continue;
      }
      built.push({
        name: t.name || "(unnamed)",
        phone,
        body: composeOfferPushBody(firstNameOf(t.name), spaName, offer.title, slug),
      });
    }
    if (built.length === 0) {
      return {
        drafted: 0,
        skippedNoPhone,
        sentTo: null,
        error: "No reachable patients in this cohort (none had a phone number).",
      };
    }

    const subject = `${built.length} offer draft${built.length === 1 ? "" : "s"} — ${offer.title}`;
    const rows = built
      .map(
        (b) =>
          `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee">${escHtml(b.name)}</td><td style="padding:6px 10px;border-bottom:1px solid #eee">${escHtml(b.phone)}</td><td style="padding:6px 10px;border-bottom:1px solid #eee">${escHtml(b.body)}</td></tr>`,
      )
      .join("");
    const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1c2024">
<p>Paste this whole email into Claude Desktop with the iMessage MCP installed. Claude will call <code>draft_imessage(recipient_phone, body)</code> for each row — one Messages.app conversation per draft. Review each and tap Send.</p>
<p><strong>Offer:</strong> ${escHtml(offer.title)} &middot; <strong>Cohort:</strong> ${cohort} &middot; <strong>${built.length}</strong> patient(s)${skippedNoPhone ? ` &middot; ${skippedNoPhone} skipped (no phone)` : ""}</p>
<table style="border-collapse:collapse;font-size:13px"><thead><tr><th style="text-align:left;padding:6px 10px;border-bottom:2px solid #ccc">Name</th><th style="text-align:left;padding:6px 10px;border-bottom:2px solid #ccc">Phone</th><th style="text-align:left;padding:6px 10px;border-bottom:2px solid #ccc">Message</th></tr></thead><tbody>${rows}</tbody></table>
</div>`;
    const text = built.map((b) => `${b.name}\t${b.phone}\t${b.body}`).join("\n");

    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey) throw new Error("Server is missing RESEND_API_KEY.");
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: process.env.REFILL_FROM_EMAIL ?? "offers@getrefill.app",
          to: [proxyEmail],
          subject,
          text,
          html,
          tags: [
            { name: "type", value: "refill-offer-push" },
            { name: "tenant", value: effectiveUserId },
          ],
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        return {
          drafted: built.length,
          skippedNoPhone,
          sentTo: null,
          error: `Resend ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`,
        };
      }
    } catch (e) {
      return {
        drafted: built.length,
        skippedNoPhone,
        sentTo: null,
        error: e instanceof Error ? e.message : String(e),
      };
    }
    return { drafted: built.length, skippedNoPhone, sentTo: proxyEmail, error: null };
  });
