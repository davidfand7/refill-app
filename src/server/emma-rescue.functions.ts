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
 *   1. waitlist where status='active' for this spa
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
 * Race-safe claim: UPDATE rescue_offers SET claimed_at = now()
 *   WHERE id = $offer_id AND claimed_at IS NULL RETURNING *
 * The reassign step then takes a second lock on appointments to
 * make sure the appointment is still in cancelled/no_show state.
 *
 * Established 2026-05-17 (Promotions Engine v361).
 */

import { createServerFn } from "@tanstack/react-start";
import { admin } from "./admin-client";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { sendSms } from "@/server/sms-provider";
import { fetchAllRows } from "@/server/paginate";
import { resolveSpaFromEmail } from "@/server/emma-sender.functions";
import { postResendEmail } from "@/server/resend-send";
import { resolveBrand } from "@/server/brand-resolver";
import { recordMessagingActivity, recordAgentAction } from "@/server/messaging-activity";
import {
  checkRecentContact,
  FREQUENCY_CAP_WINDOW_HOURS,
} from "@/server/frequency-cap";
import {
  sendingPausedFromRow,
  SENDING_PAUSED_REASON,
} from "@/server/sending-pause";
import {
  resolveOwnerDisplayName,
  resolveSpaFromNumber,
  resolveSpaName,
} from "@/server/emma-spa-profile";
import { loadServiceCatalogForUser } from "@/server/refill-catalog";
import { resolveTreatmentsToServiceIds } from "@/lib/treatment-catalog-resolver";
import { normalizePhoneE164 } from "@/lib/client-list-csv";
import {
  getOrMintWaitlistToken,
  buildWaitlistOptInUrl,
} from "@/server/emma-waitlist.functions";

// ─── Public types ─────────────────────────────────────────────────────────

export type RescueDispatchResult = {
  ok: boolean;
  attemptId: string | null;
  offersSent: number;
  /** Texts the frequency cap held back (patient contacted in-window). */
  offersSuppressed?: number;
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
  /** v2.66.0 — "Your Brand" white-label. The resolved brand for THIS spa
   * (project_your_brand_white_label). Plain SmartSpa when the spa isn't
   * entitled/active; the spa's own name/accent/logo when it is. The claim
   * page styles itself from these. */
  brand: ClaimBrand;
};

/** The brand fields the public claim page renders (subset of ResolvedBrand). */
export type ClaimBrand = {
  name: string;
  accent: string;
  logoUrl: string | null;
  logoMark: string;
  removePoweredBy: boolean;
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
  const base = (process.env.REFILL_PUBLIC_ORIGIN ?? "https://smartspa.app").replace(/\/+$/, "");
  return `${base}/rescue/claim/${token}`;
}

// ─── Fit-patient selection ────────────────────────────────────────────────

type WaitlistRow = {
  id: string;
  patient_node_id: string;
  treatment_types: string[];
  // v2.64.0 — catalog-linked desires (Slice 2 spine). Smart Slot-Fill matches
  // these against the freed provider's qualifications. Null/empty = no stated
  // catalog desire → this row falls through to the legacy free-text matcher.
  desired_service_ids: string[] | null;
};

/** Smart Slot-Fill context for one freed slot (v2.64.0). Built by the
 *  dispatcher only when the freed appointment is linked to a scheduling
 *  provider (appointments.provider_id) — that's the join into the
 *  qualification matrix. Null when the slot is unlinked OR the matrix is
 *  unavailable, in which case selectFitPatients degrades to the legacy
 *  free-text matcher unchanged. */
export type SlotFillContext = {
  /** The freed slot's own treatment resolved to catalog service ids. */
  freedServiceIds: Set<string>;
  /** Services the freed provider is qualified for AND that fit ≤ slot duration. */
  qualifiedFitServiceIds: Set<string>;
  /** services.id → display name (for offer copy + claim surfaces). */
  serviceNameById: Map<string, string>;
};

/** How a fit-patient was matched — drives ranking and offer framing.
 *   "exact"  = patient's stated desire IS the freed slot's service (qualified+fits).
 *   "cross"  = patient wants a DIFFERENT service the provider is qualified for
 *              and that fits the freed duration (the Smart Slot-Fill unlock).
 *   "legacy" = matched by the free-text treatment path (no catalog desire, or
 *              the slot/provider wasn't linked) — pre-v2.64.0 behavior. */
export type RescueMatchKind = "exact" | "cross" | "legacy";

/** Confidence tier of a rescue fit — the gate signal for the autonomous send.
 *  "explicit" = the patient's own waitlist treatment matched the freed slot.
 *  "open" = the patient is on the waitlist with no preference (they opted into
 *  "any opening") AND the slot has a treatment, so we can honestly name what
 *  it's for. Both of those auto-text — they're consented and describable.
 *  "blind" = the freed slot itself has NO treatment set, so SmartSpa can't even
 *  tell the patient what they'd be coming in for → direct mode HOLDS it for a
 *  one-tap human OK rather than texting blind. (Calibrated against real data:
 *  most waitlists carry no per-patient treatment preference, so holding "open"
 *  would have silently switched rescue automation off.) */
export type RescueMatchTier = "explicit" | "open" | "blind";

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
  // v2.64.0 — Smart Slot-Fill context. Non-null only when the freed slot is
  // linked to a scheduling provider; null degrades to the legacy matcher.
  slotFill: SlotFillContext | null = null,
): Promise<
  Array<{
    waitlistId: string;
    patientNodeId: string;
    phone: string;
    lifetimeSpend: number;
    matchTier: RescueMatchTier;
    matchKind: RescueMatchKind;
    // The catalog service this patient's offer should be framed around.
    // null = legacy same-service (offer copy uses the freed slot's treatment).
    offerServiceId: string | null;
    offerServiceName: string | null;
  }>
> {
  // Paginated: a capped read silently drops waitlist members past row 1,000,
  // excluding them from EVERY rescue attempt (silent lost recovery revenue on
  // the core path). The treatment filter below runs in JS over the full set.
  const waitlist = await fetchAllRows<WaitlistRow>((from, to) =>
    sb
      .from("waitlist")
      .select("id, patient_node_id, treatment_types, desired_service_ids")
      .eq("user_id", userId)
      .eq("status", "active")
      .order("id")
      .range(from, to),
  );
  if (waitlist.length === 0) return [];

  // Per-candidate classification. Two layered paths:
  //
  //   1) Smart Slot-Fill catalog path (v2.64.0) — runs only when the freed slot
  //      is provider-linked (slotFill != null). The patient's catalog-linked
  //      desire (desired_service_ids) is matched against what the freed provider
  //      is qualified for AND that fits the slot duration. An exact freed-service
  //      desire → matchKind "exact"; a different-but-qualified-and-fitting desire
  //      → matchKind "cross" (the headline unlock: a freed Tox-w/-Karen slot can
  //      surface a Filler-wanting patient). Both are "explicit" tier — a stated
  //      desire the provider can serve is nameable + consented, so it auto-texts.
  //      desired_service_ids is a POSITIVE signal ONLY: a stated desire that
  //      doesn't match this slot falls THROUGH to the legacy path (never a hard
  //      exclude — catchall opt-ins carry inferred-soft desire, per Slice 2).
  //
  //   2) Legacy free-text matcher (pre-v2.64.0, byte-identical) — the fallback
  //      for every row the catalog path didn't claim, and the ONLY path when the
  //      slot is unlinked (slotFill == null). "explicit" when the patient's own
  //      free-text treatment matches the freed slot, "open" when kept by a
  //      default (no preference but the slot is typed), "blind" when the slot has
  //      no treatment at all. The gate holds "open"/"blind" in direct mode.
  //
  // Net effect: a freed slot with no cross-service-qualified candidates behaves
  // exactly as it did before v2.64.0.
  const trtLower = appointmentTreatment?.toLowerCase() ?? "";
  type Classified = {
    tier: RescueMatchTier;
    matchKind: RescueMatchKind;
    offerServiceId: string | null;
  };
  const classifyByWaitlistId = new Map<string, Classified>();
  const candidates: WaitlistRow[] = waitlist.filter((w) => {
    // 1) Smart Slot-Fill catalog path.
    if (slotFill) {
      const desired = w.desired_service_ids ?? [];
      const exact = desired.find((id) => slotFill.freedServiceIds.has(id));
      if (exact) {
        classifyByWaitlistId.set(w.id, {
          tier: "explicit",
          matchKind: "exact",
          offerServiceId: exact,
        });
        return true;
      }
      const cross = desired.find((id) => slotFill.qualifiedFitServiceIds.has(id));
      if (cross) {
        classifyByWaitlistId.set(w.id, {
          tier: "explicit",
          matchKind: "cross",
          offerServiceId: cross,
        });
        return true;
      }
      // No catalog match → fall through to the legacy free-text path below.
    }

    // 2) Legacy free-text matcher (unchanged).
    let tier: RescueMatchTier | null = null;
    if (!trtLower) {
      // The slot has no treatment set — we can't even name the opening, so
      // every candidate here is "blind" and the gate holds them in direct mode.
      tier = "blind";
    } else if (!w.treatment_types || w.treatment_types.length === 0) {
      // No per-patient preference, but the slot IS typed — they opted into any
      // opening and we can tell them what it's for, so this auto-texts.
      tier = "open";
    } else if (
      w.treatment_types.some(
        (t) => t.toLowerCase() === trtLower || trtLower.includes(t.toLowerCase()),
      )
    ) {
      tier = "explicit"; // the patient's own treatment matches the freed slot
    }
    if (tier) {
      classifyByWaitlistId.set(w.id, { tier, matchKind: "legacy", offerServiceId: null });
      return true;
    }
    return false;
  });
  if (candidates.length === 0) return [];

  // Load patient summaries. Chunk the id list at 300: a large waitlist (now
  // paginated above) can yield more candidate ids than PostgREST's 1,000-row
  // cap or a safe URL length, which would silently drop candidates.
  const patientIds = candidates.map((c) => c.patient_node_id);
  const patients: { id: string; attachments: unknown }[] = [];
  const PATIENT_ID_CHUNK = 300;
  for (let i = 0; i < patientIds.length; i += PATIENT_ID_CHUNK) {
    const { data: chunk } = await sb
      .from("knowledge_nodes")
      .select("id, attachments")
      .in("id", patientIds.slice(i, i + PATIENT_ID_CHUNK));
    if (chunk) patients.push(...chunk);
  }
  const patientById = new Map<
    string,
    {
      phone: string | null;
      lifetimeSpend: number;
      banned: boolean;
      optedOut: boolean;
      hidden: boolean;
    }
  >();
  for (const p of patients ?? []) {
    const a = p.attachments as {
      phone?: string;
      lifetimeSpendUsd?: number;
      banned?: boolean;
      opted_out?: boolean;
      hidden?: boolean;
    } | null;
    patientById.set(p.id, {
      phone: a?.phone ?? null,
      lifetimeSpend: Number(a?.lifetimeSpendUsd ?? 0),
      banned: !!a?.banned,
      optedOut: !!a?.opted_out,
      hidden: !!a?.hidden,
    });
  }

  const fit: Array<{
    waitlistId: string;
    patientNodeId: string;
    phone: string;
    lifetimeSpend: number;
    matchTier: RescueMatchTier;
    matchKind: RescueMatchKind;
    offerServiceId: string | null;
    offerServiceName: string | null;
  }> = [];
  for (const c of candidates) {
    const p = patientById.get(c.patient_node_id);
    if (!p || !p.phone) continue;
    if (p.banned || p.optedOut) continue;
    // v1.34.9.6: skip soft-hidden patients. Hidden = Karen explicitly
    // removed this patient from active flows; rescue shouldn't text them.
    if (p.hidden) continue;
    const cls = classifyByWaitlistId.get(c.id);
    const offerServiceId = cls?.offerServiceId ?? null;
    fit.push({
      waitlistId: c.id,
      patientNodeId: c.patient_node_id,
      phone: p.phone,
      lifetimeSpend: p.lifetimeSpend,
      matchTier: cls?.tier ?? "open",
      matchKind: cls?.matchKind ?? "legacy",
      offerServiceId,
      // Resolve a display name for cross/exact offers; null for legacy (the
      // copy layer falls back to the freed slot's treatment).
      offerServiceName:
        offerServiceId && slotFill
          ? slotFill.serviceNameById.get(offerServiceId) ?? null
          : null,
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
  //
  // v2.64.0 — LEGACY PATH ONLY. When Smart Slot-Fill context is present the
  // real provider-qualification matrix (scheduling_provider_services) is a
  // strictly better signal than most-frequent-prior-provider-by-name, so we
  // skip the affinity heuristic and rank by match quality below instead.
  if (!slotFill && appointmentProvider && fit.length > 0) {
    const targetProvider = appointmentProvider.trim().toLowerCase();
    const candidateIds = fit.map((f) => f.patientNodeId);

    // Chunk candidate ids at 300, and page each chunk: a candidate's all-time
    // appointment history is multiplicative, so even a modest candidate pool can
    // exceed PostgREST's 1,000-row cap — a truncated read would mis-derive
    // primary providers and wrongly drop candidates from the affinity filter.
    const aptRows: { patient_node_id: string | null; provider_name: string | null }[] = [];
    const AFFINITY_ID_CHUNK = 300;
    for (let i = 0; i < candidateIds.length; i += AFFINITY_ID_CHUNK) {
      const slice = candidateIds.slice(i, i + AFFINITY_ID_CHUNK);
      const chunkRows = await fetchAllRows<{
        patient_node_id: string | null;
        provider_name: string | null;
      }>((from, to) =>
        sb
          .from("appointments")
          .select("patient_node_id, provider_name")
          .eq("user_id", userId)
          .in("patient_node_id", slice)
          .not("provider_name", "is", null)
          .order("id")
          .range(from, to),
      );
      aptRows.push(...chunkRows);
    }

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

  // Ranking. Legacy mode (no slot-fill context) preserves pre-v2.64.0 behavior
  // exactly: pure lifetime-value desc, tier ignored (tier only gates the
  // direct-mode hold). Smart Slot-Fill mode ranks by MATCH QUALITY first —
  // exact freed-service desire and legacy same-service matches share the top
  // bucket, then cross-service qualified fills, then "open"/"blind" defaults —
  // breaking ties by lifetime value within each bucket.
  if (slotFill) {
    const rankBucket = (f: (typeof fit)[number]): number => {
      if (f.matchKind === "exact") return 0;
      if (f.matchKind === "legacy" && f.matchTier === "explicit") return 0;
      if (f.matchKind === "cross") return 1;
      if (f.matchTier === "open") return 2;
      return 3; // blind
    };
    fit.sort(
      (a, b) => rankBucket(a) - rankBucket(b) || b.lifetimeSpend - a.lifetimeSpend,
    );
  } else {
    // Sort by lifetime value desc; tie-break is stable.
    fit.sort((a, b) => b.lifetimeSpend - a.lifetimeSpend);
  }
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

// v1.26.15 — Acuity treatment strings often bake provider into the label
// itself ("Tox w/ Karen", "Filler with Lisa", "Tox - Karen"). Every rescue
// surface (SMS, proxy SMS, proxy email, claim page) also stitches its own
// " with <provider>" clause via providerClause / displayProviderName, so
// the raw Acuity value double-renders the same name. This strips the
// redundancy in one place; the connector list covers what's been seen in
// Acuity exports across pilot tenants. Returns the input unchanged when
// no candidate matches (treatment has no baked-in provider, or matches a
// different name).
function stripProviderFromTreatment(
  treatment: string | null,
  providerName: string | null,
  ownerDisplayName: string | null,
): string | null {
  if (!treatment) return treatment;
  const candidates = [providerName, ownerDisplayName]
    .map((c) => c?.trim())
    .filter((c): c is string => !!c && c.length > 0);
  if (candidates.length === 0) return treatment;

  let out = treatment.trim();
  for (const candidate of candidates) {
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(
      `\\s*(?:w\\/\\s*|with\\s+|[-–—\\/:]\\s*)${escaped}\\s*$`,
      "i",
    );
    out = out.replace(pattern, "").trim();
  }
  return out || treatment;
}

function composeRescueSms(args: {
  spaName: string;
  treatmentType: string | null;
  providerName: string | null;
  ownerDisplayName: string | null;
  scheduledAt: string;
  claimUrl: string;
  // v2.64.0 — when set (cross-service / exact catalog match), the message is
  // framed around the opening and names THIS patient's service instead of the
  // freed slot's treatment. Already a clean catalog name (no provider baked in).
  treatmentOverride?: string | null;
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
  // Cross-service fill names the patient's own service. Strip any provider
  // baked into the catalog name ("Tox w/ Karen" → "Tox") so it doesn't collide
  // with the " with <provider>" clause below (which names the provider once).
  const override = stripProviderFromTreatment(
    args.treatmentOverride ?? null,
    args.providerName,
    args.ownerDisplayName,
  )?.trim();
  const cleanedTreatment = stripProviderFromTreatment(
    args.treatmentType,
    args.providerName,
    args.ownerDisplayName,
  );
  // Cross-service fill: name the patient's own service ("…for your Filler");
  // otherwise the freed slot's treatment, as before.
  const treatment = override
    ? ` for ${override}`
    : cleanedTreatment
      ? ` for ${cleanedTreatment}`
      : "";
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
  // v2.64.0 — the service THIS patient's draft is framed around. Set for
  // cross-service / exact catalog matches (Smart Slot-Fill); null = legacy
  // same-service, in which case the draft uses the freed slot's treatment.
  treatmentLabel?: string | null;
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
  const cleanedTreatment = stripProviderFromTreatment(
    args.treatmentType,
    args.providerName,
    args.ownerDisplayName,
  );
  const treatment = cleanedTreatment ? ` ${cleanedTreatment}` : "";
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

/**
 * The single source of truth for ONE patient's warm, STOP-less rescue draft body
 * (v2.191.0). Used by the proxy-email digest (the draft the owner pastes) AND the
 * zero-setup queue lane (the body the local helper sends) — so the two lanes are
 * byte-identical and can't drift. STOP-less because it goes out as the spa's own
 * personal iMessage, not an A2P SMS.
 */
function composeRescueProxyDraftBody(args: {
  spaName: string;
  when: string;
  provider: string;
  offerTreatment: string;
  firstName: string;
  claimUrl: string;
}): string {
  return `Hi ${args.firstName}! Last-minute opening at ${args.spaName} ${args.when}${args.provider} for ${args.offerTreatment}. Tap to grab if you want it: ${args.claimUrl}`;
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
  const cleanedTreatment = stripProviderFromTreatment(
    args.treatmentType,
    args.providerName,
    args.ownerDisplayName,
  );
  const treatment = cleanedTreatment ?? "Appointment";
  const provider = providerClause(
    args.spaName,
    args.providerName,
    args.ownerDisplayName,
    " with ",
  );
  const subject = `${args.spaName} — ${args.offers.length} rescue offer${args.offers.length === 1 ? "" : "s"} ready for ${when} ${treatment}`;

  const draftLines = args.offers
    .map((o) => {
      // Strip any provider baked into the catalog name ("Filler w/ Karen" →
      // "Filler"); the provider clause already names the provider once.
      const offerTreatment =
        stripProviderFromTreatment(
          o.treatmentLabel ?? null,
          args.providerName,
          args.ownerDisplayName,
        )?.trim() || treatment;
      const courtesy = composeRescueProxyDraftBody({
        spaName: args.spaName,
        when,
        provider,
        offerTreatment,
        firstName: o.firstName,
        claimUrl: o.claimUrl,
      });
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
      // Strip any provider baked into the catalog name ("Filler w/ Karen" →
      // "Filler"); the provider clause already names the provider once.
      const offerTreatment =
        stripProviderFromTreatment(
          o.treatmentLabel ?? null,
          args.providerName,
          args.ownerDisplayName,
        )?.trim() || treatment;
      const courtesy = composeRescueProxyDraftBody({
        spaName: args.spaName,
        when,
        provider,
        offerTreatment,
        firstName: o.firstName,
        claimUrl: o.claimUrl,
      });
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

// ─── dispatchAtBookingAsk (internal — Slice 1: the AT-BOOKING ask) ─────────

/** Don't ask if the booking is sooner than this — there'd be no "earlier"
 *  slot worth offering, and the text would read as noise. */
const AT_BOOKING_MIN_LEAD_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * "VIP early-access" ask. Fired from the Acuity webhook the first time an
 * appointment transitions into 'scheduled' with a future date. If the spa
 * opted in (noshow_policies.at_booking_ask_enabled) and isn't paused, and the
 * patient isn't already on the waitlist in ANY status, text them once:
 * "want first dibs if an earlier spot opens?" Tapping the link joins the
 * waitlist with intent_type='earlier_appointment' + scheduled_appointment_id
 * pointing at THIS booking — so the freed-slot matcher (dispatchRescueAttempt)
 * inherits their service + their "earlier-than" ceiling for free, and the
 * opt-in landing page renders the tailored "earlier slot for your <service>
 * on <date>?" copy with no extra work.
 *
 * Scope discipline: owns ONLY the earlier-opening thread. Never touches
 * reminders — Acuity keeps sending those, so the patient is never double-texted.
 *
 * One-ask-ever: a waitlist row in any status (active=already in, paused=already
 * asked, revoked=declined/opted-out) short-circuits. Seed-before-send preserves
 * the ceiling even if the patient taps instantly; an SMS failure rolls the seed
 * back so a future booking can re-ask.
 */
/**
 * The effective outbound mode for a spa (v2.190.0 — B-server.2). The zero-setup
 * 'queue' lane is taken ONLY when the relay is set to it AND auto_send is on —
 * because the helper claims nothing while auto_send is off (server gate), so
 * queueing without it would silently never send. Anything else → 'email' (today's
 * owner-draft lane). Degrades to 'email' on any read failure (migration not
 * applied, no agent row) so the live send path is never broken by this lookup.
 */
async function resolveDelivery(
  sb: SupabaseAdmin,
  userId: string,
): Promise<{ mode: "queue" | "email"; testRecipients: string[] }> {
  try {
    const { data, error } = await (sb as unknown as { from(t: string): any })
      .from("local_agents")
      .select("delivery_mode, auto_send, test_recipients")
      .eq("user_id", userId)
      .maybeSingle();
    if (error || !data) return { mode: "email", testRecipients: [] };
    const row = data as {
      delivery_mode: string | null;
      auto_send: boolean | null;
      test_recipients: unknown;
    };
    const mode =
      row.delivery_mode === "queue" && row.auto_send === true ? "queue" : "email";
    const testRecipients = Array.isArray(row.test_recipients)
      ? (row.test_recipients as unknown[]).filter(
          (r): r is string => typeof r === "string",
        )
      : [];
    return { mode, testRecipients };
  } catch {
    return { mode: "email", testRecipients: [] };
  }
}

/**
 * The test-recipient gate (v2.192.0). An EMPTY allowlist = full live (the queue
 * takes everyone). A NON-EMPTY allowlist = test mode: ONLY those exact (E.164)
 * numbers take the autonomous queue lane; every other patient falls back to the
 * safe email-draft lane (at-booking) or is held for review (rescue) — so a real
 * client can't get an autonomous text while the spa tests internally.
 */
function queueAllows(testRecipients: string[], recipient: string): boolean {
  return testRecipients.length === 0 || testRecipients.includes(recipient);
}

/**
 * Enqueue one patient text for the local helper to send (v2.190.0). Idempotent on
 * (user_id, dedup_key): a duplicate enqueue of a still-pending text is treated as
 * success (already queued), not a double-send. Returns true when the text is
 * queued (new or already-present), false only on a real failure.
 */
async function enqueueOutboundImessage(
  sb: SupabaseAdmin,
  args: {
    userId: string;
    recipient: string;
    body: string;
    source: string;
    dedupKey: string;
    metadata?: Record<string, unknown>;
  },
): Promise<boolean> {
  try {
    const { error } = await (sb as unknown as { from(t: string): any })
      .from("outbound_imessage_queue")
      .insert({
        user_id: args.userId,
        recipient: args.recipient,
        body: args.body,
        source: args.source,
        dedup_key: args.dedupKey,
        metadata: args.metadata ?? {},
      });
    if (error) {
      // 23505 = the dedup unique index fired → an identical text is already
      // pending/claimed. That IS the desired state, so report success.
      if ((error as { code?: string }).code === "23505") return true;
      console.error("[queue enqueue] insert failed:", error);
      return false;
    }
    return true;
  } catch (e) {
    console.error("[queue enqueue] failed:", e);
    return false;
  }
}

/**
 * The per-offer autonomy gate, shared by direct mode (Twilio) and the zero-setup
 * queue lane (v2.191.0) so an autonomous send is governed identically however it
 * leaves the building. Decision:
 *   - hold    → the offer needs the owner's one-tap OK (blind match, or Autonomous
 *               Refill not yet turned on). Goes to the rescue review queue.
 *   - suppress→ the cross-agent frequency cap fired (someone texted this patient
 *               recently); skip and let a later sweep re-evaluate.
 *   - send    → clear to go out.
 * The three gates are PARAMETERIZED (default all-on) so 2b.2 can expose per-gate
 * operator toggles without touching either send path.
 */
type RescueGateDecision =
  | { decision: "send" }
  | { decision: "hold"; reason: string }
  | { decision: "suppress"; lastAgent: string | null; lastAt: string | null };

async function evaluateRescueGate(
  sb: SupabaseAdmin,
  userId: string,
  offer: { patientNodeId: string; matchTier: string },
  opts: {
    autonomousEnabled: boolean;
    holdBlindMatches: boolean;
    applyFrequencyCap: boolean;
  },
): Promise<RescueGateDecision> {
  const holdReason =
    opts.holdBlindMatches && offer.matchTier === "blind"
      ? "This opening has no treatment set, so SmartSpa couldn't tell this patient what they'd be coming in for — your OK before we text."
      : !opts.autonomousEnabled
        ? "SmartSpa found a confident match — approve it to text them. (Turn on Autonomous Refill to let SmartSpa send these the moment a slot frees.)"
        : null;
  if (holdReason) return { decision: "hold", reason: holdReason };
  if (opts.applyFrequencyCap) {
    const recent = await checkRecentContact(sb, userId, offer.patientNodeId, "sms");
    if (recent.recentlyContacted) {
      return {
        decision: "suppress",
        lastAgent: recent.lastAgent,
        lastAt: recent.lastAt,
      };
    }
  }
  return { decision: "send" };
}

/** Park an offer for owner review (held_at/held_reason added by v2.16.0; cast
 *  narrowly — not in generated types). Best-effort: a failed write leaves the
 *  offer unsent rather than blasting it. Shared by both send lanes. */
async function markRescueOfferHeld(
  sb: SupabaseAdmin,
  offerId: string,
  reason: string,
): Promise<void> {
  try {
    await (sb.from("rescue_offers") as unknown as {
      update(v: Record<string, unknown>): {
        eq(c: string, v: string): Promise<{ error: unknown }>;
      };
    })
      .update({ held_at: new Date().toISOString(), held_reason: reason })
      .eq("id", offerId);
  } catch (e) {
    console.error("[rescue] hold-write failed:", e);
  }
}

/** Record an immutable "did NOT text (frequency cap)" ledger row — the honest
 *  audit of a suppression + the tally the cap reads next time. Shared by both
 *  send lanes. */
async function recordRescueSuppression(
  sb: SupabaseAdmin,
  userId: string,
  offer: { patientNodeId: string; matchTier: string },
  info: { lastAgent: string | null; lastAt: string | null },
): Promise<void> {
  await recordAgentAction(sb, userId, {
    agent: "rescue",
    action: "sms_suppressed",
    channel: "sms",
    patientNodeId: offer.patientNodeId,
    count: 1,
    confidenceTier: offer.matchTier,
    initiatedBy: "autonomous",
    metadata: {
      reason: "frequency_cap",
      window_h: FREQUENCY_CAP_WINDOW_HOURS,
      last_agent: info.lastAgent,
      last_at: info.lastAt,
    },
  });
}

export async function dispatchAtBookingAsk(args: {
  sb: SupabaseAdmin;
  userId: string;
  appointmentId: string;
}): Promise<{ ok: boolean; reason?: string }> {
  const { sb, userId, appointmentId } = args;

  // 1) Load appointment + policy together.
  const [aptRes, policyRes] = await Promise.all([
    sb
      .from("appointments")
      .select("*")
      .eq("id", appointmentId)
      .eq("user_id", userId)
      .maybeSingle(),
    sb
      .from("noshow_policies")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle(),
  ]);
  if (aptRes.error)
    throw new Error(`Couldn't load appointment: ${aptRes.error.message}`);
  const apt = aptRes.data;
  const policy = policyRes.data;
  if (!apt) return { ok: false, reason: "Appointment not found." };
  if (!policy) return { ok: false, reason: "No no-show policy for this spa." };

  // 2) Gates — per-spa opt-in (default off; column not in generated types yet,
  //    so loose-cast read mirroring sendingPausedFromRow) + the master pause
  //    that sits above every per-engine enable.
  const askEnabled =
    (policy as { at_booking_ask_enabled?: boolean })
      .at_booking_ask_enabled === true;
  if (!askEnabled)
    return { ok: false, reason: "At-booking ask disabled for this spa." };
  if (sendingPausedFromRow(policy))
    return { ok: false, reason: SENDING_PAUSED_REASON };

  // 3) Eligibility — a future 'scheduled' booking, far enough out to have an
  //    "earlier" worth offering, with a matched patient + a phone to text.
  if (apt.status !== "scheduled")
    return { ok: false, reason: `Status '${apt.status}' not eligible.` };
  if (new Date(apt.scheduled_at).getTime() - Date.now() < AT_BOOKING_MIN_LEAD_MS)
    return { ok: false, reason: "Booking too soon — no earlier slot to offer." };
  if (!apt.patient_node_id)
    return { ok: false, reason: "No matched patient — can't mint opt-in token." };
  // E.164 (+1…) — the iMessage-staging routine's STEP 2c extracts "the +1
  // number (digits + leading +)", and draft_imessage needs a resolvable
  // recipient. Raw 10-digit (Acuity's format) breaks both. Matches rescue's
  // proxy lines, which already emit +1.
  const phone = normalizePhoneE164(apt.booking_phone);
  if (!phone) return { ok: false, reason: "No usable phone on the booking." };

  // 3b) A-list gate (v2.194.0). When the spa restricts the invite to its A-list,
  //     only hand-selected/VIP patients are invited — read straight from
  //     knowledge_nodes.attachments.vip, the SAME flag the Patients-page star and
  //     the "A-list rules" Apply write, so this can't drift from what the owner
  //     sees. Default off = invite every matched patient (today's behavior).
  const aListOnly =
    (policy as { at_booking_a_list_only?: boolean }).at_booking_a_list_only ===
    true;
  if (aListOnly) {
    const { data: pnode } = await sb
      .from("knowledge_nodes")
      .select("attachments")
      .eq("id", apt.patient_node_id)
      .maybeSingle();
    const isVip =
      !!(pnode?.attachments as { vip?: boolean } | null | undefined)?.vip;
    if (!isVip)
      return { ok: false, reason: "Patient not on the A-list — invite skipped." };
  }

  // 4) Patient-level dedup — ask once per patient, ever (across all their
  //    bookings). Any-status row = skip. Reuses the invite path's existing-row
  //    check; the (user_id, patient_node_id) unique index makes the seed race-safe.
  const { data: existing } = await sb
    .from("waitlist")
    .select("id, status")
    .eq("user_id", userId)
    .eq("patient_node_id", apt.patient_node_id)
    .maybeSingle();
  if (existing)
    return { ok: false, reason: `Already on waitlist (${existing.status}).` };

  // 5) Transport. Rejuv (and any spa without Twilio) runs the iMessage PROXY
  //    lane: a ready-to-send draft is emailed to the owner → pasted into Claude
  //    Desktop (iMessage MCP) → sent from the spa's own number. Mirror rescue's
  //    mode pick — proxy when rescue_proxy_email/phone is set; direct otherwise.
  const proxyEmail = policy.rescue_proxy_email;
  const proxyPhone = policy.rescue_proxy_phone;
  const isProxyMode = !!(proxyEmail || proxyPhone);
  const fromNumber = await resolveSpaFromNumber(sb, userId);
  // Zero-setup queue lane (B-server.2): when active, the local helper sends the
  // text from the spa's own number — needs neither a proxy email nor a Twilio
  // number, so it must pass the transport gate on its own. In test mode (non-empty
  // allowlist), only allowlisted numbers take the queue; everyone else falls back
  // to the email/direct lane so a real client can't get an autonomous text.
  const { mode: deliveryMode, testRecipients } = await resolveDelivery(sb, userId);
  const queueForThis =
    deliveryMode === "queue" && queueAllows(testRecipients, phone);
  // Need at least one viable lane: the queue lane (when it'll take this recipient)
  // needs none of the below; proxy-email needs no number; proxy-SMS to the owner
  // and a direct patient text both need a fromNumber.
  if (!queueForThis && !proxyEmail && !fromNumber)
    return { ok: false, reason: "No transport — no SMS number and no proxy email." };

  // 6) Pre-seed the paused waitlist row carrying the "earlier-than" ceiling.
  //    intent_type='earlier_appointment' + scheduled_appointment_id=this booking
  //    → the matcher inherits the service and the opt-in page self-personalizes.
  const catalog = await loadServiceCatalogForUser(sb, userId).catch(() => []);
  const treatmentTypes = apt.treatment_type ? [apt.treatment_type] : [];
  const desiredServiceIds = apt.treatment_type
    ? resolveTreatmentsToServiceIds([apt.treatment_type], catalog).serviceIds
    : [];
  const { data: seeded, error: seedErr } = await sb
    .from("waitlist")
    .insert({
      user_id: userId,
      patient_node_id: apt.patient_node_id,
      status: "paused",
      opt_in_source: "at-booking-ask",
      intent_type: "earlier_appointment",
      scheduled_appointment_id: apt.id,
      treatment_types: treatmentTypes,
      desired_service_ids: desiredServiceIds,
    })
    .select("id")
    .single();
  if (seedErr || !seeded) {
    // A row appeared between the dedup read and here (race) — treat as
    // already-asked, not an error.
    return { ok: false, reason: `Seed skipped: ${seedErr?.message ?? "unknown"}` };
  }

  // 7) Mint token, compose, send via the chosen lane. Seed-then-send means an
  //    instant tap still finds the ceiling; if NOTHING goes out we roll the seed
  //    back so a future booking can re-ask (else the dedup treats a
  //    never-delivered row as "already asked" forever).
  const token = await getOrMintWaitlistToken(sb, userId, apt.patient_node_id);
  const optInUrl = buildWaitlistOptInUrl(token);
  const spaName = await resolveSpaName(sb, userId);
  const fullName = apt.booking_name ?? "Patient";
  const firstName = extractFirstName(fullName) ?? "there";

  let sent = false;
  if (queueForThis) {
    // Zero-setup lane (B-server.2): enqueue the patient text; the local helper
    // claims and sends it from the spa's own number within ~60s — no owner email,
    // no Claude Desktop paste, no manual Send. The seed.id keys the enqueue so a
    // retried dispatch can't double-queue the same ask.
    const draft = composeAtBookingProxyDraft({ spaName, firstName, optInUrl });
    sent = await enqueueOutboundImessage(sb, {
      userId,
      recipient: phone,
      body: draft,
      source: "at_booking",
      dedupKey: `at-booking:${seeded.id}`,
    });
  } else if (isProxyMode) {
    // Proxy lane: hand the owner a ready-to-send iMessage draft. No STOP footer
    // — it goes out as the spa's own personal iMessage, not an A2P SMS.
    const draft = composeAtBookingProxyDraft({ spaName, firstName, optInUrl });
    if (proxyEmail) {
      const resendKey = process.env.RESEND_API_KEY;
      if (!resendKey) {
        console.error("[at-booking proxy] RESEND_API_KEY missing — skipping email.");
      } else {
        try {
          const fromEmail = await resolveSpaFromEmail(userId);
          const email = composeAtBookingProxyEmail({
            spaName,
            firstName,
            fullName,
            phone,
            draft,
          });
          const res = await postResendEmail({
            apiKey: resendKey,
            from: fromEmail,
            to: [proxyEmail],
            subject: email.subject,
            text: email.text,
            html: email.html,
            tags: [{ name: "type", value: "at-booking-ask-proxy" }],
            signal: AbortSignal.timeout(15_000),
          });
          if (res.ok) sent = true;
          else
            console.error(
              `[at-booking proxy] email failed: ${res.status} ${res.body.slice(0, 160)}`,
            );
        } catch (e) {
          console.error("[at-booking proxy] email failed:", e);
        }
      }
    }
    if (proxyPhone && fromNumber) {
      try {
        await sendSms({
          from: fromNumber,
          to: proxyPhone,
          body: `Text ${firstName} (${phone}):\n${draft}`,
        });
        sent = true;
      } catch (e) {
        console.error("[at-booking proxy] owner SMS failed:", e);
      }
    }
  } else if (fromNumber) {
    // Direct lane: text the patient via Twilio. STOP footer (A2P compliance).
    const body = composeAtBookingAskSms({
      spaName,
      patientFirstName: firstName,
      optInUrl,
    });
    try {
      await sendSms({ from: fromNumber, to: phone, body });
      sent = true;
    } catch (e) {
      console.error("[at-booking direct] SMS failed:", e);
    }
  }

  if (!sent) {
    await sb.from("waitlist").delete().eq("id", seeded.id);
    return { ok: false, reason: "Send failed on all available lanes." };
  }
  return { ok: true };
}

/**
 * The VIP early-access ask SMS. Deliberately positive — "first dibs," not
 * "join a waitlist" — and deliberately generic: the tailored "earlier slot for
 * your <service> on <date>?" lives on the opt-in landing page (pre-seeded
 * ceiling), so this stays short and clean. Caller-owned STOP footer.
 */
function composeAtBookingAskSms(args: {
  spaName: string;
  patientFirstName: string;
  optInUrl: string;
}): string {
  return [
    `${args.spaName}: you're booked, ${args.patientFirstName} 🎉 Want first dibs if an earlier spot opens up? Tap for VIP early-access alerts: ${args.optInUrl}`,
    `Reply STOP to opt out.`,
  ].join("\n");
}

/**
 * The patient-facing iMessage body for the PROXY lane — warm and STOP-less,
 * since it goes out as the spa's own personal iMessage (not an A2P SMS).
 * Mirrors the courtesy tone of rescue's proxy drafts.
 */
function composeAtBookingProxyDraft(args: {
  spaName: string;
  firstName: string;
  optInUrl: string;
}): string {
  return `Hi ${args.firstName}! You're booked at ${args.spaName} 🎉 Want first dibs if an earlier spot opens up? Tap here and we'll text you the moment one does: ${args.optInUrl}`;
}

/**
 * Owner-facing "paste into Claude Desktop" email carrying a single ready-to-send
 * iMessage draft. Same AUTO-SEND format as rescue's composeProxyEmail, scoped to
 * the one patient who just booked.
 */
function composeAtBookingProxyEmail(args: {
  spaName: string;
  firstName: string;
  fullName: string;
  phone: string;
  draft: string;
}): { subject: string; text: string; html: string } {
  const subject = `${args.spaName} — VIP early-access text for ${args.firstName}`;
  const text = [
    "═══ AUTO-SEND ═══",
    "Paste this whole email into Claude Desktop with the iMessage MCP installed.",
    "Claude will call draft_imessage(recipient_phone, body) for the patient below —",
    "review it and tap Send.",
    "═════════════════",
    "",
    `${args.firstName} just booked — offer them first dibs on earlier openings.`,
    "",
    // NOTE: markers are intentionally the PLURAL "DRAFTS" form so this email is
    // byte-compatible with rescue's composeProxyEmail — the spa's Claude Desktop
    // iMessage-staging routine greps for "═══ READY-TO-SEND DRAFTS ═══" and
    // would skip a singular header. One patient = one block here.
    "═══ READY-TO-SEND DRAFTS ═══",
    "",
    "────────────────",
    `To: ${args.phone} (${args.fullName})`,
    "",
    args.draft,
    "",
    "═══ END DRAFTS ═══",
    "",
    "Prefer manual? Just text the link above to them yourself.",
  ].join("\n");
  const html = `<!doctype html><html><body style="margin:0;padding:32px;background:#fafaf7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Inter,sans-serif;color:#1a1a1a;">
  <div style="max-width:640px;margin:0 auto;">
    <div style="margin-bottom:20px;padding:14px 16px;background:#ecfdf5;border-left:3px solid #047857;border-radius:6px;font-size:13px;color:#064e3b;line-height:1.55;">
      <div style="font-size:11px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#047857;margin-bottom:6px;">Auto-send</div>
      Paste this whole email into Claude Desktop with the iMessage MCP installed. Claude will call <code style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;background:#d1fae5;padding:1px 5px;border-radius:3px;">draft_imessage(recipient_phone, body)</code> for the patient below &mdash; review it and tap Send.
    </div>
    <div style="font-size:14px;color:#374151;line-height:1.55;margin-bottom:18px;"><strong>${args.firstName}</strong> just booked &mdash; offer them first dibs on earlier openings.</div>
    <div style="font-size:11px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#047857;margin:24px 0 8px;">Ready-to-send draft</div>
    <div style="margin:18px 0;padding:14px 16px;background:#f7f6f3;border-left:3px solid #047857;border-radius:6px;">
      <div style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:#222;margin-bottom:8px;"><strong>To:</strong> ${args.phone} <span style="color:#666;">(${args.fullName})</span></div>
      <div style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:#222;white-space:pre-wrap;">${args.draft}</div>
    </div>
    <div style="font-size:12px;color:#6b7280;line-height:1.55;margin-top:20px;border-top:1px solid #e5e7eb;padding-top:14px;">Prefer manual? Just text the link above to them yourself.</div>
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
      .from("appointments")
      .select("*")
      .eq("id", appointmentId)
      .eq("user_id", userId)
      .maybeSingle(),
    sb
      .from("noshow_policies")
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
      reason: "Refill agent disabled for this spa.",
    };
  }
  // Tier-2 kill switch (Slice 3): the master pause sits above every per-engine
  // enable. If the spa has paused all sending, halt here — before any attempt,
  // proxy draft, or direct text. The policy row is already loaded, so this is a
  // free read of a column it's holding.
  if (sendingPausedFromRow(policy)) {
    return {
      ok: false,
      attemptId: null,
      offersSent: 0,
      reason: SENDING_PAUSED_REASON,
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
    .from("rescue_attempts")
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

  // v2.64.0 — Smart Slot-Fill context. The qualification matrix
  // (scheduling_provider_services) keys on scheduling_providers.id, reachable
  // only when this freed appointment is linked to a provider via provider_id
  // (≈half of Acuity-imported appts are; the rest are name-matched only). When
  // linked, resolve: the freed slot's own service, the set of services this
  // provider is qualified for AND that fit ≤ the freed duration, and the
  // service-name lookup. When NOT linked — or anything below throws — slotFill
  // stays null and selectFitPatients degrades to the legacy free-text matcher.
  let slotFill: SlotFillContext | null = null;
  if (apt.provider_id) {
    try {
      const catalog = await loadServiceCatalogForUser(sb, userId);
      if (catalog.length > 0) {
        const serviceNameById = new Map(catalog.map((s) => [s.id, s.name]));
        // Opt-out qualification: a row with offered=false EXCLUDES the service;
        // no row at all means the provider offers it. A per-provider duration
        // override (when set) wins over the service's default (effective dur).
        // Paginated: a provider's qualification rows scale with the catalog
        // size, so a capped read could silently mis-classify services past
        // row 1,000 as offered (no row = offered) and skew the match pool.
        const psRows = await fetchAllRows<{
          service_id: string;
          offered: boolean;
          duration_min: number | null;
        }>((from, to) =>
          sb
            .from("scheduling_provider_services")
            .select("service_id, offered, duration_min")
            .eq("provider_id", apt.provider_id as string)
            .order("service_id")
            .range(from, to),
        );
        const excluded = new Set<string>();
        const overrideDuration = new Map<string, number>();
        for (const r of psRows) {
          if (r.offered === false) excluded.add(r.service_id);
          if (r.duration_min != null) overrideDuration.set(r.service_id, r.duration_min);
        }
        const D = apt.duration_min;
        const qualifiedFitServiceIds = new Set<string>();
        for (const s of catalog) {
          if (excluded.has(s.id)) continue;
          const effDuration = overrideDuration.get(s.id) ?? s.durationMin;
          if (effDuration <= D) qualifiedFitServiceIds.add(s.id);
        }
        const freed = resolveTreatmentsToServiceIds(
          apt.treatment_type ? [apt.treatment_type] : [],
          catalog,
        );
        slotFill = {
          freedServiceIds: new Set(freed.serviceIds),
          qualifiedFitServiceIds,
          serviceNameById,
        };
      }
    } catch (e) {
      console.error(
        "[rescue] slot-fill context build failed; falling back to legacy matcher:",
        e,
      );
      slotFill = null;
    }
  }

  const fitPatients = await selectFitPatients(
    sb,
    userId,
    apt.treatment_type,
    policy.rescue_max_concurrent ?? 5,
    providerForMatch,
    slotFill,
  );
  if (fitPatients.length === 0) {
    // Still record an attempt for the audit trail, marked closed_unfilled.
    const { data: attempt } = await sb
      .from("rescue_attempts")
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
  //    partial unique index `rescue_attempts_one_active_per_apt`
  //    constrains at most one active row per (user_id, freed_appointment_id);
  //    the losing INSERT comes back with SQLSTATE 23505 and we fall
  //    through to returning the winner's id rather than throwing.
  const { data: attempt, error: attemptErr } = await sb
    .from("rescue_attempts")
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
        .from("rescue_attempts")
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
  // Zero-setup queue lane (B-server.2b): when active it sends each text from the
  // spa's own number via the local helper — needs no Twilio number, and takes
  // precedence over the proxy-digest/direct paths below. testRecipients gates it
  // per-patient in test mode (non-allowlisted offers are held for review).
  const { mode: deliveryMode, testRecipients } = await resolveDelivery(sb, userId);

  // Need fromNumber when: direct mode (sends to each patient) OR proxy
  // mode with proxyPhone set (sends consolidated SMS to spa owner). Pure
  // proxy-email-only mode and the queue lane don't need it.
  const willNeedFromNumber =
    deliveryMode !== "queue" && (!isProxyMode || !!proxyPhone);
  if (willNeedFromNumber && !fromNumber) {
    await sb
      .from("rescue_attempts")
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
    matchTier: RescueMatchTier;
    // v2.64.0 — the service this offer is framed around. null = legacy
    // same-service (copy uses the freed slot's treatment); a name = a
    // cross-service or exact catalog match (copy names this service).
    offerServiceId: string | null;
    offerServiceName: string | null;
  };
  const collected: CollectedOffer[] = [];
  for (const fp of fitPatients) {
    const { data: offer, error: offerErr } = await sb
      .from("rescue_offers")
      .insert({
        user_id: userId,
        rescue_attempt_id: attempt.id,
        appointment_id: appointmentId,
        patient_node_id: fp.patientNodeId,
        // Persist what this offer was framed around so the claim page + Karen
        // note name the right service even if the waitlist changes later.
        offer_service_id: fp.offerServiceId,
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
      matchTier: fp.matchTier,
      offerServiceId: fp.offerServiceId,
      offerServiceName: fp.offerServiceName,
    });
  }

  // 6b) Branch: proxy mode (Karen-in-the-loop) vs direct mode (per-patient).
  //     Proxy mode activates when EITHER rescue_proxy_phone OR
  //     rescue_proxy_email is set on the policy — both can be set together.
  //     (Declared at top of step 6 in v1.4.4 so the upfront fromNumber
  //     check could be path-aware. Re-used here for readability.)

  let offersSent = 0;
  let offersSuppressed = 0;

  if (deliveryMode === "queue" && collected.length > 0) {
    // Zero-setup rescue lane (B-server.2b): the autonomous, no-touch path. Same
    // gates as direct mode (shared evaluator; per-gate operator toggles wired in
    // 2b.2 = v2.199.0 — both lanes read the same policy columns),
    // but each cleared offer is ENQUEUED as a warm STOP-less iMessage for the
    // local helper to send from the spa's own number — no Twilio, no owner email,
    // no Claude Desktop paste, no manual Send.
    const autonomousEnabled =
      (policy as { rescue_autonomous_enabled?: boolean })
        .rescue_autonomous_enabled === true;
    // v2.199.0: per-gate operator safeguards, default ON. `!== false` keeps the
    // engine's prior behavior when the columns are null/undefined (pre-migration).
    const holdBlindMatches =
      (policy as { hold_blind_matches?: boolean | null }).hold_blind_matches !==
      false;
    const applyFrequencyCap =
      (policy as { apply_frequency_cap?: boolean | null })
        .apply_frequency_cap !== false;

    // Hydrate names + the shared rendering bits once (mirrors composeProxyEmail so
    // the queued body is byte-identical to the digest draft).
    const patientIds = collected.map((c) => c.patientNodeId);
    const { data: patientNodes } = await sb
      .from("knowledge_nodes")
      .select("id, title")
      .in("id", patientIds);
    const titleById = new Map(
      (patientNodes ?? []).map((p) => [p.id, p.title as string | null]),
    );
    const when = formatRescueWhen(apt.scheduled_at);
    const cleanedTreatment = stripProviderFromTreatment(
      apt.treatment_type,
      apt.provider_name,
      ownerDisplayName,
    );
    const treatment = cleanedTreatment ?? "Appointment";
    const provider = providerClause(
      spaName,
      apt.provider_name,
      ownerDisplayName,
      " with ",
    );

    for (const c of collected) {
      // Test mode: a real patient who isn't on the allowlist is held for review
      // rather than auto-texted, so internal testing can't reach a real client.
      if (!queueAllows(testRecipients, c.phone)) {
        await markRescueOfferHeld(
          sb,
          c.offerId,
          "Test mode: only your test number auto-sends right now — this patient is held for your review.",
        );
        continue;
      }
      const gate = await evaluateRescueGate(sb, userId, c, {
        autonomousEnabled,
        holdBlindMatches,
        applyFrequencyCap,
      });
      if (gate.decision === "hold") {
        await markRescueOfferHeld(sb, c.offerId, gate.reason);
        continue;
      }
      if (gate.decision === "suppress") {
        offersSuppressed++;
        await recordRescueSuppression(sb, userId, c, {
          lastAgent: gate.lastAgent,
          lastAt: gate.lastAt,
        });
        continue;
      }
      const firstName =
        extractFirstName(titleById.get(c.patientNodeId) ?? "Patient") ?? "there";
      const offerTreatment =
        stripProviderFromTreatment(
          c.offerServiceName ?? null,
          apt.provider_name,
          ownerDisplayName,
        )?.trim() || treatment;
      const body = composeRescueProxyDraftBody({
        spaName,
        when,
        provider,
        offerTreatment,
        firstName,
        claimUrl: c.claimUrl,
      });
      const queued = await enqueueOutboundImessage(sb, {
        userId,
        recipient: c.phone,
        body,
        source: "rescue",
        dedupKey: `rescue:${c.offerId}`,
      });
      if (queued) {
        // Delivered-via-queue marker (mirrors the proxy/direct message_id shape so
        // telemetry needs no new column) + the autonomous send ledger row.
        await sb
          .from("rescue_offers")
          .update({ message_id: `queue:${c.offerId}` })
          .eq("id", c.offerId);
        offersSent++;
        await recordAgentAction(sb, userId, {
          agent: "rescue",
          action: "sms_sent",
          channel: "sms",
          patientNodeId: c.patientNodeId,
          count: 1,
          confidenceTier: c.matchTier,
          initiatedBy: "autonomous",
        });
      } else {
        await sb
          .from("rescue_offers")
          .update({ send_error: "queue: enqueue failed" })
          .eq("id", c.offerId);
      }
    }
  } else if (isProxyMode && collected.length > 0) {
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
        treatmentLabel: c.offerServiceName,
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
          const res = await postResendEmail({
            apiKey: resendKey,
            from: fromEmail,
            to: [proxyEmail],
            subject: email.subject,
            text: email.text,
            html: email.html,
            tags: [
              { name: "type", value: "emma-rescue-proxy" },
              { name: "attempt_id", value: attempt.id },
            ],
            signal: AbortSignal.timeout(15_000),
          });
          if (res.ok) {
            proxyEmailMessageId = res.id ?? null;
          } else {
            console.error(
              `[rescue proxy] Email send failed: ${res.status} ${res.body.slice(0, 200)}`,
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
      .from("rescue_offers")
      .update({ message_id: proxyMarker })
      .in(
        "id",
        collected.map((c) => c.offerId),
      );
    if (proxySmsMessageId || proxyEmailMessageId) {
      offersSent = collected.length;
    }
  } else {
    // Direct mode — per-patient auto-send (production behavior when no proxy
    // fields are configured). This is the ONLY truly-autonomous outbound send,
    // so the confidence gate lives here: a "blind" fit — the freed slot has no
    // treatment set, so we can't honestly tell the patient what they'd be
    // claiming — is HELD for the owner's one-tap OK instead of auto-texted.
    // Explicit matches and consented "open" fits (no preference + a typed slot)
    // send as before. Held offers don't count toward offersSent (no send
    // happened) and surface in the rescue-page review queue.
    //
    // Tier-2 autonomy gate (Slice 4): confident matches only AUTO-send once the
    // owner has turned on Autonomous Refill (earned + adopted). Until then even
    // confident offers are HELD for her one-tap OK — the review queue is the
    // training ground that earns autonomy. Blind matches are held regardless.
    const autonomousEnabled =
      (policy as { rescue_autonomous_enabled?: boolean })
        .rescue_autonomous_enabled === true;
    // v2.199.0: per-gate operator safeguards, default ON. `!== false` keeps the
    // engine's prior behavior when the columns are null/undefined (pre-migration).
    const holdBlindMatches =
      (policy as { hold_blind_matches?: boolean | null }).hold_blind_matches !==
      false;
    const applyFrequencyCap =
      (policy as { apply_frequency_cap?: boolean | null })
        .apply_frequency_cap !== false;
    for (const c of collected) {
      // Same gate as the queue lane (shared evaluator). Tier-2 autonomy gate is
      // autonomousEnabled; the blind-match hold + frequency cap are now per-spa
      // policy (v2.199.0), default ON so behavior is unchanged until toggled.
      const gate = await evaluateRescueGate(sb, userId, c, {
        autonomousEnabled,
        holdBlindMatches,
        applyFrequencyCap,
      });
      if (gate.decision === "hold") {
        await markRescueOfferHeld(sb, c.offerId, gate.reason);
        continue;
      }
      if (gate.decision === "suppress") {
        offersSuppressed++;
        await recordRescueSuppression(sb, userId, c, {
          lastAgent: gate.lastAgent,
          lastAt: gate.lastAt,
        });
        continue;
      }
      const body = composeRescueSms({
        spaName,
        treatmentType: apt.treatment_type,
        providerName: apt.provider_name,
        ownerDisplayName,
        scheduledAt: apt.scheduled_at,
        claimUrl: c.claimUrl,
        treatmentOverride: c.offerServiceName,
      });
      try {
        const resp = await sendSms({
          from: fromNumber,
          to: c.phone,
          body,
        });
        await sb
          .from("rescue_offers")
          .update({ message_id: resp.messageId })
          .eq("id", c.offerId);
        offersSent++;
        // Tier-2 ledger (autonomous): one IMMUTABLE row PER patient texted with
        // no human tap — the dispute-proof record of what the agent did on its
        // own AND the shared tally the frequency cap reads next time. (Slice 1
        // logged this as one aggregate row; per-patient is what makes the
        // cross-agent cap above possible.) Best-effort — the text already sent.
        await recordAgentAction(sb, userId, {
          agent: "rescue",
          action: "sms_sent",
          channel: "sms",
          patientNodeId: c.patientNodeId,
          count: 1,
          confidenceTier: c.matchTier,
          initiatedBy: "autonomous",
        });
      } catch (e) {
        await sb
          .from("rescue_offers")
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
    .from("rescue_attempts")
    .update({ outreach_count: offersSent })
    .eq("id", attempt.id);

  // Outbound heartbeat: rescue offers just went out (proxy iMessage or direct
  // SMS). Like recall, the proxy/iMessage path writes no patient_outreach row,
  // so this beat is what makes the delivery health card see rescue activity.
  // Only stamp when something actually went out. Best-effort (never throws).
  if (offersSent > 0) {
    await recordMessagingActivity(sb, userId, "sms", "rescue", offersSent);
  }

  return { ok: true, attemptId: attempt.id, offersSent, offersSuppressed };
}

// ─── Public landing-page payload ──────────────────────────────────────────

const tokenInput = z.object({
  token: z.string().uuid(),
});

// v2.66.0 — lightweight brand-only lookup for the claim route's <head> loader,
// so iMessage / Mail link previews show the SPA's brand name (og:site_name)
// for a white-labeled spa, not "SmartSpa". Kept separate from the full payload
// fn (which runs several queries) since a preview scraper needs only the name.
export const getRescueOfferBrand = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => tokenInput.parse(input))
  .handler(async ({ data }): Promise<{ name: string } | null> => {
    const sb = admin();
    const { data: offer } = await sb
      .from("rescue_offers")
      .select("user_id")
      .eq("token", data.token)
      .maybeSingle();
    if (!offer) return null;
    const resolved = await resolveBrand(sb, offer.user_id);
    return { name: resolved.name };
  });

export const getRescueOfferPayload = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => tokenInput.parse(input))
  .handler(async ({ data }): Promise<RescueOfferPayload | null> => {
    const sb = admin();

    const { data: offer } = await sb
      .from("rescue_offers")
      .select(
        "id, user_id, appointment_id, patient_node_id, claimed_at, declined_at, expired_at, offer_service_id",
      )
      .eq("token", data.token)
      .maybeSingle();
    if (!offer) return null;

    // v2.64.0 — Smart Slot-Fill: when this offer was framed around a specific
    // catalog service (a cross-service or exact match), the claim page must
    // name THAT service ("for your Filler"), not the freed slot's original
    // treatment. Resolve its name; null/missing falls back to the freed slot
    // treatment below.
    let offerServiceName: string | null = null;
    if (offer.offer_service_id) {
      const { data: svc } = await sb
        .from("services")
        .select("name")
        .eq("id", offer.offer_service_id)
        .maybeSingle();
      offerServiceName = svc?.name?.trim() || null;
    }

    const [
      { data: apt },
      { data: spa },
      { data: owner },
      { data: patient },
      { data: anyClaimed },
    ] = await Promise.all([
      sb
        .from("appointments")
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
        .from("rescue_offers")
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

    const resolvedOwnerDisplayName = owner?.title?.trim() || null;

    // v2.66.0 — resolve the spa's brand so the claim page can white-label
    // itself (project_your_brand_white_label). resolveBrand degrades to plain
    // SmartSpa on any failure, so this never blocks the offer.
    const resolved = await resolveBrand(sb, offer.user_id);

    return {
      spaName: spa?.title?.trim() || "your spa",
      patientFirstName: extractFirstName(patient?.title ?? null),
      status,
      // Strip any provider baked into the name ("Tox w/ Karen" → "Tox") — the
      // claim page renders the provider on its own row, so leaving it in would
      // double up.
      treatmentType: stripProviderFromTreatment(
        offerServiceName ?? apt.treatment_type,
        apt.provider_name,
        resolvedOwnerDisplayName,
      ),
      providerName: apt.provider_name,
      ownerDisplayName: resolvedOwnerDisplayName,
      scheduledAt: apt.scheduled_at,
      durationMin: apt.duration_min,
      brand: {
        name: resolved.name,
        accent: resolved.accent,
        logoUrl: resolved.logoUrl,
        logoMark: resolved.logoMark,
        removePoweredBy: resolved.removePoweredBy,
      },
    };
  });

// ─── claimRescueSlot (public) — first-tap-wins ────────────────────────────

export const claimRescueSlot = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => tokenInput.parse(input))
  .handler(async ({ data }): Promise<RescueClaimResult> => {
    const sb = admin();

    // 1) Load the offer
    const { data: offer } = await sb
      .from("rescue_offers")
      .select(
        "id, user_id, appointment_id, patient_node_id, rescue_attempt_id, claimed_at, offer_service_id",
      )
      .eq("token", data.token)
      .maybeSingle();
    if (!offer) {
      return { ok: false, status: "no_longer_available" };
    }

    if (offer.claimed_at) {
      // Re-visiting; already claimed by us. Return success-shape.
      const { data: apt } = await sb
        .from("appointments")
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
      .from("rescue_offers")
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
      .from("appointments")
      .update({
        patient_node_id: offer.patient_node_id,
        status: "scheduled",
      })
      .eq("id", offer.appointment_id)
      .in("status", ["cancelled", "no_show"])
      .select("id, scheduled_at, treatment_type")
      .maybeSingle();

    if (reassignErr || !reassigned) {
      // Sibling won. Roll our claim back so the spa knows the offer
      // didn't actually take.
      await sb
        .from("rescue_offers")
        .update({ claimed_at: null })
        .eq("id", offer.id);
      return { ok: false, status: "claimed_by_someone_else" };
    }

    // 4) Mark the rescue attempt as filled
    await sb
      .from("rescue_attempts")
      .update({
        status: "filled",
        filled_at: new Date().toISOString(),
        filled_by_offer_id: offer.id,
      })
      .eq("id", offer.rescue_attempt_id)
      .eq("status", "active");

    // 4b) v2.64.0 — cross-service fill honesty note. When the patient grabbed
    //     this opening for a DIFFERENT service than the freed slot's original
    //     (Smart Slot-Fill), the appointment row still carries the old
    //     treatment_type (the PMS writeback is P3, not this slice). Rather than
    //     silently leave it mislabeled, record a note on the attempt so the
    //     owner knows to set the right type in their PMS. Skipped for exact /
    //     same-service fills (resolved name == freed treatment) and best-effort
    //     (the claim already succeeded — a note failure must not roll it back).
    if (offer.offer_service_id) {
      try {
        const [{ data: svc }, { data: patientNode }] = await Promise.all([
          sb.from("services").select("name").eq("id", offer.offer_service_id).maybeSingle(),
          sb.from("knowledge_nodes").select("title").eq("id", offer.patient_node_id).maybeSingle(),
        ]);
        const svcName = svc?.name?.trim() || null;
        const freedTreatment = reassigned.treatment_type?.trim() || null;
        const isCrossService =
          !!svcName &&
          (!freedTreatment || svcName.toLowerCase() !== freedTreatment.toLowerCase());
        if (isCrossService) {
          const who = extractFirstName(patientNode?.title ?? null) ?? "A waitlist patient";
          const note = `Cross-service fill: ${who} grabbed this opening for ${svcName}${
            freedTreatment ? ` (the slot freed up was ${freedTreatment})` : ""
          } — set the appointment type to ${svcName} in your booking calendar.`;
          await sb
            .from("rescue_attempts")
            .update({ notes: note })
            .eq("id", offer.rescue_attempt_id);
        }
      } catch (e) {
        console.error("[rescue] cross-service claim note failed (non-fatal):", e);
      }
    }

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
    //    committed and stamp the outcome on rescue_attempts.notes so
    //    the spa can reconcile manually from the rescue dashboard. The
    //    patient still sees "you're on the books" — never punish the
    //    patient for an upstream API issue.
    const stampWritebackNotes = async (notes: string) => {
      try {
        await sb
          .from("rescue_attempts")
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
        .from("appointments")
        .select("id, source, external_id, scheduled_at")
        .eq("id", offer.appointment_id)
        .maybeSingle();

      const source = claimedApt?.source;
      const writeableSource =
        source === "acuity" ||
        source === "square" ||
        source === "boulevard" ||
        source === "mindbody" ||
        source === "vagaro" ||
        source === "booker" ||
        source === "zenoti" ||
        source === "jane"
          ? source
          : null;

      // v1.43.0 — Lite Mode writeback branch. When the appointment
      // came in via Lite Mode email parse (source matches /^lite-/),
      // we don't have vendor API access. Compose + send the owner an
      // email with a deeplink to the vendor portal + copy-paste payload
      // so they can do the booking in 30 seconds. The vendor's own
      // confirmation email triggered by that manual book closes the
      // loop via the next Lite Mode parse.
      const isLightModeSource =
        typeof source === "string" && source.startsWith("lite-");

      if (isLightModeSource) {
        try {
          const { dispatchLightModeWriteback } = await import(
            "@/server/light-mode-writeback.functions"
          );
          const result = await dispatchLightModeWriteback({
            userId: offer.user_id,
            appointmentId: offer.appointment_id,
            patientNodeId: offer.patient_node_id,
            source: source as string,
            originalExternalId: claimedApt?.external_id ?? null,
            scheduledAt:
              (claimedApt?.scheduled_at as string | null | undefined) ?? null,
          });
          await stampWritebackNotes(result.notes);
        } catch (e) {
          console.error(
            "light-mode writeback dispatch failed:",
            e instanceof Error ? e.message : e,
          );
          await stampWritebackNotes(
            `writeback_failed: light_mode dispatch threw (${
              e instanceof Error ? e.message.slice(0, 80) : "unknown"
            })`,
          );
        }
      } else if (!writeableSource) {
        // CSV-only spas, or future platforms not yet wired for write-back.
        // No-op silently — the claim flow is complete for them.
        console.info(
          `[claim-writeback] skipped (source=${source ?? "unknown"}) for appointment ${offer.appointment_id}`,
        );
        await stampWritebackNotes(
          `writeback_skipped: source=${source ?? "unknown"}`,
        );
      } else if (!claimedApt?.external_id) {
        console.warn(
          `[claim-writeback] ${writeableSource} row missing external_id; cannot resolve original appointment for ${offer.appointment_id}`,
        );
        await stampWritebackNotes("writeback_failed: missing_external_id");
      } else if (writeableSource === "acuity") {
        // scheduler_connections is not in the generated Database
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
          .from("scheduler_connections")
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
            .from("appointments")
            .update({ external_id: String(newApt.id) })
            .eq("id", offer.appointment_id);

          await stampWritebackNotes(
            `writeback_ok: new_external_id=${newApt.id} replaced=${claimedApt.external_id}`,
          );
        }
      } else if (writeableSource === "square") {
        // v1.35.0 — Square claim writeback. Mirror of the Acuity path:
        // look up active connection → fetch original booking →
        // find-or-create the rescuee customer → createBooking with the
        // original location + appointment segments at the same start
        // time. Tier-blocked sellers (Square Free) fail-degrade with a
        // dedicated note value the Refill dashboard renders as an
        // upgrade prompt.
        const sbAny = sb as unknown as {
          from: (t: string) => {
            select: (cols: string) => {
              eq: (col: string, val: string) => {
                eq: (col: string, val: string) => {
                  maybeSingle: () => Promise<{
                    data: {
                      id: string;
                      access_token: string | null;
                      refresh_token: string | null;
                      token_expires_at: string | null;
                      status: string;
                      platform: string;
                    } | null;
                  }>;
                };
              };
            };
            update: (v: object) => {
              eq: (c: string, v: string) => Promise<unknown>;
            };
          };
        };
        const { data: connection } = await sbAny
          .from("scheduler_connections")
          .select("id, access_token, refresh_token, token_expires_at, status, platform")
          .eq("user_id", offer.user_id)
          .eq("platform", "square")
          .maybeSingle();

        if (
          !connection ||
          connection.status !== "connected" ||
          !connection.access_token
        ) {
          console.warn(
            `[claim-writeback] no active square connection for user ${offer.user_id}`,
          );
          await stampWritebackNotes(
            "writeback_failed: no_active_square_connection",
          );
        } else {
          const {
            getSquareBooking,
            createSquareBooking,
            upsertSquareCustomer,
            resolveSquareEnv,
          } = await import("@/lib/schedulers/square");
          const { withFreshSquareToken } = await import(
            "@/server/emma-scheduler.functions"
          );
          const env: import("@/lib/schedulers/square").SquareEnv =
            resolveSquareEnv();

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

          try {
            const newApt = await withFreshSquareToken({
              sb,
              connectionId: connection.id,
              accessToken: connection.access_token,
              refreshToken: connection.refresh_token,
              expiresAt: connection.token_expires_at,
              fn: async (accessToken) => {
                const originalApt = await getSquareBooking({
                  accessToken,
                  env,
                  bookingId: claimedApt.external_id,
                });
                const customer = await upsertSquareCustomer({
                  accessToken,
                  env,
                  phone: a?.phone || null,
                  email: a?.email || null,
                  givenName: firstName,
                  familyName: lastName,
                });
                return createSquareBooking({
                  accessToken,
                  env,
                  startAt: originalApt.startAt,
                  locationId: originalApt.locationId,
                  customerId: customer.id,
                  appointmentSegments: originalApt.appointmentSegments,
                  sellerNote: `Rebooked via Refill from cancelled booking ${claimedApt.external_id}`,
                  idempotencyKey: `refill-rescue-${offer.id}`,
                });
              },
            });

            await sb
              .from("appointments")
              .update({ external_id: newApt.id })
              .eq("id", offer.appointment_id);

            await stampWritebackNotes(
              `writeback_ok: new_external_id=${newApt.id} replaced=${claimedApt.external_id}`,
            );
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            // Square returns 403 + a permission-denied error code when
            // the seller is on Free tier (no Bookings write access).
            // Surface this distinctly so the Refill dashboard can show
            // an upgrade prompt instead of a generic write-back failure.
            const tierBlocked =
              msg.includes("403") &&
              (msg.toLowerCase().includes("subscription") ||
                msg.toLowerCase().includes("forbidden") ||
                msg.toLowerCase().includes("unauthorized"));
            await stampWritebackNotes(
              tierBlocked
                ? "writeback_failed: tier_blocked (Square Appointments Plus/Premium required)"
                : `writeback_failed: ${msg.slice(0, 400)}`,
            );
            console.error("square write-back failed:", msg);
          }
        }
      } else if (writeableSource === "zenoti") {
        // v1.41.0 — Zenoti claim writeback. Server-side API key + per-
        // center scope. No token refresh (API key non-expiring).
        const sbAny = sb as unknown as {
          from: (t: string) => {
            select: (cols: string) => {
              eq: (col: string, val: string) => {
                eq: (col: string, val: string) => {
                  maybeSingle: () => Promise<{
                    data: { platform_account_id: string | null; status: string } | null;
                  }>;
                };
              };
            };
            update: (v: object) => { eq: (c: string, v: string) => Promise<unknown> };
          };
        };
        const { data: connection } = await sbAny
          .from("scheduler_connections")
          .select("platform_account_id, status")
          .eq("user_id", offer.user_id)
          .eq("platform", "zenoti")
          .maybeSingle();

        if (!connection || connection.status !== "connected" || !connection.platform_account_id) {
          console.warn(`[claim-writeback] no active zenoti connection for user ${offer.user_id}`);
          await stampWritebackNotes("writeback_failed: no_active_zenoti_connection");
        } else {
          const { createZenotiAppointment, getZenotiAppointment, resolveZenotiEnv, upsertZenotiGuest } =
            await import("@/lib/schedulers/zenoti");
          const env = resolveZenotiEnv();
          const stripWs = (v: string | undefined) => v?.replace(/\s+/g, "");
          const API_KEY = stripWs(env === "sandbox" ? process.env.ZENOTI_SANDBOX_API_KEY : process.env.ZENOTI_API_KEY);

          if (!API_KEY) {
            await stampWritebackNotes("writeback_failed: zenoti_api_key_not_configured");
          } else {
            const credentials = { apiKey: API_KEY, centerId: connection.platform_account_id, env };

            const { data: claimer } = await sb
              .from("knowledge_nodes")
              .select("title, attachments")
              .eq("id", offer.patient_node_id)
              .maybeSingle();

            const fullName = (claimer?.title ?? "").trim();
            const nameParts = fullName.split(/\s+/).filter(Boolean);
            const lastName = nameParts.length > 1 ? nameParts.pop()! : "";
            const firstName = nameParts.join(" ") || fullName || "Patient";
            const a = claimer?.attachments as { phone?: string; email?: string } | null;

            try {
              const originalApt = await getZenotiAppointment({ credentials, appointmentId: claimedApt.external_id });
              if (!originalApt.serviceId || !originalApt.therapistId) {
                throw new Error("original_appointment_missing_service_or_therapist");
              }
              const guest = await upsertZenotiGuest({
                credentials,
                phone: a?.phone || null,
                email: a?.email || null,
                firstName,
                lastName,
              });
              const newApt = await createZenotiAppointment({
                credentials,
                startTime: originalApt.startTime,
                guestId: guest.id,
                therapistId: originalApt.therapistId,
                serviceId: originalApt.serviceId,
                notes: `Rebooked via Refill from cancelled appointment ${claimedApt.external_id}`,
              });
              await sb.from("appointments").update({ external_id: newApt.id }).eq("id", offer.appointment_id);
              await stampWritebackNotes(`writeback_ok: new_external_id=${newApt.id} replaced=${claimedApt.external_id}`);
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              await stampWritebackNotes(`writeback_failed: ${msg.slice(0, 400)}`);
              console.error("zenoti write-back failed:", msg);
            }
          }
        }
      } else if (writeableSource === "jane") {
        // v1.40.0 — Jane claim writeback. PKCE + 5-min token TTL means
        // withFreshJaneToken handles refresh; per-clinic base URL.
        const sbAny = sb as unknown as {
          from: (t: string) => {
            select: (cols: string) => {
              eq: (col: string, val: string) => {
                eq: (col: string, val: string) => {
                  maybeSingle: () => Promise<{
                    data: {
                      id: string;
                      access_token: string | null;
                      refresh_token: string | null;
                      token_expires_at: string | null;
                      platform_account_id: string | null;
                      status: string;
                    } | null;
                  }>;
                };
              };
            };
            update: (v: object) => { eq: (c: string, v: string) => Promise<unknown> };
          };
        };
        const { data: connection } = await sbAny
          .from("scheduler_connections")
          .select("id, access_token, refresh_token, token_expires_at, platform_account_id, status")
          .eq("user_id", offer.user_id)
          .eq("platform", "jane")
          .maybeSingle();

        if (
          !connection ||
          connection.status !== "connected" ||
          !connection.access_token ||
          !connection.platform_account_id
        ) {
          console.warn(`[claim-writeback] no active jane connection for user ${offer.user_id}`);
          await stampWritebackNotes("writeback_failed: no_active_jane_connection");
        } else {
          const { createJaneAppointment, getJaneAppointment, upsertJanePatient } =
            await import("@/lib/schedulers/jane");
          const { withFreshJaneToken } = await import("@/server/emma-scheduler.functions");

          const { data: claimer } = await sb
            .from("knowledge_nodes")
            .select("title, attachments")
            .eq("id", offer.patient_node_id)
            .maybeSingle();

          const fullName = (claimer?.title ?? "").trim();
          const nameParts = fullName.split(/\s+/).filter(Boolean);
          const lastName = nameParts.length > 1 ? nameParts.pop()! : "";
          const firstName = nameParts.join(" ") || fullName || "Patient";
          const a = claimer?.attachments as { phone?: string; email?: string } | null;

          try {
            const clinicUrl = connection.platform_account_id;
            const newApt = await withFreshJaneToken({
              sb,
              connectionId: connection.id,
              accessToken: connection.access_token,
              refreshToken: connection.refresh_token,
              expiresAt: connection.token_expires_at,
              fn: async (accessToken) => {
                const originalApt = await getJaneAppointment({
                  accessToken,
                  clinicUrl,
                  appointmentId: claimedApt.external_id,
                });
                if (!originalApt.treatmentId || !originalApt.staffMemberId) {
                  throw new Error("original_appointment_missing_treatment_or_staff");
                }
                const patient = await upsertJanePatient({
                  accessToken,
                  clinicUrl,
                  firstName,
                  lastName,
                  email: a?.email || null,
                  phone: a?.phone || null,
                });
                return createJaneAppointment({
                  accessToken,
                  clinicUrl,
                  startAt: originalApt.startAt,
                  patientId: patient.id,
                  staffMemberId: originalApt.staffMemberId,
                  treatmentId: originalApt.treatmentId,
                  locationId: originalApt.locationId ?? undefined,
                  notes: `Rebooked via Refill from cancelled appointment ${claimedApt.external_id}`,
                });
              },
            });
            await sb.from("appointments").update({ external_id: newApt.id }).eq("id", offer.appointment_id);
            await stampWritebackNotes(
              `writeback_ok: new_external_id=${newApt.id} replaced=${claimedApt.external_id}`,
            );
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            await stampWritebackNotes(`writeback_failed: ${msg.slice(0, 400)}`);
            console.error("jane write-back failed:", msg);
          }
        }
      } else if (writeableSource === "booker") {
        // v1.39.0 — Booker claim writeback. Server-to-server OAuth mint
        // access_token per writeback, scope by stored LocationId.
        const sbAny = sb as unknown as {
          from: (t: string) => {
            select: (cols: string) => {
              eq: (col: string, val: string) => {
                eq: (col: string, val: string) => {
                  maybeSingle: () => Promise<{
                    data: { platform_account_id: string | null; status: string } | null;
                  }>;
                };
              };
            };
            update: (v: object) => { eq: (c: string, v: string) => Promise<unknown> };
          };
        };
        const { data: connection } = await sbAny
          .from("scheduler_connections")
          .select("platform_account_id, status")
          .eq("user_id", offer.user_id)
          .eq("platform", "booker")
          .maybeSingle();

        if (!connection || connection.status !== "connected" || !connection.platform_account_id) {
          console.warn(`[claim-writeback] no active booker connection for user ${offer.user_id}`);
          await stampWritebackNotes("writeback_failed: no_active_booker_connection");
        } else {
          const {
            createBookerAppointment,
            getBookerAccessToken,
            getBookerAppointment,
            resolveBookerEnv,
            upsertBookerCustomer,
          } = await import("@/lib/schedulers/booker");
          const env = resolveBookerEnv();
          const stripWs = (v: string | undefined) => v?.replace(/\s+/g, "");
          const CLIENT_ID = stripWs(env === "sandbox" ? process.env.BOOKER_SANDBOX_CLIENT_ID : process.env.BOOKER_CLIENT_ID);
          const CLIENT_SECRET = stripWs(env === "sandbox" ? process.env.BOOKER_SANDBOX_CLIENT_SECRET : process.env.BOOKER_CLIENT_SECRET);
          const SUBSCRIPTION_KEY = stripWs(env === "sandbox" ? process.env.BOOKER_SANDBOX_SUBSCRIPTION_KEY : process.env.BOOKER_SUBSCRIPTION_KEY);

          if (!CLIENT_ID || !CLIENT_SECRET || !SUBSCRIPTION_KEY) {
            await stampWritebackNotes("writeback_failed: booker_credentials_not_configured");
          } else {
            const credentials = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, subscriptionKey: SUBSCRIPTION_KEY, env };

            const { data: claimer } = await sb
              .from("knowledge_nodes")
              .select("title, attachments")
              .eq("id", offer.patient_node_id)
              .maybeSingle();

            const fullName = (claimer?.title ?? "").trim();
            const nameParts = fullName.split(/\s+/).filter(Boolean);
            const lastName = nameParts.length > 1 ? nameParts.pop()! : "";
            const firstName = nameParts.join(" ") || fullName || "Patient";
            const a = claimer?.attachments as { phone?: string; email?: string } | null;

            try {
              const tok = await getBookerAccessToken({ credentials });
              const originalApt = await getBookerAppointment({
                accessToken: tok.accessToken,
                credentials,
                appointmentId: claimedApt.external_id,
              });
              if (!originalApt.employeeId || !originalApt.treatmentId) {
                throw new Error("original_appointment_missing_employee_or_treatment");
              }
              const customer = await upsertBookerCustomer({
                accessToken: tok.accessToken,
                credentials,
                phone: a?.phone || null,
                email: a?.email || null,
                firstName,
                lastName,
              });
              const newApt = await createBookerAppointment({
                accessToken: tok.accessToken,
                credentials,
                startDateTime: originalApt.startDateTime,
                customerId: customer.id,
                employeeId: originalApt.employeeId,
                treatmentId: originalApt.treatmentId,
                notes: `Rebooked via Refill from cancelled appointment ${claimedApt.external_id}`,
              });
              await sb.from("appointments").update({ external_id: newApt.id }).eq("id", offer.appointment_id);
              await stampWritebackNotes(`writeback_ok: new_external_id=${newApt.id} replaced=${claimedApt.external_id}`);
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              await stampWritebackNotes(`writeback_failed: ${msg.slice(0, 400)}`);
              console.error("booker write-back failed:", msg);
            }
          }
        }
      } else if (writeableSource === "vagaro") {
        // v1.38.0 — Vagaro claim writeback. Per-spa API key auth (no OAuth).
        const sbAny = sb as unknown as {
          from: (t: string) => {
            select: (cols: string) => {
              eq: (col: string, val: string) => {
                eq: (col: string, val: string) => {
                  maybeSingle: () => Promise<{
                    data: {
                      access_token: string | null;
                      platform_account_id: string | null;
                      status: string;
                    } | null;
                  }>;
                };
              };
            };
            update: (v: object) => {
              eq: (c: string, v: string) => Promise<unknown>;
            };
          };
        };
        const { data: connection } = await sbAny
          .from("scheduler_connections")
          .select("access_token, platform_account_id, status")
          .eq("user_id", offer.user_id)
          .eq("platform", "vagaro")
          .maybeSingle();

        if (!connection || connection.status !== "connected" || !connection.access_token) {
          console.warn(`[claim-writeback] no active vagaro connection for user ${offer.user_id}`);
          await stampWritebackNotes("writeback_failed: no_active_vagaro_connection");
        } else {
          const { createVagaroAppointment, getVagaroAppointment, upsertVagaroCustomer } =
            await import("@/lib/schedulers/vagaro");

          const { data: claimer } = await sb
            .from("knowledge_nodes")
            .select("title, attachments")
            .eq("id", offer.patient_node_id)
            .maybeSingle();

          const fullName = (claimer?.title ?? "").trim();
          const nameParts = fullName.split(/\s+/).filter(Boolean);
          const lastName = nameParts.length > 1 ? nameParts.pop()! : "";
          const firstName = nameParts.join(" ") || fullName || "Patient";
          const a = claimer?.attachments as { phone?: string; email?: string } | null;

          try {
            const credentials = {
              apiKey: connection.access_token,
              merchantId: connection.platform_account_id ?? "",
            };
            const originalApt = await getVagaroAppointment({
              credentials,
              appointmentId: claimedApt.external_id,
            });
            if (!originalApt.serviceId || !originalApt.staffId) {
              throw new Error("original_appointment_missing_service_or_staff");
            }
            const customer = await upsertVagaroCustomer({
              credentials,
              phone: a?.phone || null,
              email: a?.email || null,
              firstName,
              lastName,
            });
            const newApt = await createVagaroAppointment({
              credentials,
              startDateTime: originalApt.startDateTime,
              customerId: customer.id,
              serviceId: originalApt.serviceId,
              staffId: originalApt.staffId,
              notes: `Rebooked via Refill from cancelled appointment ${claimedApt.external_id}`,
            });
            await sb
              .from("appointments")
              .update({ external_id: newApt.id })
              .eq("id", offer.appointment_id);
            await stampWritebackNotes(
              `writeback_ok: new_external_id=${newApt.id} replaced=${claimedApt.external_id}`,
            );
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            await stampWritebackNotes(`writeback_failed: ${msg.slice(0, 400)}`);
            console.error("vagaro write-back failed:", msg);
          }
        }
      } else if (writeableSource === "mindbody") {
        // v1.37.0 — Mindbody claim writeback. Mirror of the Acuity +
        // Square + Boulevard branches. Mindbody requires explicit
        // ClientId on the booking POST (no inline name/email/phone),
        // so the roster-miss path calls addclient first then uses
        // the returned ClientId in the booking. Execute: "Force" is
        // the admin override (analog to Acuity's ?admin=true).
        const sbAny = sb as unknown as {
          from: (t: string) => {
            select: (cols: string) => {
              eq: (col: string, val: string) => {
                eq: (col: string, val: string) => {
                  maybeSingle: () => Promise<{
                    data: {
                      id: string;
                      access_token: string | null;
                      refresh_token: string | null;
                      token_expires_at: string | null;
                      status: string;
                      platform: string;
                      platform_account_id: string | null;
                    } | null;
                  }>;
                };
              };
            };
            update: (v: object) => {
              eq: (c: string, v: string) => Promise<unknown>;
            };
          };
        };
        const { data: connection } = await sbAny
          .from("scheduler_connections")
          .select(
            "id, access_token, refresh_token, token_expires_at, status, platform, platform_account_id",
          )
          .eq("user_id", offer.user_id)
          .eq("platform", "mindbody")
          .maybeSingle();

        if (
          !connection ||
          connection.status !== "connected" ||
          !connection.access_token ||
          !connection.platform_account_id
        ) {
          console.warn(
            `[claim-writeback] no active mindbody connection for user ${offer.user_id}`,
          );
          await stampWritebackNotes(
            "writeback_failed: no_active_mindbody_connection",
          );
        } else {
          const {
            addMindbodyClient,
            bookMindbodyAppointment,
            getMindbodyAppointment,
            resolveMindbodyEnv,
          } = await import("@/lib/schedulers/mindbody");
          const { withFreshMindbodyToken } = await import(
            "@/server/emma-scheduler.functions"
          );
          const env = resolveMindbodyEnv();
          const stripWs = (v: string | undefined) => v?.replace(/\s+/g, "");
          const API_KEY = stripWs(
            env === "sandbox"
              ? process.env.MINDBODY_SANDBOX_API_KEY
              : process.env.MINDBODY_API_KEY,
          );
          if (!API_KEY) {
            await stampWritebackNotes(
              "writeback_failed: mindbody_api_key_not_configured",
            );
          } else {
            const siteId = connection.platform_account_id;

            const { data: claimer } = await sb
              .from("knowledge_nodes")
              .select("title, attachments")
              .eq("id", offer.patient_node_id)
              .maybeSingle();

            const fullName = (claimer?.title ?? "").trim();
            const nameParts = fullName.split(/\s+/).filter(Boolean);
            const lastName = nameParts.length > 1 ? nameParts.pop()! : "";
            const firstName =
              nameParts.join(" ") || fullName || "Patient";
            const a = claimer?.attachments as
              | {
                  phone?: string;
                  email?: string;
                  scheduler_client_id?: string;
                }
              | null;

            try {
              const newApt = await withFreshMindbodyToken({
                sb,
                connectionId: connection.id,
                accessToken: connection.access_token,
                refreshToken: connection.refresh_token,
                expiresAt: connection.token_expires_at,
                fn: async (accessToken) => {
                  const originalApt = await getMindbodyAppointment({
                    accessToken,
                    apiKey: API_KEY,
                    siteId,
                    env,
                    appointmentId: claimedApt.external_id,
                  });

                  if (!originalApt.sessionTypeId || !originalApt.staffId) {
                    throw new Error(
                      "original_appointment_missing_session_type_or_staff",
                    );
                  }

                  // Roster hit vs roster miss
                  let clientId =
                    a?.scheduler_client_id || null;
                  if (!clientId) {
                    const newClient = await addMindbodyClient({
                      accessToken,
                      apiKey: API_KEY,
                      siteId,
                      env,
                      firstName,
                      lastName,
                      email: a?.email || null,
                      phone: a?.phone || null,
                    });
                    clientId = newClient.id;
                    // Stamp returned ID back onto the patient node so
                    // future writebacks hit the fast path.
                    const newAttachments = {
                      ...(a ?? {}),
                      scheduler_client_id: clientId,
                    };
                    await sb
                      .from("knowledge_nodes")
                      .update({ attachments: newAttachments })
                      .eq("id", offer.patient_node_id);
                  }

                  return bookMindbodyAppointment({
                    accessToken,
                    apiKey: API_KEY,
                    siteId,
                    env,
                    startDateTime: originalApt.startDateTime,
                    clientId,
                    sessionTypeId: originalApt.sessionTypeId,
                    staffId: originalApt.staffId,
                    locationId: originalApt.locationId ?? undefined,
                    notes: `Rebooked via Refill from cancelled appointment ${claimedApt.external_id}`,
                  });
                },
              });

              await sb
                .from("appointments")
                .update({ external_id: newApt.id })
                .eq("id", offer.appointment_id);

              await stampWritebackNotes(
                `writeback_ok: new_external_id=${newApt.id} replaced=${claimedApt.external_id}`,
              );
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              await stampWritebackNotes(
                `writeback_failed: ${msg.slice(0, 400)}`,
              );
              console.error("mindbody write-back failed:", msg);
            }
          }
        }
      } else if (writeableSource === "boulevard") {
        // v1.36.0 — Boulevard claim writeback. Mirror of the Acuity +
        // Square branches but on the GraphQL substrate. Boulevard auth
        // is app-level (BLVD_API_KEY + BLVD_API_SECRET from env) +
        // businessId URN scopes each mutation. No per-spa access token
        // to refresh. Tier-blocked sellers (Free/Starter) fail-degrade
        // with a dedicated note value the Refill dashboard renders as
        // an upgrade prompt.
        const sbAny = sb as unknown as {
          from: (t: string) => {
            select: (cols: string) => {
              eq: (col: string, val: string) => {
                eq: (col: string, val: string) => {
                  maybeSingle: () => Promise<{
                    data: {
                      id: string;
                      status: string;
                      platform: string;
                      platform_account_id: string | null;
                    } | null;
                  }>;
                };
              };
            };
            update: (v: object) => {
              eq: (c: string, v: string) => Promise<unknown>;
            };
          };
        };
        const { data: connection } = await sbAny
          .from("scheduler_connections")
          .select("id, status, platform, platform_account_id")
          .eq("user_id", offer.user_id)
          .eq("platform", "boulevard")
          .maybeSingle();

        if (
          !connection ||
          connection.status !== "connected" ||
          !connection.platform_account_id
        ) {
          console.warn(
            `[claim-writeback] no active boulevard connection for user ${offer.user_id}`,
          );
          await stampWritebackNotes(
            "writeback_failed: no_active_boulevard_connection",
          );
        } else {
          const {
            getBoulevardAppointment,
            createBoulevardAppointment,
            upsertBoulevardClient,
            resolveBoulevardEnv,
          } = await import("@/lib/schedulers/boulevard");
          const env = resolveBoulevardEnv();
          const stripWs = (v: string | undefined) => v?.replace(/\s+/g, "");
          const APPLICATION_ID = stripWs(
            env === "sandbox"
              ? process.env.BLVD_SANDBOX_APPLICATION_ID
              : process.env.BLVD_APPLICATION_ID,
          );
          const API_KEY = stripWs(
            env === "sandbox"
              ? process.env.BLVD_SANDBOX_API_KEY
              : process.env.BLVD_API_KEY,
          );
          const API_SECRET = stripWs(
            env === "sandbox"
              ? process.env.BLVD_SANDBOX_API_SECRET
              : process.env.BLVD_API_SECRET,
          );

          if (!APPLICATION_ID || !API_KEY || !API_SECRET) {
            await stampWritebackNotes(
              "writeback_failed: boulevard_app_credentials_not_configured",
            );
          } else {
            const credentials = {
              applicationId: APPLICATION_ID,
              apiKey: API_KEY,
              apiSecret: API_SECRET,
              env,
            };
            const businessId = connection.platform_account_id;

            const { data: claimer } = await sb
              .from("knowledge_nodes")
              .select("title, attachments")
              .eq("id", offer.patient_node_id)
              .maybeSingle();

            const fullName = (claimer?.title ?? "").trim();
            const nameParts = fullName.split(/\s+/).filter(Boolean);
            const lastName = nameParts.length > 1 ? nameParts.pop()! : "";
            const firstName =
              nameParts.join(" ") || fullName || "Patient";
            const a = claimer?.attachments as
              | { phone?: string; email?: string }
              | null;

            try {
              const originalApt = await getBoulevardAppointment({
                credentials,
                businessId,
                appointmentId: claimedApt.external_id,
              });

              if (!originalApt.locationId) {
                await stampWritebackNotes(
                  "writeback_failed: original_appointment_missing_location",
                );
              } else {
                const client = await upsertBoulevardClient({
                  credentials,
                  businessId,
                  phone: a?.phone || null,
                  email: a?.email || null,
                  firstName,
                  lastName,
                });
                const newApt = await createBoulevardAppointment({
                  credentials,
                  businessId,
                  startAt: originalApt.startAt,
                  locationId: originalApt.locationId,
                  clientId: client.id,
                  serviceIds: originalApt.serviceIds,
                  staffId: originalApt.staffId ?? undefined,
                  notes: `Rebooked via Refill from cancelled appointment ${claimedApt.external_id}`,
                  idempotencyKey: `refill-rescue-${offer.id}`,
                });

                await sb
                  .from("appointments")
                  .update({ external_id: newApt.id })
                  .eq("id", offer.appointment_id);

                await stampWritebackNotes(
                  `writeback_ok: new_external_id=${newApt.id} replaced=${claimedApt.external_id}`,
                );
              }
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              // Boulevard surfaces tier-block via GraphQL userErrors[]
              // (the connector throws with the message text). Detect
              // tier-block on common substring patterns; same UX as
              // Square tier-block.
              const lower = msg.toLowerCase();
              const tierBlocked =
                lower.includes("premier") ||
                lower.includes("enterprise") ||
                lower.includes("subscription") ||
                lower.includes("forbidden");
              await stampWritebackNotes(
                tierBlocked
                  ? "writeback_failed: tier_blocked (Boulevard Premier/Enterprise required)"
                  : `writeback_failed: ${msg.slice(0, 400)}`,
              );
              console.error("boulevard write-back failed:", msg);
            }
          }
        }
      }
    } catch (e) {
      console.error(
        "scheduler write-back failed:",
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
      .from("rescue_attempts")
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
        .from("appointments")
        .select("id, scheduled_at, treatment_type")
        .in("id", aptIds),
      offerIds.length > 0
        ? sb
            .from("rescue_offers")
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

// ─── Held-rescue review queue (the autonomous-send confidence gate) ────────
//
// Direct mode holds low-confidence ("open") fits instead of auto-texting them
// (see dispatch step 6b). These three fns are the human side of that gate on
// the rescue page: list the held offers, release one with a single tap (we
// send the same SMS the auto-path would have), or dismiss it. Mirrors the
// reward-attribution hold queue (reward-attribution-holds.functions.ts).

/** held_at / held_reason live on rescue_offers as of the v2.16.0 migration
 *  but aren't in the generated types yet — a loose handle keeps these queries
 *  readable without weakening the typed client everywhere else. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function looseOffers(sb: SupabaseAdmin): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (sb as unknown as { from(t: string): any }).from("rescue_offers");
}

export type HeldRescueOffer = {
  offerId: string;
  patientName: string | null;
  treatmentType: string | null;
  scheduledAt: string;
  heldReason: string | null;
  heldAt: string;
  lifetimeSpendUsd: number | null;
};

const heldListInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
});

export const listHeldRescueOffers = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => heldListInput.parse(input))
  .handler(async ({ data }): Promise<HeldRescueOffer[]> => {
    const { resolveEffectiveUserId } = await import("@/server/auth-helpers");
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();

    // Held = created but not auto-sent, and not yet acted on (no send, not
    // declined/expired/claimed). The migration may not be live in every
    // environment yet — degrade to an empty queue rather than break the page.
    let rows: Array<{
      id: string;
      appointment_id: string;
      patient_node_id: string;
      held_at: string;
      held_reason: string | null;
      offer_service_id: string | null;
    }> = [];
    try {
      const res = await looseOffers(sb)
        .select("id, appointment_id, patient_node_id, held_at, held_reason, offer_service_id")
        .eq("user_id", effectiveUserId)
        .not("held_at", "is", null)
        .is("message_id", null)
        .is("declined_at", null)
        .is("expired_at", null)
        .is("claimed_at", null)
        .order("held_at", { ascending: false })
        .limit(200);
      if (res.error) return [];
      rows = res.data ?? [];
    } catch {
      return [];
    }
    if (rows.length === 0) return [];

    const aptIds = Array.from(new Set(rows.map((r) => r.appointment_id)));
    const patientIds = Array.from(new Set(rows.map((r) => r.patient_node_id)));
    const [{ data: appts }, { data: patients }] = await Promise.all([
      sb
        .from("appointments")
        .select("id, scheduled_at, treatment_type")
        .in("id", aptIds),
      sb.from("knowledge_nodes").select("id, title, attachments").in("id", patientIds),
    ]);
    const aptById = new Map((appts ?? []).map((a) => [a.id, a]));
    const patientById = new Map(
      (patients ?? []).map((p) => [p.id, p]),
    );

    // v2.64.0 — resolve catalog names for any cross-service / exact offers so
    // the held-review queue shows what the patient actually wants, not the
    // freed slot's original treatment.
    const offerServiceIds = Array.from(
      new Set(rows.map((r) => r.offer_service_id).filter((id): id is string => !!id)),
    );
    const serviceNameById = new Map<string, string>();
    if (offerServiceIds.length > 0) {
      const { data: svcs } = await sb
        .from("services")
        .select("id, name")
        .in("id", offerServiceIds)
        // Bounded: offerServiceIds is deduped from the ≤200-row held queue, so
        // one row per id — limit keeps the read provably truncation-safe.
        .limit(offerServiceIds.length);
      for (const s of svcs ?? []) serviceNameById.set(s.id, s.name);
    }

    return rows.map((r) => {
      const apt = aptById.get(r.appointment_id);
      const p = patientById.get(r.patient_node_id);
      const spend = (p?.attachments as { lifetimeSpendUsd?: number } | null)?.lifetimeSpendUsd;
      const offerServiceName = r.offer_service_id
        ? serviceNameById.get(r.offer_service_id) ?? null
        : null;
      return {
        offerId: r.id,
        patientName: (p?.title as string | null) ?? null,
        treatmentType: offerServiceName ?? apt?.treatment_type ?? null,
        scheduledAt: apt?.scheduled_at ?? "",
        heldReason: r.held_reason,
        heldAt: r.held_at,
        lifetimeSpendUsd: spend == null ? null : Number(spend),
      };
    });
  });

const heldActInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
  offerId: z.string().uuid(),
});

/** Release a held offer: send the same rescue SMS the auto-path would have. */
export const sendHeldRescueOffer = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => heldActInput.parse(input))
  .handler(async ({ data }): Promise<{ ok: boolean; sent: boolean }> => {
    const { resolveEffectiveUserId } = await import("@/server/auth-helpers");
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();

    const { data: offer } = await looseOffers(sb)
      .select(
        "id, token, appointment_id, patient_node_id, rescue_attempt_id, held_at, message_id, offer_service_id",
      )
      .eq("id", data.offerId)
      .eq("user_id", effectiveUserId)
      .maybeSingle();
    if (!offer) throw new Error("That rescue offer couldn't be found.");
    if (offer.message_id) return { ok: true, sent: true }; // already sent — idempotent

    const { data: apt } = await sb
      .from("appointments")
      .select("scheduled_at, treatment_type, provider_name, status")
      .eq("id", offer.appointment_id)
      .maybeSingle();
    if (!apt) throw new Error("The freed appointment couldn't be found.");
    // Only send if the slot is still genuinely open.
    if (apt.status !== "cancelled" && apt.status !== "no_show") {
      throw new Error("That slot is no longer open — nothing to send.");
    }
    if (new Date(apt.scheduled_at).getTime() <= Date.now()) {
      throw new Error("That opening is in the past — too late to text.");
    }

    // The patient's phone (offer row doesn't carry it).
    const { data: patientNode } = await sb
      .from("knowledge_nodes")
      .select("attachments")
      .eq("id", offer.patient_node_id)
      .maybeSingle();
    const phone = (patientNode?.attachments as { phone?: string } | null)?.phone ?? null;
    if (!phone) throw new Error("That patient has no phone number on file.");

    const spaName = await resolveSpaName(sb, effectiveUserId);
    const ownerDisplayName = await resolveOwnerDisplayName(sb, effectiveUserId);
    const fromNumber = await resolveSpaFromNumber(sb, effectiveUserId);
    if (!fromNumber) {
      throw new Error("Your spa has no SMS number set, so this can't be texted.");
    }

    // v2.64.0 — if this held offer was framed around a specific service
    // (cross-service / exact catalog match), name THAT service in the text
    // rather than the freed slot's original treatment.
    let offerServiceName: string | null = null;
    const heldServiceId = (offer as { offer_service_id?: string | null }).offer_service_id;
    if (heldServiceId) {
      const { data: svc } = await sb
        .from("services")
        .select("name")
        .eq("id", heldServiceId)
        .maybeSingle();
      offerServiceName = svc?.name?.trim() || null;
    }

    const body = composeRescueSms({
      spaName,
      treatmentType: apt.treatment_type,
      providerName: apt.provider_name,
      ownerDisplayName,
      scheduledAt: apt.scheduled_at,
      claimUrl: buildRescueClaimUrl(offer.token),
      treatmentOverride: offerServiceName,
    });

    try {
      const resp = await sendSms({ from: fromNumber, to: phone, body });
      await looseOffers(sb)
        .update({ message_id: resp.messageId, held_at: null })
        .eq("id", offer.id)
        .eq("user_id", effectiveUserId);
    } catch (e) {
      // Keep it held (retryable) but record the error so it's not silent.
      await looseOffers(sb)
        .update({
          send_error:
            e instanceof Error ? `sms: ${e.message}` : "sms: unknown error",
        })
        .eq("id", offer.id)
        .eq("user_id", effectiveUserId);
      throw new Error("Couldn't send the text. It's still in your queue to retry.");
    }

    // Recompute outreach_count from actually-sent offers (exact, race-safe).
    if (offer.rescue_attempt_id) {
      const { count } = await sb
        .from("rescue_offers")
        .select("id", { count: "exact", head: true })
        .eq("rescue_attempt_id", offer.rescue_attempt_id)
        .not("message_id", "is", null);
      await sb
        .from("rescue_attempts")
        .update({ outreach_count: count ?? 0 })
        .eq("id", offer.rescue_attempt_id);
    }
    // Tier-2 trust rung (Slice 4): the owner just approved a held offer with a
    // tap. This is the earn signal for Autonomous Refill — N of these unlock the
    // Skill (reachedAutonomyRung reads exactly these rows). Best-effort.
    await recordAgentAction(sb, effectiveUserId, {
      agent: "rescue",
      action: "held_offer_approved",
      channel: "sms",
      patientNodeId: offer.patient_node_id,
      count: 1,
      initiatedBy: "owner",
    });

    // Outbound heartbeat so the delivery-health card sees this manual send.
    await recordMessagingActivity(sb, effectiveUserId, "sms", "rescue", 1);

    return { ok: true, sent: true };
  });

/** Dismiss a held offer: the owner chose not to text this patient. */
export const dismissHeldRescueOffer = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => heldActInput.parse(input))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { resolveEffectiveUserId } = await import("@/server/auth-helpers");
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    await looseOffers(sb)
      .update({ declined_at: new Date().toISOString(), held_at: null })
      .eq("id", data.offerId)
      .eq("user_id", effectiveUserId)
      .not("held_at", "is", null);
    return { ok: true };
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

// ─── Simulate a rescue (go-live test harness) ────────────────────────────────
//
// Fire a REAL rescue dispatch WITHOUT cancelling a live Acuity appointment. The
// dispatch lives in the webhook handler (not a DB trigger), so a raw insert
// won't trigger it — this server fn inserts a throwaway future-cancelled slot
// (marked notes='rescue-sim' for one-line cleanup) and runs the exact
// dispatchRescueAttempt path the webhook uses. The waitlist select, ranking,
// composition, and proxy email are all real, so it's a true end-to-end rerun.
// Admin/tenant-view only (gated in the UI); cleanup:
//   delete from appointments where user_id = '<spa>' and notes = 'rescue-sim';

const simulateRescueInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
  /** The freed slot's treatment (default Tox) — drives the waitlist match copy. */
  treatmentType: z.string().max(120).optional(),
  /** v2.64.0 — the freed slot's duration in minutes (default 30). The Smart
   *  Slot-Fill safety gate: only services whose effective duration fits this
   *  are eligible, so a short sim slot tests the duration gate. */
  durationMin: z.number().int().positive().max(600).optional(),
  /** v2.64.0 — link the test slot to a specific scheduling provider so the
   *  qualification matrix (Smart Slot-Fill) is exercised. Omit to auto-pick the
   *  tenant's primary active provider; pass null to force the legacy (unlinked)
   *  path. */
  providerId: z.string().uuid().nullable().optional(),
});

export const simulateRescueDispatchFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => simulateRescueInput.parse(input))
  .handler(
    async ({
      data,
    }): Promise<RescueDispatchResult & { testAppointmentId: string; slotDurationMin: number }> => {
      const { resolveEffectiveUserId } = await import("@/server/auth-helpers");
      const { effectiveUserId } = await resolveEffectiveUserId({
        accessToken: data.accessToken,
        viewAsUserId: data.viewAsUserId,
      });
      const sb = admin();
      const nowMs = Date.now();
      // +2h so it's comfortably future (dispatch requires scheduled_at > now).
      const scheduledAt = new Date(nowMs + 2 * 60 * 60 * 1000).toISOString();

      // v2.64.0 — link the test slot to a scheduling provider so the Smart
      // Slot-Fill qualification matrix actually runs (an unlinked slot degrades
      // to the legacy matcher). Auto-pick a provider unless the caller passed
      // one (or explicitly passed null for legacy). Prefer the provider whose
      // name matches the spa's owner-display-name so the sim reads coherently
      // for a solo practitioner (Rejuv's services bake "w/ Karen" into the
      // name — picking the oldest provider "Michelle" would read as a conflict);
      // fall back to the primary active provider.
      let providerId: string | null = data.providerId ?? null;
      let providerName: string | null = null;
      if (data.providerId !== null) {
        try {
          const { getTenantIdForUser } = await import("@/server/auth-helpers");
          const tenantId = await getTenantIdForUser(sb, effectiveUserId);
          if (data.providerId) {
            const { data: named } = await sb
              .from("scheduling_providers")
              .select("id, name")
              .eq("id", data.providerId)
              .maybeSingle();
            providerName = named?.name ?? null;
          } else {
            // .limit bounds the read (a tenant has a handful of providers) so
            // it's provably truncation-safe (sim harness, not a hot path).
            const { data: provs } = await sb
              .from("scheduling_providers")
              .select("id, name, created_at")
              .eq("tenant_id", tenantId)
              .eq("is_active", true)
              .limit(200)
              .order("created_at", { ascending: true });
            const ownerName = (await resolveOwnerDisplayName(sb, effectiveUserId))?.trim();
            const ownerMatch =
              ownerName != null
                ? (provs ?? []).find(
                    (p) => p.name.trim().toLowerCase() === ownerName.toLowerCase(),
                  )
                : undefined;
            const pick = ownerMatch ?? (provs ?? [])[0];
            if (pick) {
              providerId = pick.id;
              providerName = pick.name;
            }
          }
        } catch (e) {
          console.error("[rescue-sim] provider link failed; running unlinked:", e);
        }
      }

      // v2.64.4 — use the freed service's REAL catalog duration when the caller
      // didn't pass one, so a "Tox" sim is a faithful 15-min slot (not a flat
      // 30). Without this the duration gate can't be tested: a 30-min sim slot
      // wrongly admits a 45-min Filler patient. Resolve the freed treatment →
      // catalog → its duration (min across matches = the tightest/most accurate
      // slot); fall back to 30 if it doesn't resolve.
      const freedTreatment = (data.treatmentType ?? "Tox").trim() || "Tox";
      let slotDuration = data.durationMin ?? 30;
      if (data.durationMin == null) {
        try {
          const simCatalog = await loadServiceCatalogForUser(sb, effectiveUserId);
          const resolvedFreed = resolveTreatmentsToServiceIds([freedTreatment], simCatalog);
          const durations = resolvedFreed.serviceIds
            .map((id) => simCatalog.find((c) => c.id === id)?.durationMin)
            .filter((d): d is number => typeof d === "number" && d > 0);
          if (durations.length > 0) slotDuration = Math.min(...durations);
        } catch (e) {
          console.error("[rescue-sim] freed-duration resolve failed; using 30:", e);
        }
      }

      // Loose cast: booking_name / cancelled_at landed in later migrations than
      // the generated types know (same pattern the reschedule + ingest paths use).
      const { data: inserted, error } = await (
        sb as unknown as { from(t: string): any }
      )
        .from("appointments")
        .insert({
          user_id: effectiveUserId,
          scheduled_at: scheduledAt,
          status: "cancelled",
          cancelled_at: new Date(nowMs).toISOString(),
          treatment_type: freedTreatment,
          duration_min: slotDuration,
          provider_id: providerId,
          provider_name: providerName,
          booking_name: "__Rescue Sim__",
          source: "manual",
          notes: "rescue-sim",
        })
        .select("id")
        .single();
      if (error || !inserted) {
        throw new Error(
          `Couldn't create the test slot: ${error?.message ?? "no row"}`,
        );
      }
      const testAppointmentId = (inserted as { id: string }).id;
      const result = await dispatchRescueAttempt({
        sb,
        userId: effectiveUserId,
        appointmentId: testAppointmentId,
      });
      return { ...result, testAppointmentId, slotDurationMin: slotDuration };
    },
  );
