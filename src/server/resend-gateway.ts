/**
 * Resend bridge — inbound email reply routing (v338).
 *
 * Mirrors twilio-gateway.ts shape:
 *   - signature verification (Svix-compatible HMAC-SHA256 for Resend webhooks)
 *   - REST helpers for fetching what the webhook payload doesn't include
 *   - typed envelopes the route handler dispatches on
 *
 * Resend's inbound webhook delivers metadata only — no body, no headers,
 * no attachments. Per docs (https://resend.com/docs/dashboard/receiving/
 * introduction), the body lives behind a separate authenticated call:
 *   GET https://api.resend.com/emails/receiving/{id}
 *
 * Routing strategy: plus-addressing in Reply-To carries the
 * promotion_outreach.intent_token (already minted by sendPromoBlast,
 * already indexed). The To address on the inbound webhook is the
 * verbatim plus-address; we parse it for the token, look up the
 * originating outreach row, log the reply, flip the parent state
 * (outreached → engaged). If the token's been stripped (rare on modern
 * providers), the In-Reply-To header on the fetched body lets us fall
 * back to a promotion_outreach.email_id lookup. If both miss, the
 * payload lands in inbox_unmatched for manual linking.
 */

import crypto from "node:crypto";

// ── Constants ───────────────────────────────────────────────────────────────

export const RESEND_API_BASE = "https://api.resend.com";

/**
 * The receiving subdomain. Refill cleave 2026-05-25: was reply.openagentic.site,
 * now refill-pure. Inbound MX + Resend inbound forwarding for reply.getrefill.app
 * still need to be configured before any LIVE outreach send — until then,
 * Reply-To displays correctly but actual replies will bounce. Tracked separately.
 * Env override (REFILL_DRIP_REPLY_DOMAIN) is honored so the rest of the codebase
 * uses one source of truth.
 */
export const REPLY_DOMAIN =
  process.env.REFILL_DRIP_REPLY_DOMAIN ?? "reply.getrefill.app";

/**
 * Plus-address prefix. The full Reply-To looks like
 *   reply+<intent_token>@reply.openagentic.site
 * which the catch-all MX delivers to Resend, which posts the verbatim
 * `to` array to our webhook.
 */
const REPLY_LOCAL_PREFIX = "reply+";

// ── Svix signature verification ─────────────────────────────────────────────

/**
 * Verify a Resend (Svix) webhook signature.
 *
 * Svix signing scheme:
 *   payload  = `${msg_id}.${timestamp}.${rawBody}`
 *   sig      = base64(HMAC-SHA256(payload, decodedSecret))
 *   header   = "v1,<sig>  v1,<sig2>  ..."   (space-separated; rotation)
 *   secret   = "whsec_<base64>"            (the `whsec_` prefix is stripped)
 *
 * Constant-time compare. Returns false on any malformed input — the route
 * handler turns that into a 401 unconditionally.
 *
 * Replay-window enforcement (Svix default ±5 minutes) is deliberately
 * left out for v338 — Resend's clock + our Cloudflare Worker clock are
 * both NTP-synced and the upstream Resend retry policy doesn't replay
 * outside that window in practice. Easy to add later if we observe
 * suspicious patterns.
 */
export function verifyResendWebhook(input: {
  msgId: string | null;
  timestamp: string | null;
  signature: string | null;
  rawBody: string;
  secret: string;
}): boolean {
  const { msgId, timestamp, signature, rawBody, secret } = input;
  if (!msgId || !timestamp || !signature || !secret) return false;

  const secretBody = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  let secretBytes: Buffer;
  try {
    secretBytes = Buffer.from(secretBody, "base64");
  } catch {
    return false;
  }
  if (secretBytes.length === 0) return false;

  const signedPayload = `${msgId}.${timestamp}.${rawBody}`;
  const expected = crypto
    .createHmac("sha256", secretBytes)
    .update(signedPayload)
    .digest("base64");
  const expectedBuf = Buffer.from(expected);

  // The header can carry multiple "v1,<sig>" tokens (key rotation window).
  // Accept if ANY matches.
  for (const token of signature.split(/\s+/)) {
    const [version, sig] = token.split(",");
    if (version !== "v1" || !sig) continue;
    const candidateBuf = Buffer.from(sig);
    if (candidateBuf.length !== expectedBuf.length) continue;
    if (crypto.timingSafeEqual(candidateBuf, expectedBuf)) return true;
  }
  return false;
}

// ── Plus-address parsing ────────────────────────────────────────────────────

/**
 * Extract the intent_token from the inbound `to[]` field.
 *
 * Accepts the verbatim Resend webhook `to` array (each entry is a bare
 * email address, no display name). Returns the first token found, or
 * null if none matches the reply+<token>@<REPLY_DOMAIN> pattern.
 *
 * Case-insensitive on the domain; tokens are mixed-case base64url so
 * we preserve their casing.
 */
export function parseReplyToToken(toAddrs: string[]): string | null {
  const domain = REPLY_DOMAIN.toLowerCase();
  for (const raw of toAddrs ?? []) {
    const addr = String(raw).trim().toLowerCase();
    if (!addr.includes("@")) continue;
    const [local, host] = addr.split("@", 2);
    if (host !== domain) continue;
    if (!local.startsWith(REPLY_LOCAL_PREFIX)) continue;
    // Pull the original-case token out of the original (un-lowercased) addr.
    const originalLocal = String(raw).trim().split("@", 1)[0];
    const tokenPart = originalLocal.slice(REPLY_LOCAL_PREFIX.length);
    if (tokenPart.length === 0) continue;
    return tokenPart;
  }
  return null;
}

// ── Received Emails API ─────────────────────────────────────────────────────

/**
 * Shape returned by GET /emails/receiving/{id}. We pick out the fields
 * the inbound handler actually uses; Resend may add more later
 * (forward-compatibility via the catch-all index signature on headers).
 */
export type ReceivedEmail = {
  id: string;
  from: string;
  to: string[];
  subject: string | null;
  text: string | null;
  html: string | null;
  message_id: string | null;
  headers: Record<string, string>;
  created_at: string;
};

/**
 * Fetch the full received email body + headers.
 *
 * Resend's webhook delivers metadata only; we must call this endpoint
 * (Bearer auth with the same RESEND_API_KEY we send with) to get text,
 * html, and the headers map. The handler is responsible for catching
 * non-2xx responses — we throw a descriptive error so the webhook
 * returns 500 and Resend retries.
 */
export async function fetchReceivedEmail(
  emailId: string,
  apiKey: string,
): Promise<ReceivedEmail> {
  const res = await fetch(`${RESEND_API_BASE}/emails/receiving/${emailId}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `Resend received-email fetch failed (${res.status}): ${errText.slice(0, 400)}`,
    );
  }
  const body = (await res.json()) as Partial<ReceivedEmail> & {
    headers?: Record<string, string> | null;
  };
  return {
    id: body.id ?? emailId,
    from: body.from ?? "",
    to: Array.isArray(body.to) ? body.to : [],
    subject: body.subject ?? null,
    text: body.text ?? null,
    html: body.html ?? null,
    message_id: body.message_id ?? null,
    headers: body.headers ?? {},
    created_at: body.created_at ?? new Date().toISOString(),
  };
}

// ── In-Reply-To normalization ───────────────────────────────────────────────

/**
 * Pull a Message-ID-shaped string out of an In-Reply-To header value.
 * In-Reply-To is typically wrapped in angle brackets: "<abc@host>". We
 * also see comma-separated lists in the wild — take the first.
 */
export function normalizeInReplyTo(value: string | null | undefined): string | null {
  if (!value) return null;
  const first = value.split(",")[0]?.trim();
  if (!first) return null;
  const match = first.match(/<([^>]+)>/);
  if (match && match[1]) return match[1];
  return first;
}

// ── Webhook envelope ────────────────────────────────────────────────────────

/**
 * Subset of the Resend inbound webhook payload we rely on. Resend may
 * include additional fields (attachments[], created_at, etc.) — those
 * pass through the route handler unread.
 */
export type ResendInboundWebhook = {
  type:
    | "email.received"
    | "email.opened"
    | "email.clicked"
    | (string & {});
  created_at?: string;
  data: {
    email_id: string;
    from?: string;
    to?: string[];
    subject?: string | null;
    /** Present on email.clicked events — the URL the recipient clicked. */
    click?: {
      link?: string;
      ipAddress?: string;
      userAgent?: string;
      timestamp?: string;
    };
  };
};

export function isInboundEvent(payload: unknown): payload is ResendInboundWebhook {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  if (typeof p.type !== "string") return false;
  if (!p.data || typeof p.data !== "object") return false;
  const d = p.data as Record<string, unknown>;
  return typeof d.email_id === "string";
}
