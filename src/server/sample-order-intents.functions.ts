/**
 * Sample-order intents — public landing-page server fns (v325).
 *
 * Backs the public Order NOW landing page. Three operations:
 *   - getOrderIntent(token)         → fetch the frozen snapshot + state
 *   - recordOrderIntentView(token)  → increment view tracking on page-load
 *   - confirmOrderIntent(token, …)  → "Confirm & forward to Galderma" CTA
 *
 * All three are PUBLIC by design — the practice owner has no auth session.
 * The token IS the capability; the table is locked behind service-role RLS
 * so no other endpoint can leak intent data. The token is 32 random bytes
 * (~256 bits of entropy, base64url-encoded ~43 chars) — unguessable.
 *
 * Confirmation is idempotent: re-clicking "Confirm" never overwrites the
 * first confirmed_at timestamp, so the rep sees "when they first said yes,"
 * not "when they last clicked." A revoked intent (revoked_at set) is
 * surfaced to the practice owner as a friendly "this offer is no longer
 * current — please reach out to your rep" message rather than a 404 wall.
 */

import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database, Json } from "@/integrations/supabase/types";
import type { LizSampleOrder } from "@/server/liz-chat.functions";
import { verifyAuth, accessTokenInput } from "@/server/auth-helpers";
import { resolveEffectiveUserId, type ViewAs } from "@/server/demo-user";

export type SampleOrderIntentState =
  | "active"
  | "viewed"
  | "confirmed"
  | "revoked";

export type SampleOrderIntentPublic = {
  token: string;
  state: SampleOrderIntentState;
  practice: { email: string };
  rep: { name: string; email: string | null };
  order: LizSampleOrder;
  sentAt: string;
  firstViewedAt: string | null;
  lastViewedAt: string | null;
  confirmedAt: string | null;
  confirmedByName: string | null;
  revokedAt: string | null;
};

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

const tokenInput = z.object({
  token: z.string().min(16).max(128),
});

function rowToPublic(row: {
  token: string;
  practice_email: string;
  rep_name: string;
  rep_email: string | null;
  order_snapshot: Json;
  sent_at: string;
  first_viewed_at: string | null;
  last_viewed_at: string | null;
  confirmed_at: string | null;
  confirmed_by_name: string | null;
  revoked_at: string | null;
}): SampleOrderIntentPublic {
  const state: SampleOrderIntentState = row.revoked_at
    ? "revoked"
    : row.confirmed_at
      ? "confirmed"
      : row.first_viewed_at
        ? "viewed"
        : "active";

  // The snapshot's shape is enforced at write-time (sendSampleOrderEmail
  // only persists what extractSampleOrder produced). Cast back is safe here.
  const order = row.order_snapshot as unknown as LizSampleOrder;

  return {
    token: row.token,
    state,
    practice: { email: row.practice_email },
    rep: { name: row.rep_name, email: row.rep_email },
    order,
    sentAt: row.sent_at,
    firstViewedAt: row.first_viewed_at,
    lastViewedAt: row.last_viewed_at,
    confirmedAt: row.confirmed_at,
    confirmedByName: row.confirmed_by_name,
    revokedAt: row.revoked_at,
  };
}

const INTENT_COLS =
  "token, practice_email, rep_name, rep_email, order_snapshot, sent_at, first_viewed_at, last_viewed_at, confirmed_at, confirmed_by_name, revoked_at";

// ── getOrderIntent ─────────────────────────────────────────────────────────

export const getOrderIntent = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => tokenInput.parse(input))
  .handler(async ({ data }): Promise<SampleOrderIntentPublic> => {
    const sb = admin();
    const { data: row, error } = await sb
      .from("sample_order_intents")
      .select(INTENT_COLS)
      .eq("token", data.token)
      .maybeSingle();

    if (error) throw new Error(`Couldn't load that order — ${error.message}`);
    if (!row) throw new Error("This order link isn't valid — double-check the URL.");

    return rowToPublic(row);
  });

// ── recordOrderIntentView ──────────────────────────────────────────────────
// Fire-and-forget side effect from the landing page. Increments view_count,
// stamps first_viewed_at (one-shot), updates last_viewed_at. Returns the
// fresh public state so the page can re-render with the new timestamps
// without a second fetch.

export const recordOrderIntentView = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => tokenInput.parse(input))
  .handler(async ({ data }): Promise<SampleOrderIntentPublic> => {
    const sb = admin();
    const now = new Date().toISOString();

    // Read first so we know whether to set first_viewed_at — Postgres has no
    // COALESCE on UPDATE for "leave existing not-null alone" in supabase-js
    // without writing raw SQL, and the read is cheap.
    const { data: existing, error: readErr } = await sb
      .from("sample_order_intents")
      .select("first_viewed_at, view_count")
      .eq("token", data.token)
      .maybeSingle();
    if (readErr) throw new Error(`Couldn't record view — ${readErr.message}`);
    if (!existing) throw new Error("This order link isn't valid — double-check the URL.");

    const { data: row, error: upErr } = await sb
      .from("sample_order_intents")
      .update({
        first_viewed_at: existing.first_viewed_at ?? now,
        last_viewed_at: now,
        view_count: (existing.view_count ?? 0) + 1,
      })
      .eq("token", data.token)
      .select(INTENT_COLS)
      .single();
    if (upErr || !row) {
      throw new Error(`Couldn't record view — ${upErr?.message ?? "unknown"}`);
    }
    return rowToPublic(row);
  });

// ── confirmOrderIntent ─────────────────────────────────────────────────────
// "Confirm & forward to Galderma" CTA. Idempotent — re-clicking returns the
// existing confirmed timestamp. Both name + note are optional; a confirm
// with no name/note still counts (the timestamp itself is the signal).

const confirmInput = tokenInput.extend({
  name: z.string().trim().max(120).optional(),
  note: z.string().trim().max(1000).optional(),
});

export const confirmOrderIntent = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => confirmInput.parse(input))
  .handler(async ({ data }): Promise<SampleOrderIntentPublic> => {
    const sb = admin();
    const now = new Date().toISOString();

    const { data: existing, error: readErr } = await sb
      .from("sample_order_intents")
      .select("confirmed_at, confirmed_by_name, confirmed_note, revoked_at")
      .eq("token", data.token)
      .maybeSingle();
    if (readErr) throw new Error(`Couldn't load that order — ${readErr.message}`);
    if (!existing) throw new Error("This order link isn't valid — double-check the URL.");
    if (existing.revoked_at) {
      throw new Error(
        "This order link is no longer current — please reach out to your rep for an updated quote.",
      );
    }

    const nextName = data.name && data.name.length > 0
      ? data.name
      : existing.confirmed_by_name;
    const nextNote = data.note && data.note.length > 0
      ? data.note
      : existing.confirmed_note;

    const { data: row, error: upErr } = await sb
      .from("sample_order_intents")
      .update({
        // Preserve the first confirmation timestamp on re-clicks.
        confirmed_at: existing.confirmed_at ?? now,
        confirmed_by_name: nextName ?? null,
        confirmed_note: nextNote ?? null,
      })
      .eq("token", data.token)
      .select(INTENT_COLS)
      .single();
    if (upErr || !row) {
      throw new Error(`Couldn't record confirmation — ${upErr?.message ?? "unknown"}`);
    }
    return rowToPublic(row);
  });

// ── listSendIntents (v326 — Deals Desk) ────────────────────────────────────
// Authed: returns every intent the rep has sent, newest first. Pulls just
// the columns the dashboard needs (header summary from snapshot, state,
// timestamps, turn_id for chat deep-link, confirmation byline + note).
// Result is shaped as a flat row to keep the client cheap to render.

export type RepSendIntentRow = {
  token: string;
  state: SampleOrderIntentState;
  practiceTitle: string;
  /** Lookup key from the frozen snapshot, when present. Kept for diagnostics
   *  / future filters; v328 routes the Deals-Desk practice-name link through
   *  `practiceAccountId` (UUID) instead, so colon-bearing keys don't have to
   *  survive URL encoding. */
  practiceLookupKey: string | null;
  /** Resolved account UUID for this intent's practice, if the lookup_key
   *  matches a current account knowledge_node. Null when the account was
   *  deleted or the snapshot's lookup_key never matched a row. */
  practiceAccountId: string | null;
  practiceEmail: string;
  totalUsd: number;
  putsThemAtTier: string | null;
  manufacturer: string | null;
  sentAt: string;
  firstViewedAt: string | null;
  lastViewedAt: string | null;
  viewCount: number;
  confirmedAt: string | null;
  confirmedByName: string | null;
  confirmedNote: string | null;
  revokedAt: string | null;
  /** Source chat turn — null if the rep has since cleared their chat. */
  turnId: string | null;
};

export type ListSendIntentsResult = {
  rows: RepSendIntentRow[];
};

// v332: extends accessTokenInput with optional viewAs for the demo
// pass-through. Inputs without viewAs behave exactly as before.
const listSendIntentsInput = accessTokenInput.extend({
  viewAs: z.enum(["demo"]).optional(),
});

export const listSendIntents = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => listSendIntentsInput.parse(input))
  .handler(async ({ data }): Promise<ListSendIntentsResult> => {
    const repUserId = await verifyAuth(data.accessToken);
    const userId = await resolveEffectiveUserId(repUserId, data.viewAs as ViewAs);
    const sb = admin();

    const { data: intents, error } = await sb
      .from("sample_order_intents")
      .select(
        "token, practice_email, order_snapshot, sent_at, first_viewed_at, last_viewed_at, view_count, confirmed_at, confirmed_by_name, confirmed_note, revoked_at, turn_id",
      )
      .eq("rep_user_id", userId)
      .order("sent_at", { ascending: false })
      .limit(500);

    if (error) throw new Error(`Couldn't load your sends — ${error.message}`);

    // v328: bulk-resolve lookup_key → account UUID so the Deals-Desk practice
    // name can link via /app/rep/accounts/$accountId. Single round-trip
    // for all lookup keys present in this rep's intents.
    const lookupKeys = Array.from(
      new Set(
        (intents ?? [])
          .map((r) => (r.order_snapshot as unknown as LizSampleOrder)?.account?.lookup_key)
          .filter((k): k is string => typeof k === "string" && k.length > 0),
      ),
    );
    const lookupToAccountId = new Map<string, string>();
    if (lookupKeys.length > 0) {
      const { data: accountRows } = await sb
        .from("knowledge_nodes")
        .select("id, lookup_key")
        .eq("user_id", userId)
        .eq("node_type", "account")
        .in("lookup_key", lookupKeys);
      for (const a of accountRows ?? []) {
        if (a.lookup_key) lookupToAccountId.set(a.lookup_key, a.id);
      }
    }

    const rows: RepSendIntentRow[] = (intents ?? []).map((r) => {
      const order = r.order_snapshot as unknown as LizSampleOrder;
      const state: SampleOrderIntentState = r.revoked_at
        ? "revoked"
        : r.confirmed_at
          ? "confirmed"
          : r.first_viewed_at
            ? "viewed"
            : "active";
      const lookupKey = order?.account?.lookup_key ?? null;
      return {
        token: r.token,
        state,
        practiceTitle: order?.account?.title ?? "(unknown practice)",
        practiceLookupKey: lookupKey,
        practiceAccountId: lookupKey ? (lookupToAccountId.get(lookupKey) ?? null) : null,
        practiceEmail: r.practice_email,
        totalUsd: typeof order?.total_usd === "number" ? order.total_usd : 0,
        putsThemAtTier: order?.puts_them_at_tier ?? null,
        manufacturer: order?.manufacturer ?? null,
        sentAt: r.sent_at,
        firstViewedAt: r.first_viewed_at,
        lastViewedAt: r.last_viewed_at,
        viewCount: r.view_count ?? 0,
        confirmedAt: r.confirmed_at,
        confirmedByName: r.confirmed_by_name,
        confirmedNote: r.confirmed_note,
        revokedAt: r.revoked_at,
        turnId: r.turn_id,
      };
    });

    return { rows };
  });
