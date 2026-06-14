/**
 * Reschedule Reminders — server functions (v2.34.0, Slice 1).
 *
 * Slice 1 ships the canonical no-show classification + the settings preview —
 * NO sending yet. `getRescheduleClassificationPreview` runs the operator's own
 * notice rule over their recent cancellations and tells them, in plain numbers,
 * how many of those "cancellations" are really no-shows by that rule — making
 * the abstract rule concrete against real data before a single message is sent.
 *
 * The drafting/sending path + the /recovery/reschedule page land in Slice 2.
 */

import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { resolveEffectiveUserId } from "@/server/auth-helpers";
import { getTenantIdForUser } from "@/server/scheduling-settings.functions";
import { resolveSpaName } from "@/server/emma-spa-profile";
import { recordAgentAction, recordMessagingActivity } from "@/server/messaging-activity";
import { fetchAllRows } from "@/server/paginate";
import { classifyAppointmentOutcome } from "@/lib/noshow-classify";

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

type AnySb = ReturnType<typeof admin>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loose(sb: AnySb): { from(t: string): any } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return sb as unknown as { from(t: string): any };
}

/** The illustration window for the settings preview (independent of the
 *  operational lookback — it's a "what does my rule do" snapshot). */
const PREVIEW_WINDOW_DAYS = 30;

export type RescheduleClassificationPreview = {
  windowDays: number;
  /** The spa's current notice rule (hours). */
  noticeHours: number;
  /** status='cancelled' rows in the window. */
  cancelledTotal: number;
  /** Of those: cancelled with fair notice (≥ the rule). */
  cancelHonored: number;
  /** Of those: cancelled too late → counts as a no-show by the rule. */
  lateCancelsAsNoShow: number;
  /** Of those: cancellation time unknown → stays a cancel (never branded). */
  noticeUnknown: number;
  /** status='no_show' rows in the window (always no-shows). */
  noShowTotal: number;
};

const previewInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
  /** Optionally preview against a hypothetical rule (the slider's live value)
   *  without saving it first. Falls back to the saved policy. */
  noticeHoursOverride: z.number().int().min(0).max(336).optional(),
});

export const getRescheduleClassificationPreview = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => previewInput.parse(raw))
  .handler(async ({ data }): Promise<RescheduleClassificationPreview> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();

    // The notice rule: the live slider value if given, else the saved policy.
    let noticeHours = data.noticeHoursOverride;
    if (noticeHours === undefined) {
      const { data: policy } = await loose(sb)
        .from("emma_noshow_policies")
        .select("noshow_notice_hours")
        .eq("user_id", effectiveUserId)
        .maybeSingle();
      noticeHours = (policy?.noshow_notice_hours as number | null) ?? 24;
    }

    const sinceIso = new Date(
      Date.now() - PREVIEW_WINDOW_DAYS * 86_400_000,
    ).toISOString();

    type Row = {
      status: string;
      scheduled_at: string;
      cancelled_at: string | null;
    };
    const rows = await fetchAllRows<Row>((from, to) =>
      loose(sb)
        .from("emma_appointments")
        .select("status, scheduled_at, cancelled_at")
        .eq("user_id", effectiveUserId)
        .in("status", ["cancelled", "no_show"])
        .gte("scheduled_at", sinceIso)
        .order("scheduled_at", { ascending: false })
        .range(from, to),
    );

    let cancelledTotal = 0;
    let cancelHonored = 0;
    let lateCancelsAsNoShow = 0;
    let noticeUnknown = 0;
    let noShowTotal = 0;

    for (const r of rows) {
      if (r.status === "no_show") {
        noShowTotal += 1;
        continue;
      }
      // status === 'cancelled'
      cancelledTotal += 1;
      const res = classifyAppointmentOutcome({
        status: r.status,
        scheduledAt: r.scheduled_at,
        cancelledAt: r.cancelled_at,
        noticeHours,
      });
      if (!res.noticeKnown) noticeUnknown += 1;
      else if (res.outcome === "no_show") lateCancelsAsNoShow += 1;
      else cancelHonored += 1;
    }

    return {
      windowDays: PREVIEW_WINDOW_DAYS,
      noticeHours,
      cancelledTotal,
      cancelHonored,
      lateCancelsAsNoShow,
      noticeUnknown,
      noShowTotal,
    };
  });

// ─── The target list + the drafting (Slice 2) ────────────────────────────────
//
// The /app/refill/recovery/reschedule page lists the recent cancels/no-shows
// the operator chose to follow up (run through the canonical classifier), and a
// "Draft rebook nudges" action reuses the human-gated draft-to-proxy pipeline
// (compose → email the batch to the spa's iMessage proxy → human reviews & taps
// Send). Nothing is sent to a patient by the server.

const CHUNK = 200;

export type RescheduleOutcomeKind = "cancel" | "no_show";

export type RescheduleTarget = {
  patientNodeId: string;
  name: string;
  phone: string | null;
  email: string | null;
  /** cancel = honored cancel; no_show = no-show OR a late cancel (by the rule). */
  kind: RescheduleOutcomeKind;
  appointmentId: string;
  scheduledAt: string;
  treatmentType: string | null;
  noticeKnown: boolean;
  leadHours: number | null;
};

type ReschedulePolicy = {
  enabled: boolean;
  noticeHours: number;
  targetCancels: boolean;
  targetNoshows: boolean;
  lookbackDays: number;
  proxyEmail: string | null;
  sendingPaused: boolean;
};

async function loadReschedulePolicy(
  sb: AnySb,
  userId: string,
): Promise<ReschedulePolicy> {
  const { data } = await loose(sb)
    .from("emma_noshow_policies")
    .select(
      "reschedule_enabled, noshow_notice_hours, reschedule_target_cancels, reschedule_target_noshows, reschedule_lookback_days, rescue_proxy_email, sending_paused",
    )
    .eq("user_id", userId)
    .maybeSingle();
  const r = (data ?? {}) as Record<string, unknown>;
  return {
    enabled: (r.reschedule_enabled as boolean) ?? false,
    noticeHours: (r.noshow_notice_hours as number) ?? 24,
    targetCancels: (r.reschedule_target_cancels as boolean) ?? true,
    targetNoshows: (r.reschedule_target_noshows as boolean) ?? true,
    lookbackDays: (r.reschedule_lookback_days as number) ?? 14,
    proxyEmail: ((r.rescue_proxy_email as string | null) ?? "")?.trim() || null,
    sendingPaused: r.sending_paused === true,
  };
}

/** Chunked id-set collector — the standard guard against the .in() URL limit /
 *  silent 1,000-row cap. Reads `patient_node_id` (or `id`) off each row. */
async function collectIdSet(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  build: (slice: string[]) => PromiseLike<{ data: any }>,
  ids: string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data } = await build(ids.slice(i, i + CHUNK));
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const v = (row.patient_node_id ?? row.id) as string | undefined;
      if (v) out.add(v);
    }
  }
  return out;
}

/** The shared core: recent cancels/no-shows the operator chose to follow up,
 *  classified, deduped by patient, and stripped of anyone already nudged,
 *  already rebooked, or opted out. The list page and the drafter both call this
 *  so they never disagree. */
async function computeRescheduleTargets(
  sb: AnySb,
  userId: string,
  pol: ReschedulePolicy,
): Promise<RescheduleTarget[]> {
  const any = loose(sb);
  const sinceIso = new Date(Date.now() - pol.lookbackDays * 86_400_000).toISOString();
  const nowIso = new Date().toISOString();

  type ApptRow = {
    id: string;
    patient_node_id: string | null;
    scheduled_at: string;
    status: string;
    cancelled_at: string | null;
    treatment_type: string | null;
  };
  const appts = await fetchAllRows<ApptRow>((from, to) =>
    any
      .from("emma_appointments")
      .select("id, patient_node_id, scheduled_at, status, cancelled_at, treatment_type")
      .eq("user_id", userId)
      .in("status", ["cancelled", "no_show"])
      .gte("scheduled_at", sinceIso)
      .order("scheduled_at", { ascending: false })
      .range(from, to),
  );

  // Classify, filter to the chosen classes, dedupe to one row per patient
  // (the most recent, since the rows are ordered newest-first).
  const byPatient = new Map<string, RescheduleTarget>();
  for (const a of appts) {
    if (!a.patient_node_id || byPatient.has(a.patient_node_id)) continue;
    const res = classifyAppointmentOutcome({
      status: a.status,
      scheduledAt: a.scheduled_at,
      cancelledAt: a.cancelled_at,
      noticeHours: pol.noticeHours,
    });
    let kind: RescheduleOutcomeKind | null = null;
    if (res.outcome === "no_show") kind = "no_show";
    else if (res.outcome === "cancel_honored") kind = "cancel";
    else continue; // rescheduled / attended — not a target
    if (kind === "cancel" && !pol.targetCancels) continue;
    if (kind === "no_show" && !pol.targetNoshows) continue;
    byPatient.set(a.patient_node_id, {
      patientNodeId: a.patient_node_id,
      name: "",
      phone: null,
      email: null,
      kind,
      appointmentId: a.id,
      scheduledAt: a.scheduled_at,
      treatmentType: a.treatment_type,
      noticeKnown: res.noticeKnown,
      leadHours: res.leadHours,
    });
  }
  let ids = [...byPatient.keys()];
  if (ids.length === 0) return [];

  // Suppressions, each chunked.
  const nudged = await collectIdSet(
    (slice) =>
      any
        .from("agent_actions")
        .select("patient_node_id")
        .eq("user_id", userId)
        .eq("agent", "reschedule")
        .eq("action", "nudge_drafted")
        .gte("created_at", sinceIso)
        .in("patient_node_id", slice),
    ids,
  );
  const rebooked = await collectIdSet(
    (slice) =>
      any
        .from("emma_appointments")
        .select("patient_node_id")
        .eq("user_id", userId)
        .in("status", ["scheduled", "confirmed"])
        .gt("scheduled_at", nowIso)
        .in("patient_node_id", slice),
    ids,
  );
  const opted = await collectIdSet(
    (slice) =>
      any
        .from("patient_outreach_state")
        .select("patient_node_id")
        .eq("user_id", userId)
        .eq("state", "opted_out")
        .in("patient_node_id", slice),
    ids,
  );
  ids = ids.filter((id) => !nudged.has(id) && !rebooked.has(id) && !opted.has(id));
  if (ids.length === 0) return [];

  // Resolve contact from the patient node (emma_appointments has no denormalized
  // contact — only patient_node_id).
  const contact = new Map<string, { name: string; phone: string | null; email: string | null }>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data } = await any
      .from("knowledge_nodes")
      .select("id, title, attachments")
      .in("id", ids.slice(i, i + CHUNK));
    for (const n of (data ?? []) as Array<{
      id: string;
      title: string | null;
      attachments: { phone?: string | null; email?: string | null; displayName?: string | null } | null;
    }>) {
      const att = n.attachments ?? {};
      contact.set(n.id, {
        name: n.title ?? att.displayName ?? "",
        phone: att.phone ?? null,
        email: att.email ?? null,
      });
    }
  }

  const out: RescheduleTarget[] = ids.map((id) => {
    const t = byPatient.get(id)!;
    const c = contact.get(id);
    return { ...t, name: c?.name ?? "", phone: c?.phone ?? null, email: c?.email ?? null };
  });
  out.sort((a, b) => (a.scheduledAt < b.scheduledAt ? 1 : -1));
  return out;
}

const accessOnly = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
});

export type RescheduleTargetsResult = {
  enabled: boolean;
  targetCancels: boolean;
  targetNoshows: boolean;
  noticeHours: number;
  lookbackDays: number;
  hasProxyEmail: boolean;
  sendingPaused: boolean;
  reachable: number;
  targets: RescheduleTarget[];
};

export const listRescheduleTargets = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => accessOnly.parse(raw))
  .handler(async ({ data }): Promise<RescheduleTargetsResult> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const pol = await loadReschedulePolicy(sb, effectiveUserId);
    const targets = await computeRescheduleTargets(sb, effectiveUserId, pol);
    return {
      enabled: pol.enabled,
      targetCancels: pol.targetCancels,
      targetNoshows: pol.targetNoshows,
      noticeHours: pol.noticeHours,
      lookbackDays: pol.lookbackDays,
      hasProxyEmail: Boolean(pol.proxyEmail),
      sendingPaused: pol.sendingPaused,
      reachable: targets.filter((t) => (t.phone ?? "").trim()).length,
      targets,
    };
  });

// ── Compose + draft-to-proxy (mirrors draftOfferPushFn) ──────────────────────

const firstNameOf = (full: string): string => full.trim().split(/\s+/)[0] || "there";

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** One warm, no-blame rebook nudge — same copy whether they cancelled or
 *  no-showed (v1; a split per kind is a later refinement). */
function composeRescheduleBody(firstName: string, spaName: string, slug: string): string {
  const host = (process.env.REFILL_PUBLIC_ORIGIN ?? "https://getrefill.app")
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  const link = slug ? ` Rebook here: ${host}/s/${slug}` : "";
  return `Hi ${firstName}! It's ${spaName} — we'd love to get you back on the calendar.${link} Reply and I'll find you a time. 💛`;
}

export type RescheduleDraftResult = {
  drafted: number;
  skippedNoPhone: number;
  sentTo: string | null;
  error: string | null;
};

export const draftRescheduleNudges = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => accessOnly.parse(raw))
  .handler(async ({ data }): Promise<RescheduleDraftResult> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const pol = await loadReschedulePolicy(sb, effectiveUserId);
    if (!pol.enabled)
      throw new Error("Turn on Reschedule Reminders first (Reminders → No-show definition).");
    if (pol.sendingPaused)
      throw new Error("Sending is paused — resume it before drafting nudges.");
    if (!pol.proxyEmail)
      throw new Error(
        "Set your iMessage proxy email first (Refill → no-show settings) so drafts have somewhere to land.",
      );

    const targets = await computeRescheduleTargets(sb, effectiveUserId, pol);
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);
    const spaName = await resolveSpaName(
      sb as unknown as Parameters<typeof resolveSpaName>[0],
      effectiveUserId,
    );
    const { data: tenantRow } = await sb
      .from("tenants")
      .select("slug")
      .eq("id", tenantId)
      .maybeSingle();
    const slug = (tenantRow as { slug?: string } | null)?.slug ?? "";

    const built: Array<{
      name: string;
      phone: string;
      body: string;
      patientNodeId: string;
      appointmentId: string;
      kind: string;
    }> = [];
    let skippedNoPhone = 0;
    for (const t of targets) {
      const phone = (t.phone ?? "").trim();
      if (!phone) {
        skippedNoPhone += 1;
        continue;
      }
      built.push({
        name: t.name || "(unnamed)",
        phone,
        body: composeRescheduleBody(firstNameOf(t.name), spaName, slug),
        patientNodeId: t.patientNodeId,
        appointmentId: t.appointmentId,
        kind: t.kind,
      });
    }
    if (built.length === 0) {
      return {
        drafted: 0,
        skippedNoPhone,
        sentTo: null,
        error: "No reachable patients to nudge (none had a phone number).",
      };
    }

    const subject = `${built.length} rebook nudge${built.length === 1 ? "" : "s"} — Reschedule Reminders`;
    const rows = built
      .map(
        (b) =>
          `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee">${escHtml(b.name)}</td><td style="padding:6px 10px;border-bottom:1px solid #eee">${escHtml(b.phone)}</td><td style="padding:6px 10px;border-bottom:1px solid #eee">${escHtml(b.body)}</td></tr>`,
      )
      .join("");
    const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1c2024">
<p>Paste this whole email into Claude Desktop with the iMessage MCP installed. Claude will call <code>draft_imessage(recipient_phone, body)</code> for each row — one Messages.app conversation per draft. Review each and tap Send.</p>
<p><strong>Reschedule Reminders</strong> &middot; <strong>${built.length}</strong> patient(s)${skippedNoPhone ? ` &middot; ${skippedNoPhone} skipped (no phone)` : ""}</p>
<table style="border-collapse:collapse;font-size:13px"><thead><tr><th style="text-align:left;padding:6px 10px;border-bottom:2px solid #ccc">Name</th><th style="text-align:left;padding:6px 10px;border-bottom:2px solid #ccc">Phone</th><th style="text-align:left;padding:6px 10px;border-bottom:2px solid #ccc">Message</th></tr></thead><tbody>${rows}</tbody></table>
</div>`;
    const text = built.map((b) => `${b.name}\t${b.phone}\t${b.body}`).join("\n");

    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey) throw new Error("Server is missing RESEND_API_KEY.");
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: process.env.REFILL_FROM_EMAIL ?? "offers@getrefill.app",
          to: [pol.proxyEmail],
          subject,
          text,
          html,
          tags: [
            { name: "type", value: "refill-reschedule-nudge" },
            { name: "tenant", value: effectiveUserId },
          ],
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        return {
          drafted: built.length,
          skippedNoPhone,
          sentTo: null,
          error: `Resend ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`,
        };
      }
    } catch (e) {
      return {
        drafted: built.length,
        skippedNoPhone,
        sentTo: null,
        error: e instanceof Error ? e.message : String(e),
      };
    }

    // Mark each patient nudged (the dedupe marker — listRescheduleTargets excludes
    // patients with a recent reschedule·nudge_drafted) + a channel heartbeat.
    for (const b of built) {
      await recordAgentAction(
        sb as unknown as Parameters<typeof recordAgentAction>[0],
        effectiveUserId,
        {
          agent: "reschedule",
          action: "nudge_drafted",
          channel: "imessage",
          patientNodeId: b.patientNodeId,
          count: 1,
          initiatedBy: "owner",
          metadata: { appointmentId: b.appointmentId, kind: b.kind },
        },
      );
    }
    await recordMessagingActivity(
      sb as unknown as Parameters<typeof recordMessagingActivity>[0],
      effectiveUserId,
      "sms",
      "reschedule",
      built.length,
    );

    return { drafted: built.length, skippedNoPhone, sentTo: pol.proxyEmail, error: null };
  });
