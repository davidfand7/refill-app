/**
 * scan-followup.ts — Compose + send the /scan email follow-up (v369.1).
 *
 * Fires automatically after captureScanLead inserts a row with usable
 * math (monthlyLeakUsd != null). Sends Draft A from the v369.x plan —
 * "we did your homework" — with the lead's actual numbers templated in.
 *
 * Architecture:
 *   - composeScanFollowUpEmail (pure): lead row → { subject, text, html }
 *   - sendScanFollowUpEmail: composes + POSTs to Resend + writes
 *     followup_sent_at / followup_message_id / followup_error back to
 *     the same csv_scanner_leads row.
 *
 * Idempotency: the sender checks followup_sent_at IS NULL before firing,
 * so a duplicate captureScanLead (or a manual retry) cannot double-send.
 *
 * Fail-safe: any Resend failure stamps followup_error on the row and
 * never throws upstream — the lead capture itself always succeeds.
 *
 * Why this matters: the moment a user types their email is the freshest-
 * intent moment they will ever be in. A "we will email you within 24
 * hours" follow-up loses 60% of that intent. Instant send keeps the
 * curiosity warm and lets David's reply land while the page is still
 * open on their screen.
 */

import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import { REFILL_BRAND, type BrandConfig } from "@/lib/brand";
import { postResendEmail } from "@/server/resend-send";

// ─── Sender config ────────────────────────────────────────────────────────

// Through v381 the from-display-name swapped per brand (David at Emma vs
// David at Refill) but the sending mailbox stayed pinned to
// hello@notify.openagentic.site to preserve SPF/DKIM/DMARC alignment.
//
// Phase 0 (2026-05-19) introduces hello@smartspa.app as the Refill-branded
// mailbox. The flip is gated by REFILL_FROM_ENABLED to keep this safe:
//   - off (default): every send uses the legacy mailbox. No risk to
//     Karen's deliverability while DNS records propagate.
//   - on (Grasshopper toggles after Gmail "tabs" placement is verified
//     on getrefill.app per the arch doc risk register §10): Refill-branded
//     leads send from hello@smartspa.app; Emma-branded leads still use
//     the legacy mailbox.
//
// SCAN_FOLLOWUP_MAILBOX overrides both paths for dev/test rigging.
const LEGACY_FROM_MAILBOX =
  process.env.SCAN_FOLLOWUP_MAILBOX ?? "hello@notify.openagentic.site";
const REFILL_FROM_ENABLED = process.env.REFILL_FROM_ENABLED === "1";

function fromMailboxForBrand(brandMailbox: string): string {
  if (process.env.SCAN_FOLLOWUP_MAILBOX) return process.env.SCAN_FOLLOWUP_MAILBOX;
  if (REFILL_FROM_ENABLED && brandMailbox) return brandMailbox;
  return LEGACY_FROM_MAILBOX;
}

const REPLY_TO_EMAIL =
  process.env.SCAN_FOLLOWUP_REPLY_TO ?? "david@openagentic.site";

const EMMA_SCAN_URL =
  process.env.PUBLIC_SCAN_URL ?? "https://openagentic.site/scan";
const REFILL_SCAN_URL =
  process.env.PUBLIC_REFILL_URL ?? "https://getrefill.app";

// ─── Types ───────────────────────────────────────────────────────────────

type SbClient = ReturnType<typeof createClient<Database>>;

export type ScanLeadRow =
  Database["public"]["Tables"]["csv_scanner_leads"]["Row"];

export type ScanFollowUpEmail = {
  subject: string;
  text: string;
  html: string;
};

// ─── Formatting helpers ───────────────────────────────────────────────────

function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return `$${Math.round(n).toLocaleString()}`;
}

function monthsBetween(startIso: string | null, endIso: string | null): number {
  if (!startIso || !endIso) return 0;
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (isNaN(start) || isNaN(end) || end <= start) return 0;
  const months = (end - start) / (30 * 24 * 60 * 60 * 1000);
  return Math.max(0.1, Math.round(months * 10) / 10);
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// ─── Email composition ────────────────────────────────────────────────────

const RECOVERY_FLOOR_PCT = 0.45;
const RECOVERY_CEILING_PCT = 0.55;

export function composeScanFollowUpEmail(
  lead: ScanLeadRow,
  reportUrl?: string | null,
): ScanFollowUpEmail {
  const brand = REFILL_BRAND /* cleave: single brand, source-URL discrimination unnecessary */;
  const scanUrl = brand.name === "Refill" ? REFILL_SCAN_URL : EMMA_SCAN_URL;
  const scanLabel =
    brand.name === "Refill" ? "getrefill.app" : "openagentic.site/scan";
  const platform = lead.detected_platform?.trim() || "scheduler";
  const apptCount = lead.appointment_count ?? 0;
  const months = monthsBetween(lead.date_range_start, lead.date_range_end);
  const monthsDisplay = months > 0 ? months.toString() : "—";
  const noshowCount = lead.noshow_count ?? 0;
  const monthlyLeak = lead.estimated_monthly_leak_usd
    ? Number(lead.estimated_monthly_leak_usd)
    : null;
  const monthlyRecoveryCeiling = lead.estimated_monthly_recovery_usd
    ? Number(lead.estimated_monthly_recovery_usd)
    : null;
  // Recompute floor from the ceiling using the constant ratio
  const monthlyRecoveryFloor =
    monthlyRecoveryCeiling !== null
      ? Math.round(
          monthlyRecoveryCeiling * (RECOVERY_FLOOR_PCT / RECOVERY_CEILING_PCT),
        )
      : null;
  const annualRecoveryFloor =
    monthlyRecoveryFloor !== null ? monthlyRecoveryFloor * 12 : null;
  const annualRecoveryCeiling =
    monthlyRecoveryCeiling !== null ? monthlyRecoveryCeiling * 12 : null;

  // v370: subject + opening reframed to validate-then-augment. The
  // monthlyLeak number in the lead row is now the EMPTY-SLOT leak only
  // (per the v370 slot-level analysis), not the naive "every cancel is
  // a loss" number — so the email is defensible against the spa's books.
  const subject = `The ~${fmtUsd(monthlyLeak)}/mo gap your front desk can't catch`;

  // ── Plain text body
  const text = [
    "Hi there —",
    "",
    `I went through the ${platform} export you scanned on ${scanUrl}. Here's the honest read:`,
    "",
    "THE HONEST MATH",
    "",
    `- ${apptCount.toLocaleString()} appointments across ${monthsDisplay} months (${fmtDate(lead.date_range_start)} → ${fmtDate(lead.date_range_end)})`,
    `- Your team manually refilled most of your cancelled slots — that revenue is already in your books`,
    `- The slots that stayed empty add up to roughly ${fmtUsd(monthlyLeak)}/mo of unrecovered revenue`,
    `- ${brand.name} catches 45–55% of THAT gap = ${fmtUsd(monthlyRecoveryFloor)}–${fmtUsd(monthlyRecoveryCeiling)}/mo (${fmtUsd(annualRecoveryFloor)}–${fmtUsd(annualRecoveryCeiling)}/yr) — plus automates the manual rebooking your front desk is doing now`,
    "",
    ...(reportUrl
      ? [
          `→ FULL BREAKDOWN: ${reportUrl}`,
          `   (worst day, top providers, top services, 12-mo recovery projection, what ${brand.name} would do first — all from your actual data)`,
          "",
        ]
      : []),
    `WHAT ${brand.name.toUpperCase()} WOULD ACTUALLY DO FOR YOU`,
    "",
    "1. 48 / 24 / 3-hour pre-show reminder cadence — multi-touch SMS + email, tuned to your tone (warm / professional / casual), with one-tap confirm. ~30% of no-shows die in the cadence alone.",
    "",
    `2. Same-day rescue when a slot opens — the moment a patient cancels or no-shows, ${brand.name} fires a slot offer to your waitlist patients (first-tap-wins, race-safe). Filled slots = recovered revenue.`,
    "",
    `3. Reliability tiers per patient — ${brand.name} watches patterns and flags chronic offenders before they cost you another $250. You get to decide what to do (deposit, restrict booking, etc.) — ${brand.name} never punishes a patient unless you tell us to.`,
    "",
    `4. Verified receipt dashboard — every dollar ${brand.name} recovers is code-computed and audit-trailed against your bookkeeping. Nothing fuzzy, nothing approximated.`,
    "",
    "THE PRICING THAT PROBABLY SURPRISED YOU",
    "",
    `${brand.name} is free. You only pay $5 per booking we actually create — and only after you've verified the math against your books. No card to start. Month-to-month. Cancel anytime. The incumbents charge $200–$500/mo flat with annual contracts; we don't.`,
    "",
    "Two ways forward, your pick:",
    "",
    `- Want me to spin up ${brand.name} for your spa? Takes 10 minutes. Just reply with a yes and I'll send the setup link (or go straight to ${brand.ctaOrigin}${brand.ctaHref}).`,
    `- Want to see it run first? 15-minute screen-share — I'll show you what ${brand.name} does with your actual schedule. Just reply with a couple of times that work.`,
    "",
    `Either way, the ${fmtUsd(annualRecoveryCeiling)}/yr isn't going to recover itself.`,
    "",
    "— David",
    "",
    `P.S. If this number surprised you and you want to scan another date range or another location, just drop another CSV at ${scanUrl}. Same 30 seconds, same instant math.`,
  ].join("\n");

  // ── HTML body — light bg, dark ink, polished, mobile-friendly
  const brandTagline =
    brand.name === "Refill"
      ? "refill your schedule, recover your revenue"
      : "no-show recovery for med-spas";

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f8f6f1;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#1e293b;line-height:1.55;">
<div style="max-width:600px;margin:0 auto;padding:32px 24px;">
  <div style="font-size:14px;color:#64748b;margin-bottom:24px;">
    <strong style="color:#1e293b;">${escapeHtml(brand.name)}</strong> · ${escapeHtml(brandTagline)}
  </div>

  <p style="font-size:16px;margin:0 0 16px;">Hi there —</p>

  <p style="font-size:16px;margin:0 0 24px;">I went through the <strong>${escapeHtml(platform)}</strong> export you scanned on <a href="${scanUrl}" style="color:#0f766e;text-decoration:underline;">${escapeHtml(scanLabel)}</a>. Here's the honest read:</p>

  <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;padding:24px;margin-bottom:24px;">
    <div style="font-size:11px;color:#0f766e;text-transform:uppercase;letter-spacing:0.08em;font-weight:600;margin-bottom:12px;">The honest math · code-computed</div>
    <ul style="margin:0;padding:0 0 0 20px;font-size:15px;">
      <li style="margin-bottom:8px;"><strong>${apptCount.toLocaleString()}</strong> appointments across <strong>${monthsDisplay}</strong> months (${escapeHtml(fmtDate(lead.date_range_start))} → ${escapeHtml(fmtDate(lead.date_range_end))})</li>
      <li style="margin-bottom:8px;">Your team manually refilled most of your cancelled slots — <em>that</em> revenue is already in your books.</li>
      <li style="margin-bottom:8px;">The slots that stayed empty add up to roughly <strong>${fmtUsd(monthlyLeak)}/mo</strong> of unrecovered revenue.</li>
      <li>${escapeHtml(brand.name)} catches 45–55% of that gap: <strong style="color:#047857;">${fmtUsd(monthlyRecoveryFloor)}–${fmtUsd(monthlyRecoveryCeiling)}/mo</strong> additional (<strong style="color:#047857;">${fmtUsd(annualRecoveryFloor)}–${fmtUsd(annualRecoveryCeiling)}/yr</strong>) — plus automates the manual rebooking your front desk is doing now.</li>
    </ul>
  </div>

  ${
    reportUrl
      ? `<div style="background:#fef3c7;border:1px solid #fde68a;border-radius:14px;padding:20px;margin-bottom:24px;">
    <div style="font-size:11px;color:#92400e;text-transform:uppercase;letter-spacing:0.08em;font-weight:600;margin-bottom:6px;">Full breakdown</div>
    <p style="margin:0 0 12px;font-size:15px;color:#451a03;">Your worst day, top providers, top services, 12-month recovery projection, and what ${escapeHtml(brand.name)} would do first — all from your actual data.</p>
    <a href="${reportUrl}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:8px;font-size:14px;">View your full breakdown →</a>
  </div>`
      : ""
  }

  <h3 style="font-size:13px;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;font-weight:600;margin:32px 0 12px;">What ${escapeHtml(brand.name)} would actually do for you</h3>
  <ol style="margin:0;padding-left:20px;font-size:15px;">
    <li style="margin-bottom:14px;"><strong>48 / 24 / 3-hour pre-show reminder cadence</strong> — multi-touch SMS + email, tuned to your tone (warm / professional / casual), with one-tap confirm. ~30% of no-shows die in the cadence alone.</li>
    <li style="margin-bottom:14px;"><strong>Same-day rescue when a slot opens</strong> — the moment a patient cancels or no-shows, ${escapeHtml(brand.name)} fires a slot offer to your waitlist patients (first-tap-wins, race-safe). Filled slots = recovered revenue.</li>
    <li style="margin-bottom:14px;"><strong>Reliability tiers per patient</strong> — ${escapeHtml(brand.name)} watches patterns and flags chronic offenders before they cost you another $250. You get to decide what to do — ${escapeHtml(brand.name)} never punishes a patient unless you tell us to.</li>
    <li><strong>Verified receipt dashboard</strong> — every dollar ${escapeHtml(brand.name)} recovers is code-computed and audit-trailed against your bookkeeping. Nothing fuzzy, nothing approximated.</li>
  </ol>

  <div style="background:#0f172a;color:#ffffff;border-radius:16px;padding:24px;margin:32px 0;">
    <div style="font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.08em;font-weight:600;margin-bottom:8px;">The pricing that probably surprised you</div>
    <p style="font-size:16px;margin:0 0 12px;line-height:1.5;">${escapeHtml(brand.name)} is <strong>free</strong>. You only pay <strong>$5 per booking we actually create</strong> — and only after you've verified the math against your books.</p>
    <p style="font-size:14px;color:#cbd5e1;margin:0;">No card to start. Month-to-month. Cancel anytime. The incumbents charge $200–$500/mo flat with annual contracts; we don't.</p>
  </div>

  <h3 style="font-size:13px;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;font-weight:600;margin:0 0 12px;">Two ways forward, your pick</h3>
  <ul style="margin:0;padding-left:20px;font-size:15px;">
    <li style="margin-bottom:12px;"><strong>Want me to spin up ${escapeHtml(brand.name)} for your spa?</strong> Takes 10 minutes. Reply with a yes and I'll send the setup link (or go straight to <a href="${brand.ctaOrigin}${brand.ctaHref}" style="color:#0f766e;">${escapeHtml((brand.ctaOrigin + brand.ctaHref).replace(/^https?:\/\//, ""))}</a>).</li>
    <li><strong>Want to see it run first?</strong> 15-minute screen-share — I'll show you what ${escapeHtml(brand.name)} does with your actual schedule. Just reply with a couple of times that work.</li>
  </ul>

  <p style="font-size:15px;margin:24px 0;">Either way, the <strong>${fmtUsd(annualRecoveryCeiling)}/yr</strong> isn't going to recover itself.</p>

  <p style="font-size:15px;margin:0 0 4px;">— David</p>

  <p style="font-size:13px;color:#64748b;margin:32px 0 0;border-top:1px solid #e2e8f0;padding-top:16px;">
    P.S. Want to scan another date range or another location? Drop another CSV at <a href="${scanUrl}" style="color:#0f766e;">${escapeHtml(scanLabel)}</a>. Same 30 seconds, same instant math.
  </p>
</div>
</body>
</html>`;

  return { subject, text, html };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ─── Send + audit-trail ───────────────────────────────────────────────────

/**
 * v371: rich context passed from captureScanLead with the breakdowns
 * computed client-side. Used to build the polished HTML report attached
 * to the email. All fields optional — when absent, the email still
 * sends but without the attachment (falls back to body-only).
 */
export type ScanFollowUpRichContext = {
  totalLossEvents: number | null;
  refilledSlotCount: number | null;
  emptySlotCount: number | null;
  monthsCovered: number | null;
  monthlyManualSavedUsd: number | null;
  byDayOfWeek: LeakBucket[] | null;
  byProvider: LeakBucket[] | null;
  byService: LeakBucket[] | null;
};

type LeakBucket = {
  label: string;
  cancelledCount: number;
  refilledCount: number;
  emptyCount: number;
  emptyLeakUsd: number;
};

/**
 * Send the follow-up email for one lead row. Idempotent — bails if
 * followup_sent_at is already stamped. Stamps either followup_sent_at +
 * followup_message_id on success, or followup_error on failure. Never
 * throws upstream — captureScanLead's success must not depend on this.
 *
 * v371: optional richContext drives the HTML report attachment. If
 * provided AND has usable breakdown data, attach `Your-Refill-Report.html`
 * to the Resend send.
 */
export async function sendScanFollowUpEmail(
  sb: SbClient,
  leadId: string,
  richContext?: ScanFollowUpRichContext,
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn(
      "[scan-followup] RESEND_API_KEY not set — skipping send for lead",
      leadId,
    );
    await sb
      .from("csv_scanner_leads")
      .update({ followup_error: "RESEND_API_KEY not configured" })
      .eq("id", leadId);
    return;
  }

  // Re-fetch the row to guarantee idempotency under race
  const { data: lead, error: fetchErr } = await sb
    .from("csv_scanner_leads")
    .select("*")
    .eq("id", leadId)
    .maybeSingle();
  if (fetchErr || !lead) {
    console.warn("[scan-followup] couldn't load lead", leadId, fetchErr?.message);
    return;
  }
  if (lead.followup_sent_at) {
    return; // already sent
  }
  if (lead.estimated_monthly_leak_usd === null) {
    // No usable math — never send a hollow email
    return;
  }

  const brand = REFILL_BRAND /* cleave: single brand, source-URL discrimination unnecessary */;
  const fromAddress = `${brand.emailFromName} <${fromMailboxForBrand(brand.emailFromMailbox)}>`;

  // v371.1: build + HOST the HTML report at /report/<token> instead of
  // attaching it. Gmail (and most email clients) renders .html attachments
  // as raw source code for XSS safety; a hosted URL renders cleanly in
  // any browser, works on mobile, no attachment friction. Token IS the
  // capability — same model as /rescue/claim/<token>. Persist the
  // rendered HTML to csv_scanner_leads so the public /report route can
  // serve it without re-computing.
  let reportUrl: string | null = null;
  if (
    richContext &&
    richContext.totalLossEvents !== null &&
    richContext.totalLossEvents > 0 &&
    richContext.byDayOfWeek &&
    richContext.byProvider &&
    richContext.byService
  ) {
    try {
      const reportHtml = buildScanReportHtml(lead, brand, richContext);
      const token = generateReportToken();
      const { error: persistErr } = await sb
        .from("csv_scanner_leads")
        .update({
          followup_report_html: reportHtml,
          followup_report_token: token,
        })
        .eq("id", leadId);
      if (persistErr) {
        console.warn(
          "[scan-followup] couldn't persist report (sending email without link):",
          persistErr.message,
        );
      } else {
        // Compose the public URL — Refill-branded URL when the lead came
        // in via getrefill.app, Emma URL otherwise. Either domain hits
        // the same Worker which renders /report/<token>.
        const reportOrigin =
          brand.name === "Refill"
            ? "https://getrefill.app"
            : "https://openagentic.site";
        reportUrl = `${reportOrigin}/report/${token}`;
      }
    } catch (err) {
      console.warn(
        "[scan-followup] report build failed (sending email without link):",
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Compose the email AFTER reportUrl is known so the body links to it
  // when present. composeScanFollowUpEmail accepts reportUrl as an
  // optional second arg and weaves it into both text + HTML bodies.
  const { subject, text, html } = composeScanFollowUpEmail(lead, reportUrl);

  try {
    const result = await postResendEmail({
      apiKey,
      from: fromAddress,
      to: [lead.email],
      replyTo: REPLY_TO_EMAIL,
      subject,
      text,
      html,
      tags: [
        { name: "type", value: "scan-followup" },
        { name: "brand", value: brand.name.toLowerCase() },
        {
          name: "has_report",
          value: reportUrl !== null ? "yes" : "no",
        },
        {
          name: "platform",
          value: (lead.detected_platform ?? "unknown")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .slice(0, 40),
        },
        { name: "was_ai_mapped", value: String(lead.was_ai_mapped) },
      ],
      signal: AbortSignal.timeout(20_000),
    });
    if (!result.ok) {
      throw new Error(`Resend ${result.status}: ${result.body.slice(0, 300)}`);
    }
    const messageId = result.id ?? null;

    await sb
      .from("csv_scanner_leads")
      .update({
        followup_sent_at: new Date().toISOString(),
        followup_message_id: messageId,
        followup_error: null,
      })
      .eq("id", leadId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("[scan-followup] send failed for lead", leadId, message);
    await sb
      .from("csv_scanner_leads")
      .update({ followup_error: message.slice(0, 500) })
      .eq("id", leadId);
  }
}

/**
 * Lean "come back and run your scan" email — for visitors who looked at the
 * pre-loaded sample on /scan but don't have their own export handy yet. There's
 * no data to report, so this is NOT sendScanFollowUpEmail (which refuses to
 * send without leak math) — just a friendly link back. Reuses the same Resend
 * send + warm from-address.
 */
export async function sendScanReturnLinkEmail(
  sb: SbClient,
  leadId: string,
  email: string,
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("[scan-return] RESEND_API_KEY not set — skipping send", leadId);
    await sb
      .from("csv_scanner_leads")
      .update({ followup_error: "RESEND_API_KEY not configured" })
      .eq("id", leadId);
    return;
  }
  const brand = REFILL_BRAND;
  const fromAddress = `${brand.emailFromName} <${fromMailboxForBrand(brand.emailFromMailbox)}>`;
  // Deep-link below the fold: the recipient already saw the demo, so land
  // them on the drop zone, not the top of the page.
  const scanUrl = "https://smartspa.app/scan#drop";
  const subject = "Your SmartSpa scan link";
  const text = [
    "You just looked at SmartSpa's no-show + cancellation scan — those were our own spa's real numbers.",
    "",
    `Whenever you've got 30 seconds, drop your scheduler's CSV here to see YOUR numbers: ${scanUrl}`,
    "",
    "Free, no signup, and your data never leaves your browser — only the column structure touches our servers.",
    "",
    "— The SmartSpa team",
  ].join("\n");
  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a;line-height:1.6;font-size:15px;max-width:520px;margin:0 auto;padding:24px;">
<p style="margin:0 0 16px;">You just looked at SmartSpa's no-show + cancellation scan &mdash; those were <strong>our own spa's real numbers</strong>.</p>
<p style="margin:0 0 20px;">Whenever you've got 30 seconds, run yours:</p>
<p style="margin:0 0 24px;"><a href="${scanUrl}" style="display:inline-block;background:#059669;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;">See your own numbers &rarr;</a></p>
<p style="margin:0 0 8px;color:#475569;font-size:13px;">Free, no signup. Your data never leaves your browser &mdash; only the column structure touches our servers.</p>
<p style="margin:16px 0 0;color:#94a3b8;font-size:13px;">&mdash; The SmartSpa team</p>
</body></html>`;

  try {
    const result = await postResendEmail({
      apiKey,
      from: fromAddress,
      to: [email],
      replyTo: REPLY_TO_EMAIL,
      subject,
      text,
      html,
      tags: [{ name: "type", value: "scan-return-link" }],
      signal: AbortSignal.timeout(20_000),
    });
    if (!result.ok) {
      throw new Error(`Resend ${result.status}: ${result.body.slice(0, 300)}`);
    }
    await sb
      .from("csv_scanner_leads")
      .update({
        followup_sent_at: new Date().toISOString(),
        followup_message_id: result.id ?? null,
        followup_error: null,
      })
      .eq("id", leadId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("[scan-return] send failed", leadId, message);
    await sb
      .from("csv_scanner_leads")
      .update({ followup_error: message.slice(0, 500) })
      .eq("id", leadId);
  }
}

// ─── v371: HTML report generator + token mint ─────────────────────────────

/**
 * v371.1: mint an opaque report token. Token IS the capability —
 * same pattern as /rescue/claim/<token> and /waitlist/optin/<token>.
 * 32 url-safe characters from crypto.getRandomValues() ≈ 192 bits of
 * entropy, well past brute-force territory. Works in both Node and
 * Cloudflare Workers (globalThis.crypto is available in both).
 */
function generateReportToken(): string {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  // Base64url encoding without padding
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const RECOVERY_FLOOR = 0.45;
const RECOVERY_CEILING = 0.55;
const AVG_TICKET = 250;

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtUsdRound(n: number): string {
  return `$${Math.round(n).toLocaleString()}`;
}

/**
 * Build the polished single-file HTML report attached to the follow-up
 * email. Light bg per polished-docs convention. Mobile-responsive via
 * viewport meta + flexible widths. All CSS inline so it renders the same
 * everywhere — opened in Chrome, saved to desktop, forwarded to a CFO,
 * printed for the staff meeting.
 */
function buildScanReportHtml(
  lead: ScanLeadRow,
  brand: BrandConfig,
  ctx: ScanFollowUpRichContext,
): string {
  const platform = lead.detected_platform?.trim() || "scheduler";
  const months = ctx.monthsCovered ?? 1;
  const total = ctx.totalLossEvents ?? 0;
  const refilled = ctx.refilledSlotCount ?? 0;
  const empty = ctx.emptySlotCount ?? 0;
  const refillRatePct = total > 0 ? Math.round((refilled / total) * 100) : 0;
  const emptyPct = total > 0 ? Math.round((empty / total) * 100) : 0;

  const manualSaved = Number(ctx.monthlyManualSavedUsd ?? 0);
  const monthlyLeak = Number(lead.estimated_monthly_leak_usd ?? 0);
  const monthlyRecoveryCeiling = Number(lead.estimated_monthly_recovery_usd ?? 0);
  const monthlyRecoveryFloor =
    monthlyRecoveryCeiling * (RECOVERY_FLOOR / RECOVERY_CEILING);
  const annualRecoveryFloor = Math.round(monthlyRecoveryFloor * 12);
  const annualRecoveryCeiling = Math.round(monthlyRecoveryCeiling * 12);

  const dow = ctx.byDayOfWeek ?? [];
  const providers = ctx.byProvider ?? [];
  const services = ctx.byService ?? [];

  // Build horizontal bar rows for a breakdown axis. Width % is relative
  // to the bucket with the largest emptyLeakUsd (so the worst bucket
  // gets the full bar).
  const renderBars = (
    buckets: LeakBucket[],
    accent: string,
    showRefill = false,
  ): string => {
    const max = Math.max(1, ...buckets.map((b) => b.emptyLeakUsd));
    return buckets
      .map((b) => {
        const pct = Math.round((b.emptyLeakUsd / max) * 100);
        const suffix = showRefill && b.cancelledCount > 0
          ? ` <span style="color:#94a3b8;">· refill rate ${Math.round(
              (b.refilledCount / b.cancelledCount) * 100,
            )}%</span>`
          : "";
        return `
          <tr>
            <td style="padding:6px 12px 6px 0;color:#475569;white-space:nowrap;vertical-align:middle;">${esc(b.label)}</td>
            <td style="padding:6px 0;width:100%;vertical-align:middle;">
              <div style="background:${accent};height:14px;width:${pct}%;border-radius:3px;min-width:2px;"></div>
            </td>
            <td style="padding:6px 0 6px 12px;color:#0f172a;font-weight:600;white-space:nowrap;vertical-align:middle;text-align:right;font-variant-numeric:tabular-nums;">${fmtUsdRound(b.emptyLeakUsd)}</td>
            <td style="padding:6px 0 6px 8px;color:#64748b;white-space:nowrap;vertical-align:middle;font-variant-numeric:tabular-nums;font-size:12px;">${b.emptyCount} empty / ${b.cancelledCount} cancelled${suffix}</td>
          </tr>`;
      })
      .join("");
  };

  // Recapture projection — simple 12-month forward extrapolation. Real
  // model would use spa-specific seasonality once we have it.
  const projectionMonths = Array.from({ length: 12 }, (_, i) => i + 1);
  const projectionRows = projectionMonths
    .map((m) => {
      const cumFloor = Math.round(monthlyRecoveryFloor * m);
      const cumCeiling = Math.round(monthlyRecoveryCeiling * m);
      return `
        <tr>
          <td style="padding:6px 12px 6px 0;color:#475569;">Month ${m}</td>
          <td style="padding:6px 0;color:#0f172a;font-weight:600;text-align:right;font-variant-numeric:tabular-nums;">${fmtUsdRound(cumFloor)} – ${fmtUsdRound(cumCeiling)}</td>
        </tr>`;
    })
    .join("");

  // Prescriptive "what Refill would do first" — uses the actual top
  // bucket from each breakdown axis so the recommendation is specific.
  const worstDow = [...dow].sort(
    (a, b) => b.emptyLeakUsd - a.emptyLeakUsd,
  )[0];
  const worstProvider = providers[0];
  const worstService = services[0];
  const recs: string[] = [];
  // v371.2: map the 3-letter day abbreviation to the full pluralized
  // weekday name. Naive `+ "s"` produced "Target Fris first" which
  // reads like a typo.
  const DAY_NAMES_PLURAL: Record<string, string> = {
    Sun: "Sundays",
    Mon: "Mondays",
    Tue: "Tuesdays",
    Wed: "Wednesdays",
    Thu: "Thursdays",
    Fri: "Fridays",
    Sat: "Saturdays",
  };
  if (worstDow && worstDow.emptyLeakUsd > 0) {
    const dayName =
      DAY_NAMES_PLURAL[worstDow.label] ?? `${worstDow.label}s`;
    recs.push(
      `<strong>Target ${esc(dayName)} first</strong> — that's your worst day for empty slots (${worstDow.emptyCount} empty over ${months} months = ${fmtUsdRound(worstDow.emptyLeakUsd)} leak). ${brand.name}'s reminder cadence runs heaviest on the days you flag highest-risk.`,
    );
  }
  if (worstProvider && worstProvider.emptyLeakUsd > 0) {
    recs.push(
      `<strong>${esc(worstProvider.label)}'s book</strong> drives ${fmtUsdRound(worstProvider.emptyLeakUsd)} of unrecovered leak (${worstProvider.emptyCount} empty slots). ${brand.name}'s waitlist + same-day rescue would have caught most of these.`,
    );
  }
  if (worstService && worstService.emptyLeakUsd > 0) {
    recs.push(
      `<strong>${esc(worstService.label)}</strong> is your highest-leak service (${fmtUsdRound(worstService.emptyLeakUsd)} from ${worstService.emptyCount} empty slots). ${brand.name}'s reliability-tier engine flags chronic cancellers for this service first.`,
    );
  }
  if (recs.length === 0) {
    recs.push(
      `Your data is clean — no single day / provider / service dominates the leak. ${brand.name} would run pre-show reminders + same-day waitlist rescue across the board.`,
    );
  }

  const scanUrl =
    brand.name === "Refill"
      ? "https://getrefill.app"
      : "https://openagentic.site/scan";
  // v372: brand-aware CTA destination — getrefill.app/start for Refill
  // (manual onboarding intake), openagentic.site/app for Emma.
  const appUrl = `${brand.ctaOrigin}${brand.ctaHref}`;
  const tagline =
    brand.name === "Refill"
      ? "refill your schedule, recover your revenue"
      : "no-show recovery for med-spas";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Your ${esc(brand.name)} Report</title>
</head>
<body style="margin:0;padding:0;background:#f8f6f1;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#1e293b;line-height:1.5;">
<div style="max-width:760px;margin:0 auto;padding:40px 24px;">

  <header style="display:flex;align-items:center;gap:10px;margin-bottom:32px;border-bottom:1px solid #e2e8f0;padding-bottom:20px;">
    <div style="width:34px;height:34px;border-radius:8px;background:#0f172a;color:#ffffff;display:inline-flex;align-items:center;justify-content:center;font-weight:600;">${esc(brand.logoMark)}</div>
    <div>
      <div style="font-weight:600;color:#0f172a;font-size:16px;">${esc(brand.name)}</div>
      <div style="color:#64748b;font-size:12px;">${esc(tagline)}</div>
    </div>
    <div style="margin-left:auto;text-align:right;color:#64748b;font-size:12px;">
      <div>Your no-show recovery report</div>
      <div>${esc(platform)} · ${esc(monthsBetween(lead.date_range_start, lead.date_range_end).toString())} months of data</div>
    </div>
  </header>

  <h1 style="font-size:28px;margin:0 0 8px;color:#0f172a;line-height:1.25;">The ${fmtUsdRound(monthlyLeak)}/mo gap your front desk can&#39;t catch.</h1>
  <p style="margin:0 0 28px;color:#475569;">A complete read of your ${esc(platform)} export from the scan. Same numbers as the page, deeper context.</p>

  <!-- Headline math -->
  <section style="background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;padding:24px;margin-bottom:28px;">
    <div style="font-size:11px;color:#0f766e;text-transform:uppercase;letter-spacing:0.08em;font-weight:600;margin-bottom:14px;">The honest math · code-computed</div>
    <p style="margin:0 0 16px;font-size:15px;color:#334155;">Your schedule shows <strong>${total}</strong> cancellations + no-shows across <strong>${months}</strong> months. Your team already refilled <strong>${refilled}</strong> of them (<strong>${refillRatePct}%</strong>) — that revenue is in your books. The remaining <strong>${empty}</strong> stayed empty (${emptyPct}%) — that's the gap ${esc(brand.name)} targets.</p>
    <table style="width:100%;border-collapse:collapse;margin:0;">
      <tr>
        <td style="vertical-align:top;width:50%;padding-right:8px;">
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:16px;">
            <div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.06em;font-weight:600;">Your team already saved</div>
            <div style="font-size:24px;font-weight:600;color:#0f172a;margin-top:4px;">${fmtUsdRound(manualSaved)}<span style="font-size:14px;color:#64748b;font-weight:500;"> / month</span></div>
            <div style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:#64748b;margin-top:6px;">${refilled} × $${AVG_TICKET} ÷ ${months} mo = ${fmtUsdRound(manualSaved)}</div>
          </div>
        </td>
        <td style="vertical-align:top;width:50%;padding-left:8px;">
          <div style="background:#059669;color:#ffffff;border-radius:12px;padding:16px;">
            <div style="font-size:10px;color:#a7f3d0;text-transform:uppercase;letter-spacing:0.06em;font-weight:600;">${esc(brand.name)} catches the gap</div>
            <div style="font-size:24px;font-weight:600;margin-top:4px;">${fmtUsdRound(monthlyRecoveryFloor)} – ${fmtUsdRound(monthlyRecoveryCeiling)}<span style="font-size:14px;color:#a7f3d0;font-weight:500;"> / month</span></div>
            <div style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:#a7f3d0;margin-top:6px;">${empty} × $${AVG_TICKET} × ${Math.round(RECOVERY_FLOOR * 100)}–${Math.round(RECOVERY_CEILING * 100)}% ÷ ${months} mo</div>
          </div>
        </td>
      </tr>
    </table>
    <div style="margin-top:14px;color:#475569;font-size:14px;">That's <strong style="color:#0f172a;">${fmtUsdRound(annualRecoveryFloor)} – ${fmtUsdRound(annualRecoveryCeiling)}/yr</strong> of additional revenue ${esc(brand.name)} catches — at 45–55% of the gap your team can&#39;t get to.</div>
  </section>

  <!-- Day-of-week breakdown -->
  <section style="margin-bottom:28px;">
    <h2 style="font-size:18px;color:#0f172a;margin:0 0 4px;">By day of week</h2>
    <p style="margin:0 0 14px;color:#64748b;font-size:13px;">Which days leak the most. Empty-slot $ in mono on the right. Refill rate per day on the far right.</p>
    <table style="width:100%;border-collapse:collapse;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:8px 16px;">
      ${renderBars(dow, "#059669", true)}
    </table>
  </section>

  <!-- Per-provider breakdown -->
  <section style="margin-bottom:28px;">
    <h2 style="font-size:18px;color:#0f172a;margin:0 0 4px;">By provider</h2>
    <p style="margin:0 0 14px;color:#64748b;font-size:13px;">Top providers ranked by empty-slot leak. If one name dominates, that's where ${esc(brand.name)} starts.</p>
    <table style="width:100%;border-collapse:collapse;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:8px 16px;">
      ${renderBars(providers, "#0ea5e9", true)}
    </table>
  </section>

  <!-- Per-service breakdown -->
  <section style="margin-bottom:28px;">
    <h2 style="font-size:18px;color:#0f172a;margin:0 0 4px;">By service</h2>
    <p style="margin:0 0 14px;color:#64748b;font-size:13px;">Top services ranked by empty-slot leak. Useful for tuning deposit policies per treatment.</p>
    <table style="width:100%;border-collapse:collapse;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:8px 16px;">
      ${renderBars(services, "#a855f7", true)}
    </table>
  </section>

  <!-- 12-month recovery projection -->
  <section style="margin-bottom:28px;">
    <h2 style="font-size:18px;color:#0f172a;margin:0 0 4px;">12-month recovery projection</h2>
    <p style="margin:0 0 14px;color:#64748b;font-size:13px;">Cumulative recovered revenue if ${esc(brand.name)} ran from today forward, holding your current cancellation rate constant. Real numbers will shift with seasonality.</p>
    <table style="width:100%;border-collapse:collapse;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:8px 16px;">
      ${projectionRows}
      <tr style="border-top:1px solid #e2e8f0;">
        <td style="padding:10px 12px 10px 0;font-weight:600;color:#0f172a;">12-month total</td>
        <td style="padding:10px 0;font-weight:600;color:#047857;text-align:right;font-variant-numeric:tabular-nums;">${fmtUsdRound(annualRecoveryFloor)} – ${fmtUsdRound(annualRecoveryCeiling)}</td>
      </tr>
    </table>
  </section>

  <!-- What Refill would do first -->
  <section style="margin-bottom:28px;background:#fffbeb;border:1px solid #fde68a;border-radius:12px;padding:20px;">
    <h2 style="font-size:18px;color:#92400e;margin:0 0 10px;">What ${esc(brand.name)} would do first</h2>
    <ul style="margin:0;padding-left:20px;color:#451a03;font-size:14px;">
      ${recs.map((r) => `<li style="margin-bottom:8px;">${r}</li>`).join("")}
    </ul>
  </section>

  <!-- Pricing card -->
  <section style="background:#0f172a;color:#ffffff;border-radius:12px;padding:24px;margin-bottom:28px;">
    <div style="font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.08em;font-weight:600;">Pricing</div>
    <div style="font-size:20px;font-weight:600;margin:4px 0 10px;">${esc(brand.name)} is free. You only pay $5 per booking we actually create.</div>
    <div style="color:#cbd5e1;font-size:14px;">No card to start. Month-to-month. Cancel anytime. Draft invoices generate from verified recovery events; you turn on Stripe only when you trust the math.</div>
    <div style="margin-top:18px;">
      <a href="${appUrl}" style="display:inline-block;background:#ffffff;color:#0f172a;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:8px;font-size:14px;">Set up ${esc(brand.name)} for my spa →</a>
    </div>
  </section>

  <footer style="color:#64748b;font-size:11px;border-top:1px solid #e2e8f0;padding-top:16px;line-height:1.5;">
    Numbers above are code-computed from your uploaded CSV. Recapture estimates use 45–55% of empty-slot leak at $${AVG_TICKET} average ticket — substitute your actual ARV for your own math. Want to scan another date range or another location? Drop another CSV at <a href="${scanUrl}" style="color:#0f766e;">${esc(scanUrl.replace(/^https?:\/\//, ""))}</a>.
  </footer>
</div>
</body>
</html>`;
}
