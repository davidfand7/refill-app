/**
 * refill-promos.ts — Spa-side eligible-promotions server fns (v1.14, ported
 * from openagenticv4 promotions.functions.ts).
 *
 * Three server fns for the /app/refill/promos surface:
 *
 *   listEligiblePromosForSpa  → spa owner sees promos for manufacturers
 *                                they actually carry (matched at claim-your-
 *                                business via service.matchedProduct.manufacturer)
 *   expressInterestInPromo    → spa flags a promo for their rep
 *   dismissPromoForSpa        → spa hides a promo from the active list
 *
 * Cross-tenant read uses the service-role admin client — the spa never sees
 * the rep's user_id or any rep-private fields.
 *
 * Why this lives in its own file (vs the 2851-line openagenticv4
 * promotions.functions.ts): per project-refill-trojan-horse-thesis, refill-app
 * is narrow. The rep-side promo management (listPromotions, draftPromoBlast,
 * sendPromoBlast, listPromoOutreachStates, routeInboundPromoReply, etc.)
 * lives in the Liz CRM stack and is intentionally NOT ported. Only the
 * spa-facing eligibility read + 2 interest writes come over.
 */

import { createServerFn } from "@tanstack/react-start";
import { admin } from "./admin-client";
import { z } from "zod";

import { verifyAuth, accessTokenInput } from "@/server/auth-helpers";
import type {
  PromotionAttachments,
  PromotionBuyInTier,
  PromotionKind,
} from "@/server/agent-schema";

// ── Public types ──────────────────────────────────────────────────────────

export type SpaInterestStatus = "interested" | "dismissed" | null;

export type EligiblePromoForSpa = {
  promotionId: string;
  title: string;
  manufacturer: string;
  promoKind: PromotionKind | null;
  description: string | null;
  starts: string | null;
  ends: string | null;
  daysToEnd: number | null;
  status: "upcoming" | "active" | "expired" | "unknown";
  heroImageUrl: string | null;
  sourceUrl: string | null;
  /** The lowest tier on the ladder — the spa's starting floor, useful as
   *  the [VERIFIED] anchor before they share a real volume number. */
  entryTier: { code: string; label: string; clause: string } | null;
  /** The top tier — aspirational reach. Helps the spa see what's possible. */
  bestTier: { code: string; label: string; clause: string } | null;
  /** Total tier count in the ladder (so UI can say "5 tiers, $370–$425/vial"). */
  tierCount: number;
  /** The spa's current interest signal. null = no signal yet. */
  spaInterestStatus: SpaInterestStatus;
  /** When the spa last changed status (interest or dismiss). null if no signal. */
  spaInterestUpdatedAt: string | null;
};

// ── Admin client ──────────────────────────────────────────────────────────

// ── Helpers ───────────────────────────────────────────────────────────────

/** Manufacturer-name normalization for cross-tenant match between spa
 *  services (matchedProduct.manufacturer, set by claim-your-business
 *  extraction — case varies: "AbbVie" / "abbvie") and promo attachments
 *  (manufacturer, set by rep — typically lower-case "evolus" / "galderma"
 *  / "abbvie" / "merz"). Normalize both to lowercase + collapse common
 *  brand-name pairs (allergan ↔ abbvie; merz ↔ merz-aesthetics). */
function normalizeManufacturer(m: string | null | undefined): string | null {
  if (!m) return null;
  const lower = m.trim().toLowerCase();
  if (lower === "allergan") return "abbvie";
  if (lower === "merz aesthetics" || lower === "merz-aesthetics") return "merz";
  return lower;
}

/** Builds the [VERIFIED]-friendly clause for a tier — e.g. "30-99 units →
 *  $370/unit flat, $50 rewards credit". Surfaces the manufacturer's
 *  structured offer so the spa can anchor their conversation with their
 *  rep on a concrete tier code rather than vibes. */
function describeTierClauseForVerified(t: PromotionBuyInTier): string {
  const range = typeof t.max_units === "number"
    ? `${t.min_units}-${t.max_units} units`
    : `${t.min_units}+ units`;
  const parts: string[] = [];
  if (typeof t.flat_price_per_unit_usd === "number") {
    parts.push(`$${t.flat_price_per_unit_usd}/unit flat`);
  } else if (typeof t.discount_per_unit_usd === "number") {
    parts.push(`$${t.discount_per_unit_usd} off per unit`);
  }
  if ((t.physical_goods ?? []).length > 0) {
    const goods = (t.physical_goods ?? [])
      .map((g) => `${g.quantity}× ${g.kind}`)
      .join(", ");
    parts.push(goods);
  }
  if (typeof t.rewards_credit_usd === "number") {
    parts.push(`$${t.rewards_credit_usd} rewards credit`);
  }
  return parts.length > 0 ? `${range} → ${parts.join(", ")}` : range;
}

// ── listEligiblePromosForSpa ──────────────────────────────────────────────

export const listEligiblePromosForSpa = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => accessTokenInput.parse(input))
  .handler(async ({ data }): Promise<EligiblePromoForSpa[]> => {
    const spaUserId = await verifyAuth(data.accessToken);
    const sb = admin();

    // 1. Pull the spa's services. Each service's matchedProduct.manufacturer
    //    tells us which manufacturer's catalog the spa actually uses.
    const { data: services } = await sb
      .from("knowledge_nodes")
      .select("attachments")
      .eq("user_id", spaUserId)
      .eq("node_type", "service");

    const manufacturers = new Set<string>();
    for (const svc of services ?? []) {
      const att = (svc.attachments ?? {}) as {
        matchedProduct?: { manufacturer?: string };
      };
      const m = normalizeManufacturer(att.matchedProduct?.manufacturer);
      if (m) manufacturers.add(m);
    }

    // No manufacturer signal yet → no eligible promos (UI shows empty state
    // pointing at the dashboard's services editor).
    if (manufacturers.size === 0) return [];

    // 2. Cross-tenant promo read. Service-role bypass — no user_id filter.
    //    Pull all promotion nodes; we filter by manufacturer in app code
    //    since the manufacturer field is inside the attachments jsonb and
    //    case-insensitive match via -> would require lower(...) which
    //    the Supabase client doesn't expose cleanly. ~hundreds of promos
    //    max for the foreseeable future, so an in-app filter is fine.
    const { data: promos, error } = await sb
      .from("knowledge_nodes")
      .select("id, user_id, title, content, attachments")
      .eq("node_type", "promotion")
      .limit(500);
    if (error) throw new Error(`Couldn't load promos: ${error.message}`);

    // 3. Filter by manufacturer + compute eligibility + status.
    const now = Date.now();
    const eligible: Array<EligiblePromoForSpa & { _repUserId: string; _sortKey: number }> = [];
    for (const p of promos ?? []) {
      const att = (p.attachments ?? {}) as PromotionAttachments;
      const promoMfr = normalizeManufacturer(att.manufacturer);
      if (!promoMfr || !manufacturers.has(promoMfr)) continue;

      // Drop expired promos older than 7 days (showed-up window already
      // closed; surfacing them just clutters).
      const endsMs = att.ends ? new Date(att.ends).getTime() : null;
      if (endsMs !== null && endsMs < now - 7 * 86_400_000) continue;

      const startsMs = att.starts ? new Date(att.starts).getTime() : null;
      const status: EligiblePromoForSpa["status"] = (() => {
        if (startsMs !== null && startsMs > now) return "upcoming";
        if (endsMs !== null && endsMs < now) return "expired";
        if (startsMs !== null || endsMs !== null) return "active";
        return "unknown";
      })();

      const tiers = (att.tiers ?? []) as PromotionBuyInTier[];
      const sortedTiers = [...tiers].sort((a, b) => a.min_units - b.min_units);
      const entry = sortedTiers[0] ?? null;
      const top = sortedTiers[sortedTiers.length - 1] ?? null;
      const daysToEnd = endsMs !== null
        ? Math.ceil((endsMs - now) / 86_400_000)
        : null;

      // Sort: active first by days-to-end ascending, then upcoming, then
      // recently-expired. Encode as a single sortable number.
      const sortKey = (() => {
        if (status === "active" && daysToEnd !== null) return daysToEnd;
        if (status === "upcoming") return 10_000 + (startsMs ?? 0);
        if (status === "expired") return 100_000 + (endsMs ?? 0);
        return 50_000;
      })();

      eligible.push({
        _repUserId: p.user_id,
        _sortKey: sortKey,
        promotionId: p.id,
        title: p.title ?? "(untitled promo)",
        manufacturer: att.manufacturer ?? promoMfr,
        promoKind: att.promo_kind ?? null,
        description: typeof att.description === "string" ? att.description : (p.content ?? null),
        starts: att.starts ?? null,
        ends: att.ends ?? null,
        daysToEnd,
        status,
        heroImageUrl: att.hero_image_url ?? null,
        sourceUrl: att.source_url ?? null,
        entryTier: entry
          ? { code: entry.code, label: entry.label, clause: describeTierClauseForVerified(entry) }
          : null,
        bestTier: top
          ? { code: top.code, label: top.label, clause: describeTierClauseForVerified(top) }
          : null,
        tierCount: sortedTiers.length,
        spaInterestStatus: null,
        spaInterestUpdatedAt: null,
      });
    }

    if (eligible.length === 0) return [];

    // 4. Pull the spa's existing interest signals for the matched promos
    //    in one query, hydrate each row.
    const promoIds = eligible.map((e) => e.promotionId);
    const { data: signals } = await sb
      .from("spa_promo_interest")
      .select("promotion_node_id, status, updated_at")
      .eq("spa_user_id", spaUserId)
      .in("promotion_node_id", promoIds);
    const signalByPromo = new Map(
      (signals ?? []).map((s) => [
        s.promotion_node_id,
        { status: s.status as SpaInterestStatus, updatedAt: s.updated_at },
      ]),
    );
    for (const row of eligible) {
      const sig = signalByPromo.get(row.promotionId);
      if (sig) {
        row.spaInterestStatus = sig.status;
        row.spaInterestUpdatedAt = sig.updatedAt;
      }
    }

    // Sort + drop the private sort key + rep_user_id before returning.
    eligible.sort((a, b) => a._sortKey - b._sortKey);
    return eligible.map((e) => {
      const { _repUserId, _sortKey, ...publicShape } = e;
      void _repUserId;
      void _sortKey;
      return publicShape;
    });
  });

// ── expressInterestInPromo + dismissPromoForSpa ───────────────────────────

const interestInput = accessTokenInput.extend({
  promotionId: z.string().uuid(),
  message: z.string().max(500).optional(),
});

export const expressInterestInPromo = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => interestInput.parse(input))
  .handler(async ({ data }): Promise<{ ok: true; status: "interested" }> => {
    const spaUserId = await verifyAuth(data.accessToken);
    const sb = admin();

    // Resolve the rep_user_id from the promotion node (we capture it on
    // the spa_promo_interest row so the rep-side query is a cheap join).
    const { data: promoRow } = await sb
      .from("knowledge_nodes")
      .select("user_id")
      .eq("id", data.promotionId)
      .eq("node_type", "promotion")
      .maybeSingle();
    if (!promoRow) throw new Error("Promo not found.");

    const { error } = await sb
      .from("spa_promo_interest")
      .upsert(
        {
          spa_user_id: spaUserId,
          rep_user_id: promoRow.user_id,
          promotion_node_id: data.promotionId,
          status: "interested",
          message: data.message ?? null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "spa_user_id,promotion_node_id" },
      );
    if (error) throw new Error(`Couldn't record interest: ${error.message}`);
    return { ok: true, status: "interested" };
  });

const dismissInput = accessTokenInput.extend({
  promotionId: z.string().uuid(),
});

export const dismissPromoForSpa = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => dismissInput.parse(input))
  .handler(async ({ data }): Promise<{ ok: true; status: "dismissed" }> => {
    const spaUserId = await verifyAuth(data.accessToken);
    const sb = admin();

    const { data: promoRow } = await sb
      .from("knowledge_nodes")
      .select("user_id")
      .eq("id", data.promotionId)
      .eq("node_type", "promotion")
      .maybeSingle();
    if (!promoRow) throw new Error("Promo not found.");

    const { error } = await sb
      .from("spa_promo_interest")
      .upsert(
        {
          spa_user_id: spaUserId,
          rep_user_id: promoRow.user_id,
          promotion_node_id: data.promotionId,
          status: "dismissed",
          updated_at: new Date().toISOString(),
        },
        { onConflict: "spa_user_id,promotion_node_id" },
      );
    if (error) throw new Error(`Couldn't dismiss: ${error.message}`);
    return { ok: true, status: "dismissed" };
  });
