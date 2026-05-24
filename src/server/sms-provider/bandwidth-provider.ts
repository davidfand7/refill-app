/**
 * Bandwidth implementation of the SmsProvider interface (v376 scaffold).
 *
 * SCAFFOLD ONLY — not yet exercised in production. The real implementation
 * lands at SMS-hosting cutover (after Karen's Rejuv number ports via
 * Bandwidth, ETA weeks-not-days from 2026-05-18). What's here is the
 * shape; the bodies are honest stubs that throw with actionable error
 * messages so any accidental flip to SMS_PROVIDER=bandwidth before
 * porting is loud, not silent.
 *
 * Cutover checklist (deferred to its own ship):
 *   1. Bandwidth account credentials provisioned (BANDWIDTH_ACCOUNT_ID,
 *      BANDWIDTH_USERNAME, BANDWIDTH_PASSWORD, BANDWIDTH_APPLICATION_ID).
 *   2. sendSms: POST https://messaging.bandwidth.com/api/v2/users/{accountId}/messages
 *      with Basic auth. Body shape: {applicationId, to: [string], from, text}.
 *      Returns {id, owner, applicationId, ...} — `id` is the messageId.
 *   3. verifyInboundSignature: Bandwidth uses Basic auth on the webhook
 *      itself (BANDWIDTH_WEBHOOK_USERNAME + BANDWIDTH_WEBHOOK_PASSWORD).
 *      Decode the Authorization header, constant-time compare.
 *   4. parseInbound: Bandwidth POSTs a JSON ARRAY of events. Each event
 *      has {type: 'message-received'|'message-delivered'|..., message: {...}}.
 *      Caller must JSON-parse the body before calling this method, then
 *      flatten the first 'message-received' event's fields into the
 *      params dict. Other event types return null.
 *   5. Add /api/bandwidth/inbound route that mirrors api.twilio.inbound.ts
 *      structure but uses request.json() + this provider.
 *
 * Until then: SMS_PROVIDER stays unset (or 'twilio') and this class is
 * dead code that exists only to make the factory pattern legible and
 * make the v376 PR easy to read.
 */
import type {
  InboundMessage,
  SendSmsInput,
  SendSmsResult,
  SmsProvider,
  VerifySignatureInput,
} from "@/server/sms-provider/types";

const NOT_WIRED = (op: string) =>
  new Error(
    `Bandwidth ${op} is not wired yet. SMS_PROVIDER=bandwidth was set but ` +
      `the BandwidthProvider implementation is a v376 scaffold. Cutover ` +
      `requires (1) Bandwidth account + 10DLC + number port complete, ` +
      `(2) BANDWIDTH_* env vars set on the Worker, (3) this class's ` +
      `methods implemented per the file header checklist.`,
  );

export class BandwidthProvider implements SmsProvider {
  readonly name = "bandwidth" as const;

  async sendSms(_input: SendSmsInput): Promise<SendSmsResult> {
    throw NOT_WIRED("sendSms");
  }

  verifyInboundSignature(_input: VerifySignatureInput): boolean {
    return false;
  }

  parseInbound(_params: Record<string, string>): InboundMessage | null {
    return null;
  }
}
