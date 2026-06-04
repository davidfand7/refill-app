/**
 * Light Mode email-parser dispatch + shared types.
 *
 * Each platform (zenoti.ts / jane.ts / boulevard.ts / mindbody.ts /
 * booker.ts) exports a single `parse<Platform>Email(input)` function
 * that returns a ParseResult. This module dispatches to the right
 * platform based on the Light Mode connection's `platform` field and
 * normalizes the result for the trigger graph (`emma-rescue` +
 * `emma-recognition`).
 *
 * Per the platforms-pre-built doctrine: Zenoti ships with a real
 * parser (its sender is confirmed-stable as `noreply@zenoti.com`).
 * The other four ship as scaffolds returning `unknown` until a pilot
 * tenant on that platform forwards real exemplars and the parser is
 * tuned per feedback-validate-against-real-exports.
 */

import { parseZenotiEmail } from "./zenoti";
import { parseJaneEmail } from "./jane";
import { parseBoulevardEmail } from "./boulevard";
import { parseMindbodyEmail } from "./mindbody";
import { parseBookerEmail } from "./booker";

export type LightModePlatform =
  | "zenoti"
  | "jane"
  | "boulevard"
  | "mindbody"
  | "booker";

export type ParsedEventType =
  | "booking.created"
  | "booking.cancelled"
  | "booking.rescheduled"
  | "booking.no_show"
  | "client.created"
  | "unknown";

export interface ParsedAppointment {
  /** Vendor-side stable ID if present in the email. Otherwise undefined. */
  externalId?: string;
  patientName?: string;
  patientPhone?: string;
  patientEmail?: string;
  serviceName?: string;
  staffName?: string;
  startAt?: string; // ISO 8601
  endAt?: string;   // ISO 8601
  locationName?: string;
}

export interface ParseInput {
  fromAddress: string;
  toAddress: string;
  subject: string;
  rawHtml: string | null;
  rawText: string | null;
  messageId: string | null;
}

export interface ParseResult {
  event: ParsedEventType;
  /** Multiple appointments per email (Jane batches up to N per ~3-min window). */
  appointments: ParsedAppointment[];
  /** 0..1 confidence the parser assigns to the event-type classification. */
  confidence: number;
  /** If unparseable: a short tag for the quarantine row's `reason` column. */
  quarantineReason?: string;
}

const DISPATCH: Record<
  LightModePlatform,
  (input: ParseInput) => ParseResult
> = {
  zenoti: parseZenotiEmail,
  jane: parseJaneEmail,
  boulevard: parseBoulevardEmail,
  mindbody: parseMindbodyEmail,
  booker: parseBookerEmail,
};

/**
 * Dispatch + parse. Returns ParseResult.event === "unknown" if the
 * platform parser cannot classify; the caller (api.resend.inbound-lite
 * handler) quarantines.
 */
export function parseLightModeEmail(
  platform: LightModePlatform,
  input: ParseInput,
): ParseResult {
  const parser = DISPATCH[platform];
  if (!parser) {
    return {
      event: "unknown",
      appointments: [],
      confidence: 0,
      quarantineReason: "platform_not_dispatchable",
    };
  }
  try {
    return parser(input);
  } catch (err) {
    return {
      event: "unknown",
      appointments: [],
      confidence: 0,
      quarantineReason: `parser_threw:${
        err instanceof Error ? err.message.slice(0, 80) : "unknown"
      }`,
    };
  }
}

/**
 * Helper: strip HTML tags + collapse whitespace. Most parsers need a
 * plain-text view of the email body to apply regex matchers.
 */
export function stripHtml(html: string | null): string {
  if (!html) return "";
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/gi, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Helper: prefer plain text if present, else strip HTML.
 */
export function emailBodyText(input: ParseInput): string {
  if (input.rawText && input.rawText.trim().length > 0) {
    return input.rawText;
  }
  return stripHtml(input.rawHtml);
}
