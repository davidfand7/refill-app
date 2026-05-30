/**
 * Emma(OS) same-day rescue agent (v361).
 *
 * When an appointment flips to 'cancelled' or 'no_show' with a future
 * scheduled_at, the dispatcher picks 3-5 fit-patients from the waitlist
 * and fires parallel SMS with claim links. First patient to tap claims.
 *
 * Three surfaces:
 *   dispatchRescueAttempt    — internal helper called by
 *                              emma-appointments.updateAppointmentStatus
 *                              when status flips. Pure fn shape: (sb,
 *                              userId, appointmentId).
 *   getRescueOfferPayload    — public (token-only) — what the claim
 *                              landing page shows.
 *   claimRescueSlot          — public (token-only) — first-tap-wins.
 *   listRescueActivity       — spa-facing — for /app/refill/rescue.
 *
 * Fit-patient selection:
 *   1. emma_waitlist where status='active' for this spa
 *   2. Treatment-type filter — if patient's treatment_types is non-empty,
 *      the freed appointment's treatment_type must be in the list
 *      (case-insensitive substring); empty list = open to anything.
 *      Same for the spa's policy.rescue_eligible_treatments.
 *   3. Sort by lifetime value (from patient attachments.lifetimeSpendUsd)
 *      desc — top spenders get first crack.
 *   4. Cap at policy.rescue_max_concurrent (default 5).
 *
 * Compliance: opted_out / banned patients are excluded. The claim SMS
 * gets a STOP footer (standard).
 *
 * Race-safe claim: UPDATE emma_rescue_offers SET claimed_at = now()
 *   WHERE id = $offer_id AND claimed_at IS NULL RETURNING *
 * The reassign step then takes a second lock on emma_appointments to
 * make sure the appointment is still in cancelled/no_show state.
 *
 * Established 2026-05-17 (Promotions Engine v361).
 */

import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { sendSms } from "@/server/sms-provider";
import { resolveSpaFromEmail } from "@/server/emma-sender.functions";

// ─── Public types ─────────────────────────────────────────────────────────

export type RescueDispatchResult = {
  ok: boolean;
  attemptId: string | null;
  offersSent: number;
  reason?: string;
};

export type RescueOfferPayload = {
  spaName: string;
  patientFirstName: string | null;
  /** State of the offer + the underlying appointment. */
  status:
    | "claimable"
    | "already_claimed_by_you"
    | "claimed_by_someone_else"
    | "no_longer_available"
    | "expired";
  treatmentType: string | null;
  providerName: string | null;
  /** v1.26.12 — solo-practitioner override; rendered when providerName equals
   * spaName (the calendar-as-practice case). Null = render no "with" clause
   * for that case (current default for multi-practitioner spas). */
  ownerDisplayName: string | null;
  scheduledAt: string;
  durationMin: number;
};

export type RescueClaimResult = {
  ok: boolean;
  status: RescueOfferPayload["status"];
  scheduledAt?: string;
};

export type RescueActivityItem = {
  attemptId: string;
  freedAppointmentScheduledAt: string;
  freedAppointmentTreatment: string | null;
  status: "active" | "filled" | "closed_unfilled" | "cancelled";
  triggeredAt: string;
  outreachCount: number;
  filledAt: string | null;
  filledPatientName: string | null;
};

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

// ─── URL builder ──────────────────────────────────────────────────────────

function buildRescueClaimUrl(token: string): string {
  // v1.4.5: was hardcoded to https://emma.agentiport.com — the legacy
  // openagenticv4 host. After the Refill cleave, patient claim URLs must
  // resolve on getrefill.app where the /rescue/claim/$token route lives
  // (src/routes/rescue.claim.$token.tsx). Caught during Karen's first
  // successful end-to-end live cancel 2026-05-26 1:02 PM MT — the rescue
  // email landed correctly but the embedded URL pointed at a dead host.
  // Pattern matches src/server/rep-platform.ts.
  const base = (process.env.REFILL_PUBLIC_ORIGIN ?? "https://getrefill.app").replace(/\/+$/, "");
  return `${base}/rescue/claim/${token}`;
}

// ─── Spa name + from-number helpers ───────────────────────────────────────

async function resolveSpaName(sb: SupabaseAdmin, userId: string): Promise<string> {
  const { data } = await sb
    .from("knowledge_nodes")
    .select("title")
    .eq("user_id", userId)
    .eq("context", "spa-profile")
    .eq("lookup_key", "spa-name")
    .maybeSingle();
  return data?.title?.trim() || "your spa";
}

// v1.26.12 — solo-practitioner override. When set, providerClause renders
// this name in place of the "with X" suppression for the case where the
// Acuity calendar's provider_name equals the spa name. Null = no override =
// suppression holds (matches v379.2 semantics for multi-practitioner spas
// where calendar names alias the practice).
async function resolveOwnerDisplayName(
  sb: SupabaseAdmin,
  userId: string,
): Promise<string | null> {
  const { data } = await sb
    .from("knowledge_nodes")
    .select("title")
    .eq("user_id", userId)
    .eq("context", "spa-profile")
    .eq("lookup_key", "owner-display-name")
    .maybeSingle();
  const trimmed = data?.title?.trim();
  return trimmed || null;
}

async function resolveSpaFromNumber(
  sb: SupabaseAdmin,
  userId: string,
): Promise<string | null> {
  const { data } = await sb
    .from("phone_numbers")
    .select("phone_number")
    .eq("user_id", userId)
    .eq("is_active", true)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return data?.phone_number ?? null;
}

// ─── Fit-patient selection ────────────────────────────────────────────────

type WaitlistRow = {
  id: string;
  patient_node_id: string;
  treatment_types: string[];
};

async function selectFitPatients(
  sb: SupabaseAdmin,
  userId: string,
  appointmentTreatment: string | null,
  maxConcurrent: number,
  // v1.26.0: provider-affinity matching criterion. When non-null, the
  // candidate pool is filtered to patients whose most-frequent prior
  // provider (case-insensitive trim) matches this string. Falls back
  // to the full pool when zero affinity-matched candidates qualify so
  // the rescue isn't lost outright when no Michelle-patients are on
  // the waitlist. Null = skip the filter (e.g. provider_name absent,
  // or matches spa name — caller handles that gate).
  appointmentProvider: string | null,
): Promise<
  Array<{
    waitlistId: string;
    patientNodeId: string;
    phone: string;
    lifetimeSpend: number;
  }>
> {
  const { data: waitlist } = await sb
    .from("emma_waitlist")
    .select("id, patient_node_id, treatment_types")
    .eq("user_id", userId)
    .eq("status", "active");
  if (!waitlist || waitlist.length === 0) return [];

  // Treatment filter at the waitlist row level.
  const trtLower = appointmentTreatment?.toLowerCase() ?? "";
  const candidates: WaitlistRow[] = waitlist.filter((w) => {
    if (!w.treatment_types || w.treatment_types.length === 0) return true;
    if (!trtLower) return true; // appointment has no treatment_type — open
    return w.treatment_types.some((t) =>
      t.toLowerCase() === trtLower || trtLower.includes(t.toLowerCase()),
    );
  });
  if (candidates.length === 0) return [];

  // Load patient summaries
  const patientIds = candidates.map((c) => c.patient_node_id);
  const { data: patients } = await sb
    .from("knowledge_nodes")
    .select("id, attachments")
    .in("id", patientIds);
  const patientById = new Map<
    string,
    {
      phone: string | null;
      lifetimeSpend: number;
      banned: boolean;
      optedOut: boolean;
    }
  >();
  for (const p of patients ?? []) {
    const a = p.attachments as {
      phone?: string;
      lifetimeSpendUsd?: number;
      banned?: boolean;
      opted_out?: boolean;
    } | null;
    patientById.set(p.id, {
      phone: a?.phone ?? null,
      lifetimeSpend: Number(a?.lifetimeSpendUsd ?? 0),
      banned: !!a?.banned,
      optedOut: !!a?.opted_out,
    });
  }

  const fit: Array<{
    waitlistId: string;
    patientNodeId: string;
    phone: string;
    lifetimeSpend: number;
  }> = [];
  for (const c of candidates) {
    const p = patientById.get(c.patient_node_id);
    if (!p || !p.phone) continue;
    if (p.banned || p.optedOut) continue;
    fit.push({
      waitlistId: c.id,
      patientNodeId: c.patient_node_id,
      phone: p.phone,
      lifetimeSpend: p.lifetimeSpend,
    });
  }

  // v1.26.0 — provider-affinity filter. Bulk-load each remaining candidate's
  // appointment history in a single round trip, derive their primary
  // provider (most-frequent provider_name across all-time appointments,
  // ties broken by string-asc which is stable enough for this scale), and
  // keep only those whose primary provider matches the appointment's. If
  // the affinity-filtered pool is empty, fall back to the unfiltered fit[]
  // so we never lose a fill-opportunity entirely. Skipped when
  // appointmentProvider is null (caller's job to gate spa-name-equals
  // suppression — see providerClause at line 245 for the pattern).
  if (appointmentProvider && fit.length > 0) {
    const targetProvider = appointmentProvider.trim().toLowerCase();
    const candidateIds = fit.map((f) => f.patientNodeId);

    const { data: aptRows } = await sb
      .from("emma_appointments")
      .select("patient_node_id, provider_name")
      .eq("user_id", userId)
      .in("patient_node_id", candidateIds)
      .not("provider_name", "is", null);

    // Per-patient provider tallies → primary provider per patient.
    const tallyByPatient = new Map<string, Map<string, number>>();
    for (const r of aptRows ?? []) {
      if (!r.patient_node_id || !r.provider_name) continue;
      const p = r.provider_name.trim();
      if (!p) continue;
      let bucket = tallyByPatient.get(r.patient_node_id);
      if (!bucket) {
        bucket = new Map<string, number>();
        tallyByPatient.set(r.patient_node_id, bucket);
      }
      bucket.set(p, (bucket.get(p) ?? 0) + 1);
    }

    const primaryByPatient = new Map<string, string>();
    for (const [pid, bucket] of tallyByPatient) {
      let bestProvider: string | null = null;
      let bestCount = -1;
      for (const [provider, count] of bucket) {
        if (
          count > bestCount ||
          (count === bestCount && bestProvider !== null && provider < bestProvider)
        ) {
          bestProvider = provider;
          bestCount = count;
        }
      }
      if (bestProvider) primaryByPatient.set(pid, bestProvider);
    }

    const affinityFit = fit.filter((f) => {
      const primary = primaryByPatient.get(f.patientNodeId);
      return primary !== undefined && primary.toLowerCase() === targetProvider;
    });

    if (affinityFit.length > 0) {
      affinityFit.sort((a, b) => b.lifetimeSpend - a.lifetimeSpend);
      return affinityFit.slice(0, maxConcurrent);
    }

    console.warn(
      JSON.stringify({
        event: "rescue_provider_affinity_fallback",
        userId,
        appointmentProvider,
        waitlistCandidates: fit.length,
        ts: new Date().toISOString(),
      }),
    );
    // Fall through to unfiltered fit[] below.
  }

  // Sort by lifetime value desc; tie-break is stable.
  fit.sort((a, b) => b.lifetimeSpend - a.lifetimeSpend);
  return fit.slice(0, maxConcurrent);
}

// ─── Compose the rescue SMS ───────────────────────────────────────────────

// When provider_name matches the spa name, two possible interpretations:
//
//   1. Acuity calendar is named after the practice rather than a human
//      provider — rendering both yields "at Rejuv Skin Spa with Rejuv Skin
//      Spa" which reads broken. SUPPRESS the "with" clause. (Original
//      v379.2 case.)
//
//   2. Solo-practitioner setup where the owner IS the practice — Karen at
//      Rejuv Skin Spa runs every appointment herself; provider_name='Rejuv
//      Skin Spa' on Acuity exports is shorthand for "Karen." Suppressing
//      strips the warmth signal ("Tox at 6:50pm" loses to "Tox with Karen
//      at 6:50pm"). RENDER the owner's display name instead. (v1.26.12.)
//
// The tenant tells us which interpretation applies via the spa-profile
// `owner-display-name` lookup_key — when set, that's the solo-practitioner
// case; when null, suppression holds as before.
function providerClause(
  spaName: string,
  providerName: string | null,
  ownerDisplayName: string | null,
  prefix: string,
): string {
  if (!providerName) return "";
  const sameAsSpa =
    providerName.trim().toLowerCase() === spaName.trim().toLowerCase();
  if (sameAsSpa) {
    const owner = ownerDisplayName?.trim();
    return owner ? `${prefix}${owner}` : "";
  }
  return `${prefix}${providerName}`;
}

function composeRescueSms(args: {
  spaName: string;
  treatmentType: string | null;
  providerName: string | null;
  ownerDisplayName: string | null;
  scheduledAt: string;
  claimUrl: string;
}): string {
  // timeZone:"UTC" pins rendering to the spa-intended clock the appointment
  // was imported with. See claim-page comment for the full TZ-naive-storage
  // explanation; rendering everywhere as UTC keeps email/SMS/claim-page in
  // lockstep. (v379.2.)
  const when = new Date(args.scheduledAt).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Denver",
  });
  const treatment = args.treatmentType ? ` for ${args.treatmentType}` : "";
  const provider = providerClause(
    args.spaName,
    args.providerName,
    args.ownerDisplayName,
    " with ",
  );
  return [
    `${args.spaName} — last-minute opening! ${when}${treatment}${provider}.`,
    `Tap to grab it: ${args.claimUrl}`,
    `First come, first served.`,
    `Reply STOP to opt out.`,
  ].join("\n");
}

// ─── Proxy-mode composers (v379) ──────────────────────────────────────────

/**
 * Per-patient draft entry surfaced inside the proxy SMS + email. Each draft
 * is a complete, copy-paste-ready iMessage body addressed to one waitlist
 * patient — the spa owner forwards whichever URLs they want, or pipes the
 * email into Claude Desktop for iMessage automation.
 */
type ProxyOfferLine = {
  firstName: string;
  fullName: string;
  phone: string;
  lifetimeSpend: number;
  claimUrl: string;
};

function formatRescueWhen(scheduledAt: string): string {
  return new Date(scheduledAt).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Denver",
  });
}

function composeProxySms(args: {
  spaName: string;
  treatmentType: string | null;
  providerName: string | null;
  ownerDisplayName: string | null;
  scheduledAt: string;
  offers: ProxyOfferLine[];
}): string {
  const when = formatRescueWhen(args.scheduledAt);
  const treatment = args.treatmentType ? ` ${args.treatmentType}` : "";
  const provider = providerClause(
    args.spaName,
    args.providerName,
    args.ownerDisplayName,
    " w/ ",
  );
  const head = `${args.spaName} — ${args.offers.length} rescue offer${args.offers.length === 1 ? "" : "s"} ready for ${when}${treatment}${provider}:`;
  const body = args.offers
    .map(
      (o) =>
        `${o.firstName} (${o.phone})\n${o.claimUrl}`,
    )
    .join("\n\n");
  return `${head}\n\n${body}\n\nFirst-tap-wins.`;
}

function composeProxyEmail(args: {
  spaName: string;
  treatmentType: string | null;
  providerName: string | null;
  ownerDisplayName: string | null;
  scheduledAt: string;
  offers: ProxyOfferLine[];
}): { subject: string; text: string; html: string } {
  const when = formatRescueWhen(args.scheduledAt);
  const treatment = args.treatmentType ?? "Appointment";
  const provider = providerClause(
    args.spaName,
    args.providerName,
    args.ownerDisplayName,
    " with ",
  );
  const subject = `${args.spaName} — ${args.offers.length} rescue offer${args.offers.length === 1 ? "" : "s"} ready for ${when} ${treatment}`;

  const draftLines = args.offers
    .map((o) => {
      const courtesy = `Hi ${o.firstName}! Last-minute opening at ${args.spaName} ${when}${provider} for ${treatment}. Tap to grab if you want it: ${o.claimUrl}`;
      const spendStr = o.lifetimeSpend > 0
        ? `, lifetime $${Math.round(o.lifetimeSpend).toLocaleString()}`
        : "";
      return [
        "────────────────",
        `To: ${o.phone} (${o.fullName}${spendStr})`,
        "",
        courtesy,
      ].join("\n");
    })
    .join("\n\n");

  const text = [
    "═══ AUTO-SEND ═══",
    "Paste this whole email into Claude Desktop with the iMessage MCP installed.",
    "Claude will call draft_imessage(recipient_phone, body) for each patient below —",
    "one Messages.app conversation per draft. Review each and tap Send.",
    "═════════════════",
    "",
    `${args.offers.length} ${args.offers.length === 1 ? "patient" : "patients"} on your waitlist match this opening. First-tap-wins — once one claims, the others see "slot taken."`,
    "",
    "═══ READY-TO-SEND DRAFTS ═══",
    "",
    draftLines,
    "",
    "═══ END DRAFTS ═══",
    "",
    "Prefer manual? Just forward whichever claim URLs above to those patients yourself.",
  ].join("\n");

  // Polished HTML version — same content, light bg, dark ink, monospace
  // for the drafts so iMessage-style copy/paste preserves intent.
  const draftBlocks = args.offers
    .map((o) => {
      const courtesy = `Hi ${o.firstName}! Last-minute opening at ${args.spaName} ${when}${provider} for ${treatment}. Tap to grab if you want it: ${o.claimUrl}`;
      const spendStr = o.lifetimeSpend > 0
        ? `, lifetime $${Math.round(o.lifetimeSpend).toLocaleString()}`
        : "";
      return `<div style="margin:18px 0;padding:14px 16px;background:#f7f6f3;border-left:3px solid #047857;border-radius:6px;">
  <div style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:#222;margin-bottom:8px;"><strong>To:</strong> ${o.phone} <span style="color:#666;">(${o.fullName}${spendStr})</span></div>
  <div style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:#222;white-space:pre-wrap;">${courtesy}</div>
</div>`;
    })
    .join("");

  const html = `<!doctype html><html><body style="margin:0;padding:32px;background:#fafaf7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Inter,sans-serif;color:#1a1a1a;">
  <div style="max-width:640px;margin:0 auto;">
    <div style="margin-bottom:20px;padding:14px 16px;background:#ecfdf5;border-left:3px solid #047857;border-radius:6px;font-size:13px;color:#064e3b;line-height:1.55;">
      <div style="font-size:11px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#047857;margin-bottom:6px;">Auto-send</div>
      Paste this whole email into Claude Desktop with the iMessage MCP installed. Claude will call <code style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;background:#d1fae5;padding:1px 5px;border-radius:3px;">draft_imessage(recipient_phone, body)</code> for each patient below &mdash; one Messages.app conversation per draft. Review each and tap Send.
    </div>
    <div style="font-size:14px;color:#374151;line-height:1.55;margin-bottom:18px;">${args.offers.length} ${args.offers.length === 1 ? "patient" : "patients"} on your waitlist match this opening. <strong>First-tap-wins</strong> &mdash; once one claims, the others see &quot;slot taken.&quot;</div>
    <div style="font-size:11px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#047857;margin:24px 0 8px;">Ready-to-send drafts</div>
    ${draftBlocks}
    <div style="font-size:12px;color:#6b7280;line-height:1.55;margin-top:20px;border-top:1px solid #e5e7eb;padding-top:14px;">Prefer manual? Just forward whichever claim URLs above to those patients yourself.</div>
  </div>
</body></html>`;

  return { subject, text, html };
}

// ─── dispatchRescueAttempt (internal) ─────────────────────────────────────

/**
 * Fire a rescue attempt for a freed appointment slot. Called from
 * emma-appointments.updateAppointmentStatus when status flips to
 * cancelled/no_show AND scheduled_at > now().
 *
 * Idempotency: if an active rescue attempt already exists for this
 * appointment, return its id without re-dispatching.
 */
export async function dispatchRescueAttempt(args: {
  sb: SupabaseAdmin;
  userId: string;
  appointmentId: string;
}): Promise<RescueDispatchResult> {
  const { sb, userId, appointmentId } = args;

  // 1) Load appointment + policy
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
      attemptId: null,
      offersSent: 0,
      reason: "Appointment not found.",
    };
  }
  const apt = aptRes.data;
  const policy = policyRes.data;

  if (!policy || !policy.rescue_enabled) {
    return {
      ok: false,
      attemptId: null,
      offersSent: 0,
      reason: "Rescue agent disabled for this spa.",
    };
  }
  if (apt.status !== "cancelled" && apt.status !== "no_show") {
    return {
      ok: false,
      attemptId: null,
      offersSent: 0,
      reason: `Appointment status is '${apt.status}', not eligible for rescue.`,
    };
  }
  if (new Date(apt.scheduled_at).getTime() <= Date.now()) {
    return {
      ok: false,
      attemptId: null,
      offersSent: 0,
      reason: "Appointment is in the past — too late to rescue.",
    };
  }

  // 2) Spa-level treatment filter
  if (
    policy.rescue_eligible_treatments &&
    policy.rescue_eligible_treatments.length > 0 &&
    apt.treatment_type
  ) {
    const t = apt.treatment_type.toLowerCase();
    const allowed = policy.rescue_eligible_treatments.some(
      (x) => x.toLowerCase() === t || t.includes(x.toLowerCase()),
    );
    if (!allowed) {
      return {
        ok: false,
        attemptId: null,
        offersSent: 0,
        reason: `Treatment '${apt.treatment_type}' not in rescue_eligible_treatments.`,
      };
    }
  }

  // 3) Idempotency — return existing active attempt if any
  const { data: existing } = await sb
    .from("emma_rescue_attempts")
    .select("id, outreach_count")
    .eq("user_id", userId)
    .eq("freed_appointment_id", appointmentId)
    .eq("status", "active")
    .maybeSingle();
  if (existing) {
    return {
      ok: true,
      attemptId: existing.id,
      offersSent: existing.outreach_count,
      reason: "Existing active attempt.",
    };
  }

  // 4) Select fit-patients
  // v1.26.0: pass the appointment's provider through so the matcher can
  // bias the waitlist to patients with affinity to THIS provider. Suppress
  // when provider_name is null OR matches the spa name (mirrors the same
  // gate that providerClause uses at line 245 — Acuity calendars are
  // often named after the practice itself). spaName is the same string
  // that resolveSpaName(sb, userId) returns below at line 590; computing
  // it twice is cheaper than restructuring the function.
  const spaNameForProviderGate = await resolveSpaName(sb, userId);
  const providerForMatch =
    apt.provider_name &&
    apt.provider_name.trim().toLowerCase() !==
      spaNameForProviderGate.trim().toLowerCase()
      ? apt.provider_name
      : null;
  const fitPatients = await selectFitPatients(
    sb,
    userId,
    apt.treatment_type,
    policy.rescue_max_concurrent ?? 5,
    providerForMatch,
  );
  if (fitPatients.length === 0) {
    // Still record an attempt for the audit trail, marked closed_unfilled.
    const { data: attempt } = await sb
      .from("emma_rescue_attempts")
      .insert({
        user_id: userId,
        freed_appointment_id: appointmentId,
        outreach_count: 0,
        status: "closed_unfilled",
        closed_at: new Date().toISOString(),
        notes: "No fit-patients in waitlist.",
      })
      .select("id")
      .single();
    return {
      ok: false,
      attemptId: attempt?.id ?? null,
      offersSent: 0,
      reason: "No fit-patients in waitlist.",
    };
  }

  // 5) Create the attempt row.
  //    v381.4: race-safe against concurrent dispatchRescueAttempt callers
  //    (Acuity fires both `appointment.canceled` and `appointment.changed`
  //    for a single status flip and they arrive within the same second,
  //    both passing the step 3 SELECT before either has INSERTed). The
  //    partial unique index `emma_rescue_attempts_one_active_per_apt`
  //    constrains at most one active row per (user_id, freed_appointment_id);
  //    the losing INSERT comes back with SQLSTATE 23505 and we fall
  //    through to returning the winner's id rather than throwing.
  const { data: attempt, error: attemptErr } = await sb
    .from("emma_rescue_attempts")
    .insert({
      user_id: userId,
      freed_appointment_id: appointmentId,
      outreach_count: 0,
      status: "active",
    })
    .select("id")
    .single();
  if (attemptErr || !attempt) {
    if (attemptErr && (attemptErr.code === "23505" || /duplicate key/i.test(attemptErr.message))) {
      const { data: winner } = await sb
        .from("emma_rescue_attempts")
        .select("id, outreach_count")
        .eq("user_id", userId)
        .eq("freed_appointment_id", appointmentId)
        .eq("status", "active")
        .maybeSingle();
      return {
        ok: true,
        attemptId: winner?.id ?? null,
        offersSent: winner?.outreach_count ?? 0,
        reason: "Concurrent dispatch raced — returning winner.",
      };
    }
    throw new Error(`Couldn't create attempt: ${attemptErr?.message ?? "no row"}`);
  }

  // 6) Resolve spa identity. fromNumber is only required for paths that
  //    actually send SMS — proxy-email-only mode skips it entirely.
  //
  //    v1.4.4 (2026-05-26): the upfront bail used to fire on null
  //    fromNumber regardless of delivery path. That gated proxy-email-only
  //    mode out of working at all — exactly Karen's setup post
  //    [[project-carriers-mothballed]] where Twilio is off and patient
  //    outreach is iMessage-MCP-via-Claude-Desktop from Karen's machine.
  //    Caught during the first real Karen Acuity cancel test 2026-05-26
  //    after the v1.4.3 TZ fix.
  const spaName = await resolveSpaName(sb, userId);
  // v1.26.12 — pre-fetched once for all composer call sites below.
  const ownerDisplayName = await resolveOwnerDisplayName(sb, userId);
  const fromNumber = await resolveSpaFromNumber(sb, userId);

  // Read proxy config early so we know which delivery path(s) will fire.
  const proxyPhone = policy.rescue_proxy_phone;
  const proxyEmail = policy.rescue_proxy_email;
  const isProxyMode = !!(proxyPhone || proxyEmail);

  // Need fromNumber when: direct mode (sends to each patient) OR proxy
  // mode with proxyPhone set (sends consolidated SMS to spa owner).
  // Pure proxy-email-only mode doesn't need it.
  const willNeedFromNumber = !isProxyMode || !!proxyPhone;
  if (willNeedFromNumber && !fromNumber) {
    await sb
      .from("emma_rescue_attempts")
      .update({
        status: "closed_unfilled",
        closed_at: new Date().toISOString(),
        notes: isProxyMode
          ? "Proxy SMS configured but spa has no provisioned SMS number — set rescue_proxy_email to skip Twilio entirely."
          : "Spa has no provisioned SMS number and no proxy email configured.",
      })
      .eq("id", attempt.id);
    return {
      ok: false,
      attemptId: attempt.id,
      offersSent: 0,
      reason: "Spa has no provisioned SMS number.",
    };
  }

  // 6a) Insert offer rows for every fit-patient up-front (proxy + direct
  //     modes both need this — the per-patient row is the token + claim
  //     state, regardless of how the URL gets delivered).
  type CollectedOffer = {
    offerId: string;
    token: string;
    patientNodeId: string;
    phone: string;
    lifetimeSpend: number;
    claimUrl: string;
  };
  const collected: CollectedOffer[] = [];
  for (const fp of fitPatients) {
    const { data: offer, error: offerErr } = await sb
      .from("emma_rescue_offers")
      .insert({
        user_id: userId,
        rescue_attempt_id: attempt.id,
        appointment_id: appointmentId,
        patient_node_id: fp.patientNodeId,
      })
      .select("id, token")
      .single();
    if (offerErr || !offer) {
      console.error("rescue offer insert failed:", offerErr?.message);
      continue;
    }
    collected.push({
      offerId: offer.id,
      token: offer.token,
      patientNodeId: fp.patientNodeId,
      phone: fp.phone,
      lifetimeSpend: fp.lifetimeSpend,
      claimUrl: buildRescueClaimUrl(offer.token),
    });
  }

  // 6b) Branch: proxy mode (Karen-in-the-loop) vs direct mode (per-patient).
  //     Proxy mode activates when EITHER rescue_proxy_phone OR
  //     rescue_proxy_email is set on the policy — both can be set together.
  //     (Declared at top of step 6 in v1.4.4 so the upfront fromNumber
  //     check could be path-aware. Re-used here for readability.)

  let offersSent = 0;

  if (isProxyMode && collected.length > 0) {
    // Hydrate patient names once for the aggregated bodies.
    const patientIds = collected.map((c) => c.patientNodeId);
    const { data: patientNodes } = await sb
      .from("knowledge_nodes")
      .select("id, title")
      .in("id", patientIds);
    const titleById = new Map(
      (patientNodes ?? []).map((p) => [p.id, p.title as string | null]),
    );

    const offerLines: ProxyOfferLine[] = collected.map((c) => {
      const fullName = titleById.get(c.patientNodeId) ?? "Patient";
      return {
        firstName: extractFirstName(fullName) ?? "there",
        fullName,
        phone: c.phone,
        lifetimeSpend: c.lifetimeSpend,
        claimUrl: c.claimUrl,
      };
    });

    let proxySmsMessageId: string | null = null;
    let proxyEmailMessageId: string | null = null;

    // Proxy SMS
    if (proxyPhone) {
      const smsBody = composeProxySms({
        spaName,
        treatmentType: apt.treatment_type,
        providerName: apt.provider_name,
        ownerDisplayName,
        scheduledAt: apt.scheduled_at,
        offers: offerLines,
      });
      try {
        const resp = await sendSms({
          from: fromNumber,
          to: proxyPhone,
          body: smsBody,
        });
        proxySmsMessageId = resp.messageId;
      } catch (e) {
        console.error("[rescue proxy] SMS send failed:", e);
      }
    }

    // Proxy email
    if (proxyEmail) {
      const resendKey = process.env.RESEND_API_KEY;
      if (!resendKey) {
        console.error("[rescue proxy] RESEND_API_KEY missing — skipping email.");
      } else {
        const fromEmail = await resolveSpaFromEmail(userId);
        const email = composeProxyEmail({
          spaName,
          treatmentType: apt.treatment_type,
          providerName: apt.provider_name,
          ownerDisplayName,
          scheduledAt: apt.scheduled_at,
          offers: offerLines,
        });
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
                { name: "type", value: "emma-rescue-proxy" },
                { name: "attempt_id", value: attempt.id },
              ],
            }),
            signal: AbortSignal.timeout(15_000),
          });
          if (res.ok) {
            const json = (await res.json().catch(() => ({}))) as {
              id?: string;
            };
            proxyEmailMessageId = json.id ?? null;
          } else {
            const errBody = await res.text().catch(() => "");
            console.error(
              `[rescue proxy] Email send failed: ${res.status} ${errBody.slice(0, 200)}`,
            );
          }
        } catch (e) {
          console.error("[rescue proxy] Email send failed:", e);
        }
      }
    }

    // Stamp every offer row with the proxy delivery marker so the audit
    // trail records that these URLs went to the spa owner, not to the
    // patient directly. Format mirrors message_id (which Twilio + Bandwidth
    // both use as a string SID) so downstream telemetry doesn't need a
    // new column.
    const proxyMarker = [
      proxySmsMessageId ? `proxy-sms:${proxySmsMessageId}` : null,
      proxyEmailMessageId ? `proxy-email:${proxyEmailMessageId}` : null,
    ]
      .filter(Boolean)
      .join(" ") || "proxy:no-delivery";
    await sb
      .from("emma_rescue_offers")
      .update({ message_id: proxyMarker })
      .in(
        "id",
        collected.map((c) => c.offerId),
      );
    if (proxySmsMessageId || proxyEmailMessageId) {
      offersSent = collected.length;
    }
  } else {
    // Direct mode — existing per-patient send loop (production behavior
    // when no proxy fields are configured).
    for (const c of collected) {
      const body = composeRescueSms({
        spaName,
        treatmentType: apt.treatment_type,
        providerName: apt.provider_name,
        ownerDisplayName,
        scheduledAt: apt.scheduled_at,
        claimUrl: c.claimUrl,
      });
      try {
        const resp = await sendSms({
          from: fromNumber,
          to: c.phone,
          body,
        });
        await sb
          .from("emma_rescue_offers")
          .update({ message_id: resp.messageId })
          .eq("id", c.offerId);
        offersSent++;
      } catch (e) {
        await sb
          .from("emma_rescue_offers")
          .update({
            send_error:
              e instanceof Error ? `sms: ${e.message}` : "sms: unknown error",
          })
          .eq("id", c.offerId);
      }
    }
  }

  // 7) Bump outreach_count on the attempt row
  await sb
    .from("emma_rescue_attempts")
    .update({ outreach_count: offersSent })
    .eq("id", attempt.id);

  return { ok: true, attemptId: attempt.id, offersSent };
}

// ─── Public landing-page payload ──────────────────────────────────────────

const tokenInput = z.object({
  token: z.string().uuid(),
});

export const getRescueOfferPayload = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => tokenInput.parse(input))
  .handler(async ({ data }): Promise<RescueOfferPayload | null> => {
    const sb = admin();

    const { data: offer } = await sb
      .from("emma_rescue_offers")
      .select(
        "id, user_id, appointment_id, patient_node_id, claimed_at, declined_at, expired_at",
      )
      .eq("token", data.token)
      .maybeSingle();
    if (!offer) return null;

    const [
      { data: apt },
      { data: spa },
      { data: owner },
      { data: patient },
      { data: anyClaimed },
    ] = await Promise.all([
      sb
        .from("emma_appointments")
        .select(
          "scheduled_at, duration_min, treatment_type, provider_name, status, patient_node_id",
        )
        .eq("id", offer.appointment_id)
        .maybeSingle(),
      sb
        .from("knowledge_nodes")
        .select("title")
        .eq("user_id", offer.user_id)
        .eq("context", "spa-profile")
        .eq("lookup_key", "spa-name")
        .maybeSingle(),
      // v1.26.12 — solo-practitioner override fetched in parallel; null
      // when the tenant hasn't set it (existing suppression-by-default).
      sb
        .from("knowledge_nodes")
        .select("title")
        .eq("user_id", offer.user_id)
        .eq("context", "spa-profile")
        .eq("lookup_key", "owner-display-name")
        .maybeSingle(),
      sb
        .from("knowledge_nodes")
        .select("title")
        .eq("id", offer.patient_node_id)
        .maybeSingle(),
      // Has any sibling offer been claimed?
      sb
        .from("emma_rescue_offers")
        .select("id")
        .eq("appointment_id", offer.appointment_id)
        .not("claimed_at", "is", null)
        .limit(1)
        .maybeSingle(),
    ]);
    if (!apt) return null;

    let status: RescueOfferPayload["status"];
    if (offer.claimed_at) {
      // This offer was claimed by THIS patient (we reuse the same token
      // for follow-up visits to the URL).
      status = "already_claimed_by_you";
    } else if (anyClaimed) {
      status = "claimed_by_someone_else";
    } else if (apt.status !== "cancelled" && apt.status !== "no_show") {
      // Spa might've put the appointment back or it was reassigned.
      status = "no_longer_available";
    } else if (
      offer.expired_at ||
      new Date(apt.scheduled_at).getTime() <= Date.now()
    ) {
      status = "expired";
    } else {
      status = "claimable";
    }

    return {
      spaName: spa?.title?.trim() || "your spa",
      patientFirstName: extractFirstName(patient?.title ?? null),
      status,
      treatmentType: apt.treatment_type,
      providerName: apt.provider_name,
      ownerDisplayName: owner?.title?.trim() || null,
      scheduledAt: apt.scheduled_at,
      durationMin: apt.duration_min,
    };
  });

// ─── claimRescueSlot (public) — first-tap-wins ────────────────────────────

export const claimRescueSlot = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => tokenInput.parse(input))
  .handler(async ({ data }): Promise<RescueClaimResult> => {
    const sb = admin();

    // 1) Load the offer
    const { data: offer } = await sb
      .from("emma_rescue_offers")
      .select(
        "id, user_id, appointment_id, patient_node_id, rescue_attempt_id, claimed_at",
      )
      .eq("token", data.token)
      .maybeSingle();
    if (!offer) {
      return { ok: false, status: "no_longer_available" };
    }

    if (offer.claimed_at) {
      // Re-visiting; already claimed by us. Return success-shape.
      const { data: apt } = await sb
        .from("emma_appointments")
        .select("scheduled_at")
        .eq("id", offer.appointment_id)
        .maybeSingle();
      return {
        ok: true,
        status: "already_claimed_by_you",
        scheduledAt: apt?.scheduled_at,
      };
    }

    // 2) Race-safe lock on the offer
    const { data: locked, error: lockErr } = await sb
      .from("emma_rescue_offers")
      .update({ claimed_at: new Date().toISOString() })
      .eq("id", offer.id)
      .is("claimed_at", null)
      .select("id")
      .maybeSingle();
    if (lockErr) {
      return { ok: false, status: "no_longer_available" };
    }
    if (!locked) {
      // Someone else won the race on THIS offer. Vanishingly rare.
      return { ok: false, status: "claimed_by_someone_else" };
    }

    // 3) Reassign the appointment AND verify no sibling offer beat us
    //    to it. The appointment update uses a status guard.
    const { data: reassigned, error: reassignErr } = await sb
      .from("emma_appointments")
      .update({
        patient_node_id: offer.patient_node_id,
        status: "scheduled",
      })
      .eq("id", offer.appointment_id)
      .in("status", ["cancelled", "no_show"])
      .select("id, scheduled_at")
      .maybeSingle();

    if (reassignErr || !reassigned) {
      // Sibling won. Roll our claim back so the spa knows the offer
      // didn't actually take.
      await sb
        .from("emma_rescue_offers")
        .update({ claimed_at: null })
        .eq("id", offer.id);
      return { ok: false, status: "claimed_by_someone_else" };
    }

    // 4) Mark the rescue attempt as filled
    await sb
      .from("emma_rescue_attempts")
      .update({
        status: "filled",
        filled_at: new Date().toISOString(),
        filled_by_offer_id: offer.id,
      })
      .eq("id", offer.rescue_attempt_id)
      .eq("status", "active");

    // 5) v363: record a provisional recovery event. This is the
    //    [VERIFIED] receipt the spa owner bills against — verification
    //    (revenue amount + verified_at) follows via the QBO
    //    reconciliation cron OR manual confirm on /app/refill/recovery.
    //    v373.4: must AWAIT on Workers — isolate dies at response time
    //    and fire-and-forget silently no-ops the row.
    try {
      const { recordRecoveryEvent } = await import(
        "@/server/emma-attribution.functions"
      );
      await recordRecoveryEvent({
        sb,
        userId: offer.user_id,
        appointmentId: offer.appointment_id,
        patientNodeId: offer.patient_node_id,
        recoveryAgent: "rescue",
        attributionMethod: "direct",
      });
    } catch (e) {
      console.error(
        "recovery event record failed:",
        e instanceof Error ? e.message : e,
      );
    }

    // 6) v364: optional deposit intent. Only fires when the spa has
    //    explicitly enabled deposit_enabled in their policy AND the
    //    patient matches the configured trigger. OFF by default —
    //    most spas never reach this branch. v373.4: awaited (was IIFE
    //    fire-and-forget — same Workers isolate-death class as #5).
    try {
      const { checkDepositEligibility, logDepositIntent } = await import(
        "@/server/emma-deposits.functions"
      );
      const elig = await checkDepositEligibility({
        sb,
        userId: offer.user_id,
        patientNodeId: offer.patient_node_id,
        appointmentId: offer.appointment_id,
      });
      if (elig.eligible && elig.reason && elig.amountUsd) {
        await logDepositIntent({
          sb,
          userId: offer.user_id,
          appointmentId: offer.appointment_id,
          patientNodeId: offer.patient_node_id,
          triggerReason: elig.reason,
          amountUsd: elig.amountUsd,
        });
      }
    } catch (e) {
      console.error(
        "deposit intent log failed:",
        e instanceof Error ? e.message : e,
      );
    }

    // 7) v382: write the new booking back to the source-of-truth scheduler.
    //    Until v382 the claim flow only updated Refill's DB; Acuity (or
    //    whatever scheduler the spa connected) still showed the original
    //    cancellation with no replacement, so the spa owner had to manually
    //    add the patient to their calendar. First live Karen cancel on
    //    2026-05-19 6:08 PM MT exposed the gap.
    //
    //    Fail-open: if any step fails (no connection, Acuity API down,
    //    appointment-type lookup miss, etc.) we keep the local claim
    //    committed and stamp the outcome on emma_rescue_attempts.notes so
    //    the spa can reconcile manually from the rescue dashboard. The
    //    patient still sees "you're on the books" — never punish the
    //    patient for an upstream API issue.
    const stampWritebackNotes = async (notes: string) => {
      try {
        await sb
          .from("emma_rescue_attempts")
          .update({ notes })
          .eq("id", offer.rescue_attempt_id);
      } catch (e) {
        console.error(
          "writeback notes stamp failed:",
          e instanceof Error ? e.message : e,
        );
      }
    };

    try {
      const { data: claimedApt } = await sb
        .from("emma_appointments")
        .select("id, source, external_id, scheduled_at")
        .eq("id", offer.appointment_id)
        .maybeSingle();

      const acuitySource = claimedApt?.source === "acuity";
      if (!acuitySource) {
        // CSV-only spas, or future platforms not yet wired for write-back.
        // No-op silently — the claim flow is complete for them.
        console.info(
          `[claim-writeback] skipped (source=${claimedApt?.source ?? "unknown"}) for appointment ${offer.appointment_id}`,
        );
        await stampWritebackNotes(
          `writeback_skipped: source=${claimedApt?.source ?? "unknown"}`,
        );
      } else if (!claimedApt?.external_id) {
        console.warn(
          `[claim-writeback] acuity row missing external_id; cannot resolve original appointment for ${offer.appointment_id}`,
        );
        await stampWritebackNotes("writeback_failed: missing_external_id");
      } else {
        // emma_scheduler_connections is not in the generated Database
        // types yet; cast through unknown to access the table directly.
        // Same pattern used in api.webhooks.scheduler.acuity.$secret.ts
        // and src/server/emma-scheduler.functions.ts.
        const sbAny = sb as unknown as {
          from: (t: string) => {
            select: (cols: string) => {
              eq: (col: string, val: string) => {
                eq: (col: string, val: string) => {
                  maybeSingle: () => Promise<{
                    data: {
                      access_token: string | null;
                      status: string;
                      platform: string;
                    } | null;
                  }>;
                };
              };
            };
          };
        };
        const { data: connection } = await sbAny
          .from("emma_scheduler_connections")
          .select("access_token, status, platform")
          .eq("user_id", offer.user_id)
          .eq("platform", "acuity")
          .maybeSingle();

        if (
          !connection ||
          connection.status !== "connected" ||
          !connection.access_token
        ) {
          console.warn(
            `[claim-writeback] no active acuity connection for user ${offer.user_id}`,
          );
          await stampWritebackNotes(
            "writeback_failed: no_active_acuity_connection",
          );
        } else {
          const { getAcuityAppointment, bookAcuityAppointment } = await import(
            "@/lib/schedulers/acuity"
          );

          // Original appointment → datetime + appointmentTypeID + calendarID.
          // Acuity returns datetime in its native "2026-05-21T13:30:00-0600"
          // format which we pass back verbatim to the POST — no TZ math.
          const originalApt = await getAcuityAppointment(
            connection.access_token,
            claimedApt.external_id,
          );

          // Claimer's contact info from knowledge_nodes (the patient roster).
          const { data: claimer } = await sb
            .from("knowledge_nodes")
            .select("title, attachments")
            .eq("id", offer.patient_node_id)
            .maybeSingle();

          const fullName = (claimer?.title ?? "").trim();
          const nameParts = fullName.split(/\s+/).filter(Boolean);
          const lastName = nameParts.length > 1 ? nameParts.pop()! : "";
          const firstName = nameParts.join(" ") || fullName || "Patient";
          const a = claimer?.attachments as
            | { phone?: string; email?: string }
            | null;

          const newApt = await bookAcuityAppointment(connection.access_token, {
            datetime: originalApt.datetime,
            appointmentTypeID: originalApt.appointmentTypeID,
            calendarID: originalApt.calendarID,
            firstName,
            lastName,
            email: a?.email || undefined,
            phone: a?.phone || undefined,
            notes: `Rebooked via Refill from cancelled appointment ${claimedApt.external_id}`,
          });

          // Stamp the new external_id on the same row. The Acuity
          // appointment.scheduled webhook for this new appointment will
          // land shortly; its upsert is idempotent on (user_id, external_id,
          // source) and will be a near-no-op since this row is already
          // current.
          await sb
            .from("emma_appointments")
            .update({ external_id: String(newApt.id) })
            .eq("id", offer.appointment_id);

          await stampWritebackNotes(
            `writeback_ok: new_external_id=${newApt.id} replaced=${claimedApt.external_id}`,
          );
        }
      }
    } catch (e) {
      console.error(
        "acuity write-back failed:",
        e instanceof Error ? e.message : e,
      );
      await stampWritebackNotes(
        `writeback_failed: ${e instanceof Error ? e.message.slice(0, 400) : "unknown"}`,
      );
    }

    return {
      ok: true,
      status: "already_claimed_by_you",
      scheduledAt: reassigned.scheduled_at,
    };
  });

// ─── listRescueActivity (spa-facing) ──────────────────────────────────────

const listInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
});

export const listRescueActivity = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => listInput.parse(input))
  .handler(async ({ data }): Promise<RescueActivityItem[]> => {
    const { resolveEffectiveUserId } = await import("@/server/auth-helpers");
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();

    const { data: attempts } = await sb
      .from("emma_rescue_attempts")
      .select(
        "id, freed_appointment_id, triggered_at, outreach_count, status, filled_at, filled_by_offer_id",
      )
      .eq("user_id", effectiveUserId)
      .order("triggered_at", { ascending: false })
      .limit(50);
    if (!attempts || attempts.length === 0) return [];

    const aptIds = Array.from(new Set(attempts.map((a) => a.freed_appointment_id)));
    const offerIds = attempts
      .map((a) => a.filled_by_offer_id)
      .filter((id): id is string => id !== null);

    const [{ data: appts }, { data: filledOffers }] = await Promise.all([
      sb
        .from("emma_appointments")
        .select("id, scheduled_at, treatment_type")
        .in("id", aptIds),
      offerIds.length > 0
        ? sb
            .from("emma_rescue_offers")
            .select("id, patient_node_id")
            .in("id", offerIds)
        : Promise.resolve({ data: [] }),
    ]);

    const aptById = new Map((appts ?? []).map((a) => [a.id, a]));
    const filledPatientIds = new Set(
      (filledOffers ?? []).map((o) => o.patient_node_id),
    );
    const filledOfferToPatient = new Map(
      (filledOffers ?? []).map((o) => [o.id, o.patient_node_id]),
    );

    // Hydrate filled patient names
    const { data: patients } = await sb
      .from("knowledge_nodes")
      .select("id, title")
      .in("id", Array.from(filledPatientIds));
    const patientNameById = new Map(
      (patients ?? []).map((p) => [p.id, p.title as string | null]),
    );

    return attempts.map((a) => {
      const apt = aptById.get(a.freed_appointment_id);
      const filledPatientId = a.filled_by_offer_id
        ? filledOfferToPatient.get(a.filled_by_offer_id)
        : null;
      return {
        attemptId: a.id,
        freedAppointmentScheduledAt: apt?.scheduled_at ?? "",
        freedAppointmentTreatment: apt?.treatment_type ?? null,
        status: a.status as RescueActivityItem["status"],
        triggeredAt: a.triggered_at,
        outreachCount: a.outreach_count,
        filledAt: a.filled_at,
        filledPatientName: filledPatientId
          ? patientNameById.get(filledPatientId) ?? null
          : null,
      };
    });
  });

// ─── extractFirstName helper ──────────────────────────────────────────────

function extractFirstName(displayName: string | null): string | null {
  if (!displayName) return null;
  if (displayName.includes(",")) {
    const parts = displayName.split(",", 2).map((s) => s.trim());
    return parts[1] || null;
  }
  const parts = displayName.trim().split(/\s+/);
  return parts[0] || null;
}
