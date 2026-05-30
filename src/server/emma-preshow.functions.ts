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
  | "send_failed";

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
  } | null;

  if (patientAttachments?.banned) {
    return {
      ok: false,
      skipReason: "banned",
      message: "Patient banned — outbound blocked.",
    };
  }
  if (patientAttachments?.opted_out) {
    return {
      ok: false,
      skipReason: "opted_out",
      message: "Patient opted out.",
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

  // 4) Choose channel
  let channel: "sms" | "email";
  if (policy.preshow_channel === "sms") {
    if (!patientAttachments?.phone) {
      return {
        ok: false,
        skipReason: "no_channel",
        message: "Spa's policy is SMS-only but no phone on file.",
      };
    }
    channel = "sms";
  } else if (policy.preshow_channel === "email") {
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
    tone: policy.preshow_tone as "warm" | "professional" | "casual",
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
      composedBody = composePreShowSmsBody(composeArgs);
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
