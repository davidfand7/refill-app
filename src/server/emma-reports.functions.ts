/**
 * Emma(OS) Promotions Engine — Phase 9 reporting (v357).
 *
 * Single aggregator over patient_outreach_state + patient_outreach that
 * builds a per-campaign funnel plus a spa-wide total. The shape mirrors
 * how a med-spa owner reads marketing performance: how many got the
 * message, how many opened it, how many booked, how much revenue did
 * we get back. No deep slicing in v1 — just the canonical funnel +
 * a campaign table.
 *
 * Funnel stages (top to bottom of the actual narrowing):
 *   1. Targeted   — every row in patient_outreach_state, all states.
 *                    Includes 'targeted', 'scheduled', and everything past.
 *                    The "you tried to reach this patient" count.
 *   2. Sent       — outbound patient_outreach rows with sent_at populated.
 *                    Distinct by state row (a patient might receive multiple
 *                    messages in a campaign; one Sent count per patient).
 *   3. Skipped    — outbound patient_outreach rows with skip_reason set.
 *                    Broken down by reason in the table (quiet_hours,
 *                    velocity_cap, opted_out, banned, no_channel, etc.).
 *   4. Opened     — outbound email rows with opened_at populated. Email
 *                    only — SMS has no equivalent signal; SMS engagement
 *                    = the reply or the booking click.
 *   5. Clicked    — inbound rows with channel='link' (v354's tracked-link
 *                    redirect events). One per click; for funnel purposes
 *                    we de-dup by state row (one Clicked count per patient).
 *   6. Booked     — state in ('booked','showed','closed_won').
 *   7. Showed     — state in ('showed','closed_won').
 *   8. Won        — state = 'closed_won', sum attributed_revenue_usd.
 *
 * Rates the UI typically wants:
 *   open_rate  = opened / sent_email
 *   click_rate = clicked / opened
 *   book_rate  = booked / sent
 *   show_rate  = showed / booked
 *   conv_rate  = won / sent
 *
 * Aggregation strategy: pull all rows for the spa once (campaigns +
 * state + outreach), aggregate in memory. At spa scale (typical
 * upper bound: ~50 campaigns × 500 patients × ~3 messages = 75k rows)
 * this is comfortable in a single round-trip. If a spa ever crosses
 * 500k rows we'll move to SQL aggregation via an RPC; not v1's problem.
 *
 * Established 2026-05-16 (Promotions Engine v357).
 */

import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { resolveEffectiveUserId, verifyAuth } from "@/server/auth-helpers";
import { fetchAllRows } from "@/server/paginate";

// ─── Public types exported to UI ──────────────────────────────────────────

export type CampaignFunnel = {
  campaignId: string;
  title: string;
  /** Newest activity timestamp for sorting; null if no state rows yet. */
  lastActivityAt: string | null;
  targeted: number;
  scheduled: number;
  sent: number;
  /** Email-only subset of sent. Open rate uses this as denominator. */
  sentEmail: number;
  /** SMS subset of sent. Informational, no open signal. */
  sentSms: number;
  skipped: number;
  skipReasons: Record<string, number>;
  opened: number;
  clicked: number;
  replied: number;
  booked: number;
  showed: number;
  won: number;
  optedOut: number;
  revenueUsd: number;
};

export type EmmaReports = {
  /** Per-campaign rows ordered by lastActivityAt desc. */
  campaigns: CampaignFunnel[];
  /** Spa-wide totals across every campaign. Same shape minus title/id. */
  totals: Omit<CampaignFunnel, "campaignId" | "title" | "lastActivityAt">;
  /** ISO timestamp for "last updated X seconds ago" in the UI. */
  generatedAt: string;
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

// ─── Zod ──────────────────────────────────────────────────────────────────

const input = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
});

// ─── Helpers ──────────────────────────────────────────────────────────────

function emptyFunnel(): Omit<CampaignFunnel, "campaignId" | "title" | "lastActivityAt"> {
  return {
    targeted: 0,
    scheduled: 0,
    sent: 0,
    sentEmail: 0,
    sentSms: 0,
    skipped: 0,
    skipReasons: {},
    opened: 0,
    clicked: 0,
    replied: 0,
    booked: 0,
    showed: 0,
    won: 0,
    optedOut: 0,
    revenueUsd: 0,
  };
}

// ─── getEmmaReports ───────────────────────────────────────────────────────

export const getEmmaReports = createServerFn({ method: "POST" })
  .inputValidator((input_: unknown) => input.parse(input_))
  .handler(async ({ data }): Promise<EmmaReports> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();

    // 1) Campaigns (id + title)
    const { data: campaignRows, error: cErr } = await sb
      .from("knowledge_nodes")
      .select("id, title")
      .eq("user_id", effectiveUserId)
      .eq("node_type", "campaign")
      .eq("context", "campaigns");
    if (cErr) throw new Error(`Couldn't load campaigns: ${cErr.message}`);

    const campaignsById = new Map<string, { title: string }>();
    for (const c of campaignRows ?? []) {
      campaignsById.set(c.id, { title: c.title });
    }

    // 2) All state rows for this spa. We pull every state across every
    //    campaign in one read — at spa scale this is small (tens of
    //    thousands at most) and lets us aggregate in JS without a
    //    per-campaign roundtrip.
    // v1.92.0: page past PostgREST's 1,000-row cap. At "tens of thousands"
    // of state/outreach rows the funnel was being summed over a 1,000-row
    // slice and shown to the owner as complete.
    const stateRows = await fetchAllRows<{
      id: string;
      campaign_node_id: string;
      state: string;
      scheduled_at: string | null;
      last_touched_at: string | null;
      booking_confirmed_at: string | null;
      showed_at: string | null;
      attributed_revenue_usd: number | null;
      updated_at: string;
    }>((from, to) =>
      sb
        .from("patient_outreach_state")
        .select(
          "id, campaign_node_id, state, scheduled_at, last_touched_at, booking_confirmed_at, showed_at, attributed_revenue_usd, updated_at",
        )
        .eq("user_id", effectiveUserId)
        .order("id", { ascending: true })
        .range(from, to),
    );

    // 3) All outreach rows for this spa. Same paginated read pattern.
    const outreachRows = await fetchAllRows<{
      patient_outreach_state_id: string;
      direction: string;
      channel: string;
      sent_at: string | null;
      opened_at: string | null;
      replied_at: string | null;
      skip_reason: string | null;
    }>((from, to) =>
      sb
        .from("patient_outreach")
        .select(
          "patient_outreach_state_id, direction, channel, sent_at, opened_at, replied_at, skip_reason",
        )
        .eq("user_id", effectiveUserId)
        .order("id", { ascending: true })
        .range(from, to),
    );

    // 4) Build a map: campaignId → funnel accumulator. We also accumulate
    //    a `totals` row in parallel so we only iterate each row once.
    const funnels = new Map<string, CampaignFunnel>();
    const totals = emptyFunnel();
    let latestActivityAll: string | null = null;

    function ensureFunnel(campaignId: string): CampaignFunnel {
      let f = funnels.get(campaignId);
      if (!f) {
        const c = campaignsById.get(campaignId);
        f = {
          campaignId,
          title: c?.title ?? "(deleted campaign)",
          lastActivityAt: null,
          ...emptyFunnel(),
        };
        funnels.set(campaignId, f);
      }
      return f;
    }

    // 4a) State-row aggregation. We track which state rows are "sent-or-past"
    //     so the outreach pass can compute distinct-by-state counts.
    //     Also build a stateId → campaignId index for the outreach loop.
    const stateIdToCampaign = new Map<string, string>();
    for (const s of stateRows ?? []) {
      stateIdToCampaign.set(s.id, s.campaign_node_id);
      const f = ensureFunnel(s.campaign_node_id);

      // Targeted = every state row (any state). State='opted_out' patients
      // who never reached 'outreached' still count as "we tried to reach
      // them but they had pre-existing opt-out" — kept in targeted for
      // total-attempts denominator. The opted_out column tracks them
      // separately for the explicit opt-out rate.
      f.targeted++;
      totals.targeted++;

      if (s.state === "scheduled") {
        f.scheduled++;
        totals.scheduled++;
      }
      if (s.state === "opted_out") {
        f.optedOut++;
        totals.optedOut++;
      }
      // Booking funnel — these are state-machine signals, not message-event
      // signals. closed_won implies showed implies booked, so the inner
      // states (showed/closed_won) get counted at every level they sit at.
      if (
        s.state === "booked" ||
        s.state === "showed" ||
        s.state === "closed_won"
      ) {
        f.booked++;
        totals.booked++;
      }
      if (s.state === "showed" || s.state === "closed_won") {
        f.showed++;
        totals.showed++;
      }
      if (s.state === "closed_won") {
        f.won++;
        totals.won++;
        if (s.attributed_revenue_usd) {
          f.revenueUsd += Number(s.attributed_revenue_usd);
          totals.revenueUsd += Number(s.attributed_revenue_usd);
        }
      }

      // Track latest activity for sort + freshness indicator.
      const activity =
        s.last_touched_at ?? s.updated_at ?? s.booking_confirmed_at ?? null;
      if (activity) {
        if (!f.lastActivityAt || activity > f.lastActivityAt) {
          f.lastActivityAt = activity;
        }
        if (!latestActivityAll || activity > latestActivityAll) {
          latestActivityAll = activity;
        }
      }
    }

    // 4b) Outreach-row aggregation. Distinct-by-state counts use a Set
    //     so a patient who received 3 messages on one campaign only
    //     contributes 1 to the Sent column.
    const sentStateIds = new Map<string, Set<string>>(); // campaignId → set of stateIds
    const sentEmailStateIds = new Map<string, Set<string>>();
    const sentSmsStateIds = new Map<string, Set<string>>();
    const openedStateIds = new Map<string, Set<string>>();
    const clickedStateIds = new Map<string, Set<string>>();
    const repliedStateIds = new Map<string, Set<string>>();

    function bump(
      map: Map<string, Set<string>>,
      campaignId: string,
      stateId: string,
    ) {
      let s = map.get(campaignId);
      if (!s) {
        s = new Set();
        map.set(campaignId, s);
      }
      s.add(stateId);
    }

    for (const o of outreachRows ?? []) {
      const campaignId = stateIdToCampaign.get(o.patient_outreach_state_id);
      if (!campaignId) continue; // Orphan — state row was deleted; skip.
      const f = ensureFunnel(campaignId);

      if (o.direction === "outbound") {
        if (o.sent_at) {
          bump(sentStateIds, campaignId, o.patient_outreach_state_id);
          if (o.channel === "email") {
            bump(sentEmailStateIds, campaignId, o.patient_outreach_state_id);
          } else if (o.channel === "sms") {
            bump(sentSmsStateIds, campaignId, o.patient_outreach_state_id);
          }
        }
        if (o.skip_reason) {
          f.skipped++;
          totals.skipped++;
          f.skipReasons[o.skip_reason] =
            (f.skipReasons[o.skip_reason] ?? 0) + 1;
          totals.skipReasons[o.skip_reason] =
            (totals.skipReasons[o.skip_reason] ?? 0) + 1;
        }
        if (o.opened_at) {
          bump(openedStateIds, campaignId, o.patient_outreach_state_id);
        }
        if (o.replied_at) {
          bump(repliedStateIds, campaignId, o.patient_outreach_state_id);
        }
      } else if (o.direction === "inbound" && o.channel === "link") {
        // v354 tracked-link click event.
        bump(clickedStateIds, campaignId, o.patient_outreach_state_id);
      }
    }

    // 4c) Fold the distinct-state-id sets back into per-campaign counts.
    for (const [campaignId, f] of funnels) {
      const s = sentStateIds.get(campaignId)?.size ?? 0;
      const se = sentEmailStateIds.get(campaignId)?.size ?? 0;
      const ss = sentSmsStateIds.get(campaignId)?.size ?? 0;
      const op = openedStateIds.get(campaignId)?.size ?? 0;
      const cl = clickedStateIds.get(campaignId)?.size ?? 0;
      const re = repliedStateIds.get(campaignId)?.size ?? 0;
      f.sent = s;
      f.sentEmail = se;
      f.sentSms = ss;
      f.opened = op;
      f.clicked = cl;
      f.replied = re;
      totals.sent += s;
      totals.sentEmail += se;
      totals.sentSms += ss;
      totals.opened += op;
      totals.clicked += cl;
      totals.replied += re;
    }

    // 5) Sort campaigns by lastActivityAt desc (most recent activity first).
    //    Campaigns with no activity (lastActivityAt=null) fall to the bottom.
    const campaigns = Array.from(funnels.values()).sort((a, b) => {
      if (!a.lastActivityAt && !b.lastActivityAt) return 0;
      if (!a.lastActivityAt) return 1;
      if (!b.lastActivityAt) return -1;
      return b.lastActivityAt.localeCompare(a.lastActivityAt);
    });

    return {
      campaigns,
      totals,
      generatedAt: new Date().toISOString(),
    };
  });
