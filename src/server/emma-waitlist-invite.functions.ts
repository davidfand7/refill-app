/**
 * Cold opt-in invite pipeline (v1.27.1).
 *
 * Karen's v1.27.x production keystone — getting real Rejuv patients onto
 * the waitlist for the first time. Distinct from emma-waitlist-seed (v374)
 * which only mints rows + tokens and dumps URLs into a UI table for manual
 * distribution. This pipeline ALSO:
 *
 *   1. Renders a per-tenant editable invite body with {first_name},
 *      {opt_in_url}, {spa_name}, {owner_name} tokens substituted server-side.
 *   2. Composes a proxy email to the spa owner with one ready-to-send
 *      iMessage draft section per patient — matching the rescue-dispatcher's
 *      AUTO-SEND / Claude-Desktop-MCP framing so the same hourly cron at
 *      Karen's Mac picks it up and drafts blue-bubble iMessages.
 *   3. Sends the proxy email via Resend to `emma_noshow_policies
 *      .rescue_proxy_email` (Karen's Apple-ID-linked inbox).
 *
 * iMessage MCP, NOT SMS. The path is: Refill → Resend email → Karen's Mac →
 * Claude Desktop with imessage-draft MCP → Messages.app draft → Karen taps
 * Send → blue-bubble iMessage to patient from her actual Apple ID. The cost
 * structure is Karen's $20/mo Claude Pro, NOT Refill COGS.
 *
 * Established 2026-05-30 (v1.27.1).
 */

import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { resolveEffectiveUserId } from "@/server/auth-helpers";
import { getOrMintWaitlistToken } from "@/server/emma-waitlist.functions";
import {
  getSpaProfileBundle,
  resolveSpaName,
  resolveOwnerDisplayName,
} from "@/server/emma-spa-profile";
import { resolveSpaFromEmail } from "@/server/emma-sender.functions";

const PUBLIC_REFILL_ORIGIN =
  process.env.PUBLIC_REFILL_URL ?? "https://getrefill.app";

/**
 * System-default invite body. Karen-toned but generic via tokens so any spa
 * owner sees their own spa-name + owner-name + per-patient first-name +
 * per-patient opt-in URL substituted at render time. Empty/null override
 * in the spa-profile invite-copy-template lookup_key = use this default.
 *
 * Style follows feedback_consumer_language + feedback_real_world_first_then_match
 * — reads like a friend texting, not a marketing blast. Single sentence value
 * prop. Direct ask. STOP keyword for TCPA defensibility on the iMessage
 * thread.
 */
export const DEFAULT_INVITE_TEMPLATE = `Hi {first_name}! It's {owner_name} from {spa_name}. Quick invite — I'm starting a "first dibs" list for when slots open up unexpectedly (cancellation, reschedule, last-minute opening). Want me to text you first when a great one frees up? Tap to join: {opt_in_url}

Reply STOP anytime to leave.`;

function admin() {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

type SupabaseAdmin = ReturnType<typeof admin>;

// ─── Token rendering ──────────────────────────────────────────────────────

function renderInviteBody(args: {
  template: string;
  firstName: string;
  spaName: string;
  ownerName: string;
  optInUrl: string;
}): string {
  return args.template
    .replace(/\{first_name\}/g, args.firstName)
    .replace(/\{spa_name\}/g, args.spaName)
    .replace(/\{owner_name\}/g, args.ownerName)
    .replace(/\{opt_in_url\}/g, args.optInUrl);
}

// firstName lifted from emma-waitlist.functions.ts pattern. Internal copy
// to avoid widening the exported surface of that module.
function extractFirstName(displayName: string | null): string {
  if (!displayName) return "there";
  if (displayName.includes(",")) {
    const parts = displayName.split(",", 2).map((s) => s.trim());
    return parts[1] || "there";
  }
  const parts = displayName.trim().split(/\s+/);
  return parts[0] || "there";
}

// ─── Compose proxy email ──────────────────────────────────────────────────

type InviteDraft = {
  firstName: string;
  fullName: string;
  phone: string;
  body: string;
};

function composeInviteProxyEmail(args: {
  spaName: string;
  drafts: InviteDraft[];
}): { subject: string; text: string; html: string } {
  const subject = `${args.spaName} — ${args.drafts.length} waitlist invite${
    args.drafts.length === 1 ? "" : "s"
  } ready to send`;

  const draftLines = args.drafts
    .map((d) =>
      [
        "────────────────",
        `To: ${d.phone} (${d.fullName})`,
        "",
        d.body,
      ].join("\n"),
    )
    .join("\n\n");

  const text = [
    "═══ AUTO-SEND ═══",
    "Paste this whole email into Claude Desktop with the iMessage MCP installed.",
    "Claude will call draft_imessage(recipient_phone, body) for each patient below —",
    "one Messages.app conversation per draft. Review each and tap Send.",
    "═════════════════",
    "",
    `${args.drafts.length} ${
      args.drafts.length === 1 ? "patient" : "patients"
    } selected. Each invite includes a unique opt-in URL — patient tap = waitlist row flips paused → active, treatment-matched rescue offers can target them.`,
    "",
    "═══ READY-TO-SEND DRAFTS ═══",
    "",
    draftLines,
    "",
    "═══ END DRAFTS ═══",
    "",
    "Prefer manual? Just copy any draft above into Messages.app yourself.",
  ].join("\n");

  const draftBlocks = args.drafts
    .map(
      (d) =>
        `<div style="margin:18px 0;padding:14px 16px;background:#f7f6f3;border-left:3px solid #047857;border-radius:6px;">
  <div style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:#222;margin-bottom:8px;"><strong>To:</strong> ${d.phone} <span style="color:#666;">(${d.fullName})</span></div>
  <div style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:#222;white-space:pre-wrap;">${d.body}</div>
</div>`,
    )
    .join("");

  const html = `<!doctype html><html><body style="margin:0;padding:32px;background:#fafaf7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Inter,sans-serif;color:#1a1a1a;">
  <div style="max-width:640px;margin:0 auto;">
    <div style="margin-bottom:20px;padding:14px 16px;background:#ecfdf5;border-left:3px solid #047857;border-radius:6px;font-size:13px;color:#064e3b;line-height:1.55;">
      <div style="font-size:11px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#047857;margin-bottom:6px;">Auto-send</div>
      Paste this whole email into Claude Desktop with the iMessage MCP installed. Claude will call <code style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;background:#d1fae5;padding:1px 5px;border-radius:3px;">draft_imessage(recipient_phone, body)</code> for each patient below &mdash; one Messages.app conversation per draft. Review each and tap Send.
    </div>
    <div style="font-size:14px;color:#374151;line-height:1.55;margin-bottom:18px;">${args.drafts.length} ${args.drafts.length === 1 ? "patient" : "patients"} selected. Each invite includes a unique opt-in URL &mdash; patient tap = waitlist row flips paused &rarr; active, treatment-matched rescue offers can target them.</div>
    <div style="font-size:11px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#047857;margin:24px 0 8px;">Ready-to-send drafts</div>
    ${draftBlocks}
    <div style="font-size:12px;color:#6b7280;line-height:1.55;margin-top:20px;border-top:1px solid #e5e7eb;padding-top:14px;">Prefer manual? Just copy any draft above into Messages.app yourself.</div>
  </div>
</body></html>`;

  return { subject, text, html };
}

// ─── sendOptInInviteBatchFn ────────────────────────────────────────────────

export type InviteBatchRowResult = {
  patientNodeId: string;
  name: string | null;
  phone: string | null;
  status:
    | "sent"
    | "skipped_already_on_waitlist"
    | "skipped_no_phone"
    | "skipped_banned_or_opted_out"
    | "error";
  errorMessage: string | null;
};

export type InviteBatchResult = {
  ok: boolean;
  total: number;
  sent: number;
  skipped: number;
  errored: number;
  proxyEmailMessageId: string | null;
  rows: InviteBatchRowResult[];
};

const sendInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
  patientNodeIds: z.array(z.string().uuid()).min(1).max(50),
  inviteBody: z.string().min(20).max(2000),
});

export const sendOptInInviteBatchFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => sendInput.parse(raw))
  .handler(async ({ data }): Promise<InviteBatchResult> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();

    const [bundle, policy, patientsRes] = await Promise.all([
      getSpaProfileBundle(sb, effectiveUserId),
      sb
        .from("emma_noshow_policies")
        .select("rescue_proxy_email")
        .eq("user_id", effectiveUserId)
        .maybeSingle(),
      sb
        .from("knowledge_nodes")
        .select("id, title, attachments")
        .eq("user_id", effectiveUserId)
        .in("id", data.patientNodeIds),
    ]);

    const proxyEmail = policy.data?.rescue_proxy_email?.trim() || null;
    if (!proxyEmail) {
      throw new Error(
        "Set a rescue proxy email in Settings → No-show policy before sending invites. That's the inbox we send the iMessage drafts to.",
      );
    }

    const spaName = bundle.spaName?.trim() || (await resolveSpaName(sb, effectiveUserId));
    const ownerName =
      bundle.ownerDisplayName?.trim() ||
      (await resolveOwnerDisplayName(sb, effectiveUserId)) ||
      spaName;

    const patientById = new Map(
      (patientsRes.data ?? []).map((p) => [p.id, p]),
    );

    const drafts: InviteDraft[] = [];
    const rows: InviteBatchRowResult[] = [];

    for (const patientNodeId of data.patientNodeIds) {
      const patient = patientById.get(patientNodeId);
      const attachments = patient?.attachments as
        | { phone?: string; email?: string; banned?: boolean; opted_out?: boolean }
        | null;
      const name = patient?.title?.trim() || null;
      const phone = attachments?.phone?.trim() || null;

      if (!patient) {
        rows.push({
          patientNodeId,
          name: null,
          phone: null,
          status: "error",
          errorMessage: "Patient not found in this tenant.",
        });
        continue;
      }

      if (attachments?.banned || attachments?.opted_out) {
        rows.push({
          patientNodeId,
          name,
          phone,
          status: "skipped_banned_or_opted_out",
          errorMessage: null,
        });
        continue;
      }

      if (!phone) {
        rows.push({
          patientNodeId,
          name,
          phone: null,
          status: "skipped_no_phone",
          errorMessage: null,
        });
        continue;
      }

      try {
        const { data: existing } = await sb
          .from("emma_waitlist")
          .select("id, status")
          .eq("user_id", effectiveUserId)
          .eq("patient_node_id", patientNodeId)
          .maybeSingle();

        if (existing && existing.status === "active") {
          rows.push({
            patientNodeId,
            name,
            phone,
            status: "skipped_already_on_waitlist",
            errorMessage: null,
          });
          continue;
        }

        if (existing) {
          const { error: updateErr } = await sb
            .from("emma_waitlist")
            .update({
              status: "paused",
              opt_in_source: "spa-manual",
              revoked_at: null,
            })
            .eq("id", existing.id);
          if (updateErr) throw new Error(updateErr.message);
        } else {
          const { error: insertErr } = await sb
            .from("emma_waitlist")
            .insert({
              user_id: effectiveUserId,
              patient_node_id: patientNodeId,
              status: "paused",
              opt_in_source: "spa-manual",
              intent_type: "catchall",
              treatment_types: [],
            });
          if (insertErr) throw new Error(insertErr.message);
        }

        const token = await getOrMintWaitlistToken(
          sb,
          effectiveUserId,
          patientNodeId,
        );
        const optInUrl = `${PUBLIC_REFILL_ORIGIN}/waitlist/optin/${token}`;
        const firstName = extractFirstName(name);
        const body = renderInviteBody({
          template: data.inviteBody,
          firstName,
          spaName,
          ownerName,
          optInUrl,
        });

        drafts.push({
          firstName,
          fullName: name ?? firstName,
          phone,
          body,
        });

        rows.push({
          patientNodeId,
          name,
          phone,
          status: "sent",
          errorMessage: null,
        });
      } catch (e) {
        rows.push({
          patientNodeId,
          name,
          phone,
          status: "error",
          errorMessage: e instanceof Error ? e.message : String(e),
        });
      }
    }

    let proxyEmailMessageId: string | null = null;
    let sendError: string | null = null;

    if (drafts.length > 0) {
      const resendKey = process.env.RESEND_API_KEY;
      if (!resendKey) {
        sendError = "RESEND_API_KEY missing on the worker.";
      } else {
        const fromEmail = await resolveSpaFromEmail(effectiveUserId);
        const email = composeInviteProxyEmail({ spaName, drafts });
        try {
          const res = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${resendKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              from: fromEmail,
              to: [proxyEmail],
              subject: email.subject,
              text: email.text,
              html: email.html,
              tags: [
                { name: "type", value: "refill-waitlist-invite" },
                { name: "tenant", value: effectiveUserId },
              ],
            }),
            signal: AbortSignal.timeout(20_000),
          });
          if (res.ok) {
            const json = (await res.json().catch(() => ({}))) as {
              id?: string;
            };
            proxyEmailMessageId = json.id ?? null;
          } else {
            const errBody = await res.text().catch(() => "");
            sendError = `Resend ${res.status}: ${errBody.slice(0, 200)}`;
          }
        } catch (e) {
          sendError =
            e instanceof Error ? e.message : "Resend request failed.";
        }
      }
    }

    if (sendError) {
      for (const r of rows) {
        if (r.status === "sent") {
          r.status = "error";
          r.errorMessage = `Waitlist row created but proxy email failed: ${sendError}`;
        }
      }
    }

    const sent = rows.filter((r) => r.status === "sent").length;
    const skipped = rows.filter((r) => r.status.startsWith("skipped_")).length;
    const errored = rows.filter((r) => r.status === "error").length;

    return {
      ok: sendError === null && drafts.length > 0,
      total: data.patientNodeIds.length,
      sent,
      skipped,
      errored,
      proxyEmailMessageId,
      rows,
    };
  });

// ─── Convenience for the picker UI: read the effective invite copy ────────

const templateInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
});

export type InviteCopyTemplateResult = {
  template: string;
  isDefault: boolean;
};

export const getInviteCopyTemplateFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => templateInput.parse(raw))
  .handler(async ({ data }): Promise<InviteCopyTemplateResult> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const bundle = await getSpaProfileBundle(admin(), effectiveUserId);
    const override = bundle.inviteCopyTemplate?.trim();
    if (override && override.length >= 20) {
      return { template: override, isDefault: false };
    }
    return { template: DEFAULT_INVITE_TEMPLATE, isDefault: true };
  });
