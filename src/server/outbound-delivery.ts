/**
 * outbound-delivery.ts — the zero-setup iMessage queue lane, shared (v2.201.0).
 *
 * Extracted verbatim from emma-rescue.functions.ts (v2.190.0–192.0) so more than
 * one producer can route patient texts through the same proven lane — first the
 * rescue + at-booking flows, now the Deal Desk's promo deploy (allocation). The
 * local helper claims from `outbound_imessage_queue` and sends from the spa's own
 * iMessage — no Twilio, no proxy email, no Claude Desktop.
 *
 * Behavior is unchanged from the rescue-local copies; this is a lift-and-share.
 */

import { admin } from "./admin-client";

type SupabaseAdmin = ReturnType<typeof admin>;

/**
 * The effective outbound mode for a spa. The 'queue' lane is taken ONLY when the
 * relay is set to it AND auto_send is on — the helper claims nothing while
 * auto_send is off (server gate), so queueing without it would silently never
 * send. Anything else → 'email' (the owner-draft lane). Degrades to 'email' on
 * any read failure (migration not applied, no agent row) so the live send path
 * is never broken by this lookup.
 */
export async function resolveDelivery(
  sb: SupabaseAdmin,
  userId: string,
): Promise<{ mode: "queue" | "email"; testRecipients: string[] }> {
  try {
    const { data, error } = await (sb as unknown as { from(t: string): any })
      .from("local_agents")
      .select("delivery_mode, auto_send, test_recipients")
      .eq("user_id", userId)
      .maybeSingle();
    if (error || !data) return { mode: "email", testRecipients: [] };
    const row = data as {
      delivery_mode: string | null;
      auto_send: boolean | null;
      test_recipients: unknown;
    };
    const mode =
      row.delivery_mode === "queue" && row.auto_send === true ? "queue" : "email";
    const testRecipients = Array.isArray(row.test_recipients)
      ? (row.test_recipients as unknown[]).filter(
          (r): r is string => typeof r === "string",
        )
      : [];
    return { mode, testRecipients };
  } catch {
    return { mode: "email", testRecipients: [] };
  }
}

/**
 * The test-recipient gate. An EMPTY allowlist = full live (the queue takes
 * everyone). A NON-EMPTY allowlist = test mode: ONLY those exact (E.164) numbers
 * take the autonomous queue lane; every other patient falls back to the safe
 * lane — so a real client can't get an autonomous text while the spa tests.
 */
export function queueAllows(testRecipients: string[], recipient: string): boolean {
  return testRecipients.length === 0 || testRecipients.includes(recipient);
}

/**
 * Enqueue one patient text for the local helper to send. Idempotent on
 * (user_id, dedup_key): a duplicate enqueue of a still-pending text is treated as
 * success (already queued), not a double-send. Returns true when the text is
 * queued (new or already-present), false only on a real failure.
 */
export async function enqueueOutboundImessage(
  sb: SupabaseAdmin,
  args: {
    userId: string;
    recipient: string;
    body: string;
    source: string;
    dedupKey: string;
    metadata?: Record<string, unknown>;
  },
): Promise<boolean> {
  try {
    const { error } = await (sb as unknown as { from(t: string): any })
      .from("outbound_imessage_queue")
      .insert({
        user_id: args.userId,
        recipient: args.recipient,
        body: args.body,
        source: args.source,
        dedup_key: args.dedupKey,
        metadata: args.metadata ?? {},
      });
    if (error) {
      // 23505 = the dedup unique index fired → an identical text is already
      // pending/claimed. That IS the desired state, so report success.
      if ((error as { code?: string }).code === "23505") return true;
      console.error("[queue enqueue] insert failed:", error);
      return false;
    }
    return true;
  } catch (e) {
    console.error("[queue enqueue] failed:", e);
    return false;
  }
}
