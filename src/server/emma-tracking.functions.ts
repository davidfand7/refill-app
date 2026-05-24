/**
 * Emma(OS) email engagement tracking (v354).
 *
 * Two webhook-driven recorders, both keyed by the Resend email_id we
 * stored as patient_outreach.message_id on outbound send:
 *
 *   - recordEmailOpen(emailId)  → stamps opened_at on the outbound row
 *     when the patient_outreach row exists AND opened_at is null. First
 *     open wins; subsequent opens are no-ops (Resend can fire repeat
 *     events for the same email over time as images get re-fetched).
 *
 *   - recordEmailClick(emailId, link) → writes an INBOUND audit row to
 *     patient_outreach with channel='link' and the clicked URL in the
 *     body. Each click is its own row — multiple clicks over time
 *     accumulate as a stream the future Phase 9 reporting (and the
 *     Phase 6 Emma inbox) can aggregate per-patient and per-campaign.
 *
 * Why per-event rows for clicks (vs a single "first click" stamp):
 * the clicked URL is the meaningful payload, not the timestamp alone.
 * A click on the Book CTA is different from a click on the unsubscribe
 * link is different from a click on a verified-chip link if/when we
 * add one. Phase 9 reporting will want to slice on link target.
 *
 * Idempotency on the open path is enforced via the "opened_at IS NULL"
 * predicate, race-safe per Postgres' write semantics. The click path
 * is naturally additive (every event is a new row) so no de-dup
 * needed at the storage layer; reporting can group by message_id +
 * link to dedupe in queries if a rapid-fire double-click would
 * mislead the metric.
 */

import { createClient } from "@supabase/supabase-js";
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

export type TrackingResult =
  | { ok: true; matched: true; action: "opened" | "clicked" | "ignored_duplicate" }
  | { ok: true; matched: false; reason: string }
  | { ok: false; reason: string };

export async function recordEmailOpen(emailId: string): Promise<TrackingResult> {
  if (!emailId) return { ok: false, reason: "missing emailId" };
  const sb = admin();
  const nowIso = new Date().toISOString();

  // Look up the outbound row first so we can scope the update + know
  // whether to short-circuit on already-stamped. We also need user_id
  // for the eventual reporting query path.
  const { data: row, error: lookupErr } = await sb
    .from("patient_outreach")
    .select("id, opened_at")
    .eq("message_id", emailId)
    .eq("direction", "outbound")
    .eq("channel", "email")
    .maybeSingle();
  if (lookupErr) {
    return { ok: false, reason: `lookup error: ${lookupErr.message}` };
  }
  if (!row) {
    return { ok: true, matched: false, reason: "no Emma patient_outreach for email_id" };
  }
  if (row.opened_at) {
    return { ok: true, matched: true, action: "ignored_duplicate" };
  }

  const { error: updErr } = await sb
    .from("patient_outreach")
    .update({ opened_at: nowIso })
    .eq("id", row.id)
    .is("opened_at", null); // Race-safe — first event wins.
  if (updErr) {
    return { ok: false, reason: `update error: ${updErr.message}` };
  }
  return { ok: true, matched: true, action: "opened" };
}

export async function recordEmailClick(
  emailId: string,
  link: string | null,
): Promise<TrackingResult> {
  if (!emailId) return { ok: false, reason: "missing emailId" };
  const sb = admin();
  const nowIso = new Date().toISOString();

  // Resolve the outbound row to get user_id + state row we should
  // attach the click audit to.
  const { data: row, error: lookupErr } = await sb
    .from("patient_outreach")
    .select("id, user_id, patient_outreach_state_id")
    .eq("message_id", emailId)
    .eq("direction", "outbound")
    .eq("channel", "email")
    .maybeSingle();
  if (lookupErr) {
    return { ok: false, reason: `lookup error: ${lookupErr.message}` };
  }
  if (!row) {
    return { ok: true, matched: false, reason: "no Emma patient_outreach for email_id" };
  }

  // Insert one audit row per click. Body captures the clicked URL
  // so Phase 9 reporting can slice on it. Subject is short for
  // Emma-inbox preview surfaces (Phase 6).
  const cleanLink = (link ?? "").slice(0, 1000);
  const { error: insErr } = await sb.from("patient_outreach").insert({
    user_id: row.user_id,
    patient_outreach_state_id: row.patient_outreach_state_id,
    direction: "inbound",
    channel: "link",
    subject: "Click",
    body: cleanLink ? `Clicked: ${cleanLink}` : "Clicked (no URL reported)",
    message_id: emailId,
    sent_at: nowIso,
  });
  if (insErr) {
    return { ok: false, reason: `insert error: ${insErr.message}` };
  }

  // Best-effort: also stamp the parent outbound row's opened_at if
  // it's still null — a click implies an open, and some email clients
  // (Gmail with image-loading off) report clicks without opens.
  await sb
    .from("patient_outreach")
    .update({ opened_at: nowIso })
    .eq("id", row.id)
    .is("opened_at", null);

  return { ok: true, matched: true, action: "clicked" };
}
