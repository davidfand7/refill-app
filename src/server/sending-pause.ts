/**
 * sending-pause.ts — the honest-pause kill switch (Tier-2 Autonomous · Slice 3).
 *
 * One per-tenant master switch (`noshow_policies.sending_paused`) that
 * halts ALL automated sending. Every agent that dispatches on the spa's behalf
 * polls it at its dispatch entry and bails before anything goes out:
 *   - rescue auto-text          (reads the already-loaded policy row)
 *   - pre-show reminder cron     (reads the already-loaded policy row)
 *   - weekly recall digest cron  (no policy loaded → isSendingPaused query)
 *
 * It sits ABOVE every per-engine enable: a paused spa sends nothing even if
 * rescue_enabled / preshow_enabled / recall_digest_enabled are all on. Resuming
 * is the only way to start sends again — the switch is the one brake the owner
 * (or we, on her behalf) can always reach.
 *
 * sending_paused isn't in the generated Supabase types yet → loose-cast reads
 * (same posture as the skills / recall_digest_* columns).
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/** The skip/refusal reason every guarded path returns when sending is paused. */
export const SENDING_PAUSED_REASON = "sending_paused";

/**
 * Read the pause flag off an noshow_policies row the caller already loaded
 * (rescue + preshow both hold the row). Pure — no query. Treats a missing
 * column / null as NOT paused (fail-open: a schema hiccup never silently halts
 * a spa's sends).
 */
export function sendingPausedFromRow(policyRow: unknown): boolean {
  if (!policyRow || typeof policyRow !== "object") return false;
  return (policyRow as { sending_paused?: boolean }).sending_paused === true;
}

/**
 * Query the pause flag for a tenant that hasn't loaded the policy row (the
 * recall-digest cron). Fails open — a read error returns false so a telemetry
 * hiccup can't silently mute a spa.
 */
export async function isSendingPaused(
  sb: SupabaseClient,
  userId: string,
): Promise<boolean> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tbl = (sb as unknown as { from(t: string): any }).from(
      "noshow_policies",
    );
    const { data, error } = await tbl
      .select("sending_paused")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data?.sending_paused === true;
  } catch (err) {
    console.error(
      `[sending-pause] read failed (failing open) for ${userId}:`,
      err,
    );
    return false;
  }
}
