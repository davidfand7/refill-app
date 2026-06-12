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
