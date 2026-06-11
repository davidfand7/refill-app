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
  bestActiveOfferForName,
  normalizeForMatch,
  type PromoOffer,
  type OfferType,
} from "@/lib/promo-calendar";
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
};

// Single source of truth for the columns we read, so the loader + insert
// selects never drift. New offer-engine columns land here (v2.4.2).
const OFFER_COLS =
  "id, source, manufacturer, product, title, discount_usd, starts_on, ends_on, landing_url, promotion_type, raw_title, offer_type, value_pct, addon_service_name, addon_label, is_active";

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
async function resolvePatientNodeByContact(
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
 * Record a $5 cross_sell win IF a booked service or add-on carried an active
 * manufacturer promo AND we can attribute it to a patient in the graph.
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
  let matched: string | null = null;
  for (const name of [args.serviceName, ...args.addOnNames]) {
    const offer = bestActiveOfferForName(offers, name, today);
    if (offer) {
      matched = offer.title;
      break;
    }
  }
  if (!matched) return { recorded: false, reason: "no_active_offer" };

  const patientNodeId = await resolvePatientNodeByContact(
    args.sb,
    args.userId,
    args.email,
    args.phone,
  );
  if (!patientNodeId) return { recorded: false, reason: "unmatched_patient" };

  await recordRecoveryEvent({
    sb: args.sb as unknown as Parameters<typeof recordRecoveryEvent>[0]["sb"],
    userId: args.userId,
    appointmentId: args.appointmentId,
    patientNodeId,
    recoveryAgent: "cross_sell",
    metricKey: "cross_sell_addon",
    attributionMethod: "direct",
    notes: `Cross-sell: ${matched}`,
  });
  return { recorded: true };
}
