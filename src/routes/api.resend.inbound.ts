/**
 * Resend inbound REPLY webhook — /api/resend/inbound (v2.87.0).
 *
 * The catcher for the reply pipeline whose SEND half has been live since
 * v338/v390: every Refill trial-drip + prospect-outreach email goes out with a
 * plus-addressed Reply-To (`reply+<eventId>@<REPLY_DOMAIN>`, built by
 * buildReplyTo), and the engagement rows reserve response_text /
 * response_received_at columns. This route is what was missing — it verifies
 * the inbound webhook, resolves the reply body, and dispatches to the three
 * reply routers in order (Refill drip → Refill outreach → Emma patient); first
 * match wins, unmatched replies are acked + logged (never retried forever).
 *
 * Payload tolerance: Resend's inbound has shipped in two shapes — a
 * metadata-only "email.received" EVENT (body fetched separately via
 * /emails/receiving/{id}) and a full inline envelope (the shape
 * api.resend.inbound-lite.ts already handles). This handler accepts BOTH: it
 * uses the inline body when present and only falls back to fetchReceivedEmail
 * when the event carried metadata only.
 *
 * Signature: enforced when RESEND_INBOUND_SIGNING_SECRET is set (401 on a bad
 * sig); advisory (skipped + logged) until then — the same fail-soft posture as
 * api.resend.inbound-lite.ts and the Acuity webhook receiver.
 *
 * Status codes: 200 on any processed/ignored event so Resend doesn't retry
 * forever; 401 only on an explicit signature failure; 500 only on a transient
 * body-fetch failure (the one case we WANT Resend to retry).
 */

import { createFileRoute } from "@tanstack/react-router";
import {
  verifyResendWebhook,
  parseReplyToToken,
  fetchReceivedEmail,
  normalizeInReplyTo,
  isInboundEvent,
  type ReceivedEmail,
} from "@/server/resend-gateway";
import {
  routeInboundRefillDripReply,
  routeInboundOutreachReply,
} from "@/server/refill-inbox";
import { routeInboundPatientReply } from "@/server/emma-optout.functions";
import { tryPortalEmailImport } from "@/server/portal-import-email";

function jsonResp(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type ReplyEnvelope = {
  /** Resend's id for the inbound message (audit trail). */
  emailId: string;
  /** Verbatim recipient list — carries the plus-addressed reply token. */
  to: string[];
  from: string;
  subject: string | null;
  bodyText: string | null;
  headers: Record<string, string>;
  /** True when the body arrived inline (no separate fetch needed). */
  bodyInline: boolean;
};

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === "string") return [v];
  return [];
}

/**
 * Pull a reply envelope out of EITHER inbound shape: the event shape nests the
 * fields under `data`; the inline shape (or a `{ email: {...} }` wrapper) holds
 * them at the top level. The event shape carries metadata only, so bodyText is
 * null there → the handler fetches it.
 */
function extractEnvelope(payload: unknown): ReplyEnvelope | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const src = (p.data ?? p.email ?? p) as Record<string, unknown>;
  const emailId =
    asString(src.email_id) ?? asString(src.id) ?? asString(src.message_id);
  if (!emailId) return null;
  const headers =
    src.headers && typeof src.headers === "object"
      ? (src.headers as Record<string, string>)
      : {};
  const bodyText = asString(src.text);
  return {
    emailId,
    to: toStringArray(src.to),
    from: asString(src.from) ?? "",
    subject: asString(src.subject),
    bodyText,
    headers,
    bodyInline: bodyText !== null,
  };
}

/** Read a header case-insensitively (Resend may send either casing). */
function header(headers: Record<string, string>, name: string): string | null {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
}

export const Route = createFileRoute("/api/resend/inbound")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let rawBody: string;
        try {
          rawBody = await request.text();
        } catch {
          return jsonResp(200, { ignored: "no_body" });
        }

        // ── Signature: enforce only when a secret is configured (fail-soft).
        const secret = process.env.RESEND_INBOUND_SIGNING_SECRET ?? "";
        if (secret) {
          const ok = verifyResendWebhook({
            msgId: request.headers.get("svix-id"),
            timestamp: request.headers.get("svix-timestamp"),
            signature: request.headers.get("svix-signature"),
            rawBody,
            secret,
          });
          if (!ok) return jsonResp(401, { error: "bad_signature" });
        } else {
          console.warn(
            "[resend-inbound] RESEND_INBOUND_SIGNING_SECRET unset — signature check skipped (advisory)",
          );
        }

        let payload: unknown;
        try {
          payload = JSON.parse(rawBody);
        } catch {
          return jsonResp(200, { ignored: "non_json_body" });
        }

        // When the payload is the typed EVENT shape, drop non-reply events
        // (opens/clicks/bounces still carry an email_id but aren't replies).
        if (isInboundEvent(payload)) {
          const type = (payload as { type: string }).type;
          if (type !== "email.received" && !type.includes("received")) {
            return jsonResp(200, { ignored: `event_${type}` });
          }
        }

        const env = extractEnvelope(payload);
        if (!env) return jsonResp(200, { ignored: "unrecognized_payload" });

        // ── Resolve the body: inline when present, else fetch the full email.
        let msg: ReplyEnvelope = env;
        if (!env.bodyInline) {
          const apiKey = process.env.RESEND_API_KEY ?? "";
          if (!apiKey) {
            console.error("[resend-inbound] RESEND_API_KEY unset — cannot fetch body");
            return jsonResp(500, { error: "no_api_key" });
          }
          let full: ReceivedEmail;
          try {
            full = await fetchReceivedEmail(env.emailId, apiKey);
          } catch (e) {
            console.error("[resend-inbound] body fetch failed:", e);
            // 500 → Resend retries (transient upstream failure).
            return jsonResp(500, { error: "fetch_failed" });
          }
          msg = {
            emailId: full.id,
            to: full.to.length ? full.to : env.to,
            from: full.from || env.from,
            subject: full.subject ?? env.subject,
            bodyText: full.text,
            headers: { ...env.headers, ...full.headers },
            bodyInline: true,
          };
        }

        const token = parseReplyToToken(msg.to);
        const inReplyTo = normalizeInReplyTo(header(msg.headers, "in-reply-to"));

        // ── Dispatch: Refill drip → Refill outreach → Emma patient. First win.
        const drip = await routeInboundRefillDripReply({
          token,
          fromAddr: msg.from,
          subject: msg.subject,
          bodyText: msg.bodyText,
          resendEmailId: msg.emailId,
        });
        if (drip.routed) {
          return jsonResp(200, { routed: "refill_drip", eventId: drip.eventId });
        }

        const outreach = await routeInboundOutreachReply({
          token,
          fromAddr: msg.from,
          subject: msg.subject,
          bodyText: msg.bodyText,
          resendEmailId: msg.emailId,
        });
        if (outreach.routed) {
          return jsonResp(200, { routed: "refill_outreach", eventId: outreach.eventId });
        }

        const patient = await routeInboundPatientReply({
          resendEmailId: msg.emailId,
          fromAddr: msg.from,
          toAddr: msg.to[0] ?? "",
          subject: msg.subject,
          bodyText: msg.bodyText,
          inReplyTo,
        });
        if (patient.routed) {
          return jsonResp(200, {
            routed: "emma_patient",
            action: patient.action,
            patientNodeId: patient.patientNodeId,
          });
        }

        // ── Portal-price screenshot lane: a forwarded manufacturer-portal
        // "Your Price" IMAGE to the rewards drop-address (<token>@rewards.…)
        // → stage a portal-import batch the owner reviews in-app. Runs only
        // after the reply routers miss, and only when the to-address carries a
        // rewards token + an image attachment — so it never collides with a
        // genuine reply. Same drop-address as the CSV rewards lane.
        const portalSrc = ((): Record<string, unknown> => {
          if (!payload || typeof payload !== "object") return {};
          const pp = payload as Record<string, unknown>;
          return (pp.data ?? pp.email ?? pp) as Record<string, unknown>;
        })();
        const portal = await tryPortalEmailImport({
          to: msg.to,
          subject: msg.subject,
          metaAttachments:
            portalSrc.attachments ??
            (payload as Record<string, unknown> | null)?.attachments ??
            [],
          emailId: msg.emailId,
        });
        if (portal.handled) {
          return jsonResp(200, portal.body ?? { lane: "portal_import" });
        }

        console.log(
          "[resend-inbound] no router matched — token:",
          token,
          "inReplyTo:",
          inReplyTo,
          "email:",
          msg.emailId,
        );
        return jsonResp(200, { routed: false, reason: "no_router_matched" });
      },
    },
  },
});
