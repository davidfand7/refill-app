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
import { getTenantIdForUser, tenantBooksOnExternalPms } from "@/server/scheduling-settings.functions";
import { resolveSpaName } from "@/server/emma-spa-profile";
import { recordAgentAction, recordMessagingActivity } from "@/server/messaging-activity";
import { recordRecoveryEvent } from "@/server/emma-attribution.functions";
import { resolvePatientNodeByContact } from "@/server/refill-promo-calendar.functions";
import { fetchAllRows } from "@/server/paginate";
import { classifyAppointmentOutcome } from "@/lib/noshow-classify";

/** A reschedule win is attributable only when the rebooking lands within this
 *  window of the nudge — beyond it, the booking isn't credibly ours. */
const RESCHEDULE_ATTRIBUTION_DAYS = 30;

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
  /** The patient's knowledge-node id, or null for a TRULY UNMATCHED canceller —
   *  a (usually brand-new) patient with no profile yet, reachable only via the
   *  contact captured on the appointment itself (booking_phone/email, v2.46.0).
   *  Gap-A Level 2: these used to be silently dropped (the pipeline keyed on
   *  patient_node_id); they're now first-class targets. */
  patientNodeId: string | null;
  /** Stable identity for dedupe / React keys / nudge-tracking: the patient-node
   *  id when matched, `appt:<appointmentId>` when unmatched. */
  targetKey: string;
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
  /** When this patient was last drafted a nudge (ISO), or null = not yet nudged
   *  (still actionable). Set patients are shown greyed for continuity, not hidden. */
  nudgedAt: string | null;
};

/** Normalize a phone to its last 10 digits — the dedupe key for unmatched
 *  cancellers (so the same new lead with two cancels is one target, and a later
 *  rebooking under the same number is recognized as "returned"). */
function normPhone(raw: string | null): string | null {
  if (!raw) return null;
  const d = raw.replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : d || null;
}

type ReschedulePolicy = {
  enabled: boolean;
  noticeHours: number;
  targetCancels: boolean;
  targetNoshows: boolean;
  lookbackDays: number;
  delayDays: number;
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
      "reschedule_enabled, noshow_notice_hours, reschedule_target_cancels, reschedule_target_noshows, reschedule_lookback_days, reschedule_delay_days, rescue_proxy_email, sending_paused",
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
    delayDays: (r.reschedule_delay_days as number) ?? 0,
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
): Promise<{ targets: RescheduleTarget[]; heldInGrace: number }> {
  const any = loose(sb);
  const sinceIso = new Date(Date.now() - pol.lookbackDays * 86_400_000).toISOString();

  type ApptRow = {
    id: string;
    patient_node_id: string | null;
    scheduled_at: string;
    status: string;
    cancelled_at: string | null;
    treatment_type: string | null;
    booking_name: string | null;
    booking_phone: string | null;
    booking_email: string | null;
  };
  const appts = await fetchAllRows<ApptRow>((from, to) =>
    any
      .from("emma_appointments")
      .select("id, patient_node_id, scheduled_at, status, cancelled_at, treatment_type, booking_name, booking_phone, booking_email")
      .eq("user_id", userId)
      .in("status", ["cancelled", "no_show"])
      .gte("scheduled_at", sinceIso)
      .order("scheduled_at", { ascending: false })
      .range(from, to),
  );

  // Classify, filter to the chosen classes, dedupe to one row per patient
  // (the most recent, since the rows are ordered newest-first).
  const byPatient = new Map<string, RescheduleTarget>();
  // Gap-A Level 1 (v2.57): the appointment carries the patient's contact
  // (booking_phone/email, v2.46.0) even when their patient-node has none. Capture
  // the deciding appt's contact so a matched-but-contactless patient is still
  // reachable. (Truly unmatched cancellers — no patient_node at all — are handled
  // by the separate unmatched track below, Gap-A Level 2.)
  const bookingContact = new Map<string, { phone: string | null; email: string | null }>();
  // Patients whose most-recent chosen outcome is still inside the operator's
  // grace window — held back (give them time to self-rebook first), but counted
  // so the page shows them honestly instead of the list silently shrinking.
  const graceHeld = new Set<string>();
  // The deciding outcome's scheduled_at per patient — the already-returned
  // check needs it for BOTH nudge candidates and grace-held rows.
  const outcomeSchedAt = new Map<string, string>();
  // "Decided" once we hit a patient's most-recent outcome in a CHOSEN class, so
  // an older outcome can't override it. A non-chosen / non-target row still
  // falls through to an older one (preserves prior behavior; delayDays=0 is a
  // no-op so existing spas are byte-identical).
  const decided = new Set<string>();
  const graceFloorMs = pol.delayDays > 0 ? pol.delayDays * 86_400_000 : 0;
  for (const a of appts) {
    if (!a.patient_node_id || decided.has(a.patient_node_id)) continue;
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
    // The patient's most-recent outcome in a chosen class → it decides them.
    decided.add(a.patient_node_id);
    outcomeSchedAt.set(a.patient_node_id, a.scheduled_at);
    if (graceFloorMs > 0) {
      // Anchor the grace window on WHEN the outcome happened: the cancel time
      // if known, else the appointment time (a no-show is anchored to the appt
      // time; an untimed CSV cancel falls back to scheduled_at).
      const outcomeAtMs = Date.parse(a.cancelled_at ?? a.scheduled_at);
      if (Number.isFinite(outcomeAtMs) && Date.now() - outcomeAtMs < graceFloorMs) {
        graceHeld.add(a.patient_node_id); // still in the grace window — hold
        continue;
      }
    }
    bookingContact.set(a.patient_node_id, {
      phone: (a.booking_phone ?? "").trim() || null,
      email: (a.booking_email ?? "").trim() || null,
    });
    byPatient.set(a.patient_node_id, {
      patientNodeId: a.patient_node_id,
      targetKey: a.patient_node_id,
      name: "",
      phone: null,
      email: null,
      kind,
      appointmentId: a.id,
      scheduledAt: a.scheduled_at,
      treatmentType: a.treatment_type,
      noticeKnown: res.noticeKnown,
      leadHours: res.leadHours,
      nudgedAt: null, // filled in below once the nudge map is built
    });
  }

  // ── Gap-A Level 2: the UNMATCHED track ──────────────────────────────────────
  // A cancel/no-show with NO patient_node at all (a brand-new patient who never
  // matched a profile) was dropped above. But the appointment still carries their
  // contact (booking_name/phone/email, v2.46.0), so they ARE reachable. Build them
  // as first-class targets keyed by the appointment, deduped by phone (one nudge
  // per new lead, newest cancel wins since appts are newest-first). State that
  // keys on patient_node_id doesn't apply: opt-out can't exist (no node), and the
  // "already returned" + nudge-dedupe checks below are done by contact / appt id.
  type UnmatchedDraft = {
    appointmentId: string;
    scheduledAt: string;
    kind: RescheduleOutcomeKind;
    name: string;
    phone: string | null;
    email: string | null;
    treatmentType: string | null;
    noticeKnown: boolean;
    leadHours: number | null;
  };
  const unmatched: UnmatchedDraft[] = [];
  const seenUnmatchedPhone = new Set<string>();
  let unmatchedHeldInGrace = 0;
  for (const a of appts) {
    if (a.patient_node_id) continue; // matched handled above
    const res = classifyAppointmentOutcome({
      status: a.status,
      scheduledAt: a.scheduled_at,
      cancelledAt: a.cancelled_at,
      noticeHours: pol.noticeHours,
    });
    let kind: RescheduleOutcomeKind | null = null;
    if (res.outcome === "no_show") kind = "no_show";
    else if (res.outcome === "cancel_honored") kind = "cancel";
    else continue;
    if (kind === "cancel" && !pol.targetCancels) continue;
    if (kind === "no_show" && !pol.targetNoshows) continue;
    const phone = (a.booking_phone ?? "").trim() || null;
    const email = (a.booking_email ?? "").trim() || null;
    if (!phone && !email) continue; // truly unreachable — nothing to nudge
    // Grace window (same anchor as matched): hold a too-recent outcome back.
    if (graceFloorMs > 0) {
      const outcomeAtMs = Date.parse(a.cancelled_at ?? a.scheduled_at);
      if (Number.isFinite(outcomeAtMs) && Date.now() - outcomeAtMs < graceFloorMs) {
        unmatchedHeldInGrace += 1;
        continue;
      }
    }
    // Dedupe by phone so the same new lead with multiple cancels is one target.
    const pk = normPhone(phone);
    if (pk) {
      if (seenUnmatchedPhone.has(pk)) continue;
      seenUnmatchedPhone.add(pk);
    }
    unmatched.push({
      appointmentId: a.id,
      scheduledAt: a.scheduled_at,
      kind,
      name: (a.booking_name ?? "").trim(),
      phone,
      email,
      treatmentType: a.treatment_type,
      noticeKnown: res.noticeKnown,
      leadHours: res.leadHours,
    });
  }

  let ids = [...byPatient.keys()];
  // The opted-out / already-returned facts are needed for nudge candidates AND
  // grace-held patients (so the held count excludes anyone who already came back).
  const factIds = [...new Set([...ids, ...graceHeld])];
  // Early out only when BOTH tracks are empty (matched AND unmatched).
  if (factIds.length === 0 && unmatched.length === 0) {
    return { targets: [], heldInGrace: 0 };
  }

  // Nudged maps — ONE pull of recent reschedule nudges serves both tracks: matched
  // patients dedupe by patient_node_id, unmatched by the cancelled appointment id
  // (which the draft path records in metadata). We KEEP nudged targets (shown
  // greyed for continuity); the draft path filters them so they're never re-texted.
  // Bounded by the lookback window + human-gated (small) — paginated for safety.
  const nudgedAt = new Map<string, string>(); // patient_node_id → ISO
  const nudgedApptAt = new Map<string, string>(); // appointmentId → ISO
  type NudgeRow = {
    patient_node_id: string | null;
    created_at: string;
    metadata: { appointmentId?: string } | null;
  };
  const nudgeRows = await fetchAllRows<NudgeRow>((from, to) =>
    any
      .from("agent_actions")
      .select("patient_node_id, created_at, metadata")
      .eq("user_id", userId)
      .eq("agent", "reschedule")
      .eq("action", "nudge_drafted")
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .range(from, to),
  );
  for (const r of nudgeRows) {
    if (r.patient_node_id && !nudgedAt.has(r.patient_node_id)) {
      nudgedAt.set(r.patient_node_id, r.created_at);
    }
    const apptId = r.metadata?.appointmentId;
    if (apptId && !nudgedApptAt.has(apptId)) nudgedApptAt.set(apptId, r.created_at);
  }

  const opted = await collectIdSet(
    (slice) =>
      any
        .from("patient_outreach_state")
        .select("patient_node_id")
        .eq("user_id", userId)
        .eq("state", "opted_out")
        .in("patient_node_id", slice),
    factIds,
  );

  // "Already rescheduled" (matched) = the patient has a REAL appointment (anything
  // that isn't itself a cancel/no-show) dated AFTER the cancel/no-show we'd nudge
  // them about — a future booking OR a past visit they already attended. Either
  // way they've come back; don't nudge.
  const goodMaxByPatient = new Map<string, string>();
  for (let i = 0; i < factIds.length; i += CHUNK) {
    const { data } = await any
      .from("emma_appointments")
      .select("patient_node_id, scheduled_at")
      .eq("user_id", userId)
      .in("status", ["scheduled", "confirmed", "showed", "rescheduled"])
      .in("patient_node_id", factIds.slice(i, i + CHUNK));
    for (const r of (data ?? []) as Array<{
      patient_node_id: string | null;
      scheduled_at: string;
    }>) {
      if (!r.patient_node_id) continue;
      const prev = goodMaxByPatient.get(r.patient_node_id);
      if (!prev || r.scheduled_at > prev) goodMaxByPatient.set(r.patient_node_id, r.scheduled_at);
    }
  }
  const hasReturned = (id: string): boolean => {
    const latestGood = goodMaxByPatient.get(id);
    const outcomeAt = outcomeSchedAt.get(id);
    // ISO timestamps compare lexicographically = chronologically.
    return Boolean(latestGood && outcomeAt && latestGood > outcomeAt);
  };

  // "Already rescheduled" (unmatched) = by CONTACT: a later good appt carrying the
  // same booking_phone/email means this new lead already came back. Best-effort —
  // it matches the contact string as the feed stores it (consistent within one
  // spa's source); a number reformatted between visits could be missed, which only
  // risks a warm, no-blame nudge to someone who returned — never a wrong send.
  const goodMaxByContact = new Map<string, string>(); // "p:<10d>" | "e:<lower>" → ISO
  if (unmatched.length) {
    const rawPhones = [
      ...new Set(unmatched.map((u) => u.phone).filter((v): v is string => !!v)),
    ];
    const rawEmails = [
      ...new Set(unmatched.map((u) => u.email).filter((v): v is string => !!v)),
    ];
    const absorb = (
      rows: Array<{ booking_phone: string | null; booking_email: string | null; scheduled_at: string }>,
    ) => {
      for (const r of rows) {
        const pk = normPhone(r.booking_phone);
        const ek = (r.booking_email ?? "").trim().toLowerCase() || null;
        for (const key of [pk ? `p:${pk}` : null, ek ? `e:${ek}` : null]) {
          if (!key) continue;
          const prev = goodMaxByContact.get(key);
          if (!prev || r.scheduled_at > prev) goodMaxByContact.set(key, r.scheduled_at);
        }
      }
    };
    type GoodContactRow = {
      booking_phone: string | null;
      booking_email: string | null;
      scheduled_at: string;
    };
    // Chunk by the .in() set AND paginate each chunk's rows (selectAllRows): 200
    // contacts can each carry several good appts → the result can top the 1,000-row
    // PostgREST cap, which would silently drop a rebooking and falsely nudge a
    // returned patient (feedback_silent_truncation_audit — always paginate bulk reads).
    for (let i = 0; i < rawPhones.length; i += CHUNK) {
      const slice = rawPhones.slice(i, i + CHUNK);
      const rows = await fetchAllRows<GoodContactRow>((from, to) =>
        any
          .from("emma_appointments")
          .select("booking_phone, booking_email, scheduled_at")
          .eq("user_id", userId)
          .in("status", ["scheduled", "confirmed", "showed", "rescheduled"])
          .in("booking_phone", slice)
          .range(from, to),
      );
      absorb(rows);
    }
    for (let i = 0; i < rawEmails.length; i += CHUNK) {
      const slice = rawEmails.slice(i, i + CHUNK);
      const rows = await fetchAllRows<GoodContactRow>((from, to) =>
        any
          .from("emma_appointments")
          .select("booking_phone, booking_email, scheduled_at")
          .eq("user_id", userId)
          .in("status", ["scheduled", "confirmed", "showed", "rescheduled"])
          .in("booking_email", slice)
          .range(from, to),
      );
      absorb(rows);
    }
  }
  const unmatchedReturned = (u: UnmatchedDraft): boolean => {
    const pk = normPhone(u.phone);
    const ek = (u.email ?? "").trim().toLowerCase() || null;
    const candidates = [
      pk ? goodMaxByContact.get(`p:${pk}`) : undefined,
      ek ? goodMaxByContact.get(`e:${ek}`) : undefined,
    ].filter((v): v is string => !!v);
    if (!candidates.length) return false;
    const latestGood = candidates.sort().at(-1)!;
    return latestGood > u.scheduledAt;
  };

  // Honest grace count across BOTH tracks (matched excludes opted/returned;
  // unmatched grace-held are counted as-is — a short window, brand-new leads).
  const heldInGrace =
    [...graceHeld].filter((id) => !opted.has(id) && !hasReturned(id)).length +
    unmatchedHeldInGrace;

  // Drop opted-out + already-returned (matched); KEEP nudged (shown greyed).
  ids = ids.filter((id) => !opted.has(id) && !hasReturned(id));

  // Resolve matched contact from the patient node, then fall back to the appt's
  // own booking_phone/email (Gap-A Level 1) so a node with no contact still reaches.
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

  const matchedTargets: RescheduleTarget[] = ids.map((id) => {
    const t = byPatient.get(id)!;
    const c = contact.get(id);
    const bc = bookingContact.get(id);
    return {
      ...t,
      name: c?.name ?? "",
      phone: (c?.phone ?? "").trim() || bc?.phone || null,
      email: (c?.email ?? "").trim() || bc?.email || null,
      nudgedAt: nudgedAt.get(id) ?? null,
    };
  });

  // Unmatched targets (Gap-A Level 2): drop already-returned, key by appointment,
  // dedupe-nudge by appointment id (the marker the draft path writes to metadata).
  const unmatchedTargets: RescheduleTarget[] = unmatched
    .filter((u) => !unmatchedReturned(u))
    .map((u) => ({
      patientNodeId: null,
      targetKey: `appt:${u.appointmentId}`,
      name: u.name,
      phone: u.phone,
      email: u.email,
      kind: u.kind,
      appointmentId: u.appointmentId,
      scheduledAt: u.scheduledAt,
      treatmentType: u.treatmentType,
      noticeKnown: u.noticeKnown,
      leadHours: u.leadHours,
      nudgedAt: nudgedApptAt.get(u.appointmentId) ?? null,
    }));

  const out: RescheduleTarget[] = [...matchedTargets, ...unmatchedTargets];
  // Actionable (not yet nudged) first, then by recency.
  out.sort((a, b) => {
    if (!a.nudgedAt !== !b.nudgedAt) return a.nudgedAt ? 1 : -1;
    return a.scheduledAt < b.scheduledAt ? 1 : -1;
  });
  return { targets: out, heldInGrace };
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
  delayDays: number;
  hasProxyEmail: boolean;
  sendingPaused: boolean;
  reachable: number;
  /** Patients whose cancel/no-show is still inside the grace window — held back
   *  (not yet nudged) to give them a chance to self-rebook. Shown for honesty. */
  heldInGrace: number;
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
    const { targets, heldInGrace } = await computeRescheduleTargets(
      sb,
      effectiveUserId,
      pol,
    );
    return {
      enabled: pol.enabled,
      targetCancels: pol.targetCancels,
      targetNoshows: pol.targetNoshows,
      noticeHours: pol.noticeHours,
      lookbackDays: pol.lookbackDays,
      delayDays: pol.delayDays,
      hasProxyEmail: Boolean(pol.proxyEmail),
      sendingPaused: pol.sendingPaused,
      // Reachable = fresh (not-yet-nudged) patients with a phone — the count the
      // Draft button acts on. Already-nudged ones are shown but not re-drafted.
      reachable: targets.filter((t) => !t.nudgedAt && (t.phone ?? "").trim()).length,
      heldInGrace,
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

    const { targets } = await computeRescheduleTargets(sb, effectiveUserId, pol);
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
    let slug = (tenantRow as { slug?: string } | null)?.slug ?? "";
    // v2.74.0 — an external-PMS (Acuity) spa gates native self-booking, so a
    // /s/<slug> "Rebook here" link dead-ends on the "unavailable" page. Drop the
    // link for those spas; the "Reply and I'll find you a time" CTA still stands
    // (the human rebooks via Acuity — the act-layer model).
    if (slug && (await tenantBooksOnExternalPms(sb, tenantId))) slug = "";

    const built: Array<{
      name: string;
      phone: string;
      body: string;
      patientNodeId: string | null;
      appointmentId: string;
      kind: string;
    }> = [];
    let skippedNoPhone = 0;
    for (const t of targets) {
      if (t.nudgedAt) continue; // already drafted in-window — never re-text
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

// ─── The $5 win (Slice 3) ────────────────────────────────────────────────────
//
// Called from the booking paths (owner create + public self-book), AFTER the
// cross-sell hook, so a rebooking that's ALSO a cross-sell stays a single $5 win
// (the one-event-per-appointment unique index lets cross_sell — recorded first —
// win the tie; this no-ops via 23505). Credits reschedule_booking when a
// recently-nudged patient rebooks. Best-effort, never blocks a booking.
//
// Attribution note (honest): the signal is "we drafted a nudge for this patient"
// (agent_actions reschedule·nudge_drafted) — the owner reviews + sends via the
// iMessage MCP, which is outside our system, so a draft is the truest send-proxy
// we have. Provisional until the reconcile cron matches a real transaction, so
// it only bills verified — same conservative path as cross-sell / recall.
export async function recordRescheduleWinIfNudged(args: {
  sb: AnySb;
  userId: string;
  appointmentId: string;
  email: string | null;
  phone: string | null;
}): Promise<{ recorded: boolean; reason?: string }> {
  const patientNodeId = await resolvePatientNodeByContact(
    args.sb,
    args.userId,
    args.email,
    args.phone,
  );
  if (!patientNodeId) return { recorded: false, reason: "unmatched_patient" };

  const sinceIso = new Date(
    Date.now() - RESCHEDULE_ATTRIBUTION_DAYS * 86_400_000,
  ).toISOString();
  const { data: nudge } = await loose(args.sb)
    .from("agent_actions")
    .select("id")
    .eq("user_id", args.userId)
    .eq("agent", "reschedule")
    .eq("action", "nudge_drafted")
    .eq("patient_node_id", patientNodeId)
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!nudge) return { recorded: false, reason: "no_recent_nudge" };

  await recordRecoveryEvent({
    sb: args.sb as unknown as Parameters<typeof recordRecoveryEvent>[0]["sb"],
    userId: args.userId,
    appointmentId: args.appointmentId,
    patientNodeId,
    recoveryAgent: "reschedule",
    metricKey: "reschedule_booking",
    attributionMethod: "direct",
    notes: "Reschedule: rebooked after a reschedule nudge",
  });
  return { recorded: true };
}
