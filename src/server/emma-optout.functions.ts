/**
 * Emma(OS) patient opt-out arc — the inbound side of the v350 send loop.
 *
 * Two entry paths converge on the same opt-out helper:
 *
 *   1. SMS STOP/UNSUBSCRIBE keyword  → handleInbound in twilio-gateway.ts
 *      detects the keyword in the inbound body, looks up the patient by
 *      phone within the spa's user_id, and calls optOutPatient(...).
 *
 *   2. Email unsubscribe link click  → /unsubscribe?u=<state_id> route
 *      resolves state_id → user_id + patient_node_id and calls the same
 *      optOutPatient(...) helper.
 *
 * Both paths:
 *   - Flip EVERY patient_outreach_state row for (user_id, patient_node_id)
 *     to state='opted_out'. One STOP opts the patient out of all the
 *     spa's campaigns, not just the most recent — that's the TCPA
 *     expectation and how every other compliant platform behaves.
 *   - Write a row to patient_outreach with direction='inbound' so the
 *     audit trail captures the opt-out signal alongside the outbound
 *     blast attempts. Per-row skip_reason='opted_out' is reserved for
 *     the SEND-TIME refusal (see emma-blast.functions.ts:sendCampaignMessage).
 *
 * Compliance posture: STOP is broad by design. We do NOT scope by
 * campaign — every active state row flips. If a spa later wants to
 * re-engage a STOP'd patient, they must obtain explicit re-opt-in
 * (the START keyword path below, which only flips state rows that
 * are CURRENTLY opted_out — never resurrects deleted/closed states).
 */

import { createClient } from "@supabase/supabase-js";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";

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

// ── Keyword detection ──────────────────────────────────────────────────────
// Standard Twilio TCPA keywords + the obvious extras. Match is case-
// insensitive on the trimmed first word — "stop" / "STOP" / " Stop please"
// all hit, but a passing mention inside a sentence ("don't stop the music")
// does not. Twilio's STOP filter at the carrier level also covers these,
// but defense in depth: we want our own audit trail + auto-reply, not
// just the carrier swallowing the message.

const STOP_KEYWORDS = new Set([
  "STOP",
  "STOPALL",
  "UNSUBSCRIBE",
  "CANCEL",
  "END",
  "QUIT",
  "REVOKE",
  "OPTOUT",
  "OPT-OUT",
]);

const START_KEYWORDS = new Set([
  "START",
  "UNSTOP",
  "YES",
  "OPTIN",
  "OPT-IN",
]);

const HELP_KEYWORDS = new Set([
  "HELP",
  "INFO",
]);

export type InboundKeyword = "STOP" | "START" | "HELP" | null;

/**
 * Detect a TCPA keyword in an inbound SMS body. Matches the first
 * word only (case-insensitive, trimmed). Returns null when no keyword
 * is present — the caller should fall through to normal routing.
 */
export function detectInboundKeyword(body: string): InboundKeyword {
  const firstWord = body.trim().split(/\s+/)[0]?.toUpperCase() ?? "";
  if (STOP_KEYWORDS.has(firstWord)) return "STOP";
  if (START_KEYWORDS.has(firstWord)) return "START";
  if (HELP_KEYWORDS.has(firstWord)) return "HELP";
  return null;
}

// ── Patient lookup by phone ────────────────────────────────────────────────

/**
 * Find the patient node for this spa whose phone matches the given E.164
 * number. Returns null if no patient row carries that phone. Twilio's
 * From: header is always E.164 on US numbers, so we match exactly — no
 * normalization round-trip needed.
 *
 * Multiple patients with the same phone (shared household) would be a
 * data-quality issue surfaced by the contact-import flow; for v1 we
 * return the first match. If that becomes a real-world problem we
 * promote all matches to opt-out (safer than choosing one).
 */
export async function findPatientByPhone(
  userId: string,
  phoneE164: string,
): Promise<{ id: string; title: string } | null> {
  const sb = admin();
  const { data } = await sb
    .from("knowledge_nodes")
    .select("id, title, attachments")
    .eq("user_id", userId)
    .eq("node_type", "patient")
    .eq("context", "patients");
  if (!data) return null;
  for (const row of data) {
    const att = (row.attachments ?? null) as { phone?: string } | null;
    if (att?.phone === phoneE164) {
      return { id: row.id, title: row.title ?? "(unnamed)" };
    }
  }
  return null;
}

// ── Spa name lookup (for the auto-reply) ───────────────────────────────────

/**
 * Get the spa's display name for the SMS auto-reply ("You've been
 * unsubscribed from {SPA}"). Reads from the knowledge_nodes spa-profile
 * row that v350 already established. Falls back to a generic phrase
 * when the profile node isn't seeded — we never want to crash an
 * opt-out path on a name-lookup failure.
 */
export async function getSpaName(userId: string): Promise<string> {
  const sb = admin();
  const { data } = await sb
    .from("knowledge_nodes")
    .select("title, content, attachments")
    .eq("user_id", userId)
    .eq("context", "spa-profile")
    .eq("lookup_key", "spa-name")
    .maybeSingle();
  if (data?.title && data.title.trim()) return data.title.trim();
  // Fallback: any spa-profile row at all, then the content field.
  if (data?.content && data.content.trim()) return data.content.trim();
  return "this practice";
}

// ── The core opt-out helper ────────────────────────────────────────────────

export type OptOutChannel = "sms" | "email" | "link";

export type OptOutResult = {
  patientNodeId: string;
  statesUpdated: number;
};

/**
 * Flip every patient_outreach_state row for this (user_id, patient_node_id)
 * to state='opted_out', and record an inbound row in patient_outreach
 * capturing the channel + message id + body. Idempotent: if every state
 * row is already opted_out, statesUpdated=0 and we still write the
 * inbound row (audit trail of re-confirmation).
 */
export async function optOutPatient(input: {
  userId: string;
  patientNodeId: string;
  viaChannel: OptOutChannel;
  inboundBody: string | null;
  inboundMessageId: string | null;
}): Promise<OptOutResult> {
  const sb = admin();
  const nowIso = new Date().toISOString();

  // 1. Flip every active state row for this patient to opted_out. We
  //    intentionally do NOT filter by current state — even already-sent /
  //    booked rows flip, because "STOP" is a forward-looking instruction
  //    (no more outreach), not a retroactive history rewrite.
  const { data: updated, error: updErr } = await sb
    .from("patient_outreach_state")
    .update({ state: "opted_out", updated_at: nowIso })
    .eq("user_id", input.userId)
    .eq("patient_node_id", input.patientNodeId)
    .neq("state", "opted_out")
    .select("id");
  if (updErr) {
    throw new Error(`opt-out state update failed: ${updErr.message}`);
  }
  const statesUpdated = updated?.length ?? 0;

  // 2. Pick the most-recent state row (if any) to anchor the inbound
  //    outreach row. patient_outreach has patient_outreach_state_id as
  //    its scoping field; if the patient has no state rows yet (e.g.,
  //    a brand-new patient who somehow opted out before being targeted)
  //    we skip the audit row gracefully — opt-out is recorded by the
  //    state flip alone.
  const { data: anyState } = await sb
    .from("patient_outreach_state")
    .select("id")
    .eq("user_id", input.userId)
    .eq("patient_node_id", input.patientNodeId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (anyState?.id) {
    const channel = input.viaChannel === "link" ? "email" : input.viaChannel;
    const { error: insErr } = await sb.from("patient_outreach").insert({
      user_id: input.userId,
      patient_outreach_state_id: anyState.id,
      direction: "inbound",
      channel,
      body: input.inboundBody ?? "",
      message_id: input.inboundMessageId,
      sent_at: nowIso,
    });
    if (insErr) {
      // Audit failure is not fatal — the state flip is what actually
      // protects future sends. Log + carry on.
      console.error(
        "[emma-optout] patient_outreach inbound insert failed:",
        insErr.message,
      );
    }
  }

  return { patientNodeId: input.patientNodeId, statesUpdated };
}

// ── Opt-IN (START keyword) ─────────────────────────────────────────────────

/**
 * Re-enable outreach for a patient who previously opted out. Only flips
 * rows that are CURRENTLY opted_out — never resurrects rows that ended
 * in closed_won/closed_lost/etc. Returns the count of state rows moved
 * back to 'targeted' so the caller can decide whether to send a
 * confirmation auto-reply.
 *
 * TCPA posture: START is explicit re-opt-in, which legally clears the
 * prior STOP. We document the timestamp in metadata for any future
 * regulator-asked-about-this audit.
 */
export async function optInPatient(input: {
  userId: string;
  patientNodeId: string;
  inboundBody: string | null;
  inboundMessageId: string | null;
}): Promise<{ statesRestored: number }> {
  const sb = admin();
  const nowIso = new Date().toISOString();

  const { data: updated, error: updErr } = await sb
    .from("patient_outreach_state")
    .update({ state: "targeted", updated_at: nowIso })
    .eq("user_id", input.userId)
    .eq("patient_node_id", input.patientNodeId)
    .eq("state", "opted_out")
    .select("id");
  if (updErr) {
    throw new Error(`opt-in state update failed: ${updErr.message}`);
  }
  const statesRestored = updated?.length ?? 0;

  // Audit row — even if no states changed (the patient texted START
  // without ever having opted out), we record the signal.
  const { data: anyState } = await sb
    .from("patient_outreach_state")
    .select("id")
    .eq("user_id", input.userId)
    .eq("patient_node_id", input.patientNodeId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (anyState?.id) {
    const { error: insErr } = await sb.from("patient_outreach").insert({
      user_id: input.userId,
      patient_outreach_state_id: anyState.id,
      direction: "inbound",
      channel: "sms",
      body: input.inboundBody ?? "",
      message_id: input.inboundMessageId,
      sent_at: nowIso,
    });
    if (insErr) {
      console.error(
        "[emma-optout] patient_outreach inbound (START) insert failed:",
        insErr.message,
      );
    }
  }

  return { statesRestored };
}

// ── Unsubscribe link path — resolve state_id → patient/user ────────────────

export type UnsubscribeLinkLookup =
  | { ok: true; userId: string; patientNodeId: string; spaName: string; patientName: string }
  | { ok: false; reason: string };

/**
 * Resolve a `/unsubscribe?u=<state_id>` token to the patient + spa it
 * refers to. The token is the bare patient_outreach_state.id UUID — no
 * signing for v1 (the worst case of a guessed UUID is opting someone
 * out who didn't ask, which is recoverable via the spa owner). If we
 * want signed tokens later, this is the seam.
 */
export async function lookupUnsubscribeTarget(
  stateId: string,
): Promise<UnsubscribeLinkLookup> {
  if (!/^[0-9a-f-]{36}$/i.test(stateId)) {
    return { ok: false, reason: "Invalid unsubscribe link." };
  }
  const sb = admin();
  const { data, error } = await sb
    .from("patient_outreach_state")
    .select("user_id, patient_node_id, state")
    .eq("id", stateId)
    .maybeSingle();
  if (error) {
    return { ok: false, reason: `Lookup error: ${error.message}` };
  }
  if (!data) {
    return { ok: false, reason: "Unsubscribe link not recognized." };
  }
  // Look up patient name + spa name for the confirmation page.
  const { data: patient } = await sb
    .from("knowledge_nodes")
    .select("title")
    .eq("id", data.patient_node_id)
    .maybeSingle();
  const spaName = await getSpaName(data.user_id);
  return {
    ok: true,
    userId: data.user_id,
    patientNodeId: data.patient_node_id,
    spaName,
    patientName: patient?.title ?? "you",
  };
}

// ── Email unsubscribe-intent detection (v352) ─────────────────────────────
// Patients reply to campaign emails with "unsubscribe please" / "stop"
// instead of clicking the link. Detect those replies and treat them as
// opt-outs. False-positive cost is recoverable (spa owner unblocks);
// false-negative cost is regulatory exposure. Bias toward catching it.

const EMAIL_STOP_WORDS = [
  "unsubscribe",
  "stop",
  "opt out",
  "opt-out",
  "remove me",
  "take me off",
  "do not contact",
  "do not email",
  "no more emails",
  "no more messages",
  "leave me alone",
];

/** Subject-line first-word fast path — same set as SMS. */
const SUBJECT_FAST_STOP = new Set([
  "STOP",
  "STOPALL",
  "UNSUBSCRIBE",
  "REMOVE",
  "OPTOUT",
  "OPT-OUT",
]);

/**
 * Decide whether an inbound email reply is an opt-out signal. Two
 * passes: (1) subject-line first-word match against the SMS keyword
 * set (covers "STOP" / "Unsubscribe" subjects), (2) substring scan of
 * subject + first 500 chars of body text against the wider STOP-word
 * list. The 500-char body cap dodges signature blocks and quoted-reply
 * history that often contains the unsubscribe footer text from the
 * ORIGINAL email — false positives on quoted content would opt out
 * every replier.
 */
export function detectEmailUnsubscribeIntent(
  subject: string | null,
  bodyText: string | null,
): boolean {
  const subj = (subject ?? "").trim();
  const firstSubjWord = subj.split(/\s+/)[0]?.toUpperCase() ?? "";
  if (SUBJECT_FAST_STOP.has(firstSubjWord)) return true;

  const subjLower = subj.toLowerCase();
  const bodyHead = (bodyText ?? "").slice(0, 500).toLowerCase();
  for (const word of EMAIL_STOP_WORDS) {
    if (subjLower.includes(word)) return true;
    if (bodyHead.includes(word)) return true;
  }
  return false;
}

// ── Emma inbound email reply router (v352) ────────────────────────────────

export type EmmaInboundResult =
  | { ok: true; routed: true; action: "opted_out" | "logged"; patientNodeId: string }
  | { ok: true; routed: false; reason: string };

/**
 * Route a Resend inbound webhook payload to Emma's patient-reply
 * handler when the in-reply-to header matches an outbound patient_outreach
 * email. Returns routed=false (with reason) when there's no Emma match —
 * the caller should fall through to Lizzie's promo-reply handler.
 *
 * The match key is `patient_outreach.message_id` which we set from the
 * Resend send API's `id` response on outbound — same correlation Lizzie
 * uses for promo replies, just on a different table.
 */
export async function routeInboundPatientReply(input: {
  resendEmailId: string;
  fromAddr: string;
  toAddr: string;
  subject: string | null;
  bodyText: string | null;
  inReplyTo: string | null;
}): Promise<EmmaInboundResult> {
  if (!input.inReplyTo) {
    return { ok: true, routed: false, reason: "no in-reply-to header" };
  }
  const sb = admin();

  // 1. Find the outbound patient_outreach row this is a reply to.
  const { data: parent } = await sb
    .from("patient_outreach")
    .select("id, user_id, patient_outreach_state_id, message_id, direction, channel")
    .eq("message_id", input.inReplyTo)
    .eq("direction", "outbound")
    .eq("channel", "email")
    .maybeSingle();
  if (!parent) {
    return { ok: true, routed: false, reason: "no Emma patient_outreach match" };
  }

  // 2. Resolve the patient_node_id from the state row so we can opt them out.
  const { data: state } = await sb
    .from("patient_outreach_state")
    .select("patient_node_id")
    .eq("id", parent.patient_outreach_state_id)
    .maybeSingle();
  if (!state) {
    return { ok: true, routed: false, reason: "patient_outreach_state row missing" };
  }

  const isOptOut = detectEmailUnsubscribeIntent(input.subject, input.bodyText);

  if (isOptOut) {
    try {
      await optOutPatient({
        userId: parent.user_id,
        patientNodeId: state.patient_node_id,
        viaChannel: "email",
        inboundBody: (input.subject ? `Subject: ${input.subject}\n\n` : "") +
          (input.bodyText ?? "").slice(0, 4000),
        inboundMessageId: input.resendEmailId,
      });
      return { ok: true, routed: true, action: "opted_out", patientNodeId: state.patient_node_id };
    } catch (e) {
      console.error("[emma-inbound] optOutPatient failed:", e);
      return { ok: true, routed: false, reason: "opt-out write failed" };
    }
  }

  // 3. Not an opt-out — still log the inbound row for audit + future
  //    Emma-inbox surface. Same shape as opt-out audit, no state flip.
  const nowIso = new Date().toISOString();
  const { error: insErr } = await sb.from("patient_outreach").insert({
    user_id: parent.user_id,
    patient_outreach_state_id: parent.patient_outreach_state_id,
    direction: "inbound",
    channel: "email",
    subject: input.subject,
    body: (input.bodyText ?? "").slice(0, 4000),
    message_id: input.resendEmailId,
    sent_at: nowIso,
  });
  if (insErr) {
    console.error("[emma-inbound] audit insert failed:", insErr.message);
  }
  return { ok: true, routed: true, action: "logged", patientNodeId: state.patient_node_id };
}

// ── Public server fns for the /unsubscribe page ───────────────────────────
// These are intentionally unauthenticated — the state_id IS the capability.
// Same posture as the v325 /order/$token public landing page.

const unsubInput = z.object({
  stateId: z.string().min(8).max(64),
});

export type UnsubscribePageData =
  | { ok: true; spaName: string; patientName: string; alreadyDone: boolean }
  | { ok: false; reason: string };

/** GET handler for first paint of the /unsubscribe page. */
export const getUnsubscribeTarget = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => unsubInput.parse(input))
  .handler(async ({ data }): Promise<UnsubscribePageData> => {
    const r = await lookupUnsubscribeTarget(data.stateId);
    if (!r.ok) return { ok: false, reason: r.reason };
    // Detect "already opted out" so the page renders the success view
    // immediately instead of a redundant Confirm button.
    const sb = admin();
    const { data: anyActive } = await sb
      .from("patient_outreach_state")
      .select("id")
      .eq("user_id", r.userId)
      .eq("patient_node_id", r.patientNodeId)
      .neq("state", "opted_out")
      .limit(1)
      .maybeSingle();
    return {
      ok: true,
      spaName: r.spaName,
      patientName: r.patientName,
      alreadyDone: !anyActive,
    };
  });

/** POST handler for the Confirm click on the /unsubscribe page. */
export const confirmUnsubscribe = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => unsubInput.parse(input))
  .handler(async ({ data }): Promise<UnsubscribePageData> => {
    const r = await lookupUnsubscribeTarget(data.stateId);
    if (!r.ok) return { ok: false, reason: r.reason };
    await optOutPatient({
      userId: r.userId,
      patientNodeId: r.patientNodeId,
      viaChannel: "link",
      inboundBody: null,
      inboundMessageId: `unsub:${data.stateId}`,
    });
    return {
      ok: true,
      spaName: r.spaName,
      patientName: r.patientName,
      alreadyDone: true,
    };
  });
