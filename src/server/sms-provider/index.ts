/**
 * SMS provider factory (v376).
 *
 * Single entry point for every caller that needs to send/verify/parse SMS.
 * Reads SMS_PROVIDER env (default 'twilio') and returns the appropriate
 * implementation. Cached per-worker-instance — providers are stateless
 * but allocating them on every call is wasteful.
 *
 * To cut over to Bandwidth post-porting: set SMS_PROVIDER=bandwidth on
 * the Worker via `wrangler secret put` (or the CF dashboard). No code
 * change needed in callers — that's the whole v376 design.
 */
import { BandwidthProvider } from "@/server/sms-provider/bandwidth-provider";
import type { SmsProvider, SmsProviderName } from "@/server/sms-provider/types";
import { TwilioProvider } from "@/server/sms-provider/twilio-provider";

export type { InboundMessage, SendSmsInput, SendSmsResult, SmsProvider, SmsProviderName } from "@/server/sms-provider/types";

let cached: SmsProvider | null = null;
let cachedFor: SmsProviderName | null = null;

function resolveProviderName(): SmsProviderName {
  const raw = (process.env.SMS_PROVIDER ?? "twilio").trim().toLowerCase();
  if (raw === "bandwidth") return "bandwidth";
  return "twilio";
}

export function getSmsProvider(): SmsProvider {
  const want = resolveProviderName();
  if (cached && cachedFor === want) return cached;
  cached = want === "bandwidth" ? new BandwidthProvider() : new TwilioProvider();
  cachedFor = want;
  return cached;
}

/** Convenience wrapper — most outbound callers just want sendSms. */
export async function sendSms(
  input: { from: string; to: string; body: string },
): Promise<{ messageId: string }> {
  return getSmsProvider().sendSms(input);
}
