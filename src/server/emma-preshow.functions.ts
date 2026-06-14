/**
 * Emma(OS) pre-show reminder agent (v360).
 *
 * The first of three no-show recovery agents. Pre-show watches every
 * upcoming appointment and fires a personalized reminder at each
 * cadence offset configured in emma_noshow_policies (default T-48h,
 * T-24h, T-3h). Cadence tone + channel preference + opt-in footer come
 * from policy. Compliance rails (opted_out, banned) run identically to
 * campaign sends.
 *
 * Two surfaces:
 *   dispatchPreShowReminder  — pure fn taking (sb, appointmentId, offsetHours).
 *                              Used by the cron sweep AND by manual "send
 *                              reminder now" actions from the UI.
 *   listRecentReminders      — for the /app/refill/appointments UI to show
 *                              "Emma sent X reminders this week."
 *
 * Cron lives separately at src/routes/api.cron.emma-preshow-sweep.ts.
 *
 * Established 2026-05-17 (Promotions Engine v360).
 */

import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { resolveEffectiveUserId, verifyAuth } from "@/server/auth-helpers";
import { sendSms } from "@/server/sms-provider";
import { resolveSpaFromEmail } from "@/server/emma-sender.functions";
import { recordAgentAction } from "@/server/messaging-activity";
import { sendingPausedFromRow } from "@/server/sending-pause";
import { patientOptOutStatus } from "@/server/patient-contactability";
import {
  resolveSpaFromNumber,
  resolveSpaName,
} from "@/server/emma-spa-profile";

// ─── Public types ─────────────────────────────────────────────────────────

export type PreShowDispatchResult =
  | {
      ok: true;
      messageId: string | null;
      channel: "sms" | "email";
      sentAt: string;
    }
  | {
      ok: false;
      skipReason: PreShowSkipReason;
      message: string;
    };

export type PreShowSkipReason =
  | "preshow_disabled"
  | "no_patient"
  | "no_channel"
  | "opted_out"
  | "banned"
  | "already_reminded"
  | "appointment_not_pending"
  | "no_phone_number"
  | "from_unavailable"
  | "send_failed"
  | "outside_treatment_cadence"
  | "sending_paused";

// ─── Admin client ─────────────────────────────────────────────────────────

function admin() {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw new Error("Server is missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  }
  return createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

type SupabaseAdmin = ReturnType<typeof admin>;

// ─── Composition ──────────────────────────────────────────────────────────

/**
 * v1.34.3: render a custom SMS template with variable substitution.
 * Used when the spa's default profile has a custom template for this
 * specific offset. Variables match the chip set Karen sees in the
 * Preshow agent UI:
 *   {{patient.firstName}}  → first name or "there"
 *   {{appt.dateTime}}      → full formatted date+time
 *   {{appt.time}}          → time only
 *   {{appt.treatmentType}} → treatment_type or "your appointment"
 *   {{appt.providerName}}  → provider_name or "your provider"
 *   {{spa.name}}           → spa.name
 *
 * Footer + STOP are appended automatically — Karen doesn't need to
 * include them in the template.
 */
function renderPreshowTemplate(
  template: string,
  vars: {
    patientFirstName: string | null;
    spaName: string;
    treatmentType: string | null;
    providerName: string | null;
    scheduledAt: string;
  },
): string {
  return template
    .replace(/\{\{patient\.firstName\}\}/g, vars.patientFirstName ?? "there")
    .replace(/\{\{appt\.dateTime\}\}/g, formatLocalDateTime(vars.scheduledAt))
    .replace(/\{\{appt\.time\}\}/g, formatLocalTime(vars.scheduledAt))
    .replace(
      /\{\{appt\.treatmentType\}\}/g,
      vars.treatmentType ?? "your appointment",
    )
    .replace(
      /\{\{appt\.providerName\}\}/g,
      vars.providerName ?? "your provider",
    )
    .replace(/\{\{spa\.name\}\}/g, vars.spaName);
}

/**
 * v1.34.3: append the universal opt-in footer + STOP footer to a
 * template-rendered body. Matches the footer logic in
 * composePreShowSmsBody so custom-templated messages behave the same as
 * code-composed defaults.
 */
function appendPreshowFooters(
  body: string,
  args: {
    optinFooterEnabled: boolean;
    optinFooterText: string;
    optinListUrl: string | null;
  },
): string {
  let result = body.trimEnd();
  if (args.optinFooterEnabled && args.optinListUrl) {
    result += `\n\n${args.optinFooterText} ${args.optinListUrl}`;
  }
  result += `\nReply STOP to opt out.`;
  return result;
}

/**
 * Compose the SMS body for a pre-show reminder. Code-composed not
 * LLM-composed for v1 — the message structure is simple enough that
 * deterministic templating beats LLM variance, and we want predictable
 * compliance language.
 *
 * Per the v360 plan, every Emma-outbound message appends the universal
 * opt-in footer + STOP footer when SMS.
 */
function composePreShowSmsBody(args: {
  patientFirstName: string | null;
  spaName: string;
  treatmentType: string | null;
  providerName: string | null;
  scheduledAt: string;
  offsetHours: number;
  tone: "warm" | "professional" | "casual";
  optinFooterEnabled: boolean;
  optinFooterText: string;
  optinListUrl: string | null;
}): string {
  const greeting = args.patientFirstName ? `Hey ${args.patientFirstName}` : "Hi";
  const when = formatLocalDateTime(args.scheduledAt);
  const treatment = args.treatmentType
    ? ` for your ${args.treatmentType}`
    : "";
  const provider = args.providerName ? ` with ${args.providerName}` : "";

  let opener: string;
  if (args.offsetHours >= 48) {
    // T-48h or beyond — warm pre-confirm
    opener =
      args.tone === "professional"
        ? `${greeting}, this is a reminder of your appointment${treatment}${provider} on ${when}.`
        : `${greeting} — looking forward to seeing you${treatment}${provider} on ${when}.`;
    opener += ` Should we lock it in, or do you need a different time? Sometimes it's easier to move it now than juggle later.`;
  } else if (args.offsetHours >= 24) {
    // T-24h — gentle reminder
    opener =
      args.tone === "professional"
        ? `${greeting}, your appointment${treatment} is tomorrow at ${formatLocalTime(args.scheduledAt)}${provider}.`
        : `${greeting} — quick reminder, you're booked${treatment}${provider} tomorrow at ${formatLocalTime(args.scheduledAt)}.`;
    opener += ` See you then! If anything's come up just text back and we'll find a better time.`;
  } else {
    // T-6h or less — final confirm
    opener = `${greeting} — just confirming we'll see you${treatment} at ${formatLocalTime(args.scheduledAt)} today${provider}. Reply C to confirm or R to reschedule.`;
  }

  let body = `${opener}\n\n— ${args.spaName}`;

  if (args.optinFooterEnabled && args.optinListUrl) {
    body += `\n\n${args.optinFooterText} ${args.optinListUrl}`;
  }

  // Universal STOP footer (TCPA + Emma's compliance rail consistency)
  body += `\nReply STOP to opt out.`;

  return body;
}

function composePreShowEmail(args: {
  patientFirstName: string | null;
  spaName: string;
  treatmentType: string | null;
  providerName: string | null;
  scheduledAt: string;
  offsetHours: number;
  tone: "warm" | "professional" | "casual";
  optinFooterEnabled: boolean;
  optinFooterText: string;
  optinListUrl: string | null;
}): { subject: string; text: string; html: string } {
  const when = formatLocalDateTime(args.scheduledAt);
  const treatment = args.treatmentType
    ? ` for your ${args.treatmentType}`
    : "";
  const provider = args.providerName ? ` with ${args.providerName}` : "";
  const greeting = args.patientFirstName ? `Hi ${args.patientFirstName}` : "Hi";

  const subject =
    args.offsetHours >= 24
      ? `Reminder: your appointment${treatment} on ${when}`
      : `See you today${treatment} at ${formatLocalTime(args.scheduledAt)}`;

  const text = composePreShowSmsBody(args)
    .replace(/Reply STOP to opt out\.$/, "")
    .trim();

  const optinHtml =
    args.optinFooterEnabled && args.optinListUrl
      ? `<p style="margin:18px 0 0;font-size:13px;color:#666;">${escapeHtml(args.optinFooterText)} <a href="${args.optinListUrl}" style="color:#3c5b48;">Join the list</a></p>`
      : "";

  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',sans-serif;color:#1c2024;max-width:560px;margin:0 auto;padding:24px;line-height:1.55">
  <p style="margin:0 0 14px">${escapeHtml(greeting)} —</p>
  <p style="margin:0 0 14px">Looking forward to seeing you${escapeHtml(treatment)}${escapeHtml(provider)} on <strong>${escapeHtml(when)}</strong>.</p>
  <p style="margin:0 0 14px">If anything's come up, just reply and we'll find a better time — sometimes it's easier to move it now than juggle later.</p>
  <p style="margin:18px 0 0;font-size:14px;color:#5a6068;">— ${escapeHtml(args.spaName)}</p>
  ${optinHtml}
</div>
  `.trim();

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

function formatLocalDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatLocalTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

// ─── dispatchPreShowReminder (the core pure fn) ───────────────────────────

/**
 * Send ONE pre-show reminder for ONE appointment at ONE cadence offset.
 *
 * Caller is responsible for:
 *   - Deciding which offset to dispatch (based on now() vs scheduled_at)
 *   - Idempotency at the appointment×offset level (we check has-reminded
 *     for the offset bucket via patient_outreach.message_id prefix +
 *     metadata, but caller should also coordinate to avoid wasted work)
 *
 * Skip reasons are non-fatal — caller logs and moves on.
 */
export async function dispatchPreShowReminder(args: {
  sb: SupabaseAdmin;
  userId: string;
  appointmentId: string;
  offsetHours: number;
}): Promise<PreShowDispatchResult> {
  const { sb, userId, appointmentId, offsetHours } = args;

  // 1) Load the appointment + policy in parallel.
  const [aptRes, policyRes] = await Promise.all([
    sb
      .from("emma_appointments")
      .select("*")
      .eq("id", appointmentId)
      .eq("user_id", userId)
      .maybeSingle(),
    sb
      .from("emma_noshow_policies")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle(),
  ]);
  if (aptRes.error)
    throw new Error(`Couldn't load appointment: ${aptRes.error.message}`);
  if (!aptRes.data) {
    return {
      ok: false,
      skipReason: "appointment_not_pending",
      message: "Appointment not found.",
    };
  }
  if (!policyRes.data || !policyRes.data.preshow_enabled) {
    return {
      ok: false,
      skipReason: "preshow_disabled",
      message: "Pre-show reminders are disabled for this spa.",
    };
  }
  // Tier-2 kill switch (Slice 3): the master pause halts reminders too. The
  // policy row is already loaded — a free read of a column it's holding.
  if (sendingPausedFromRow(policyRes.data)) {
    return {
      ok: false,
      skipReason: "sending_paused",
      message: "All sending is paused for this spa.",
    };
  }
  const apt = aptRes.data;
  const policy = policyRes.data;

  if (apt.status !== "scheduled" && apt.status !== "confirmed") {
    return {
      ok: false,
      skipReason: "appointment_not_pending",
      message: `Appointment is in '${apt.status}' state.`,
    };
  }
  if (!apt.patient_node_id) {
    return {
      ok: false,
      skipReason: "no_patient",
      message: "Appointment has no linked patient — can't reach anyone.",
    };
  }

  // 2) Load patient summary (phone, email, banned/opted_out flags)
  const { data: patient } = await sb
    .from("knowledge_nodes")
    .select("title, attachments")
    .eq("id", apt.patient_node_id)
    .eq("user_id", userId)
    .maybeSingle();
  const patientAttachments = (patient?.attachments ?? null) as {
    phone?: string;
    email?: string;
    banned?: boolean;
    opted_out?: boolean;
    softTags?: {
      preshowProfileId?: {
        value: string;
        setByUserId: string;
        setAt: string;
        reason: string | null;
      } | null;
    } | null;
  } | null;

  // Compliance: banned or opted-out blocks outbound — one shared rule via
  // patient-contactability (same definition recall/blast/rescue use).
  const optOut = patientOptOutStatus(patientAttachments);
  if (optOut.blocked) {
    return {
      ok: false,
      skipReason: optOut.reason === "opted_out" ? "opted_out" : "banned",
      message:
        optOut.reason === "opted_out"
          ? "Patient opted out."
          : "Patient banned — outbound blocked.",
    };
  }

  // 3) Idempotency check — has this appointment×offset already gotten a
  //    reminder? We use the message_id field tagged with a stable token
  //    "preshow:<appointmentId>:<offset>" to dedupe.
  const dedupeToken = `preshow:${apt.id}:${offsetHours}`;
  const { data: priorSend } = await sb
    .from("patient_outreach")
    .select("id")
    .eq("user_id", userId)
    .eq("direction", "outbound")
    .like("subject", `%${dedupeToken}%`)
    .limit(1)
    .maybeSingle();
  if (priorSend) {
    return {
      ok: false,
      skipReason: "already_reminded",
      message: `Already reminded at T-${offsetHours}h.`,
    };
  }

  // 3.5) v1.34.3 / v1.34.3.1: resolve the patient's cadence profile +
  //      custom message template. If Karen routed THIS patient to a
  //      named profile (via softTags.preshowProfileId — set per-patient
  //      on the detail page OR via bulk-tag on the list page), resolve
  //      that profile by id. Otherwise fall back to the spa's default
  //      profile (is_default=true). If the patient-routed profile was
  //      deleted since the override was written, we silently fall back
  //      to the default — defense-in-depth so a stale route never blocks
  //      the reminder.
  const patientRoutedProfileId =
    patientAttachments?.softTags?.preshowProfileId?.value ?? null;
  let profileRow: {
    id: string;
    tone: string;
    channel: string;
    cadence_hours: number[] | null;
    cadence_by_treatment_type: Record<string, number[]> | null;
  } | null = null;
  if (patientRoutedProfileId) {
    const { data: routedRow } = await sb
      .from("emma_preshow_profiles")
      .select("id, tone, channel, cadence_hours, cadence_by_treatment_type")
      .eq("user_id", userId)
      .eq("id", patientRoutedProfileId)
      .maybeSingle();
    profileRow = (routedRow as typeof profileRow) ?? null;
  }
  if (!profileRow) {
    const { data: defaultRow } = await sb
      .from("emma_preshow_profiles")
      .select("id, tone, channel, cadence_hours, cadence_by_treatment_type")
      .eq("user_id", userId)
      .eq("is_default", true)
      .maybeSingle();
    profileRow = (defaultRow as typeof profileRow) ?? null;
  }

  // v1.34.4: per-treatment-type cadence override. If this profile has
  // an override entry for this appointment's treatment_type, ONLY those
  // offsets are valid for this appointment — skip if offsetHours not in
  // the override list. Treatment-type match is case-insensitive against
  // the JSONB key (we always store lowercase via the UI).
  if (profileRow?.cadence_by_treatment_type && apt.treatment_type) {
    const overrideKey = apt.treatment_type.toLowerCase().trim();
    const overrideHours = profileRow.cadence_by_treatment_type[overrideKey];
    if (Array.isArray(overrideHours) && overrideHours.length > 0) {
      if (!overrideHours.includes(offsetHours)) {
        return {
          ok: false,
          skipReason: "outside_treatment_cadence",
          message: `Treatment-type override for '${overrideKey}' doesn't include T-${offsetHours}h.`,
        };
      }
    }
  }

  // Resolve effective tone + channel: profile wins over policy. Fallback
  // to policy values if profile missing (shouldn't happen after backfill,
  // defense-in-depth).
  const effectiveTone = (profileRow?.tone ?? policy.preshow_tone) as
    | "warm"
    | "professional"
    | "casual";
  const effectiveChannel = (profileRow?.channel ?? policy.preshow_channel) as
    | "sms"
    | "email"
    | "auto";

  // Look up a custom template for THIS profile×offset, if exists.
  let customTemplateBody: string | null = null;
  if (profileRow) {
    const { data: tmplRow } = await sb
      .from("emma_preshow_message_templates")
      .select("body_template")
      .eq("profile_id", profileRow.id)
      .eq("offset_hours", offsetHours)
      .maybeSingle();
    customTemplateBody = tmplRow?.body_template ?? null;
  }

  // 4) Choose channel
  let channel: "sms" | "email";
  if (effectiveChannel === "sms") {
    if (!patientAttachments?.phone) {
      return {
        ok: false,
        skipReason: "no_channel",
        message: "Spa's policy is SMS-only but no phone on file.",
      };
    }
    channel = "sms";
  } else if (effectiveChannel === "email") {
    if (!patientAttachments?.email) {
      return {
        ok: false,
        skipReason: "no_channel",
        message: "Spa's policy is email-only but no email on file.",
      };
    }
    channel = "email";
  } else {
    // auto
    if (patientAttachments?.phone) channel = "sms";
    else if (patientAttachments?.email) channel = "email";
    else
      return {
        ok: false,
        skipReason: "no_channel",
        message: "No phone or email on file.",
      };
  }

  // 5) Compose
  const spaName = await resolveSpaName(sb, userId);
  const patientFirstName = extractFirstName(patient?.title ?? null);

  // v361: if the spa hasn't set a custom optin_list_url, build Emma's
  // hosted waitlist opt-in URL using a stable per-patient token. The
  // token is minted lazily on first send; subsequent sends reuse it.
  let optinListUrl: string | null = policy.optin_list_url;
  if (policy.optin_footer_enabled && !optinListUrl && apt.patient_node_id) {
    try {
      const { getOrMintWaitlistToken, buildWaitlistOptInUrl } = await import(
        "@/server/emma-waitlist.functions"
      );
      const token = await getOrMintWaitlistToken(sb, userId, apt.patient_node_id);
      optinListUrl = buildWaitlistOptInUrl(token);
    } catch (e) {
      // Token minting failed — fall through with null URL (footer text
      // alone still appends but won't render the link in the email).
      console.error("preshow token mint failed:", e instanceof Error ? e.message : e);
    }
  }

  const composeArgs = {
    patientFirstName,
    spaName,
    treatmentType: apt.treatment_type,
    providerName: apt.provider_name,
    scheduledAt: apt.scheduled_at,
    offsetHours,
    // v1.34.3: tone comes from the profile (fallback to policy).
    tone: effectiveTone,
    optinFooterEnabled: policy.optin_footer_enabled,
    optinFooterText: policy.optin_footer_text,
    optinListUrl,
  };

  // 6) Dispatch
  const sentAt = new Date().toISOString();
  let messageId: string | null = null;
  let dispatchError: { reason: PreShowSkipReason; message: string } | null = null;
  let composedBody = "";
  let composedSubject: string | null = null;

  if (channel === "sms") {
    const fromNumber = await resolveSpaFromNumber(sb, userId);
    if (!fromNumber) {
      dispatchError = {
        reason: "from_unavailable",
        message: "Spa has no provisioned SMS number.",
      };
    } else {
      // v1.34.3: render custom template if Karen has saved one for this
      // profile×offset; otherwise fall back to code-composed default.
      // Email channel stays code-composed in v1.34.3 — template support
      // there ships in a follow-on.
      if (customTemplateBody) {
        const rendered = renderPreshowTemplate(customTemplateBody, {
          patientFirstName,
          spaName,
          treatmentType: apt.treatment_type,
          providerName: apt.provider_name,
          scheduledAt: apt.scheduled_at,
        });
        composedBody = appendPreshowFooters(rendered, {
          optinFooterEnabled: policy.optin_footer_enabled,
          optinFooterText: policy.optin_footer_text,
          optinListUrl,
        });
      } else {
        composedBody = composePreShowSmsBody(composeArgs);
      }
      try {
        const resp = await sendSms({
          from: fromNumber,
          to: patientAttachments!.phone!,
          body: composedBody,
        });
        messageId = resp.messageId;
      } catch (e) {
        dispatchError = {
          reason: "send_failed",
          message: e instanceof Error ? `sms: ${e.message}` : "sms: unknown error",
        };
      }
    }
  } else {
    const email = composePreShowEmail(composeArgs);
    composedBody = email.text;
    composedSubject = email.subject;
    const resendKey = process.env.RESEND_API_KEY;
    const fromEmail = await resolveSpaFromEmail(userId);
    if (!resendKey) {
      dispatchError = {
        reason: "from_unavailable",
        message: "Resend API key not configured.",
      };
    } else {
      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${resendKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: fromEmail,
            to: [patientAttachments!.email!],
            subject: email.subject,
            text: email.text,
            html: email.html,
            tracking: { opens: true, clicks: true },
            tags: [
              { name: "type", value: "emma-preshow" },
              { name: "appointment_id", value: apt.id },
              { name: "offset_hours", value: String(offsetHours) },
            ],
          }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
          const errBody = await res.text().catch(() => "");
          dispatchError = {
            reason: "send_failed",
            message: `resend: ${res.status} ${errBody.slice(0, 200)}`,
          };
        } else {
          const json = (await res.json().catch(() => ({}))) as { id?: string };
          messageId = json.id ?? null;
        }
      } catch (e) {
        dispatchError = {
          reason: "send_failed",
          message: e instanceof Error ? `resend: ${e.message}` : "resend: unknown error",
        };
      }
    }
  }

  // 7) Audit log — patient_outreach entry with the dedupe token in the
  //    subject so the next dispatch attempt skips. The subject is
  //    informational only on SMS but it's the easy spot to stash a
  //    dedupe marker that survives in the existing schema.
  await sb
    .from("patient_outreach")
    .insert({
      user_id: userId,
      patient_outreach_state_id: apt.id, // We're storing the appointment_id here;
      // the column is named for the campaign use but we reuse it for the
      // appointment_id here. Future migration could split this.
      direction: "outbound",
      channel,
      subject: `[${dedupeToken}] ${composedSubject ?? ""}`,
      body: composedBody,
      sent_at: dispatchError ? null : sentAt,
      message_id: messageId,
      skip_reason: dispatchError?.reason ?? null,
    })
    .then(({ error }) => {
      if (error) console.error("preshow audit insert failed:", error.message);
    });

  if (dispatchError) {
    return {
      ok: false,
      skipReason: dispatchError.reason,
      message: dispatchError.message,
    };
  }

  // Tier-2 cross-agent tally (Slice 2): a scheduled reminder just went out —
  // record a per-patient ledger row so the frequency cap counts it. Preshow is
  // TRANSACTIONAL, so it contributes to the tally but never self-suppresses
  // (we never silence a reminder for an appointment the patient actually has);
  // what it does do is make a redundant rescue blast to the same patient that
  // day yield. Best-effort — the reminder already sent.
  await recordAgentAction(sb, userId, {
    agent: "preshow",
    action: effectiveChannel === "email" ? "email_sent" : "sms_sent",
    channel: effectiveChannel === "email" ? "email" : "sms",
    patientNodeId: apt.patient_node_id,
    count: 1,
    initiatedBy: "autonomous",
    metadata: { offset_hours: offsetHours },
  });

  return { ok: true, messageId, channel, sentAt };
}

function extractFirstName(displayName: string | null): string | null {
  if (!displayName) return null;
  if (displayName.includes(",")) {
    const parts = displayName.split(",", 2).map((s) => s.trim());
    return parts[1] || null;
  }
  const parts = displayName.trim().split(/\s+/);
  return parts[0] || null;
}

// ─── listRecentReminders (UI surface) ─────────────────────────────────────

const recentInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
});

export const listRecentReminders = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => recentInput.parse(input))
  .handler(
    async ({
      data,
    }): Promise<{ sentThisWeek: number; sentToday: number; skippedThisWeek: number }> => {
      const { effectiveUserId } = await resolveEffectiveUserId({
        accessToken: data.accessToken,
        viewAsUserId: data.viewAsUserId,
      });
      const sb = admin();
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      const { data: rows } = await sb
        .from("patient_outreach")
        .select("sent_at, skip_reason, subject")
        .eq("user_id", effectiveUserId)
        .eq("direction", "outbound")
        .gte("created_at", weekAgo)
        .like("subject", "%[preshow:%");
      const all = rows ?? [];
      let sentThisWeek = 0;
      let sentToday = 0;
      let skippedThisWeek = 0;
      for (const r of all) {
        if (r.skip_reason) {
          skippedThisWeek++;
        } else if (r.sent_at) {
          sentThisWeek++;
          if (r.sent_at >= dayAgo) sentToday++;
        }
      }
      return { sentThisWeek, sentToday, skippedThisWeek };
    },
  );
