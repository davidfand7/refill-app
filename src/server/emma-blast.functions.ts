/**
 * Emma(OS) Promotions Engine — Phase 3.0 blast composer.
 *
 * Per-patient draft generation and persistence. Phase 3.0 does NOT send;
 * the Send button is a Phase 3.1 concern (Twilio + Resend wiring, state
 * machine advancement, STOP/quiet-hours/velocity-cap plumbing).
 *
 * Surface contract:
 *   listCampaignTargets — resolves cohort + upserts state='targeted' rows
 *                          + returns each target with patient summary +
 *                          saved draft (if any).
 *   generateCampaignDraft — single-patient Gemini one-shot. Returns the
 *                          draft body; caller saves it via saveCampaignDraft.
 *   saveCampaignDraft     — persists per-patient draft on patient_outreach_state.
 *
 * Tone separation from Liz: this prompt drafts spa→client B2C voice, NOT
 * rep→spa-owner B2B. The two prompts are intentionally distinct files so
 * neither side's tone-tuning bleeds into the other.
 *
 * Established 2026-05-15 (Promotions Engine Phase 3.0).
 */

import { createServerFn } from "@tanstack/react-start";
import { admin } from "./admin-client";
import { z } from "zod";

import type { Database, Json } from "@/integrations/supabase/types";
import { verifyAuth } from "@/server/auth-helpers";
import { postResendEmail } from "@/server/resend-send";
import { fetchAllRows } from "@/server/paginate";
import { patientOptOutStatus } from "@/server/patient-contactability";
import { callGeminiOneShot } from "@/server/gemini-oneshot";
import { sendSms } from "@/server/sms-provider";
import { bookingUrlFor, ensureBookingToken } from "@/server/emma-booking.functions";
import { resolveSpaFromEmail } from "@/server/emma-sender.functions";
import { resolveSpaFromNumber } from "@/server/emma-spa-profile";
import type { CampaignAttachments } from "@/lib/campaign-templates";
import type { PatientSummary } from "@/lib/patient-csv";

// ─── Public types ─────────────────────────────────────────────────────────

export type BlastChannel = "sms" | "email" | "both";

export type CampaignDraft = {
  subject: string | null;
  body: string;
  channel: BlastChannel;
  /** Brief "verified" line the UI surfaces as a chip — computed by code. */
  verifiedChip: string | null;
  generatedAt: string;
  edited: boolean;
};

export type CampaignTargetState =
  | "targeted"
  | "scheduled"
  | "outreached"
  | "engaged"
  | "booked"
  | "showed"
  | "no_show"
  | "closed_won"
  | "closed_lost"
  | "opted_out";

export type CampaignTarget = {
  id: string;
  patientNodeId: string;
  displayName: string;
  phone: string | null;
  email: string | null;
  /** Auto-selected channel — SMS if phone, else email, else null. */
  recommendedChannel: BlastChannel | null;
  totalVisits: number;
  lifetimeSpendUsd: number;
  lastVisit: string | null;
  primaryManufacturer: string | null;
  state: CampaignTargetState;
  draft: CampaignDraft | null;
  /** ISO time the cron sweep will fire this row, when state='scheduled'. */
  scheduledAt: string | null;
  updatedAt: string;
};

export type ListCampaignTargetsResult = {
  campaignTitle: string;
  totalMatched: number;
  exceedsBlastCap: boolean;
  blastCap: number;
  targets: CampaignTarget[];
};

// ─── Admin client ─────────────────────────────────────────────────────────

type SupabaseAdmin = ReturnType<typeof admin>;

// ─── Emma campaign-draft system prompt ────────────────────────────────────
//
// Distinct from Liz's DRAFT_SYSTEM_PROMPT (B2B rep→spa-owner). This is
// spa→patient B2C voice — warmer, shorter, conversational. Key constraints:
//   - Code attaches the [VERIFIED] chip with exact numbers; the body must
//     NOT quote dollar figures the model can't verify. Refer to the offer
//     qualitatively ("a little something off your next visit") and let the
//     chip carry the precise math.
//   - No clinical advice. No "we noticed your last filler is settling" —
//     that's diagnosis. Stick to scheduling and warmth.
//   - The patient never sees the manufacturer name as a marketing claim
//     (Jeuveau is "your toxin treatment," not "Jeuveau™"). Patients aren't
//     buying brands; they're buying the spa's care.
//   - SMS vs email: separate output formats so the composer can show
//     either. SMS is single-paragraph, no subject. Email gets a subject
//     line + 2-3 short paragraphs.

const EMMA_CAMPAIGN_DRAFT_PROMPT = `You are the spa owner's assistant drafting a warm, personal outreach message to ONE patient about an offer the spa is running. Patient-facing voice. The spa owner will review your draft before any send.

CORE TONE
- Conversational, like a friendly text from someone the patient trusts.
- Brief. Patients skim on a phone. Get to the point in the first sentence.
- Use first name. Avoid "valued customer," "dear patient," any corporate distance.
- No emojis. No marketing-speak. No exclamation marks unless the offer truly warrants one.

CONSTRAINTS — DO NOT VIOLATE
- The [VERIFIED] chip carries exact dollar figures + dates. Your body must NEVER quote a specific dollar amount, percentage, or exact deadline. Refer to the offer qualitatively: "a little something off," "this month's special," "a discount on your next visit."
- Zero clinical claims. Do not reference a patient's results, when their last treatment is "wearing off," what they "need" next, or any diagnosis-shaped language. Keep it to scheduling and warmth.
- Never use a manufacturer/brand name as a marketing claim. "Your usual toxin treatment" is fine; "Jeuveau is on sale" is not.
- No fake urgency. No "act now" / "while supplies last" / "limited spots." If the offer has a real end date, the [VERIFIED] chip carries it — your body just says "this month" or "before it ends."
- One clear ask. Either book a visit or reply to chat. Not both.
- Sign with literal placeholder "[SPA_NAME]" (system substitutes the spa's real practice name before send).

OUTPUT FORMAT (parse strictly)
For SMS channel:
SMS:
<single paragraph, max 320 chars including the [SPA_NAME] signature>

For email channel:
SUBJECT: <subject line, max 60 chars, no [SPA_NAME] in subject>
BODY:
<2-3 short paragraphs separated by blank lines>

For BOTH channels, produce both blocks in order: SMS first, then SUBJECT/BODY.`;

// ─── Helpers: draft parsing + verified chip computation ───────────────────

function parseEmmaDraft(
  raw: string,
  channel: BlastChannel,
): { subject: string | null; body: string } {
  const trimmed = raw.trim();
  if (channel === "sms") {
    // Pull just the SMS block; if the model returned more (e.g. BOTH), take
    // the SMS portion.
    const m = /SMS:\s*([\s\S]+?)(?:\n{2,}SUBJECT:|$)/i.exec(trimmed);
    const body = (m ? m[1] : trimmed.replace(/^SMS:\s*/i, "")).trim();
    return { subject: null, body };
  }
  if (channel === "email") {
    const subjMatch = /SUBJECT:\s*([^\n]+)/i.exec(trimmed);
    const bodyMatch = /BODY:\s*([\s\S]+)$/i.exec(trimmed);
    return {
      subject: subjMatch?.[1]?.trim() ?? null,
      body: (bodyMatch?.[1] ?? trimmed).trim(),
    };
  }
  // BOTH — return the email half by default; the UI splits visually.
  const subjMatch = /SUBJECT:\s*([^\n]+)/i.exec(trimmed);
  const bodyMatch = /BODY:\s*([\s\S]+)$/i.exec(trimmed);
  return {
    subject: subjMatch?.[1]?.trim() ?? null,
    body: (bodyMatch?.[1] ?? trimmed).trim(),
  };
}

/**
 * Compute the [VERIFIED] chip text from the campaign's offer. Code-only —
 * the LLM never produces this number. Returns null when the offer is empty
 * (custom template that the spa owner hasn't filled in yet).
 */
function buildVerifiedChip(offer: CampaignAttachments["offer"]): string | null {
  const parts: string[] = [];
  if (offer.discountPct !== undefined) parts.push(`${offer.discountPct}% off`);
  if (offer.flatAmountUsd !== undefined) parts.push(`$${offer.flatAmountUsd} off`);
  if (offer.freeUnits !== undefined) parts.push(`${offer.freeUnits} free units`);
  if (parts.length === 0) return null;
  return `[VERIFIED] ${parts.join(" · ")}`;
}

function recommendChannel(
  phone: string | null,
  email: string | null,
): BlastChannel | null {
  if (phone && email) return "sms"; // SMS by default — 95.6% phone coverage on Rejuv's data
  if (phone) return "sms";
  if (email) return "email";
  return null;
}

// ─── Zod ──────────────────────────────────────────────────────────────────

const listTargetsInput = z.object({
  accessToken: z.string().min(1),
  campaignId: z.string().uuid(),
});

const generateDraftInput = z.object({
  accessToken: z.string().min(1),
  campaignId: z.string().uuid(),
  patientNodeId: z.string().uuid(),
  /** Override the auto-recommended channel for this draft. */
  channel: z.enum(["sms", "email", "both"]).optional(),
});

const draftSchema = z.object({
  subject: z.string().nullable(),
  body: z.string().min(0).max(8000),
  channel: z.enum(["sms", "email", "both"]),
  verifiedChip: z.string().nullable(),
  generatedAt: z.string(),
  edited: z.boolean(),
});

const saveDraftInput = z.object({
  accessToken: z.string().min(1),
  campaignId: z.string().uuid(),
  patientNodeId: z.string().uuid(),
  draft: draftSchema,
});

// ─── listCampaignTargets ──────────────────────────────────────────────────

export const listCampaignTargets = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => listTargetsInput.parse(input))
  .handler(async ({ data }): Promise<ListCampaignTargetsResult> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();
    return doListCampaignTargets(sb, userId, data.campaignId);
  });

export async function doListCampaignTargets(
  sb: SupabaseAdmin,
  userId: string,
  campaignId: string,
): Promise<ListCampaignTargetsResult> {
  // 1) Load the campaign.
  const { data: campaign, error: cErr } = await sb
    .from("knowledge_nodes")
    .select("id, title, attachments")
    .eq("user_id", userId)
    .eq("id", campaignId)
    .eq("node_type", "campaign")
    .eq("context", "campaigns")
    .maybeSingle();
  if (cErr) throw new Error(`Couldn't load campaign: ${cErr.message}`);
  if (!campaign) throw new Error("Campaign not found.");
  const attachments =
    (campaign.attachments as unknown as CampaignAttachments | null) ?? null;
  if (!attachments) throw new Error("Campaign has no scaffolding.");

  // 2) Resolve full cohort using the saved query — we need the entire
  //    matched set, not just the 10-sample preview, to seed outreach rows.
  //    Cap at MAX_BLAST_SIZE (regulatory) so we don't materialize 800
  //    outreach rows for an unsplit cohort; the composer surfaces the cap
  //    warning and the spa owner narrows further.
  const fullMatches = await collectAllMatches(sb, userId, attachments);
  const totalMatched = fullMatches.length;
  const blastCap = 500;
  const cappedMatches = fullMatches.slice(0, blastCap);
  const targetIds = cappedMatches.map((m) => m.id);

  // 3) Upsert state='targeted' rows for each cohort patient. ON CONFLICT
  //    preserves any prior state (e.g. opted_out) — we never resurrect a
  //    patient who opted out by re-running the cohort.
  if (targetIds.length > 0) {
    const now = new Date().toISOString();
    const rows = targetIds.map((pid) => ({
      user_id: userId,
      campaign_node_id: campaignId,
      patient_node_id: pid,
      state: "targeted" as const,
      updated_at: now,
    }));
    const { error: upErr } = await sb
      .from("patient_outreach_state")
      .upsert(rows, {
        onConflict: "user_id,campaign_node_id,patient_node_id",
        // ignoreDuplicates so we DON'T overwrite later states.
        ignoreDuplicates: true,
      });
    if (upErr) throw new Error(`Couldn't seed targets: ${upErr.message}`);
  }

  // 4) Pull all state rows for this campaign + assemble targets.
  const { data: stateRows, error: stateErr } = await sb
    .from("patient_outreach_state")
    .select("*")
    .eq("user_id", userId)
    .eq("campaign_node_id", campaignId)
    .order("updated_at", { ascending: false });
  if (stateErr) throw new Error(`Couldn't load targets: ${stateErr.message}`);

  const matchById = new Map(fullMatches.map((m) => [m.id, m]));
  const targets: CampaignTarget[] = (stateRows ?? [])
    .filter((r) => matchById.has(r.patient_node_id))
    .map((r) => {
      const m = matchById.get(r.patient_node_id)!;
      const draft = (r.draft ?? null) as unknown as CampaignDraft | null;
      const hasDraft = draft && (draft.body || draft.subject);
      return {
        id: r.id,
        patientNodeId: r.patient_node_id,
        displayName: m.displayName,
        phone: m.phone,
        email: m.email,
        recommendedChannel: recommendChannel(m.phone, m.email),
        totalVisits: m.totalVisits,
        lifetimeSpendUsd: m.lifetimeSpendUsd,
        lastVisit: m.lastVisit,
        primaryManufacturer: m.primaryManufacturer,
        state: r.state as CampaignTargetState,
        draft: hasDraft ? draft : null,
        scheduledAt: r.scheduled_at,
        updatedAt: r.updated_at,
      };
    })
    .sort((a, b) => b.lifetimeSpendUsd - a.lifetimeSpendUsd);

  return {
    campaignTitle: campaign.title,
    totalMatched,
    exceedsBlastCap: totalMatched > blastCap,
    blastCap,
    targets,
  };
}

/**
 * Re-run the cohort resolver but return EVERY matched patient (not just
 * the top-10 sample). Used by the composer to build the full target list.
 */
async function collectAllMatches(
  sb: SupabaseAdmin,
  userId: string,
  attachments: CampaignAttachments,
): Promise<
  Array<{
    id: string;
    displayName: string;
    totalVisits: number;
    lifetimeSpendUsd: number;
    lastVisit: string | null;
    primaryManufacturer: string | null;
    phone: string | null;
    email: string | null;
  }>
> {
  // The doResolveCohort fn caps `sample` at 10. We need the full set, so
  // copy its predicate inline. Cheaper than refactoring doResolveCohort to
  // accept a "sampleSize" param right now; revisit when we need the third
  // caller with a different size.
  // (No early-return on small cohorts — we always do the full scan since
  // the inline predicate keeps the type narrow.)
  // v1.92.0: page past the 1,000-row cap — a truncated cohort silently drops
  // patients past row 1,000 from the campaign (they never get messaged).
  const patients = await fetchAllRows<{
    id: string;
    title: string;
    attachments: unknown;
  }>((from, to) =>
    sb
      .from("knowledge_nodes")
      .select("id, title, attachments")
      .eq("user_id", userId)
      .eq("node_type", "patient")
      .eq("context", "patients")
      .order("id", { ascending: true })
      .range(from, to),
  );

  // Re-do the kind affinity Set for `hasPurchasedKind` / `notPurchasedKind`.
  // This duplicates the doResolveCohort logic — acceptable for v1 of the
  // blast composer; if the duplication ever drifts we'll consolidate.
  const kindsNeeded = new Set<string>();
  if (attachments.cohortQuery.hasPurchasedKind)
    kindsNeeded.add(attachments.cohortQuery.hasPurchasedKind);
  if (attachments.cohortQuery.notPurchasedKind)
    kindsNeeded.add(attachments.cohortQuery.notPurchasedKind);

  const kindToPatients = new Map<string, Set<string>>();
  if (kindsNeeded.size > 0) {
    const PAGE = 1000;
    let from = 0;
    while (true) {
      const { data: chunk, error: tErr } = await sb
        .from("patient_transactions")
        .select("patient_node_id, product_kind")
        .eq("user_id", userId)
        .in("product_kind", Array.from(kindsNeeded))
        .gt("amount_usd", 0)
        .range(from, from + PAGE - 1);
      if (tErr) throw new Error(tErr.message);
      if (!chunk || chunk.length === 0) break;
      for (const t of chunk) {
        const k = t.product_kind;
        if (!k) continue;
        let s = kindToPatients.get(k);
        if (!s) {
          s = new Set();
          kindToPatients.set(k, s);
        }
        s.add(t.patient_node_id);
      }
      if (chunk.length < PAGE) break;
      from += PAGE;
    }
  }

  const todayMonth = new Date().getUTCMonth();
  const q = attachments.cohortQuery;
  const out: Array<{
    id: string;
    displayName: string;
    totalVisits: number;
    lifetimeSpendUsd: number;
    lastVisit: string | null;
    primaryManufacturer: string | null;
    phone: string | null;
    email: string | null;
  }> = [];
  for (const row of patients ?? []) {
    const a = (row.attachments ?? null) as {
      banned?: boolean;
      phone?: string | null;
      email?: string | null;
      primaryManufacturer?: string | null;
      totalVisits?: number;
      lifetimeSpendUsd?: number;
      firstVisit?: string | null;
      lastVisit?: string | null;
    } | null;
    if (!a) continue;
    if (a.banned) continue;
    if (q.requireReachable && !a.phone && !a.email) continue;
    if (q.hasPurchasedKind) {
      const set = kindToPatients.get(q.hasPurchasedKind);
      if (!set || !set.has(row.id)) continue;
    }
    if (q.notPurchasedKind) {
      const set = kindToPatients.get(q.notPurchasedKind);
      if (set && set.has(row.id)) continue;
    }
    if (q.primaryManufacturer && a.primaryManufacturer !== q.primaryManufacturer)
      continue;
    if (q.minTotalVisits !== undefined && (a.totalVisits ?? 0) < q.minTotalVisits)
      continue;
    const daysSinceLast = a.lastVisit ? daysSinceIso(a.lastVisit) : null;
    if (q.minDaysSinceLastVisit !== undefined) {
      if (daysSinceLast === null || daysSinceLast < q.minDaysSinceLastVisit)
        continue;
    }
    if (q.maxDaysSinceLastVisit !== undefined) {
      if (daysSinceLast === null || daysSinceLast > q.maxDaysSinceLastVisit)
        continue;
    }
    if (q.minLifetimeSpendUsd !== undefined && (a.lifetimeSpendUsd ?? 0) < q.minLifetimeSpendUsd)
      continue;
    if (q.anniversaryMonth) {
      if (!a.firstVisit) continue;
      const m = Number(a.firstVisit.split("-")[1]);
      if (!Number.isFinite(m) || m - 1 !== todayMonth) continue;
    }
    out.push({
      id: row.id,
      displayName: row.title,
      totalVisits: a.totalVisits ?? 0,
      lifetimeSpendUsd: a.lifetimeSpendUsd ?? 0,
      lastVisit: a.lastVisit ?? null,
      primaryManufacturer: a.primaryManufacturer ?? null,
      phone: a.phone ?? null,
      email: a.email ?? null,
    });
  }
  return out.sort((a, b) => b.lifetimeSpendUsd - a.lifetimeSpendUsd);
}

function daysSinceIso(iso: string): number | null {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return null;
  return Math.floor((Date.now() - Date.UTC(y, m - 1, d)) / 86_400_000);
}

// ─── generateCampaignDraft ────────────────────────────────────────────────

export const generateCampaignDraft = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => generateDraftInput.parse(input))
  .handler(async ({ data }): Promise<CampaignDraft> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();

    // Load campaign + patient context.
    const [
      { data: campaign, error: cErr },
      { data: patient, error: pErr },
    ] = await Promise.all([
      sb
        .from("knowledge_nodes")
        .select("id, title, content, attachments")
        .eq("user_id", userId)
        .eq("id", data.campaignId)
        .eq("node_type", "campaign")
        .maybeSingle(),
      sb
        .from("knowledge_nodes")
        .select("id, title, attachments")
        .eq("user_id", userId)
        .eq("id", data.patientNodeId)
        .eq("node_type", "patient")
        .maybeSingle(),
    ]);
    if (cErr) throw new Error(`Couldn't load campaign: ${cErr.message}`);
    if (pErr) throw new Error(`Couldn't load patient: ${pErr.message}`);
    if (!campaign) throw new Error("Campaign not found.");
    if (!patient) throw new Error("Patient not found.");

    const cAtt =
      (campaign.attachments as unknown as CampaignAttachments | null) ?? null;
    const pAtt = (patient.attachments ?? null) as {
      displayName?: string;
      phone?: string | null;
      email?: string | null;
      lastVisit?: string | null;
      totalVisits?: number;
      primaryManufacturer?: string | null;
      lifetimeSpendUsd?: number;
    } | null;
    if (!cAtt) throw new Error("Campaign has no scaffolding.");

    const channel: BlastChannel =
      data.channel ?? recommendChannel(pAtt?.phone ?? null, pAtt?.email ?? null) ?? "email";
    const firstName = patient.title.split(",")[1]?.trim() || patient.title;
    const userPrompt = [
      `CAMPAIGN: ${campaign.title}`,
      `CAMPAIGN DESCRIPTION: ${campaign.content ?? ""}`,
      `CAMPAIGN TEMPLATE KIND: ${cAtt.templateKind}`,
      cAtt.offer.headline ? `OFFER HEADLINE (paraphrase only): ${cAtt.offer.headline}` : "",
      `CHANNEL: ${channel}`,
      "",
      `PATIENT FIRST NAME: ${firstName}`,
      pAtt?.totalVisits ? `PATIENT TOTAL VISITS: ${pAtt.totalVisits}` : "",
      pAtt?.lastVisit ? `PATIENT LAST VISIT: ${pAtt.lastVisit}` : "",
      pAtt?.primaryManufacturer
        ? `PATIENT PRIMARY TREATMENT BUCKET (do NOT name the brand in the body): ${pAtt.primaryManufacturer}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");

    const raw = await callGeminiOneShot(EMMA_CAMPAIGN_DRAFT_PROMPT, userPrompt, {
      // Slightly warmer than the rep-side default — patient outreach is
      // less formal and benefits from natural-language variation.
      temperature: 0.55,
      maxOutputTokens: 4096,
    });
    const parsed = parseEmmaDraft(raw, channel);
    const verifiedChip = buildVerifiedChip(cAtt.offer);

    return {
      subject: parsed.subject,
      body: parsed.body,
      channel,
      verifiedChip,
      generatedAt: new Date().toISOString(),
      edited: false,
    };
  });

// ─── saveCampaignDraft ────────────────────────────────────────────────────

export const saveCampaignDraft = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => saveDraftInput.parse(input))
  .handler(async ({ data }): Promise<{ ok: true; updatedAt: string }> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();
    const now = new Date().toISOString();
    const draft: CampaignDraft = { ...data.draft, edited: true };
    const { error } = await sb
      .from("patient_outreach_state")
      .upsert(
        {
          user_id: userId,
          campaign_node_id: data.campaignId,
          patient_node_id: data.patientNodeId,
          state: "targeted",
          channel: draft.channel,
          draft: draft as unknown as Json,
          updated_at: now,
        },
        { onConflict: "user_id,campaign_node_id,patient_node_id" },
      );
    if (error) throw new Error(`Couldn't save draft: ${error.message}`);
    return { ok: true, updatedAt: now };
  });

// ════════════════════════════════════════════════════════════════════════════
//  Phase 3.1 — Actual sending
// ════════════════════════════════════════════════════════════════════════════

// ─── Public send-result types ─────────────────────────────────────────────

export type SendSkipReason =
  | "banned"
  | "opted_out"
  | "velocity_cap"
  | "quiet_hours"
  | "no_channel"
  | "no_draft"
  | "from_unavailable"
  | "patient_missing"
  | "already_sent";

export type SendCampaignMessageResult =
  | {
      ok: true;
      messageId: string | null;
      channel: "sms" | "email";
      sentAt: string;
    }
  | {
      ok: false;
      skipReason: SendSkipReason;
      message: string;
    };

// ─── Compliance utilities ─────────────────────────────────────────────────

/**
 * Quiet-hours check. Returns true when current UTC clock is OUTSIDE the
 * campaign's quietHours window (treated as the spa's local hours; for v1
 * we assume the spa's timezone is America/Denver — Rejuv's locale —
 * pending a per-spa timezone field on the profile).
 */
function isQuietNow(quietHours: { localStart: string; localEnd: string }): boolean {
  const SPA_TIMEZONE = "America/Denver";
  const now = new Date();
  const localeTime = now.toLocaleTimeString("en-US", {
    timeZone: SPA_TIMEZONE,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
  // localeTime is "HH:MM" — compare lex with the same-format window bounds.
  // start < end means daytime window (09:00 → 21:00); we're QUIET outside it.
  const start = quietHours.localStart;
  const end = quietHours.localEnd;
  if (start <= end) {
    return localeTime < start || localeTime >= end;
  }
  // Inverted window (e.g. 22:00 → 08:00) — quiet only when INSIDE.
  return localeTime >= start && localeTime < end;
}

/** Has this patient received an outbound message in the velocity window? */
async function recentOutboundExists(
  sb: ReturnType<typeof admin>,
  userId: string,
  stateRowId: string,
  velocityCapDays: number,
): Promise<boolean> {
  const cutoff = new Date(
    Date.now() - velocityCapDays * 86_400_000,
  ).toISOString();
  const { count, error } = await sb
    .from("patient_outreach")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("patient_outreach_state_id", stateRowId)
    .eq("direction", "outbound")
    .not("sent_at", "is", null)
    .gte("sent_at", cutoff);
  if (error) return false; // err on the side of allowing send — never silently block
  return (count ?? 0) > 0;
}

// ─── Body composition ─────────────────────────────────────────────────────

const SMS_STOP_FOOTER = " Reply STOP to opt out.";

function composeSmsBody(args: {
  draftBody: string;
  spaName: string;
  verifiedChip: string | null;
  bookingUrl: string | null;
}): string {
  let body = args.draftBody.replace(/\[SPA_NAME\]/g, args.spaName).trim();
  // [VERIFIED] chip rendered inline for SMS (no UI surface). Chip already
  // starts with "[VERIFIED] " — surface it as a short line above the
  // signature.
  if (args.verifiedChip && !body.includes(args.verifiedChip)) {
    body = `${body}\n${args.verifiedChip}`;
  }
  // v353: booking link goes ABOVE the STOP footer so it's the prominent
  // CTA. Embed only if provisioning succeeded — never ship "Book: null".
  if (args.bookingUrl && !body.includes(args.bookingUrl)) {
    body = `${body}\nBook: ${args.bookingUrl}`;
  }
  if (!/(reply\s+stop|opt\s*out)/i.test(body)) {
    body = `${body}${SMS_STOP_FOOTER}`;
  }
  return body;
}

function composeEmail(args: {
  draftSubject: string | null;
  draftBody: string;
  spaName: string;
  verifiedChip: string | null;
  unsubscribeUrl: string;
  bookingUrl: string | null;
}): { subject: string; text: string; html: string } {
  const subject = (args.draftSubject ?? "")
    .replace(/\[SPA_NAME\]/g, args.spaName)
    .trim() || `News from ${args.spaName}`;
  const bodyText = args.draftBody.replace(/\[SPA_NAME\]/g, args.spaName).trim();

  const text = [
    bodyText,
    args.verifiedChip ? `\n${args.verifiedChip}` : "",
    args.bookingUrl ? `\nBook your appointment: ${args.bookingUrl}` : "",
    `\n—\nYou're receiving this because you've visited ${args.spaName}.`,
    `Unsubscribe: ${args.unsubscribeUrl}`,
  ]
    .filter(Boolean)
    .join("\n");

  const html = renderEmailHtml({
    bodyText,
    spaName: args.spaName,
    verifiedChip: args.verifiedChip,
    unsubscribeUrl: args.unsubscribeUrl,
    bookingUrl: args.bookingUrl,
  });

  return { subject, text, html };
}

function renderEmailHtml(args: {
  bodyText: string;
  spaName: string;
  verifiedChip: string | null;
  unsubscribeUrl: string;
  bookingUrl: string | null;
}): string {
  const escape = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const paragraphs = args.bodyText
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 16px 0;">${escape(p).replace(/\n/g, "<br/>")}</p>`)
    .join("\n");
  return `<!doctype html><html><body style="margin:0;padding:24px;font:15px/1.55 -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif;color:#1a1a1a;background:#f7f5f0;">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;padding:28px;">
${paragraphs}
${
  args.verifiedChip
    ? `<div style="display:inline-block;background:#dcfce7;color:#166534;padding:6px 12px;border-radius:999px;font-size:12px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;margin:8px 0;">${escape(args.verifiedChip)}</div>`
    : ""
}
${
  args.bookingUrl
    ? `<p style="margin:20px 0 0 0;"><a href="${escape(args.bookingUrl)}" style="display:inline-block;background:#1a1a1a;color:#fff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:8px;font-size:15px;">Book your appointment</a></p>`
    : ""
}
<hr style="border:none;border-top:1px solid #e5e0d6;margin:24px 0;"/>
<p style="font-size:12px;color:#6b6b6b;margin:0;">You're receiving this because you've visited ${escape(args.spaName)}. <a href="${escape(args.unsubscribeUrl)}" style="color:#6b6b6b;">Unsubscribe</a>.</p>
</div></body></html>`;
}

// ─── sendCampaignMessage ──────────────────────────────────────────────────

const sendMessageInput = z.object({
  accessToken: z.string().min(1),
  campaignId: z.string().uuid(),
  patientNodeId: z.string().uuid(),
});

export const sendCampaignMessage = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => sendMessageInput.parse(input))
  .handler(async ({ data }): Promise<SendCampaignMessageResult> => {
    const userId = await verifyAuth(data.accessToken);
    return dispatchOutreach({
      sb: admin(),
      userId,
      campaignId: data.campaignId,
      patientNodeId: data.patientNodeId,
    });
  });

/**
 * Core dispatch — the pure-fn shape used by BOTH the foreground
 * sendCampaignMessage server fn AND the v356 cron sweep
 * (`/api/cron/emma-sweep`). Caller has already established trust
 * (verifyAuth on the foreground path; SCHEDULER_SECRET on the cron
 * path), so this fn just acts on (userId, campaignId, patientNodeId).
 *
 * Returns the same SendCampaignMessageResult shape — caller can audit
 * skip reasons or success identically.
 *
 * Exported so the cron route can import it. NOT a TanStack server fn —
 * the trust boundary differs and we don't want a service-role token
 * leaking from a route-handler payload.
 */
export async function dispatchOutreach({
  sb,
  userId,
  campaignId,
  patientNodeId,
}: {
  sb: ReturnType<typeof admin>;
  userId: string;
  campaignId: string;
  patientNodeId: string;
}): Promise<SendCampaignMessageResult> {
    // 1) Load campaign + state row + patient summary in parallel.
    const [campaignRes, stateRes, patientRes] = await Promise.all([
      sb
        .from("knowledge_nodes")
        .select("id, title, attachments")
        .eq("user_id", userId)
        .eq("id", campaignId)
        .eq("node_type", "campaign")
        .maybeSingle(),
      sb
        .from("patient_outreach_state")
        .select("*")
        .eq("user_id", userId)
        .eq("campaign_node_id", campaignId)
        .eq("patient_node_id", patientNodeId)
        .maybeSingle(),
      sb
        .from("knowledge_nodes")
        .select("id, title, attachments")
        .eq("user_id", userId)
        .eq("id", patientNodeId)
        .eq("node_type", "patient")
        .maybeSingle(),
    ]);
    if (campaignRes.error)
      throw new Error(`Couldn't load campaign: ${campaignRes.error.message}`);
    if (stateRes.error)
      throw new Error(`Couldn't load state: ${stateRes.error.message}`);
    if (patientRes.error)
      throw new Error(`Couldn't load patient: ${patientRes.error.message}`);
    if (!campaignRes.data) throw new Error("Campaign not found.");
    if (!stateRes.data) {
      return {
        ok: false,
        skipReason: "no_draft",
        message: "No outreach row — open the composer first.",
      };
    }
    if (!patientRes.data) {
      return {
        ok: false,
        skipReason: "patient_missing",
        message: "Patient not found.",
      };
    }

    const campaignAttachments =
      (campaignRes.data.attachments as unknown as CampaignAttachments | null) ??
      null;
    if (!campaignAttachments) {
      return {
        ok: false,
        skipReason: "no_draft",
        message: "Campaign has no scaffolding.",
      };
    }
    const stateRow = stateRes.data;
    const draft = (stateRow.draft ?? null) as unknown as CampaignDraft | null;
    if (!draft || !draft.body) {
      return {
        ok: false,
        skipReason: "no_draft",
        message: "No draft saved for this patient. Save the draft first.",
      };
    }
    if (stateRow.state === "outreached" && stateRow.last_touched_at) {
      // Defensive: don't re-send if we already sent. Spa can re-target on a
      // fresh campaign.
      return {
        ok: false,
        skipReason: "already_sent",
        message: "Already sent. Use a new campaign to re-target.",
      };
    }
    if (stateRow.state === "opted_out") {
      return {
        ok: false,
        skipReason: "opted_out",
        message: "Patient opted out — never resurrected.",
      };
    }

    const patientSummary =
      (patientRes.data.attachments as unknown as PatientSummary | null) ?? null;
    if (!patientSummary) {
      return {
        ok: false,
        skipReason: "patient_missing",
        message: "Patient summary missing.",
      };
    }
    // Compliance: banned OR opted-out blocks all outbound. The state-table
    // opted_out check above catches STOP replies; this also catches a spa-flagged
    // attachments.opted_out (no STOP) that previously slipped through — one
    // shared rule via patient-contactability.
    const optOut = patientOptOutStatus(patientSummary);
    if (optOut.blocked) {
      return {
        ok: false,
        skipReason: optOut.reason === "opted_out" ? "opted_out" : "banned",
        message:
          optOut.reason === "opted_out"
            ? "Patient opted out — outbound blocked."
            : "Patient flagged banned — outbound blocked.",
      };
    }

    // 2) Compliance: quiet hours + velocity cap.
    if (isQuietNow(campaignAttachments.quietHours)) {
      return {
        ok: false,
        skipReason: "quiet_hours",
        message: `Quiet hours (${campaignAttachments.quietHours.localStart}–${campaignAttachments.quietHours.localEnd} local). Retry later.`,
      };
    }
    if (
      await recentOutboundExists(
        sb,
        userId,
        stateRow.id,
        campaignAttachments.velocityCapDays,
      )
    ) {
      return {
        ok: false,
        skipReason: "velocity_cap",
        message: `Sent within the last ${campaignAttachments.velocityCapDays} days.`,
      };
    }

    // 3) Resolve channel — prefer the draft's channel; downgrade if the
    //    patient doesn't have the required contact field. 'both' → SMS first
    //    when available, else email; for v1 we don't actually fire two
    //    messages per patient — Phase 3.1.x will add the dual-send option.
    let channel: "sms" | "email";
    if (draft.channel === "email") {
      if (!patientSummary.email) {
        return {
          ok: false,
          skipReason: "no_channel",
          message: "No email on file.",
        };
      }
      channel = "email";
    } else if (draft.channel === "sms") {
      if (!patientSummary.phone) {
        return {
          ok: false,
          skipReason: "no_channel",
          message: "No phone on file.",
        };
      }
      channel = "sms";
    } else {
      // BOTH: pick SMS if available, else email.
      if (patientSummary.phone) channel = "sms";
      else if (patientSummary.email) channel = "email";
      else
        return {
          ok: false,
          skipReason: "no_channel",
          message: "Neither phone nor email on file.",
        };
    }

    // 4) Spa name for [SPA_NAME] substitution.
    const { data: spaNameNode } = await sb
      .from("knowledge_nodes")
      .select("title")
      .eq("user_id", userId)
      .eq("context", "spa-profile")
      .eq("lookup_key", "spa-name")
      .maybeSingle();
    const spaName = spaNameNode?.title?.trim() || "your spa";

    // 4b) v353 — provision booking_intent_token for this state row if not
    //     already set. ensureBookingToken is idempotent so re-sends reuse
    //     the same token (one URL across an entire campaign for a given
    //     patient). On failure (DB hiccup) bookingUrl stays null and the
    //     compose code skips embedding — never sends a broken link.
    const bookingToken = await ensureBookingToken(stateRow.id);
    const bookingUrl = bookingToken ? bookingUrlFor(bookingToken) : null;

    // 5) Dispatch.
    const sentAt = new Date().toISOString();
    let messageId: string | null = null;
    let dispatchError: { reason: SendSkipReason; message: string } | null = null;
    const composedBody =
      channel === "sms"
        ? composeSmsBody({
            draftBody: draft.body,
            spaName,
            verifiedChip: draft.verifiedChip,
            bookingUrl,
          })
        : draft.body;

    if (channel === "sms") {
      const fromNumber = await resolveSpaFromNumber(sb, userId);
      if (!fromNumber) {
        dispatchError = {
          reason: "from_unavailable",
          message: "Spa has no provisioned SMS number.",
        };
      } else {
        try {
          const resp = await sendSms({
            from: fromNumber,
            to: patientSummary.phone!,
            body: composedBody,
          });
          messageId = resp.messageId;
        } catch (e) {
          dispatchError = {
            reason: "from_unavailable",
            message:
              e instanceof Error ? `sms: ${e.message}` : "sms: unknown error",
          };
        }
      }
    } else {
      const composed = composeEmail({
        draftSubject: draft.subject,
        draftBody: draft.body,
        spaName,
        verifiedChip: draft.verifiedChip,
        unsubscribeUrl: `https://emma.agentiport.com/unsubscribe?u=${stateRow.id}`,
        bookingUrl,
      });
      const resendKey = process.env.RESEND_API_KEY;
      // v355: per-spa verified sender if available, else platform default.
      // resolveSpaFromEmail handles the fallback chain — see
      // emma-sender.functions.ts for precedence.
      const fromEmail = await resolveSpaFromEmail(userId);
      if (!resendKey) {
        dispatchError = {
          reason: "from_unavailable",
          message: "Resend API key not configured.",
        };
      } else {
        try {
          const res = await postResendEmail({
            apiKey: resendKey,
            from: fromEmail,
            to: [patientSummary.email!],
            subject: composed.subject,
            text: composed.text,
            html: composed.html,
            // v354 — engagement tracking. Resend fires email.opened
            // and email.clicked webhook events handled at
            // /api/resend/inbound. Open tracking inserts a 1x1
            // pixel; click tracking rewrites in-body URLs through
            // a tracking redirect (transparent to recipient, ~80ms
            // hop, original destination unchanged). Both stamp
            // patient_outreach for Phase 9 reporting.
            tracking: { opens: true, clicks: true },
            tags: [
              { name: "type", value: "emma-campaign" },
              { name: "campaign_id", value: campaignId },
            ],
            signal: AbortSignal.timeout(15_000),
          });
          if (!res.ok) {
            dispatchError = {
              reason: "from_unavailable",
              message: `resend: ${res.status} ${res.body.slice(0, 200)}`,
            };
          } else {
            messageId = res.id ?? null;
          }
        } catch (e) {
          dispatchError = {
            reason: "from_unavailable",
            message:
              e instanceof Error ? `resend: ${e.message}` : "resend: unknown error",
          };
        }
      }
    }

    // 6) Log the outreach row regardless of success — failures are valuable
    //    audit data and feed retry logic later.
    const outreachRow: Database["public"]["Tables"]["patient_outreach"]["Insert"] = {
      user_id: userId,
      patient_outreach_state_id: stateRow.id,
      direction: "outbound",
      channel,
      subject: channel === "email" ? draft.subject : null,
      body: composedBody,
      sent_at: dispatchError ? null : sentAt,
      message_id: messageId,
      skip_reason: dispatchError?.reason ?? null,
    };
    const { error: insertErr } = await sb
      .from("patient_outreach")
      .insert(outreachRow);
    if (insertErr) {
      // The send already fired; we can't unsend. Surface the audit failure
      // but don't claim a skip the caller didn't actually experience.
      console.error("patient_outreach insert failed:", insertErr.message);
    }

    if (dispatchError) {
      return {
        ok: false,
        skipReason: dispatchError.reason,
        message: dispatchError.message,
      };
    }

    // 7) Advance the state row.
    const { error: updErr } = await sb
      .from("patient_outreach_state")
      .update({
        state: "outreached",
        channel,
        last_touched_at: sentAt,
        last_message_id: messageId,
        updated_at: sentAt,
      })
      .eq("id", stateRow.id)
      .eq("user_id", userId);
    if (updErr) {
      console.error("state advance failed:", updErr.message);
    }

    return {
      ok: true,
      messageId,
      channel,
      sentAt,
    };
}

// ─── scheduleCampaignBlast / cancelScheduledBlast (v356) ──────────────────

const scheduleInput = z.object({
  accessToken: z.string().min(1),
  campaignId: z.string().uuid(),
  /** ISO timestamp the spa wants the blast to fire. Must be in the future. */
  scheduledAt: z.string().datetime(),
});

const cancelScheduleInput = z.object({
  accessToken: z.string().min(1),
  campaignId: z.string().uuid(),
});

export type ScheduleResult = {
  ok: true;
  count: number;
  scheduledAt: string;
};

/**
 * Flip every 'targeted' row for this campaign to state='scheduled' with
 * scheduled_at set. The cron sweep at /api/cron/emma-sweep picks them
 * up when scheduled_at <= now() and dispatches each through the same
 * dispatchOutreach helper the foreground Send button uses.
 *
 * Skip targets already in non-targeted states ('outreached', 'opted_out',
 * 'booked', etc.) — those have moved past the schedule-able window.
 * Idempotent: re-scheduling updates the scheduled_at on any rows still
 * in 'scheduled' state from a prior call.
 */
export const scheduleCampaignBlast = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => scheduleInput.parse(input))
  .handler(async ({ data }): Promise<ScheduleResult> => {
    const userId = await verifyAuth(data.accessToken);
    const when = new Date(data.scheduledAt);
    if (isNaN(when.getTime())) {
      throw new Error("Invalid scheduled time.");
    }
    if (when.getTime() < Date.now() + 60_000) {
      // Reject schedules within the next 60s — those should just use
      // Send all. Avoids a race where the sweep fires before the UI
      // refresh shows the scheduled state.
      throw new Error("Schedule at least 1 minute in the future.");
    }
    const sb = admin();

    const { data: rows, error } = await sb
      .from("patient_outreach_state")
      .update({
        state: "scheduled",
        scheduled_at: when.toISOString(),
      })
      .eq("user_id", userId)
      .eq("campaign_node_id", data.campaignId)
      .in("state", ["targeted", "scheduled"])
      .select("id");
    if (error) throw new Error(`Couldn't schedule: ${error.message}`);

    return {
      ok: true,
      count: rows?.length ?? 0,
      scheduledAt: when.toISOString(),
    };
  });

/**
 * Flip every 'scheduled' row for this campaign back to 'targeted' and
 * clear scheduled_at. The spa now sees the normal pre-send composer
 * state and can re-schedule, edit drafts, or send manually.
 */
export const cancelScheduledBlast = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => cancelScheduleInput.parse(input))
  .handler(async ({ data }): Promise<{ ok: true; count: number }> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();

    const { data: rows, error } = await sb
      .from("patient_outreach_state")
      .update({
        state: "targeted",
        scheduled_at: null,
      })
      .eq("user_id", userId)
      .eq("campaign_node_id", data.campaignId)
      .eq("state", "scheduled")
      .select("id");
    if (error) throw new Error(`Couldn't cancel schedule: ${error.message}`);

    return { ok: true, count: rows?.length ?? 0 };
  });

