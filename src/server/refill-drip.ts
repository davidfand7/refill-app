/**
 * Refill trial-drip engagement library (v388 → v389 / Phase 1.6 slices 1-2).
 *
 * Sends the five-message trial drip sequence from Karen:
 *   Day  3 — "how's your first week going?"
 *   Day  7 — "one week in — what's working?"
 *   Day 14 — "halfway through your trial"
 *   Day 21 — "one week left"
 *   Day 28 — "wraps in 2 days"
 *
 * Triggered by the daily cron at /api/cron/refill-trial-drip. The cron
 * iterates each day-bucket, selects tenants past that threshold who
 * haven't received that specific drip yet, and fires the appropriate
 * composer per tenant.
 *
 * Voice + sender:
 *   From: Karen Anderson <karen@getrefill.app>
 *   Reply-To: david@openagentic.site (v389 interim — getrefill.app
 *     inbound MX lands in v390 with the reply-capture loop)
 *
 *   Karen is the RN-owner of Rejuv Skin Spa. Peer-to-peer voice for the
 *   med-spa audience. David-as-founder voice held in reserve for vision
 *   moments. Every drip ends with a hit-reply CTA — the data we want
 *   most is the actual replies, not the open rates.
 *
 * Per the trial-first-no-money-asks product rule (memory:
 * project-trial-first-no-money-asks): no drip asks for money. The
 * Day-28 message offers a conversation about plan options, not a
 * payment form. Plan-pick UI lands in v391 at /app/billing.
 *
 * Send semantics:
 *   - Insert-on-success only. Failed sends don't write a row; the
 *     daily cron picks the tenant up again on its next run.
 *   - Per-day dedup via tenant_engagement_events.event_type
 *     ('drip:day3', 'drip:day7', 'drip:day14', 'drip:day21', 'drip:day28').
 *     A successful send writes the row; subsequent cron passes skip.
 */

import { admin, type SbClient } from "./admin-client";

import type { Database } from "@/integrations/supabase/types";
import {
  wrapDripEmail,
  type DripEmailRendered,
} from "@/lib/email-templates/refill-drip-shell";

// ─── Service-role admin client (module-private) ──────────────────────────


export type TenantRow = Database["public"]["Tables"]["tenants"]["Row"];

export type DripDay = 3 | 7 | 14 | 21 | 28;

export const DRIP_DAYS: readonly DripDay[] = [3, 7, 14, 21, 28] as const;

// ─── Sender config ───────────────────────────────────────────────────────

const KAREN_FROM =
  process.env.REFILL_DRIP_FROM ?? "Karen Anderson <karen@getrefill.app>";

// v390: Reply-To is per-send plus-addressed at reply.openagentic.site
// (the inbound MX already used by Emma's promo reply tracking). The
// plus-token is the tenant_engagement_events.id so the inbound handler
// can look the original drip up and stamp response_text on the same row.
// Domain matches the REPLY_DOMAIN constant in src/server/resend-gateway.ts.
const REPLY_DOMAIN =
  process.env.REFILL_DRIP_REPLY_DOMAIN ?? "reply.getrefill.app";

function buildReplyTo(eventId: string): string {
  return `Karen Anderson <reply+${eventId}@${REPLY_DOMAIN}>`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Resolve the owner's email for a tenant. Path: tenant_memberships
 * (role='owner') → auth.users.email via service-role admin API.
 *
 * Returns null on any failure so the cron can log + skip cleanly rather
 * than throwing and aborting the whole batch.
 */
export async function getTenantOwnerEmail(
  sb: SbClient,
  tenantId: string,
): Promise<string | null> {
  const { data: membership, error: memErr } = await sb
    .from("tenant_memberships")
    .select("user_id")
    .eq("tenant_id", tenantId)
    .eq("role", "owner")
    .maybeSingle();
  if (memErr || !membership) {
    if (memErr) {
      console.warn(
        "[refill-drip] owner lookup failed for tenant",
        tenantId,
        memErr.message,
      );
    }
    return null;
  }
  const { data: userResp, error: userErr } = await sb.auth.admin.getUserById(
    membership.user_id,
  );
  if (userErr) {
    console.warn(
      "[refill-drip] auth.users lookup failed for tenant",
      tenantId,
      userErr.message,
    );
    return null;
  }
  return userResp?.user?.email ?? null;
}

export function dripEventTypeForDay(day: DripDay): string {
  return `drip:day${day}`;
}

function spaName(tenant: TenantRow): string {
  return tenant.name?.trim() || "your spa";
}

// ─── Composers (Karen's voice across all five) ────────────────────────────

function composeDay3(tenant: TenantRow): DripEmailRendered {
  const name = spaName(tenant);
  return wrapDripEmail({
    subject: `How's your first week with SmartSpa, ${name}?`,
    preheader: "Quick check-in from Karen at Rejuv.",
    headline: `How's your first week with SmartSpa, ${name}?`,
    bodyParagraphs: [
      `Hi ${name} team,`,
      "Karen here — RN and owner of Rejuv Skin Spa, and one of the spa owners who's been using SmartSpa since the beginning.",
      "You signed up three days ago. How's it going? Any snags getting set up, questions about the dashboard, or feedback on what you'd want next?",
      "**Hit reply — I read every message.** Your feedback shapes what we build next.",
    ],
  });
}

function composeDay7(tenant: TenantRow): DripEmailRendered {
  const name = spaName(tenant);
  return wrapDripEmail({
    subject: `One week in — what's working for you, ${name}?`,
    preheader: "A quick favor — one specific piece of feedback.",
    headline: `One week in, ${name}.`,
    bodyParagraphs: [
      `Hi ${name} team,`,
      "Karen again. One full week with SmartSpa — wanted to check in.",
      "**Quick favor**: hit reply with one of these — (a) something you wish SmartSpa did, (b) something that's surprised you so far, or (c) a question about how anything works.",
      "Your answer goes straight to David and me. We're rolling new features every week based on what spa owners actually tell us, and your inputs land in real product decisions.",
    ],
  });
}

function composeDay14(tenant: TenantRow): DripEmailRendered {
  const name = spaName(tenant);
  return wrapDripEmail({
    subject: `You're halfway through your SmartSpa trial, ${name}`,
    preheader: "Two weeks in — here's what's coming.",
    headline: `Halfway there, ${name}.`,
    bodyParagraphs: [
      `Hi ${name} team,`,
      "Two weeks in. Hard to believe.",
      "If you've had any cancellations come through, you've already seen the engine work — catching them, drafting the rescue offer, getting the slot refilled before the front desk could lift a finger. (If you haven't had any cancellations yet, lucky you — it'll happen, and SmartSpa will be ready.)",
      "We're shipping a recovered-revenue dashboard in the next couple of weeks — running total of what SmartSpa caught for you, plus the cancellations you didn't have to chase. I'll send the link the moment it's live.",
      "**Anything tripping you up? Hit reply.** I read every message.",
    ],
  });
}

function composeDay21(tenant: TenantRow): DripEmailRendered {
  const name = spaName(tenant);
  return wrapDripEmail({
    subject: `One week left in your SmartSpa trial, ${name}`,
    preheader: "Two questions before your trial wraps.",
    headline: `One week left, ${name}.`,
    bodyParagraphs: [
      `Hi ${name} team,`,
      "Three weeks down. Your trial wraps in 7 days.",
      "**Two questions before then**:",
      "(1) Has SmartSpa earned its keep? If yes, we'll keep the engine running — David and I will reach out next week to walk you through plan options personally.",
      "(2) Any feedback you've been sitting on? Now's the moment — we listen hardest at the end of trials.",
      "Hit reply — same inbox, same Karen.",
    ],
  });
}

function composeDay28(tenant: TenantRow): DripEmailRendered {
  const name = spaName(tenant);
  return wrapDripEmail({
    subject: `Your SmartSpa trial wraps in 2 days, ${name}`,
    preheader: "If you'd like to keep going — let's talk.",
    headline: `2 days left, ${name}.`,
    bodyParagraphs: [
      `Hi ${name} team,`,
      "Day 28. Your SmartSpa trial wraps in 2 days.",
      "If you'd like to keep going past then, **hit reply** — David and I will walk you through the plan options personally. No checkout flow, no credit card form, just a conversation about what works for your spa.",
      "Most spas stay on our performance plan — free + just $5 for each booking SmartSpa creates for you, no flat fee, you only pay when we put money back in your books. But there are alternatives if that doesn't fit your numbers.",
      "Either way, even if you decide SmartSpa isn't for you, we'd love a quick \"here's why\" on reply. Those notes shape the product more than anything else.",
    ],
  });
}

const COMPOSERS: Record<DripDay, (tenant: TenantRow) => DripEmailRendered> = {
  3: composeDay3,
  7: composeDay7,
  14: composeDay14,
  21: composeDay21,
  28: composeDay28,
};

export function composeTrialDripByDay(
  day: DripDay,
  tenant: TenantRow,
): DripEmailRendered {
  return COMPOSERS[day](tenant);
}

// ─── Send + record ───────────────────────────────────────────────────────

export type SendDripResult =
  | { ok: true; messageId: string | null }
  | { ok: false; reason: string };

/**
 * Send a specific day's drip to one tenant and record the event row on
 * success. Caller is either the cron (daily sweep) or the admin route
 * (manual override via /app/admin/refill-trials).
 *
 * Failures don't throw; they return { ok: false } so callers can tally
 * and keep going.
 */
export async function sendTrialDripByDay(
  day: DripDay,
  tenantId: string,
): Promise<SendDripResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { ok: false, reason: "RESEND_API_KEY not configured" };
  }

  const sb = admin();
  const { data: tenant, error: tenantErr } = await sb
    .from("tenants")
    .select("*")
    .eq("id", tenantId)
    .maybeSingle();
  if (tenantErr || !tenant) {
    return {
      ok: false,
      reason: `tenant lookup: ${tenantErr?.message ?? "not found"}`,
    };
  }

  const ownerEmail = await getTenantOwnerEmail(sb, tenantId);
  if (!ownerEmail) {
    return { ok: false, reason: "no owner email on tenant" };
  }

  const { subject, text, html } = composeTrialDripByDay(day, tenant);

  // v390: mint the event id BEFORE the send so Reply-To can be
  // plus-addressed with this exact UUID. The inbound webhook handler
  // parses the token back to this row when the spa owner replies.
  // Using Web Crypto (globally available in Cloudflare Workers) rather
  // than node:crypto so the vite worker bundle doesn't pull in node-only
  // shims.
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
          { name: "type", value: "refill-drip" },
          { name: "drip_day", value: String(day) },
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

    const { error: insertErr } = await sb
      .from("tenant_engagement_events")
      .insert({
        id: eventId,
        tenant_id: tenantId,
        event_type: dripEventTypeForDay(day),
        sent_at: new Date().toISOString(),
        payload: {
          subject,
          recipient: ownerEmail,
          from: KAREN_FROM,
          reply_to: replyTo,
          message_id: messageId,
        },
      });
    if (insertErr) {
      console.error(
        "[refill-drip] event log failed AFTER send for tenant",
        tenantId,
        "day",
        day,
        insertErr.message,
      );
    }

    return { ok: true, messageId };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Backwards-compat alias for the v388 cron callsite. Will be removed once
 * the cron is updated to call sendTrialDripByDay(3, ...) directly.
 *
 * @deprecated use sendTrialDripByDay(3, tenantId) instead.
 */
export const sendTrialDripDay3 = (tenantId: string) =>
  sendTrialDripByDay(3, tenantId);
