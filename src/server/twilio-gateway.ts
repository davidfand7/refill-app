/**
 * Cleave stub — twilio-gateway placeholder.
 *
 * The openagenticv4 version was Karen-vertical-specific (imported
 * KAREN_SYSTEM_PROMPT + sms-conversations table). Refill's proxy
 * delivery channel doesn't use Twilio inbound at all (spa owners
 * reply via their own iMessage), so the api.twilio.inbound route
 * is non-load-bearing in Phase 1.
 *
 * When the first direct-channel tenant ports a number, we'll either:
 *   - re-implement handleInbound() here against Refill-native shape
 *   - or rip out the api.twilio.inbound route entirely
 *
 * Until then, log + return success so the webhook (if Twilio ever
 * hits it) doesn't 500.
 */

export async function handleInbound(_req: Request): Promise<Response> {
  console.warn("[twilio-gateway] inbound webhook received but not handled — refill-app proxy mode doesn't process Twilio inbound");
  return new Response("OK", { status: 200 });
}
