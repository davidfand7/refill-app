/**
 * Twilio implementation of the SmsProvider interface (v376).
 *
 * This is the current production path. Logic was moved out of the
 * monolithic twilio-gateway.ts so a parallel BandwidthProvider can drop
 * in behind the SMS_PROVIDER env flag. twilio-gateway.ts keeps the Karen
 * orchestration (handleInbound, dispatchSmsResolution, opt-out keyword
 * routing) and now imports send/verify primitives from here.
 *
 * No behavioral change versus v375 when SMS_PROVIDER=twilio (the default).
 */
import crypto from "node:crypto";
import type {
  InboundMessage,
  SendSmsInput,
  SendSmsResult,
  SmsProvider,
  VerifySignatureInput,
} from "@/server/sms-provider/types";

const TWILIO_API = "https://api.twilio.com/2010-04-01";

function twilioCreds(): { accountSid: string; authToken: string } {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    throw new Error(
      "Twilio is not configured — missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN.",
    );
  }
  return { accountSid, authToken };
}

export class TwilioProvider implements SmsProvider {
  readonly name = "twilio" as const;

  async sendSms(input: SendSmsInput): Promise<SendSmsResult> {
    const { accountSid, authToken } = twilioCreds();
    const url = `${TWILIO_API}/Accounts/${accountSid}/Messages.json`;
    const formBody = new URLSearchParams({
      From: input.from,
      To: input.to,
      Body: input.body,
    });
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(`${accountSid}:${authToken}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formBody,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(
        `Twilio send failed (${res.status}): ${errText.slice(0, 400)}`,
      );
    }
    const data = (await res.json()) as { sid?: string };
    if (!data.sid) {
      throw new Error("Twilio send returned no SID.");
    }
    return { messageId: data.sid };
  }

  /**
   * HMAC-SHA1 over: <full_url> + <sorted_param_concat>
   * where param_concat is each form param as `${key}${value}` joined.
   * Base64-encoded. Constant-time compare.
   */
  verifyInboundSignature(input: VerifySignatureInput): boolean {
    if (!input.signatureHeader) return false;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (!authToken) return false;
    const sortedKeys = Object.keys(input.params).sort();
    const data = sortedKeys.reduce(
      (acc, k) => acc + k + input.params[k],
      input.fullUrl,
    );
    const computed = crypto
      .createHmac("sha1", authToken)
      .update(data)
      .digest("base64");
    const a = Buffer.from(computed);
    const b = Buffer.from(input.signatureHeader);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  parseInbound(params: Record<string, string>): InboundMessage | null {
    const from = (params.From ?? "").trim();
    const to = (params.To ?? "").trim();
    const body = (params.Body ?? "").trim();
    if (!from || !to || !body) return null;
    return {
      from,
      to,
      body,
      providerMessageId: params.MessageSid ?? null,
    };
  }
}
