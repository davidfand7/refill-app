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

import { wrapDripEmail } from "@/lib/email-templates/refill-drip-shell";

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
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: args.from,
        to: args.to,
        subject: args.subject,
        html: args.html,
        tags: [
          { name: "product", value: "refill" },
          { name: "stream", value: "scheduling" },
        ],
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return { ok: false, error: `Resend ${resp.status}: ${body.slice(0, 200)}` };
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
}

/** Patient-facing booking confirmation. Best-effort. */
export async function sendBookingConfirmation(
  args: BookingEmailArgs,
): Promise<{ ok: boolean; error?: string }> {
  const { to, spaName, startIso, timezone } = args;
  const rendered = wrapDripEmail({
    subject: `Your appointment at ${spaName} is confirmed`,
    headline: "You're booked!",
    bodyParagraphs: [
      `Your appointment with **${spaName}** is confirmed for **${fmtDate(
        startIso,
        timezone,
      )}** at **${fmtTime(startIso, timezone)}**.`,
      "Need to make a change? Just reply to this email and we'll help.",
    ],
    signoff: `— ${spaName}`,
  });
  const r = await sendViaResend({
    from: fromForSpa(spaName),
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
  const rendered = wrapDripEmail({
    subject: `Reminder: your appointment at ${spaName}`,
    headline: "See you soon!",
    bodyParagraphs: [
      `This is a friendly reminder of your appointment with **${spaName}** on **${fmtDate(
        startIso,
        timezone,
      )}** at **${fmtTime(startIso, timezone)}**.`,
      "Need to reschedule? Just reply to this email.",
    ],
    signoff: `— ${spaName}`,
  });
  const r = await sendViaResend({
    from: fromForSpa(spaName),
    to,
    subject: rendered.subject,
    html: rendered.html,
  });
  if (!r.ok) console.error("[scheduling-email] reminder send failed:", r.error);
  return r;
}
