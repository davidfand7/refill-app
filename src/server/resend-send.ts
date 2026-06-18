/**
 * resend-send.ts — the single Resend HTTP POST seam (v2.85.0).
 *
 * Three senders (refill-drip cron, refill-outreach-send, scheduling-email) each
 * hand-rolled the SAME fetch to https://api.resend.com/emails: same auth header,
 * same JSON body shape, same `!resp.ok` → status+body-snippet handling, same
 * `id` read on success. This collapses just that HTTP layer into one place.
 *
 * What it deliberately does NOT unify (these genuinely differ per caller and
 * must stay where they are):
 *   - throw-vs-return on failure (outreach throws; drip/scheduling return),
 *   - the exact error-string format + slice length each caller emits,
 *   - the engagement-event insert and ITS ordering vs the send,
 *   - the missing-API-key pre-check (each caller owns its own message).
 *
 * Contract (behavior-preserving):
 *   - Returns a STRUCTURED result for any HTTP-level outcome (2xx or !ok) — it
 *     never throws on an HTTP error, so the caller decides throw vs return.
 *   - RE-THROWS a network/transport error (fetch reject, AbortSignal timeout)
 *     so a caller's existing try/catch (drip, scheduling) or bare propagation
 *     (outreach) keeps behaving exactly as before.
 *   - On success, parses the JSON body for Resend's message id (null if absent),
 *     matching the drip/outreach readers; scheduling simply ignores it.
 *   - Returns the raw `status` + un-sliced `body` so each caller formats its own
 *     error string at its own slice length.
 */

export type ResendTag = { name: string; value: string };

/** Open/click tracking toggle (Resend's `tracking` field). */
export type ResendTracking = { opens?: boolean; clicks?: boolean };

/** A file attachment (Resend's `attachments` field); `content` is base64. */
export type ResendAttachment = { filename: string; content: string };

export type ResendSendResult =
  | { ok: true; id: string | null }
  | { ok: false; status: number; body: string };

export async function postResendEmail(args: {
  apiKey: string;
  from: string;
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  /** Maps to Resend's `reply_to` field; omitted when undefined. */
  replyTo?: string;
  tags?: ResendTag[];
  /** Resend open/click tracking; omitted when undefined. */
  tracking?: ResendTracking;
  /** Resend file attachments; omitted when undefined. */
  attachments?: ResendAttachment[];
  signal?: AbortSignal;
}): Promise<ResendSendResult> {
  // Only include keys a caller actually set — preserves each sender's exact
  // request body (e.g. scheduling sends no `text`/`reply_to`; outreach no `text`).
  const body: Record<string, unknown> = {
    from: args.from,
    to: args.to,
    subject: args.subject,
  };
  if (args.html !== undefined) body.html = args.html;
  if (args.text !== undefined) body.text = args.text;
  if (args.replyTo !== undefined) body.reply_to = args.replyTo;
  if (args.tags !== undefined) body.tags = args.tags;
  if (args.tracking !== undefined) body.tracking = args.tracking;
  if (args.attachments !== undefined) body.attachments = args.attachments;

  // No try/catch: a transport error rejects and propagates to the caller,
  // matching the pre-extraction behavior of all three senders.
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    ...(args.signal ? { signal: args.signal } : {}),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    return { ok: false, status: resp.status, body: text };
  }
  const json = (await resp.json().catch(() => ({}))) as { id?: string };
  return { ok: true, id: json.id ?? null };
}
