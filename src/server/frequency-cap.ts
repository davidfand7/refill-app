/**
 * frequency-cap.ts — the cross-agent frequency cap (Tier-2 Autonomous · Slice 2).
 *
 * One pre-send check the autonomous outreach path calls before it texts a
 * patient: "has ANY agent already contacted this patient on this channel within
 * the window?" It reads the agent_actions ledger (Slice 1) through the
 * per-patient index `agent_actions_patient`. The point: no patient gets texted
 * twice in a day across rescue + preshow — even though those are different
 * engines that don't know about each other. The ledger is the shared memory;
 * this is the gate over it.
 *
 * THE POLICY (an honest asymmetry, not a uniform mute):
 *  - Every patient-directed send WRITES a per-patient '<chan>_sent' row → the
 *    shared tally. Both rescue direct-mode and preshow do this.
 *  - Only AUTONOMOUS OUTREACH reads the cap and YIELDS — that's rescue
 *    direct-mode (the one truly-autonomous patient send today). A transactional
 *    appointment reminder (preshow) contributes to the tally but is never
 *    auto-suppressed: we never silence a reminder for an appointment the patient
 *    actually has. The cap exists to stop redundant "a slot opened / come back"
 *    blasts from stacking, not to drop the reminders that reduce no-shows.
 *
 * FAILS OPEN: a ledger read error returns "not recently contacted" — a missed
 * cap (a rare double-text) is less harmful than blocking a legitimate send on a
 * telemetry hiccup. Same best-effort spirit as messaging-activity / the ledger.
 *
 * agent_actions isn't in the generated Supabase types yet → loose-cast read
 * (mirrors recordAgentAction).
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Default lookback window. Just under a full day so a genuine once-a-day cadence
 * isn't blocked by an exactly-24h boundary, while "twice in a day" is still
 * caught. Override per-call if a path wants a tighter/looser window.
 */
export const FREQUENCY_CAP_WINDOW_HOURS = 20;

export type RecentContact = {
  /** True if a '<channel>_sent' action was logged for this patient in-window. */
  recentlyContacted: boolean;
  /** ISO timestamp of the most recent in-window send, or null. */
  lastAt: string | null;
  /** Which agent made that contact ('rescue' | 'preshow' | …), or null. */
  lastAgent: string | null;
  /** The action of that contact ('sms_sent' | 'email_sent' | …), or null. */
  lastAction: string | null;
};

const NOT_CONTACTED: RecentContact = {
  recentlyContacted: false,
  lastAt: null,
  lastAgent: null,
  lastAction: null,
};

/**
 * Has this patient already been contacted on `channel` by ANY agent within the
 * window? Reads the agent_actions ledger; counts only '..._sent' actions (never
 * suppressions or owner-facing rows). Fails open (returns NOT_CONTACTED) so a
 * read error never blocks a send.
 */
export async function checkRecentContact(
  sb: SupabaseClient,
  userId: string,
  patientNodeId: string,
  channel: "sms" | "email" | "imessage",
  windowHours: number = FREQUENCY_CAP_WINDOW_HOURS,
): Promise<RecentContact> {
  try {
    const sinceIso = new Date(
      Date.now() - windowHours * 60 * 60 * 1000,
    ).toISOString();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tbl = (sb as unknown as { from(t: string): any }).from(
      "agent_actions",
    );
    const { data, error } = await tbl
      .select("agent, action, channel, created_at")
      .eq("user_id", userId)
      .eq("patient_node_id", patientNodeId)
      .eq("channel", channel)
      .like("action", "%_sent")
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) throw new Error(error.message);
    const row = (data ?? [])[0] as
      | { agent: string; action: string; created_at: string }
      | undefined;
    if (!row) return NOT_CONTACTED;
    return {
      recentlyContacted: true,
      lastAt: row.created_at,
      lastAgent: row.agent,
      lastAction: row.action,
    };
  } catch (err) {
    // Fail open — never block a send because the cap read hiccuped.
    console.error(
      `[frequency-cap] read failed (failing open) for patient ${patientNodeId}/${channel}:`,
      err,
    );
    return NOT_CONTACTED;
  }
}
