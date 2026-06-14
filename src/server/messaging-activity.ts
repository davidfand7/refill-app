/**
 * messaging-activity.ts — stamp the outbound "messages are going out" heartbeat.
 *
 * The one writer behind the messaging_activity table (see the v2.11.0 migration).
 * Every outbound dispatch path calls recordMessagingActivity after it has
 * actually pushed messages out — the recall dispatch, the rescue dispatch, and
 * (room for) campaign sends. Connection Health's 'delivery' feed reads the
 * freshest beat per channel and unions it with patient_outreach.sent_at, so the
 * iMessage killer-arch channel — which writes no patient_outreach row — finally
 * shows up on the delivery card instead of reading "no text ever sent."
 *
 * BEST-EFFORT BY CONTRACT: this is telemetry, never load-bearing. A failure here
 * must NOT break the dispatch that triggered it (the patient messages already
 * went out; a missed heartbeat just means the health card is momentarily stale).
 * So every call is wrapped — it logs and swallows, never throws.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type MessagingChannel = "sms" | "email";

/**
 * Record that `count` messages just went out on `channel` for this tenant.
 * Upserts the single (user_id, channel) row to the latest beat. `kind` is the
 * engine that produced it ('recall' | 'rescue' | 'campaign' | …) for context.
 *
 * messaging_activity isn't in the generated Supabase types yet, so we use the
 * loose-cast pattern (mirrors reward_ingest_tokens / expected_sources).
 */
export async function recordMessagingActivity(
  sb: SupabaseClient,
  userId: string,
  channel: MessagingChannel,
  kind: string,
  count: number,
): Promise<void> {
  try {
    const nowIso = new Date().toISOString();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tbl = (sb as unknown as { from(t: string): any }).from(
      "messaging_activity",
    );
    const { error } = await tbl.upsert(
      {
        user_id: userId,
        channel,
        last_activity_at: nowIso,
        last_kind: kind,
        last_count: Math.max(0, count),
        updated_at: nowIso,
      },
      { onConflict: "user_id,channel" },
    );
    if (error) throw new Error(error.message);
  } catch (err) {
    // Never let a telemetry miss break a dispatch — the messages already sent.
    console.error(
      `[messaging-activity] heartbeat write failed (non-fatal) for ${kind}/${channel}:`,
      err,
    );
  }
}

// ─── agent_actions ledger (Tier-2 Autonomous · Slice 1) ──────────────────────
//
// The immutable, append-only record of an action an agent took on the spa's
// behalf. Unlike the messaging_activity heartbeat above (one mutable row per
// channel), this writes one IMMUTABLE row PER action — the dispute-proof spine
// under autonomy. Same best-effort contract: a ledger miss must never break the
// dispatch it describes (it logs and swallows, never throws).
//
// agent_actions isn't in the generated Supabase types yet → loose-cast insert
// (mirrors recordMessagingActivity / the skills tables).

export type AgentActionInput = {
  /** Which agent acted: 'rescue' | 'recall_digest' | … */
  agent: string;
  /** What it did: 'sms_sent' | 'digest_emailed' | … */
  action: string;
  channel?: MessagingChannel | "imessage" | null;
  /** Patient-directed actions carry the node; owner-facing ones leave it null. */
  patientNodeId?: string | null;
  count?: number;
  /** The confidence the action fired at, when it had one. */
  confidenceTier?: string | null;
  /** Did the agent act on its own, or did the owner trigger it? */
  initiatedBy?: "autonomous" | "owner";
  metadata?: Record<string, unknown>;
};

export async function recordAgentAction(
  sb: SupabaseClient,
  userId: string,
  input: AgentActionInput,
): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tbl = (sb as unknown as { from(t: string): any }).from(
      "agent_actions",
    );
    const { error } = await tbl.insert({
      user_id: userId,
      agent: input.agent,
      action: input.action,
      channel: input.channel ?? null,
      patient_node_id: input.patientNodeId ?? null,
      count: Math.max(0, input.count ?? 1),
      confidence_tier: input.confidenceTier ?? null,
      initiated_by: input.initiatedBy ?? "autonomous",
      metadata: input.metadata ?? {},
    });
    if (error) throw new Error(error.message);
  } catch (err) {
    console.error(
      `[agent-actions] ledger write failed (non-fatal) for ${input.agent}/${input.action}:`,
      err,
    );
  }
}
