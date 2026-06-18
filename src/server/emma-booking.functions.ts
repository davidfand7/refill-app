/**
 * Emma(OS) Phase 4 — booking landing page (v353).
 *
 * Two public server fns (token = capability, same pattern as the v325
 * /order page and the v351 /unsubscribe page):
 *
 *   - getBookingTarget({ token }) — first paint of /book?b=<token>.
 *     Resolves the booking_intent_token → state row → patient + campaign
 *     + spa name + offer headline. Returns alreadyBooked=true when the
 *     row's booking_confirmed_at is already populated (idempotent re-visit
 *     shows the success state immediately).
 *
 *   - submitBookingRequest({ token, preferredDate, preferredTime, ... })
 *     — runs on form submit. Sets booking_confirmed_at, advances state
 *     to 'booked', writes an inbound patient_outreach audit row carrying
 *     the form data so the spa owner sees WHEN + HOW the patient wants
 *     to come in (channel='link' since this is a link-click capture,
 *     not SMS/email — matches the v351 /unsubscribe convention).
 *
 * Plus the send-time helper ensureBookingToken(stateId) which v350's
 * sendCampaignMessage now calls to provision a token before composing,
 * so the body can embed the booking URL alongside the unsubscribe URL.
 * Lazy generation keeps existing un-sent state rows unaffected.
 *
 * Scope note: v353 is REQUEST-A-TIME, not full calendar booking. The
 * patient submits their preferred date + time-of-day + a note; the
 * spa owner sees it in the inbound patient_outreach feed (future Emma
 * inbox surface, Phase 6) and confirms via their normal booking system
 * (Boulevard/Vagaro/AestheticsRecord). Integrating those vendors'
 * calendar APIs is deferred until a specific spa asks.
 */

import { admin } from "./admin-client";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { CampaignAttachments, CampaignOffer } from "@/lib/campaign-templates";
import { getSpaName } from "@/server/emma-optout.functions";

export const BOOKING_PAGE_BASE_URL =
  process.env.EMMA_BOOKING_BASE_URL ?? "https://emma.agentiport.com";

/**
 * Generate-on-demand booking token for a patient_outreach_state row.
 * Idempotent: returns the existing token if already set, otherwise
 * writes a new UUID and returns it. Called by v350's send loop before
 * composing the email/SMS body so the URL can be embedded.
 */
export async function ensureBookingToken(stateId: string): Promise<string | null> {
  const sb = admin();
  const { data: row, error } = await sb
    .from("patient_outreach_state")
    .select("id, booking_intent_token")
    .eq("id", stateId)
    .maybeSingle();
  if (error || !row) return null;
  if (row.booking_intent_token) return row.booking_intent_token;

  const token = crypto.randomUUID();
  const { error: updErr } = await sb
    .from("patient_outreach_state")
    .update({ booking_intent_token: token, updated_at: new Date().toISOString() })
    .eq("id", stateId);
  if (updErr) {
    console.error("[emma-booking] ensureBookingToken update failed:", updErr.message);
    return null;
  }
  return token;
}

/** Build the public booking URL for a token. */
export function bookingUrlFor(token: string): string {
  return `${BOOKING_PAGE_BASE_URL}/book?b=${token}`;
}

// ── Public page data fetching ──────────────────────────────────────────────

const tokenInput = z.object({
  token: z.string().min(8).max(64),
});

export type BookingPageData =
  | {
      ok: true;
      spaName: string;
      patientFirstName: string;
      campaignTitle: string;
      offerHeadline: string | null;
      offerLineItems: string[];
      alreadyBooked: boolean;
      bookedAt: string | null;
    }
  | { ok: false; reason: string };

async function resolveTokenInternal(token: string) {
  const sb = admin();
  const { data: state, error } = await sb
    .from("patient_outreach_state")
    .select(
      "id, user_id, campaign_node_id, patient_node_id, booking_confirmed_at, state, channel",
    )
    .eq("booking_intent_token", token)
    .maybeSingle();
  if (error) {
    return { ok: false as const, reason: `Lookup error: ${error.message}` };
  }
  if (!state) {
    return { ok: false as const, reason: "Booking link not recognized." };
  }
  return { ok: true as const, state };
}

function formatOfferLineItems(offer: CampaignOffer | undefined): string[] {
  if (!offer) return [];
  const out: string[] = [];
  if (offer.discountPct) out.push(`${offer.discountPct}% off`);
  if (offer.flatAmountUsd) out.push(`$${offer.flatAmountUsd} off`);
  if (offer.freeUnits) {
    out.push(`${offer.freeUnits} complimentary unit${offer.freeUnits === 1 ? "" : "s"}`);
  }
  return out;
}

function extractFirstName(title: string | null | undefined): string {
  if (!title) return "there";
  // Patient titles are typically "Last, First" from the QB ingestion.
  const lastFirst = title.split(",");
  if (lastFirst.length === 2) {
    const first = lastFirst[1].trim();
    return first || "there";
  }
  // Fallback: first whitespace-delimited token.
  return title.trim().split(/\s+/)[0] ?? "there";
}

export const getBookingTarget = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => tokenInput.parse(input))
  .handler(async ({ data }): Promise<BookingPageData> => {
    const r = await resolveTokenInternal(data.token);
    if (!r.ok) return { ok: false, reason: r.reason };
    const sb = admin();

    const [{ data: patient }, { data: campaign }, spaName] = await Promise.all([
      sb.from("knowledge_nodes").select("title").eq("id", r.state.patient_node_id).maybeSingle(),
      sb
        .from("knowledge_nodes")
        .select("title, attachments")
        .eq("id", r.state.campaign_node_id)
        .maybeSingle(),
      getSpaName(r.state.user_id),
    ]);

    const att = (campaign?.attachments ?? null) as CampaignAttachments | null;
    return {
      ok: true,
      spaName,
      patientFirstName: extractFirstName(patient?.title),
      campaignTitle: campaign?.title ?? "your appointment",
      offerHeadline: att?.offer?.headline ?? null,
      offerLineItems: formatOfferLineItems(att?.offer),
      alreadyBooked: !!r.state.booking_confirmed_at,
      bookedAt: r.state.booking_confirmed_at,
    };
  });

// ── Submit handler ─────────────────────────────────────────────────────────

const PREFERRED_TIMES = ["morning", "afternoon", "evening", "flexible"] as const;
const CONTACT_PREFS = ["phone", "text", "email"] as const;

const submitInput = z.object({
  token: z.string().min(8).max(64),
  preferredDate: z.string().min(1).max(40),
  preferredTime: z.enum(PREFERRED_TIMES),
  contactPref: z.enum(CONTACT_PREFS),
  note: z.string().max(800).optional().default(""),
});

export type BookingSubmitResult =
  | { ok: true; spaName: string; alreadyBookedBefore: boolean }
  | { ok: false; reason: string };

export const submitBookingRequest = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => submitInput.parse(input))
  .handler(async ({ data }): Promise<BookingSubmitResult> => {
    const r = await resolveTokenInternal(data.token);
    if (!r.ok) return { ok: false, reason: r.reason };

    const sb = admin();
    const nowIso = new Date().toISOString();
    const wasAlreadyBooked = !!r.state.booking_confirmed_at;

    // 1. Stamp the booking on the state row (idempotent — first stamp
    //    wins; re-submits don't overwrite).
    if (!wasAlreadyBooked) {
      const { error: updErr } = await sb
        .from("patient_outreach_state")
        .update({
          state: "booked",
          booking_confirmed_at: nowIso,
          updated_at: nowIso,
        })
        .eq("id", r.state.id)
        .is("booking_confirmed_at", null); // Race-safe — first writer wins.
      if (updErr) {
        return { ok: false, reason: `Booking save failed: ${updErr.message}` };
      }
    }

    // 2. Audit row in patient_outreach. Subject summarizes for the
    //    future Emma inbox surface; body carries the structured form
    //    data so the spa owner can act on it.
    const formattedDate = data.preferredDate.trim();
    const subject = `Booking request — ${formattedDate} · ${data.preferredTime}`;
    const bodyLines = [
      `Preferred date: ${formattedDate}`,
      `Preferred time: ${data.preferredTime}`,
      `Best contact method: ${data.contactPref}`,
      data.note?.trim() ? `\nNote from patient:\n${data.note.trim()}` : "",
    ].filter(Boolean);
    const body = bodyLines.join("\n");

    const { error: insErr } = await sb.from("patient_outreach").insert({
      user_id: r.state.user_id,
      patient_outreach_state_id: r.state.id,
      direction: "inbound",
      channel: "link",
      subject,
      body,
      message_id: `book:${data.token}`,
      sent_at: nowIso,
    });
    if (insErr) {
      // The state advance already happened; the audit failure is
      // non-fatal. Surface in logs so a future cron can backfill if
      // needed.
      console.error("[emma-booking] audit insert failed:", insErr.message);
    }

    const spaName = await getSpaName(r.state.user_id);
    return {
      ok: true,
      spaName,
      alreadyBookedBefore: wasAlreadyBooked,
    };
  });
