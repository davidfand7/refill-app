/**
 * POST /api/twilio/inbound — Twilio webhook for inbound SMS.
 *
 * Phase 3.5.3 entry point. When a customer texts the spa's number, Twilio
 * POSTs us this handler with x-www-form-urlencoded fields (From, To,
 * Body, MessageSid, AccountSid, ...). We verify X-Twilio-Signature,
 * hand off to handleInbound, and return empty TwiML 200 — Twilio
 * doesn't need to send the reply itself because the gateway already
 * fired it via the Messages REST API.
 *
 * Auth: HMAC-SHA1 signature header (X-Twilio-Signature) against
 * TWILIO_AUTH_TOKEN. Reject 403 on missing or invalid signature —
 * strict from day 1 (Q6 lock).
 *
 * v376: signature verification routes through the SMS provider abstraction
 * so the same route shape can be ported to /api/bandwidth/inbound at
 * cutover (or this route can be reused if Bandwidth posts to the same
 * URL via a webhook config — TBD at cutover).
 */

import { createFileRoute } from "@tanstack/react-router";
import { handleInbound } from "@/server/twilio-gateway";
import { getSmsProvider } from "@/server/sms-provider";

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response/>';

function twiml(status: number, body: string = EMPTY_TWIML) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}

function plain(status: number, body: string) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

export const Route = createFileRoute("/api/twilio/inbound")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // Read raw form body (Twilio sends x-www-form-urlencoded).
        let bodyText: string;
        try {
          bodyText = await request.text();
        } catch {
          return plain(400, "Couldn't read body.");
        }
        const params: Record<string, string> = {};
        for (const [k, v] of new URLSearchParams(bodyText).entries()) {
          params[k] = v;
        }

        const provider = getSmsProvider();
        const signature = request.headers.get("x-twilio-signature");
        const ok = provider.verifyInboundSignature({
          fullUrl: request.url,
          params,
          signatureHeader: signature,
          rawBody: bodyText,
        });
        if (!ok) {
          return plain(403, "Invalid SMS provider signature.");
        }

        const result = await handleInbound(params);
        if (!result.ok) {
          return plain(result.status, result.reason);
        }
        // Empty TwiML 200 even when not routed — we don't want Twilio to
        // retry on a "wrong number" misroute (which would just keep failing).
        return twiml(200);
      },
    },
  },
});
