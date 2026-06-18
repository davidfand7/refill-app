/**
 * Smart Scheduling — transactional email (v1.48.x).
 *
 * One reusable best-effort sender for booking confirmation + reminder emails,
 * built on the existing Resend rails + the shared refill-drip-shell template so
 * it matches Refill's transactional look. Best-effort: a send failure is logged
 * and returned, never thrown — a booking must never fail because email did.
 *
 * From-line uses the spa's display name over the verified platform address
 * (same trick as buildRepFrom in refill-outreach-send.ts), so the patient sees
 * "Rejuv Skin Spa <karen@getrefill.app>".
 */

import {
  wrapDripEmail,
  type DripEmailBrand,
} from "@/lib/email-templates/refill-drip-shell";
import { postResendEmail } from "@/server/resend-send";

/** Bare address from "Name <addr>" (or the string itself if already bare). */
function bareAddress(fromLine: string): string {
  const m = fromLine.match(/<([^>]+)>/);
  return (m ? m[1] : fromLine).trim();
}

function fromForSpa(spaName: string): string {
  const base = process.env.REFILL_OUTREACH_FROM ?? "Karen Anderson <karen@getrefill.app>";
  const addr = bareAddress(base) || "karen@getrefill.app";
  // Strip characters that would break the display-name portion of the header.
  const safeName = spaName.replace(/[<>"\r\n]/g, "").trim() || "Your appointment";
  return `${safeName} <${addr}>`;
}

function fmtDate(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date(iso));
}

function fmtTime(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(iso));
}

async function sendViaResend(args: {
  from: string;
  to: string;
  subject: string;
  html: string;
}): Promise<{ ok: boolean; error?: string }> {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) return { ok: false, error: "RESEND_API_KEY not configured" };
  try {
    const r = await postResendEmail({
      apiKey: RESEND_API_KEY,
      from: args.from,
      to: args.to,
      subject: args.subject,
      html: args.html,
      tags: [
        { name: "product", value: "refill" },
        { name: "stream", value: "scheduling" },
      ],
    });
    if (!r.ok) {
      return { ok: false, error: `Resend ${r.status}: ${r.body.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "send failed" };
  }
}

export interface BookingEmailArgs {
  to: string;
  spaName: string;
  startIso: string;
  timezone: string;
  /** Booked service name (snapshot). When absent, the email falls back to
   *  the generic single-line copy (back-compatible with older callers). */
  serviceName?: string;
  /** Provider display name, if the booking is tied to one. */
  providerName?: string | null;
  /** Combined visit duration in minutes (base + chosen add-ons). */
  durationMin?: number;
  /** Chosen add-ons, snapshotted at booking. Prices intentionally omitted. */
  addOns?: { name: string; durationMin: number }[];
  /** v2.69.0 — per-spa white-label brand (project_your_brand_white_label).
   * When the spa is entitled + active, the from-name + email chrome + footer
   * become the spa's; omitted/SmartSpa otherwise. The patient-facing display
   * name (from-line, body, sign-off) prefers brand.name over spaName. */
  brand?: DripEmailBrand;
}

/**
 * Itemized detail paragraphs (service · provider · total duration, then a
 * comma-joined add-ons line). Returns [] when no serviceName is supplied so
 * callers cleanly degrade to the generic copy. No prices by product decision.
 */
function appointmentDetailParagraphs(args: BookingEmailArgs): string[] {
  if (!args.serviceName) return [];
  const out: string[] = [];
  const withProv = args.providerName ? ` with ${args.providerName}` : "";
  const dur = args.durationMin ? ` · ${args.durationMin} min total` : "";
  out.push(`**${args.serviceName}**${withProv}${dur}`);
  if (args.addOns && args.addOns.length) {
    const list = args.addOns
      .map((a) => `${a.name}${a.durationMin ? ` (+${a.durationMin} min)` : ""}`)
      .join(", ");
    out.push(`Add-ons: ${list}`);
  }
  return out;
}

/** Patient-facing booking confirmation. Best-effort. */
export async function sendBookingConfirmation(
  args: BookingEmailArgs,
): Promise<{ ok: boolean; error?: string }> {
  const { to, spaName, startIso, timezone } = args;
  // Patient-facing name prefers the white-label brand over the tenant name.
  const displayName = args.brand?.name?.trim() || spaName;
  const rendered = wrapDripEmail({
    subject: `Your appointment at ${displayName} is confirmed`,
    headline: "You're booked!",
    brand: args.brand,
    bodyParagraphs: [
      `Your appointment with **${displayName}** is confirmed for **${fmtDate(
        startIso,
        timezone,
      )}** at **${fmtTime(startIso, timezone)}**.`,
      ...appointmentDetailParagraphs(args),
      "Need to make a change? Just reply to this email and we'll help.",
    ],
    signoff: `— ${displayName}`,
  });
  const r = await sendViaResend({
    from: fromForSpa(displayName),
    to,
    subject: rendered.subject,
    html: rendered.html,
  });
  if (!r.ok) console.error("[scheduling-email] confirmation send failed:", r.error);
  return r;
}

/** Patient-facing appointment reminder. Best-effort. */
export async function sendBookingReminder(
  args: BookingEmailArgs,
): Promise<{ ok: boolean; error?: string }> {
  const { to, spaName, startIso, timezone } = args;
  const displayName = args.brand?.name?.trim() || spaName;
  const rendered = wrapDripEmail({
    subject: `Reminder: your appointment at ${displayName}`,
    headline: "See you soon!",
    brand: args.brand,
    bodyParagraphs: [
      `This is a friendly reminder of your appointment with **${displayName}** on **${fmtDate(
        startIso,
        timezone,
      )}** at **${fmtTime(startIso, timezone)}**.`,
      ...appointmentDetailParagraphs(args),
      "Need to reschedule? Just reply to this email.",
    ],
    signoff: `— ${displayName}`,
  });
  const r = await sendViaResend({
    from: fromForSpa(displayName),
    to,
    subject: rendered.subject,
    html: rendered.html,
  });
  if (!r.ok) console.error("[scheduling-email] reminder send failed:", r.error);
  return r;
}
