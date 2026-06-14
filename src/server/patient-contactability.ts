/**
 * patient-contactability.ts — the ONE definition of "may we contact this patient?"
 *
 * A patient is off-limits to ALL outbound agents if they're `banned` (the spa
 * removed them) or `opted_out` (they said stop, or the spa flagged them). Those
 * two booleans live on knowledge_nodes.attachments. Before this module the check
 * was duplicated inline across preshow / rescue / waitlist-invite and — the bug
 * this centralization fixes — MISSING entirely from recall, and PARTIAL in blast
 * (which read an opted_out STATE row but not the attachments.opted_out flag, so a
 * spa-flagged opt-out with no STOP reply slipped through).
 *
 * One rule, one place: a patient who opted out never gets messaged by any agent.
 *
 * attachments isn't strongly typed (knowledge_nodes.attachments is Json), so the
 * pure reader takes `unknown` and narrows defensively.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type OptOutStatus = {
  /** True if this patient must NOT be contacted (banned OR opted out). */
  blocked: boolean;
  banned: boolean;
  optedOut: boolean;
  /** Why they're blocked, for a skip reason / audit. */
  reason: "banned" | "opted_out" | null;
};

/**
 * Read opt-out status off an already-loaded knowledge_nodes.attachments blob.
 * Pure — no query. The canonical decision every send path should make.
 */
export function patientOptOutStatus(attachments: unknown): OptOutStatus {
  const a = (attachments ?? null) as {
    banned?: boolean;
    opted_out?: boolean;
  } | null;
  const banned = a?.banned === true;
  const optedOut = a?.opted_out === true;
  return {
    blocked: banned || optedOut,
    banned,
    optedOut,
    reason: banned ? "banned" : optedOut ? "opted_out" : null,
  };
}

/**
 * Batch variant for list-building paths (e.g. recall) that need to drop blocked
 * patients from a candidate set at the source. Chunked .in() read (300/chunk to
 * stay under the PostgREST 1,000-row cap), returns the set of BLOCKED node ids.
 * Fails open per id only on a read error (logs); never throws.
 */
export async function loadBlockedNodeIds(
  sb: SupabaseClient,
  userId: string,
  nodeIds: Array<string | null | undefined>,
): Promise<Set<string>> {
  const blocked = new Set<string>();
  const distinct = Array.from(
    new Set(nodeIds.filter((x): x is string => !!x)),
  );
  const CHUNK = 300;
  for (let i = 0; i < distinct.length; i += CHUNK) {
    const slice = distinct.slice(i, i + CHUNK);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (sb as unknown as { from(t: string): any })
        .from("knowledge_nodes")
        .select("id, attachments")
        .eq("user_id", userId)
        .in("id", slice);
      if (error) throw new Error(error.message);
      for (const n of (data ?? []) as Array<{ id: string; attachments: unknown }>) {
        if (patientOptOutStatus(n.attachments).blocked) blocked.add(n.id);
      }
    } catch (err) {
      console.error("[contactability] blocked-ids read failed (chunk skipped):", err);
    }
  }
  return blocked;
}
