/**
 * Provider-agnostic SMS interface (v376).
 *
 * Lets the codebase swap between Twilio (current default) and Bandwidth
 * (cutover target — pending Karen-Rejuv number porting) by flipping a
 * single env flag. Everything Twilio-specific lives in twilio-provider.ts;
 * Bandwidth lives in bandwidth-provider.ts. Callers should ONLY import
 * from `sms-provider/index.ts` (the factory) — never reach past it.
 *
 * The cutover path: set SMS_PROVIDER=bandwidth on the Worker, deploy.
 * No caller-side changes. That's the whole point of v376.
 */
export type SmsProviderName = "twilio" | "bandwidth";

export type SendSmsInput = {
  from: string;
  to: string;
  body: string;
};

export type SendSmsResult = {
  /** Provider-neutral message identifier. For Twilio this is the SID; for
   *  Bandwidth this is the messageId from their JSON response. Stored in
   *  the DB column `message_id` on rescue/blast/preshow rows. */
  messageId: string;
};

export type InboundMessage = {
  from: string;
  to: string;
  body: string;
  providerMessageId: string | null;
};

export type VerifySignatureInput = {
  /** The exact URL the provider POSTed to — including scheme, host, path,
   *  query. On Cloudflare Workers `request.url` preserves this. */
  fullUrl: string;
  /** Parsed form params (Twilio) or empty (Bandwidth uses JSON + headers).
   *  Providers that don't need this MUST tolerate `{}`. */
  params: Record<string, string>;
  /** The provider-specific signature header value, or null if absent. */
  signatureHeader: string | null;
  /** Raw request body string — Bandwidth signs the body, Twilio doesn't
   *  need it. Providers MUST tolerate `null`. */
  rawBody: string | null;
};

export interface SmsProvider {
  readonly name: SmsProviderName;

  /** Send an outbound SMS. Throws on hard failure (network, auth, carrier
   *  refusal). Caller is responsible for catching + stamping send_error
   *  columns. */
  sendSms(input: SendSmsInput): Promise<SendSmsResult>;

  /** Verify the inbound webhook signature. Constant-time compare. Returns
   *  false on any missing/invalid input — never throws (so the route
   *  handler can reply 403 cleanly). */
  verifyInboundSignature(input: VerifySignatureInput): boolean;

  /** Normalize the provider-shape webhook into the canonical InboundMessage.
   *  Twilio: form params with From/To/Body/MessageSid. Bandwidth: parsed
   *  JSON event array (caller passes the first event's fields in via
   *  params). Returns null when the shape doesn't match a deliverable
   *  inbound SMS (e.g. Bandwidth status callbacks, opt-out events). */
  parseInbound(params: Record<string, string>): InboundMessage | null;
}
