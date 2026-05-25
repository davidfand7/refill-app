/**
 * Refill incentive offers server fns (v390.1 / Phase 1.6 slice 3b).
 *
 * Grasshopper's lever board to attach individual or global offers to
 * Refill tenants — trial extensions, discounted revenue-share windows,
 * flat credits, free-form custom offers. v390 shipped the schema +
 * reply-capture; v390.1 makes the levers actually pull-able.
 *
 * Surface:
 *   createIncentiveOffer  — INSERT + return the new offer
 *   listOffersForTenant   — pull all offers for a tenant (active + past)
 *   sendOfferToTenant     — compose Karen-voiced email from the offer,
 *                           POST through Resend (plus-addressed Reply-To
 *                           same as drips), log a tenant_engagement_events
 *                           row with event_type='offer:sent' and the
 *                           offer_id wired into source_drip_id for chain
 *                           visibility in v391+ analytics.
 *
 * Offer-type taxonomy (mirrors migration header):
 *   trial_extension        terms: { days: number }
 *   revenue_share_discount terms: { pct: number, durationMonths: number }
 *   flat_credit            terms: { usd: number }
 *   custom                 terms: { description: string, value?: string }
 *
 * Per-type validation runs server-side so the modal can be loose about
 * input types — the boundary is the DB.
 */

import { createClient } from "@supabase/supabase-js";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import type { Database, Json } from "@/integrations/supabase/types";
import { verifyAuth } from "@/server/auth-helpers";
import { wrapDripEmail } from "@/lib/email-templates/refill-drip-shell";

type SbClient = ReturnType<typeof createClient<Database>>;

function admin(): SbClient {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function requireAdmin(sb: SbClient, accessToken: string): Promise<string> {
  const userId = await verifyAuth(accessToken);
  const { data: roleRow, error } = await sb
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (error) throw new Error(`Couldn't verify admin role: ${error.message}`);
  if (!roleRow) throw new Error("Admin role required.");
  return userId;
}

// ─── Sender + reply config (mirrors refill-drip.ts) ──────────────────────

const KAREN_FROM =
  process.env.REFILL_DRIP_FROM ?? "Karen Anderson <karen@getrefill.app>";

const REPLY_DOMAIN =
  process.env.REFILL_DRIP_REPLY_DOMAIN ?? "reply.getrefill.app";

function buildReplyTo(eventId: string): string {
  return `Karen Anderson <reply+${eventId}@${REPLY_DOMAIN}>`;
}

// ─── Offer type validation ───────────────────────────────────────────────

export const OFFER_TYPES = [
  "trial_extension",
  "revenue_share_discount",
  "flat_credit",
  "custom",
] as const;

export type OfferType = (typeof OFFER_TYPES)[number];

const trialExtensionTerms = z.object({
  days: z.number().int().min(1).max(180),
});

const revenueShareTerms = z.object({
  pct: z.number().min(0).max(100),
  durationMonths: z.number().int().min(1).max(36),
});

const flatCreditTerms = z.object({
  usd: z.number().int().min(1).max(100_000),
});

const customTerms = z.object({
  description: z.string().min(1).max(500),
  value: z.string().max(200).optional(),
});

function validateTermsForType(offerType: OfferType, terms: unknown): Record<string, unknown> {
  switch (offerType) {
    case "trial_extension":
      return trialExtensionTerms.parse(terms);
    case "revenue_share_discount":
      return revenueShareTerms.parse(terms);
    case "flat_credit":
      return flatCreditTerms.parse(terms);
    case "custom":
      return customTerms.parse(terms);
  }
}

// ─── createIncentiveOffer ────────────────────────────────────────────────

const createInput = z.object({
  accessToken: z.string().min(1),
  tenantId: z.string().uuid().nullable(),
  offerType: z.enum(OFFER_TYPES),
  terms: z.unknown(),
  validUntil: z.string().nullable().optional(),
});

export interface OfferRow {
  id: string;
  tenantId: string | null;
  offerType: OfferType;
  terms: Json;
  validFrom: string;
  validUntil: string | null;
  claimedAt: string | null;
  createdAt: string;
}

export const createIncentiveOffer = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => createInput.parse(raw))
  .handler(async ({ data }): Promise<{ offer: OfferRow }> => {
    const sb = admin();
    const userId = await requireAdmin(sb, data.accessToken);
    const validatedTerms = validateTermsForType(
      data.offerType as OfferType,
      data.terms,
    );

    const { data: row, error } = await sb
      .from("incentive_offers")
      .insert({
        tenant_id: data.tenantId,
        offer_type: data.offerType,
        terms: validatedTerms as Json,
        valid_until: data.validUntil ?? null,
        created_by: userId,
      })
      .select(
        "id, tenant_id, offer_type, terms, valid_from, valid_until, claimed_at, created_at",
      )
      .single();
    if (error) throw new Error(`Couldn't create offer: ${error.message}`);

    return {
      offer: {
        id: row.id,
        tenantId: row.tenant_id,
        offerType: row.offer_type as OfferType,
        terms: row.terms as Json,
        validFrom: row.valid_from,
        validUntil: row.valid_until,
        claimedAt: row.claimed_at,
        createdAt: row.created_at,
      },
    };
  });

// ─── listOffersForTenant ─────────────────────────────────────────────────

const listInput = z.object({
  accessToken: z.string().min(1),
  tenantId: z.string().uuid(),
});

export interface OfferWithStatus extends OfferRow {
  /** Latest sent event for this offer, if any. v390.1 derived. */
  sentAt: string | null;
}

export const listOffersForTenant = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => listInput.parse(raw))
  .handler(async ({ data }): Promise<{ offers: OfferWithStatus[] }> => {
    const sb = admin();
    await requireAdmin(sb, data.accessToken);

    const { data: offers, error: offersErr } = await sb
      .from("incentive_offers")
      .select(
        "id, tenant_id, offer_type, terms, valid_from, valid_until, claimed_at, created_at",
      )
      .eq("tenant_id", data.tenantId)
      .order("created_at", { ascending: false });
    if (offersErr) throw new Error(`offers query: ${offersErr.message}`);
    if (!offers || offers.length === 0) return { offers: [] };

    // Pull associated send events (one per offer at most for v390.1).
    const offerIds = offers.map((o) => o.id);
    const { data: sentEvents, error: eventsErr } = await sb
      .from("tenant_engagement_events")
      .select("source_drip_id, sent_at")
      .in("source_drip_id", offerIds)
      .like("event_type", "offer:%");
    if (eventsErr) {
      console.warn("[refill-offers] sent-event lookup non-fatal:", eventsErr.message);
    }
    const sentByOfferId = new Map<string, string>();
    for (const ev of sentEvents ?? []) {
      if (ev.source_drip_id && ev.sent_at) {
        sentByOfferId.set(ev.source_drip_id, ev.sent_at);
      }
    }

    return {
      offers: offers.map((row) => ({
        id: row.id,
        tenantId: row.tenant_id,
        offerType: row.offer_type as OfferType,
        terms: row.terms as Json,
        validFrom: row.valid_from,
        validUntil: row.valid_until,
        claimedAt: row.claimed_at,
        createdAt: row.created_at,
        sentAt: sentByOfferId.get(row.id) ?? null,
      })),
    };
  });

// ─── Email composer ──────────────────────────────────────────────────────

interface TenantBrief {
  name: string;
}

function composeIncentiveOfferEmail(
  offer: OfferRow,
  tenant: TenantBrief,
): ReturnType<typeof wrapDripEmail> {
  const name = tenant.name?.trim() || "your spa";
  const validClause = offer.validUntil
    ? `Valid through ${new Date(offer.validUntil).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}.`
    : "";

  let headline: string;
  let bodyParagraphs: string[];

  switch (offer.offerType) {
    case "trial_extension": {
      const days = Number((offer.terms as { days?: unknown }).days ?? 0);
      headline = `A few more days on us, ${name}.`;
      bodyParagraphs = [
        `Hi ${name} team,`,
        `Karen here. David and I want to extend your Refill trial by **${days} more days** — no strings, no commitment.`,
        "Use the time to keep watching the engine work. If a no-show hits while you're extended, you'll see Refill recover it just like you would on the paid plan.",
        validClause ? `${validClause} Just hit reply and we'll lock it in.` : "Hit reply to lock it in.",
        "— Karen",
      ];
      break;
    }
    case "revenue_share_discount": {
      const pct = Number((offer.terms as { pct?: unknown }).pct ?? 0);
      const months = Number(
        (offer.terms as { durationMonths?: unknown }).durationMonths ?? 0,
      );
      headline = `${pct}% revenue share for ${months} months, ${name}.`;
      bodyParagraphs = [
        `Hi ${name} team,`,
        `Karen here. We're offering ${name} a **discounted revenue share — ${pct}% instead of our standard 12% — for the first ${months} months** of your Refill subscription.`,
        "Same engine, same recovery, lower share back to us. Our way of thanking the spas who came in early.",
        validClause ? `${validClause} Hit reply and we'll set it up.` : "Hit reply and we'll set it up.",
        "— Karen",
      ];
      break;
    }
    case "flat_credit": {
      const usd = Number((offer.terms as { usd?: unknown }).usd ?? 0);
      headline = `$${usd} credit on us, ${name}.`;
      bodyParagraphs = [
        `Hi ${name} team,`,
        `Karen here. We've added a **$${usd} credit** to your Refill account. It'll apply against your first invoice when you move to a paid plan — no expiration if you stay on trial through it.`,
        validClause,
        "Hit reply if you have any questions.",
        "— Karen",
      ];
      break;
    }
    case "custom": {
      const description = String(
        (offer.terms as { description?: unknown }).description ?? "",
      );
      headline = `A note from Karen at Refill.`;
      bodyParagraphs = [
        `Hi ${name} team,`,
        description,
        validClause,
        "Hit reply with any questions — happy to walk you through.",
        "— Karen",
      ];
      break;
    }
  }

  return wrapDripEmail({
    subject: headline,
    headline,
    bodyParagraphs: bodyParagraphs.filter((p) => p.trim().length > 0),
  });
}

// ─── sendOfferToTenant ───────────────────────────────────────────────────

const sendInput = z.object({
  accessToken: z.string().min(1),
  offerId: z.string().uuid(),
});

export const sendOfferToTenant = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => sendInput.parse(raw))
  .handler(
    async ({
      data,
    }): Promise<
      | { ok: true; messageId: string | null; eventId: string }
      | { ok: false; reason: string }
    > => {
      const apiKey = process.env.RESEND_API_KEY;
      if (!apiKey) {
        return { ok: false, reason: "RESEND_API_KEY not configured" };
      }

      const sb = admin();
      await requireAdmin(sb, data.accessToken);

      const { data: offer, error: offerErr } = await sb
        .from("incentive_offers")
        .select("id, tenant_id, offer_type, terms, valid_from, valid_until, claimed_at, created_at")
        .eq("id", data.offerId)
        .maybeSingle();
      if (offerErr || !offer) {
        return { ok: false, reason: `offer lookup: ${offerErr?.message ?? "not found"}` };
      }
      if (!offer.tenant_id) {
        return { ok: false, reason: "offer has no tenant_id (global offers can't be sent to a single inbox)" };
      }

      // Find tenant + owner email
      const { data: tenant, error: tenantErr } = await sb
        .from("tenants")
        .select("id, name, slug")
        .eq("id", offer.tenant_id)
        .maybeSingle();
      if (tenantErr || !tenant) {
        return { ok: false, reason: `tenant lookup: ${tenantErr?.message ?? "not found"}` };
      }

      const { data: membership, error: memErr } = await sb
        .from("tenant_memberships")
        .select("user_id")
        .eq("tenant_id", tenant.id)
        .eq("role", "owner")
        .maybeSingle();
      if (memErr || !membership) {
        return { ok: false, reason: "no owner membership for tenant" };
      }
      const { data: userResp, error: userErr } = await sb.auth.admin.getUserById(
        membership.user_id,
      );
      if (userErr || !userResp?.user?.email) {
        return { ok: false, reason: "no owner email on tenant" };
      }
      const ownerEmail = userResp.user.email;

      const offerRow: OfferRow = {
        id: offer.id,
        tenantId: offer.tenant_id,
        offerType: offer.offer_type as OfferType,
        terms: offer.terms as Json,
        validFrom: offer.valid_from,
        validUntil: offer.valid_until,
        claimedAt: offer.claimed_at,
        createdAt: offer.created_at,
      };

      const { subject, text, html } = composeIncentiveOfferEmail(offerRow, tenant);

      const eventId = crypto.randomUUID();
      const replyTo = buildReplyTo(eventId);

      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: KAREN_FROM,
            to: [ownerEmail],
            reply_to: replyTo,
            subject,
            text,
            html,
            tags: [
              { name: "type", value: "refill-offer" },
              { name: "offer_type", value: offerRow.offerType },
              { name: "tenant_slug", value: tenant.slug.slice(0, 60) },
            ],
          }),
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          return {
            ok: false,
            reason: `Resend ${res.status}: ${body.slice(0, 200)}`,
          };
        }
        const json = (await res.json().catch(() => ({}))) as { id?: string };
        const messageId = json.id ?? null;

        // Log to tenant_engagement_events. source_drip_id points back to
        // the offer row so v391+ analytics can chain offer → send → reply.
        const { error: insertErr } = await sb
          .from("tenant_engagement_events")
          .insert({
            id: eventId,
            tenant_id: tenant.id,
            event_type: `offer:${offerRow.offerType}`,
            sent_at: new Date().toISOString(),
            source_drip_id: offerRow.id,
            payload: {
              subject,
              recipient: ownerEmail,
              from: KAREN_FROM,
              reply_to: replyTo,
              message_id: messageId,
              offer_id: offerRow.id,
              offer_type: offerRow.offerType,
              terms: offerRow.terms as Json,
            } as Json,
          });
        if (insertErr) {
          console.error(
            "[refill-offers] event log failed AFTER send for offer",
            offerRow.id,
            insertErr.message,
          );
        }

        return { ok: true, messageId, eventId };
      } catch (err) {
        return {
          ok: false,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );
