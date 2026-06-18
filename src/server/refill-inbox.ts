/**
 * Refill inbound reply routing (v390 / Phase 1.6 slice 3a).
 *
 * Catches replies to Refill trial drips. The plus-addressed Reply-To
 * line (set by refill-drip.ts → buildReplyTo) carries the originating
 * tenant_engagement_events.id as its token. When the spa owner hits
 * reply, their client sends to reply+<eventId>@reply.openagentic.site,
 * Resend's inbound MX delivers to our webhook, and the inbound handler
 * at /api/resend/inbound dispatches to this fn (BEFORE the existing
 * Emma + Promo paths — see api.resend.inbound.ts).
 *
 * Match shape: the token is parsed by parseReplyToToken in
 * src/server/resend-gateway.ts. If it's a UUID matching a row in
 * tenant_engagement_events, we own it. If not, return { routed: false }
 * so the inbound handler falls through to Emma + Promo.
 *
 * Side effects on a match:
 *   - Stamp response_text + response_received_at on the original
 *     engagement_events row
 *   - Return { ok: true, routed: true, eventId } so the webhook logs
 *     cleanly
 *
 * Idempotency: if response_text is already populated for the row, we
 * concatenate the new body underneath the existing one with a separator.
 * Resend retries are rare but possible — we'd rather have a duplicated
 * reply text than lose a message, so the append path is the right call.
 */

import { admin } from "./admin-client";



const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RefillInboundInput {
  /** Plus-address token parsed by parseReplyToToken from the webhook. */
  token: string | null;
  /** From: of the inbound reply. */
  fromAddr: string;
  /** Subject of the inbound reply. */
  subject: string | null;
  /** Plain-text body fetched from Resend. */
  bodyText: string | null;
  /** Resend's own email_id for the inbound message (audit trail). */
  resendEmailId: string;
}

export type RefillInboundResult =
  | { ok: true; routed: true; eventId: string }
  | { ok: true; routed: false; reason: string };

/**
 * Try to route an inbound reply as a Refill drip response. Returns
 * { routed: false } when the token doesn't match — caller falls
 * through to other inbound handlers.
 */
export async function routeInboundRefillDripReply(
  input: RefillInboundInput,
): Promise<RefillInboundResult> {
  // Refill drip event_ids are UUIDs minted by randomUUID() server-side.
  // Skip non-UUID tokens immediately so we don't waste a DB round-trip
  // on tokens that are clearly Emma/Promo intent_tokens (those use a
  // different shape — base64url-ish, no dashes).
  if (!input.token || !UUID_RE.test(input.token)) {
    return { ok: true, routed: false, reason: "token not a UUID" };
  }

  const sb = admin();
  const { data: event, error: lookupErr } = await sb
    .from("tenant_engagement_events")
    .select("id, tenant_id, event_type, response_text, response_received_at")
    .eq("id", input.token)
    .like("event_type", "drip:day%")
    .maybeSingle();
  if (lookupErr) {
    console.warn(
      "[refill-inbox] event lookup failed:",
      input.token,
      lookupErr.message,
    );
    return { ok: true, routed: false, reason: `lookup: ${lookupErr.message}` };
  }
  if (!event) {
    return { ok: true, routed: false, reason: "no matching drip event" };
  }

  // Compose the response_text. If we already have one (Resend retry or
  // a second reply on the same thread), append rather than overwrite.
  const incomingBody = (input.bodyText ?? "").trim() || "(empty reply body)";
  const nextBody = event.response_text
    ? `${event.response_text}\n\n--- ${new Date().toISOString()} ---\n${incomingBody}`
    : incomingBody;

  const { error: updateErr } = await sb
    .from("tenant_engagement_events")
    .update({
      response_text: nextBody,
      response_received_at: new Date().toISOString(),
    })
    .eq("id", event.id);
  if (updateErr) {
    console.error(
      "[refill-inbox] response stamp failed for event",
      event.id,
      updateErr.message,
    );
    return {
      ok: true,
      routed: false,
      reason: `update: ${updateErr.message}`,
    };
  }

  console.log(
    "[refill-inbox] reply captured for tenant",
    event.tenant_id,
    "drip",
    event.event_type,
    "from",
    input.fromAddr,
  );

  return { ok: true, routed: true, eventId: event.id };
}

/**
 * Try to route an inbound reply as a Refill OUTREACH reply (v394).
 * The plus-address token is the outreach_engagement_events.id (UUID).
 * Falls through to subsequent handlers when the token doesn't match.
 *
 * Mirrors the drip handler shape. Looks in outreach_engagement_events
 * instead of tenant_engagement_events — these are sibling tables for
 * prospect-side vs tenant-side engagement.
 */
export async function routeInboundOutreachReply(
  input: RefillInboundInput,
): Promise<RefillInboundResult> {
  if (!input.token || !UUID_RE.test(input.token)) {
    return { ok: true, routed: false, reason: "token not a UUID" };
  }

  const sb = admin();
  const { data: event, error: lookupErr } = await sb
    .from("outreach_engagement_events")
    .select("id, recipient_email, icp, channel, response_text")
    .eq("id", input.token)
    .maybeSingle();
  if (lookupErr) {
    console.warn(
      "[refill-inbox] outreach lookup failed:",
      input.token,
      lookupErr.message,
    );
    return { ok: true, routed: false, reason: `outreach lookup: ${lookupErr.message}` };
  }
  if (!event) {
    return { ok: true, routed: false, reason: "no matching outreach event" };
  }

  // Append-on-second-reply same pattern as drip.
  const incomingBody = (input.bodyText ?? "").trim() || "(empty reply body)";
  const nextBody = event.response_text
    ? `${event.response_text}\n\n--- ${new Date().toISOString()} ---\n${incomingBody}`
    : incomingBody;

  const { error: updateErr } = await sb
    .from("outreach_engagement_events")
    .update({
      response_text: nextBody,
      response_received_at: new Date().toISOString(),
    })
    .eq("id", event.id);
  if (updateErr) {
    console.error(
      "[refill-inbox] outreach response stamp failed for event",
      event.id,
      updateErr.message,
    );
    return {
      ok: true,
      routed: false,
      reason: `update: ${updateErr.message}`,
    };
  }

  console.log(
    "[refill-inbox] outreach reply captured for prospect",
    event.recipient_email,
    "icp",
    event.icp,
    "channel",
    event.channel,
    "from",
    input.fromAddr,
  );

  return { ok: true, routed: true, eventId: event.id };
}
