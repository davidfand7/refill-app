/**
 * Zenoti email-shape parser.
 *
 * Verified facts (per scout 2026-06-03):
 *   - Default sender: noreply@zenoti.com (confirmed in Zenoti docs)
 *   - Enterprise tier can request custom From via SPF; treat that as
 *     a future-fork case (parser additionally checks body markers).
 *   - HTML body with macro-templated structure
 *     (e.g. [GuestFirstName], [ServiceName], [AppointmentDate]).
 *   - Per-event templates exist for confirmation / reminder / check-in /
 *     guest-data-form submission.
 *
 * This parser ships LIVE for v1.42.0 launch. Mindbody / Booker / Jane /
 * Boulevard ship as stubs until pilot tenants on those platforms
 * forward real exemplars (per feedback-validate-against-real-exports).
 *
 * The matchers below are deliberately tolerant on whitespace + casing.
 * Each tightens after the first pilot exemplar lands and confirms
 * exact wording.
 */

import type { ParseInput, ParseResult, ParsedAppointment } from "./index";
import { emailBodyText } from "./index";

const ZENOTI_KNOWN_SENDERS = [
  /noreply@zenoti\.com$/i,
  /no-reply@zenoti\.com$/i,
  /notifications?@zenoti\.com$/i,
];

const SUBJECT_MATCHERS: Array<{
  re: RegExp;
  event: ParseResult["event"];
  baseConfidence: number;
}> = [
  // booking.created (confirmation)
  {
    re: /\b(new\s+appointment|appointment\s+confirmation|booking\s+confirmation|appointment\s+booked|new\s+booking)\b/i,
    event: "booking.created",
    baseConfidence: 0.7,
  },
  // booking.cancelled
  {
    re: /\b(appointment\s+cancell?ed|booking\s+cancell?ed|cancellation\s+notice)\b/i,
    event: "booking.cancelled",
    baseConfidence: 0.78,
  },
  // booking.rescheduled
  {
    re: /\b(appointment\s+rescheduled|booking\s+rescheduled|appointment\s+(?:date|time)\s+changed)\b/i,
    event: "booking.rescheduled",
    baseConfidence: 0.75,
  },
  // booking.no_show
  {
    re: /\b(no[-\s]?show|missed\s+appointment|did\s+not\s+show)\b/i,
    event: "booking.no_show",
    baseConfidence: 0.74,
  },
  // client.created (guest data form submission)
  {
    re: /\b(new\s+guest|new\s+client|guest\s+(?:registered|created)|client\s+registered)\b/i,
    event: "client.created",
    baseConfidence: 0.6,
  },
];

// Field-extraction matchers. Tolerant — Zenoti's macro substitution
// produces predictable label/value pairs across templates.
function extractFromBody(body: string): ParsedAppointment {
  const appt: ParsedAppointment = {};

  // "Guest: <name>" / "Client: <name>" / "Customer: <name>"
  const nameMatch =
    body.match(/(?:guest|client|customer|patient)\s*(?:name)?\s*[:\-]\s*([^\n<]+)/i);
  if (nameMatch) appt.patientName = nameMatch[1].trim().slice(0, 120);

  // "Phone: <digits>"
  const phoneMatch = body.match(/(?:phone|mobile|cell)\s*[:\-]\s*([+()0-9.\-\s]{7,})/i);
  if (phoneMatch) appt.patientPhone = phoneMatch[1].trim().slice(0, 32);

  // "Email: foo@bar.com"
  const emailMatch = body.match(
    /(?:email|e-?mail)\s*[:\-]\s*([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})/i,
  );
  if (emailMatch) appt.patientEmail = emailMatch[1].trim();

  // "Service: <name>"
  const serviceMatch = body.match(/(?:service|treatment)\s*[:\-]\s*([^\n<]+)/i);
  if (serviceMatch) appt.serviceName = serviceMatch[1].trim().slice(0, 120);

  // "Provider: <name>" / "Therapist: <name>" / "Staff: <name>"
  const staffMatch = body.match(/(?:provider|therapist|staff|specialist)\s*[:\-]\s*([^\n<]+)/i);
  if (staffMatch) appt.staffName = staffMatch[1].trim().slice(0, 120);

  // "Date: <date>" + "Time: <time>" or "Appointment Date: ..." or
  // a combined "When: <date> at <time>"
  const whenMatch = body.match(
    /(?:appointment\s+date|date(?:\s+&\s+time)?|when)\s*[:\-]\s*([^\n<]+)/i,
  );
  if (whenMatch) {
    const iso = parseDateTimeBest(whenMatch[1]);
    if (iso) appt.startAt = iso;
  }

  // Center / location
  const locMatch = body.match(/(?:center|location|branch)\s*[:\-]\s*([^\n<]+)/i);
  if (locMatch) appt.locationName = locMatch[1].trim().slice(0, 120);

  // External ID (Zenoti "Appointment ID: <uuid>" or "Booking ID")
  const idMatch = body.match(/(?:appointment\s+id|booking\s+id|guest\s+id)\s*[:\-]\s*([A-Za-z0-9-]+)/i);
  if (idMatch) appt.externalId = idMatch[1].trim().slice(0, 64);

  return appt;
}

function parseDateTimeBest(raw: string): string | undefined {
  const cleaned = raw.trim().slice(0, 80);
  if (!cleaned) return undefined;
  const t = Date.parse(cleaned);
  if (!Number.isNaN(t)) return new Date(t).toISOString();
  // Try common Zenoti template renderings: "Jun 5, 2026 at 3:00 PM"
  const norm = cleaned.replace(/\s+at\s+/i, " ").replace(/,/g, "");
  const t2 = Date.parse(norm);
  if (!Number.isNaN(t2)) return new Date(t2).toISOString();
  return undefined;
}

function senderIsZenoti(input: ParseInput): boolean {
  const from = (input.fromAddress || "").toLowerCase();
  return ZENOTI_KNOWN_SENDERS.some((re) => re.test(from));
}

function bodyMentionsZenoti(input: ParseInput): boolean {
  const body = emailBodyText(input).toLowerCase();
  return body.includes("zenoti") || body.includes("powered by zenoti");
}

export function parseZenotiEmail(input: ParseInput): ParseResult {
  // Sender gate (primary) OR body marker (Enterprise custom-From fallback).
  const senderOk = senderIsZenoti(input);
  const bodyOk = bodyMentionsZenoti(input);
  if (!senderOk && !bodyOk) {
    return {
      event: "unknown",
      appointments: [],
      confidence: 0,
      quarantineReason: "zenoti_sender_and_body_no_match",
    };
  }

  const subject = (input.subject || "").trim();
  const body = emailBodyText(input);

  const matcher = SUBJECT_MATCHERS.find((m) => m.re.test(subject)) ??
    SUBJECT_MATCHERS.find((m) => m.re.test(body));

  if (!matcher) {
    return {
      event: "unknown",
      appointments: [],
      confidence: senderOk ? 0.3 : 0.1,
      quarantineReason: "zenoti_event_type_no_match",
    };
  }

  const appt = extractFromBody(body);
  const filledFields = (Object.keys(appt) as Array<keyof ParsedAppointment>)
    .filter((k) => appt[k] !== undefined).length;

  // Bonus confidence per field successfully extracted; cap at 0.95.
  const confidence = Math.min(
    matcher.baseConfidence + filledFields * 0.03,
    0.95,
  );

  return {
    event: matcher.event,
    appointments: filledFields > 0 ? [appt] : [],
    confidence,
  };
}
