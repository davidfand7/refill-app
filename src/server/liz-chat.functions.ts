/**
 * Liz chat — TanStack server functions for the rep-side PWA chat.
 *
 * Two functions:
 *   sendLizMessage({ accessToken, message }) — append a user turn,
 *     run callAgent with LIZ_CONFIG, append the agent reply, return both.
 *   listLizMessages({ accessToken }) — load the conversation history
 *     for the user's Liz session (chronological, oldest → newest).
 *
 * Auth: explicit accessToken in payload (per project_tanstack_serverfn_auth
 * memory — NOT requireSupabaseAuth, which silently swallows in this codebase).
 *
 * Each rep has exactly one Liz session (unique constraint on
 * agent_chat_sessions.user_id+persona). Auto-created on first message.
 *
 * Each rep also has exactly one connected_agents row with platform='liz' —
 * auto-created on first message. The row exists so the executor functions
 * (memory_graph_query / upsert / escalate) have a real connected_agent_id
 * to tag crystallized knowledge_nodes against.
 */

import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import crypto from "node:crypto";
import { verifyAuth } from "@/server/auth-helpers";
import { setPrimaryRoleIfUnset } from "@/server/user-prefs.functions";
import type { Database, Json } from "@/integrations/supabase/types";
import {
  callAgent,
  type AgentTurn,
  type AgentConfig,
} from "@/server/agent-runtime";
import { LIZ_SYSTEM_PROMPT } from "@/server/liz-prompt";
import { buildActingAsPrefix, type RepPersona } from "@/lib/liz-acting-as";
import {
  detectConfabulations,
  buildRetryInstruction,
} from "@/server/liz-confabulation-detector";
import type { ConnectedAgentRow } from "@/server/vertex-platform";

const LIZ_CONFIG: AgentConfig = {
  systemPrompt: LIZ_SYSTEM_PROMPT,
  personaName: "Liz",
};

/** Build a per-call config that prepends the rep-persona scope prefix when set. */
function configFor(actingAs: RepPersona | null | undefined): AgentConfig {
  const prefix = buildActingAsPrefix(actingAs ?? null);
  if (!prefix) return LIZ_CONFIG;
  return { ...LIZ_CONFIG, systemPrompt: prefix + LIZ_SYSTEM_PROMPT };
}

/** How many recent turns to load as multi-turn context for the next call. */
const HISTORY_LIMIT = 40;

// ── Types returned to the UI ────────────────────────────────────────────────

/** Rep's rating on an agent reply — feeds the eval-fix loop. */
export type LizTurnRating = "up" | "down";
export type LizTurnRatingPayload = {
  rating?: LizTurnRating | null;
  /** Optional one-line "why" — captured on 👎 to seed golden-case evals later. */
  note?: string | null;
  /** ISO timestamp of the rating action. */
  rated_at?: string | null;
};

/** Structured sample-order artifact (v323) — Liz emits this as a hidden
 *  HTML-comment JSON block at the end of any sample-order reply. The server
 *  parses it, strips the marker from the body, persists the parsed JSON to
 *  agent_chat_turns.metadata.sample_order. The chat UI uses presence of this
 *  field to render the "Send to practice" button.
 *
 *  Schema is intentionally permissive (Record<string, unknown> for unknown
 *  fields) so prompt drift doesn't break the parse. Required-shape fields
 *  are documented; unknown extras pass through. */
export type LizSampleOrder = {
  account: { title: string; lookup_key?: string };
  verified: {
    tier: string;
    ytd_usd: number;
    threshold_to_advance_usd: number;
    gap_usd: number;
  };
  manufacturer?: string;
  line_items: Array<{
    product_family: string;
    product_display?: string;
    order_value_usd: number;
  }>;
  total_usd: number;
  puts_them_at_tier?: string;
  currency?: string;
};

/** One past send of this turn's sample order — appended each time the rep
 *  clicks Send. Surfaced so the chat UI can show "Sent to X on Y · Send again".
 *  v325 added intent-token plumbing so the chat UI can show whether the
 *  practice owner has opened the public Order NOW page and/or confirmed. */
export type LizSampleOrderSend = {
  to: string;
  subject: string;
  sent_at: string;
  email_id: string | null;
  /** v325: present on sends made on or after Order NOW shipped. */
  intent_token?: string;
  /** v325: latest intent state from sample_order_intents, joined at list time. */
  intent_first_viewed_at?: string | null;
  intent_confirmed_at?: string | null;
  intent_confirmed_by_name?: string | null;
  intent_revoked?: boolean;
};

export type LizChatTurn = {
  id: string;
  role: "user" | "agent";
  body: string;
  createdAt: string;
  /** Subset of agent_chat_turns.metadata surfaced to the UI. */
  rating?: LizTurnRating | null;
  ratingNote?: string | null;
  /** Structured sample-order artifact, if Liz emitted one this turn. */
  sampleOrder?: LizSampleOrder | null;
  /** History of sends for this turn's sample order (chronological). */
  sampleOrderSends?: LizSampleOrderSend[];
};

export type SendLizMessageResult = {
  userTurn: LizChatTurn;
  agentTurn: LizChatTurn;
  iterations: number;
};

// ── Sample-order artifact parsing (v323) ────────────────────────────────────
// Liz is prompted to emit a `<!--SAMPLE_ORDER_JSON\n{...}\n-->` block at the
// end of any sample-order reply. extractSampleOrder() pulls the JSON out and
// returns it parsed; the body is rewritten without the marker so the chat UI
// renders clean prose.
//
// Defensive: a missing/unparseable artifact returns null — never throws.
// Math is sanity-checked (line_items sum to total). If the artifact is
// present but math doesn't close, it's still surfaced so the UI can flag it;
// downstream consumers (PDF, email send) should re-verify before relying.

// Accepts the marker on its own OR wrapped in markdown code fences. Liz is
// instructed to emit raw `<!--SAMPLE_ORDER_JSON ... -->` but Gemini sometimes
// fences the example from the prompt — this swallows both forms.
const SAMPLE_ORDER_RE = /(?:```[a-zA-Z]*\s*)?<!--\s*SAMPLE_ORDER_JSON\s*([\s\S]*?)-->(?:\s*```)?/i;

function extractSampleOrder(rawBody: string): { body: string; sampleOrder: LizSampleOrder | null } {
  const match = rawBody.match(SAMPLE_ORDER_RE);
  if (!match) return { body: rawBody, sampleOrder: null };

  // Strip the marker (and any trailing whitespace it leaves behind) from the
  // body unconditionally — even if parse fails. We don't want the raw JSON
  // bleeding into the chat bubble.
  const strippedBody = rawBody.replace(SAMPLE_ORDER_RE, "").replace(/\n{3,}$/, "\n\n").trimEnd();

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1].trim());
  } catch {
    return { body: strippedBody, sampleOrder: null };
  }

  if (!parsed || typeof parsed !== "object") {
    return { body: strippedBody, sampleOrder: null };
  }
  const p = parsed as Record<string, unknown>;
  const account = p.account as Record<string, unknown> | undefined;
  const verified = p.verified as Record<string, unknown> | undefined;
  const lineItems = p.line_items as unknown;

  if (
    !account || typeof account.title !== "string" ||
    !verified ||
    typeof verified.tier !== "string" ||
    typeof verified.ytd_usd !== "number" ||
    typeof verified.threshold_to_advance_usd !== "number" ||
    typeof verified.gap_usd !== "number" ||
    !Array.isArray(lineItems) ||
    typeof p.total_usd !== "number"
  ) {
    return { body: strippedBody, sampleOrder: null };
  }

  const cleanLineItems = lineItems
    .filter((li): li is Record<string, unknown> => !!li && typeof li === "object")
    .map((li) => ({
      product_family: typeof li.product_family === "string" ? li.product_family : "unknown",
      product_display: typeof li.product_display === "string" ? li.product_display : undefined,
      order_value_usd: typeof li.order_value_usd === "number" ? li.order_value_usd : 0,
    }));

  const sampleOrder: LizSampleOrder = {
    account: {
      title: account.title,
      lookup_key: typeof account.lookup_key === "string" ? account.lookup_key : undefined,
    },
    verified: {
      tier: verified.tier,
      ytd_usd: verified.ytd_usd,
      threshold_to_advance_usd: verified.threshold_to_advance_usd,
      gap_usd: verified.gap_usd,
    },
    manufacturer: typeof p.manufacturer === "string" ? p.manufacturer : undefined,
    line_items: cleanLineItems,
    total_usd: p.total_usd,
    puts_them_at_tier: typeof p.puts_them_at_tier === "string" ? p.puts_them_at_tier : undefined,
    currency: typeof p.currency === "string" ? p.currency : "USD",
  };

  return { body: strippedBody, sampleOrder };
}

// ── Admin helper ────────────────────────────────────────────────────────────

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

// ── Ensure each rep has a Liz connected_agents row ─────────────────────────
// Created on first chat. Used by executor functions to tag crystallized
// knowledge_nodes with a real connected_agent_id.

export async function ensureLizAgent(userId: string): Promise<ConnectedAgentRow> {
  const sb = admin();

  const { data: existing } = await sb
    .from("connected_agents")
    .select(
      "id, user_id, platform, agent_name, agent_identifier, invoke_endpoint, deeplink_url, callback_secret, metadata, installed_at",
    )
    .eq("user_id", userId)
    .eq("platform", "liz")
    .is("removed_at", null)
    .maybeSingle();

  if (existing) {
    return existing as unknown as ConnectedAgentRow;
  }

  // Liz runs in our worker, not external — so api_key fields are placeholders
  // (never used to authenticate). callback_secret null. agent_identifier='liz'
  // is unique per (user_id, platform, agent_identifier).
  const placeholderHash = crypto
    .createHash("sha256")
    .update(`liz-internal-${userId}`)
    .digest("hex");

  const { data: row, error } = await sb
    .from("connected_agents")
    .insert({
      user_id: userId,
      platform: "liz",
      agent_name: "Liz",
      agent_identifier: "liz",
      api_key_prefix: "liz_int",
      api_key_hash: placeholderHash,
    })
    .select(
      "id, user_id, platform, agent_name, agent_identifier, invoke_endpoint, deeplink_url, callback_secret, metadata, installed_at",
    )
    .single();

  if (error || !row) {
    throw new Error(`Couldn't ensure Liz agent: ${error?.message ?? "no row"}`);
  }
  return row as unknown as ConnectedAgentRow;
}

// ── Ensure session exists for (user, persona='liz') ────────────────────────

export async function ensureLizSession(userId: string): Promise<string> {
  const sb = admin();

  const { data: existing } = await sb
    .from("agent_chat_sessions")
    .select("id")
    .eq("user_id", userId)
    .eq("persona", "liz")
    .maybeSingle();

  if (existing) return existing.id;

  const { data: row, error } = await sb
    .from("agent_chat_sessions")
    .insert({ user_id: userId, persona: "liz" })
    .select("id")
    .single();

  if (error || !row) {
    throw new Error(`Couldn't ensure Liz session: ${error?.message ?? "no row"}`);
  }

  // First-touch stamp: this rep just opened a Liz session for the first
  // time. Sticky — never overwrites an existing role. Awaited because CF
  // Workers kill orphan promises after the request returns. The helper
  // swallows its own errors so this never blocks the chat send.
  await setPrimaryRoleIfUnset(sb, userId, "rep");

  return row.id;
}

// ── listLizMessages ────────────────────────────────────────────────────────

const authedInput = z.object({ accessToken: z.string().min(1) });

// ── clearLizMessages (v320) ─────────────────────────────────────────────────
// "New chat" button — deletes every turn for the user's Liz session,
// keeping the session row itself so sendLizMessage on the next turn lands
// in the same shape. Used when conversation context has been poisoned
// (e.g. a prior hallucinated answer that Gemini keeps regurgitating) and
// the rep wants to start the conversation fresh without losing their
// account data or product catalog.

export const clearLizMessages = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => authedInput.parse(input))
  .handler(async ({ data }): Promise<{ deleted: number }> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();
    const { data: session } = await sb
      .from("agent_chat_sessions")
      .select("id")
      .eq("user_id", userId)
      .eq("persona", "liz")
      .maybeSingle();
    if (!session) return { deleted: 0 };
    const { error, count } = await sb
      .from("agent_chat_turns")
      .delete({ count: "exact" })
      .eq("session_id", session.id);
    if (error) throw new Error(`Couldn't clear Liz history: ${error.message}`);
    return { deleted: count ?? 0 };
  });

export const listLizMessages = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => authedInput.parse(input))
  .handler(async ({ data }): Promise<LizChatTurn[]> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();

    // Don't auto-create on list — only on send. New users see an empty thread.
    const { data: session } = await sb
      .from("agent_chat_sessions")
      .select("id")
      .eq("user_id", userId)
      .eq("persona", "liz")
      .maybeSingle();

    if (!session) return [];

    const { data: turns, error } = await sb
      .from("agent_chat_turns")
      .select("id, role, body, created_at, metadata")
      .eq("session_id", session.id)
      .order("created_at", { ascending: true })
      .limit(HISTORY_LIMIT);

    if (error) throw new Error(`Couldn't load Liz history: ${error.message}`);

    const rawTurns = (turns ?? []).map((t) => {
      const meta = (t.metadata ?? {}) as Record<string, unknown>;
      const rating = meta.rating === "up" || meta.rating === "down"
        ? (meta.rating as LizTurnRating)
        : null;
      const ratingNote = typeof meta.rating_note === "string" ? meta.rating_note : null;
      const sampleOrder =
        meta.sample_order && typeof meta.sample_order === "object"
          ? (meta.sample_order as LizSampleOrder)
          : null;
      const sampleOrderSends = Array.isArray(meta.sends)
        ? (meta.sends as LizSampleOrderSend[])
        : [];
      return {
        id: t.id,
        role: t.role as "user" | "agent",
        body: t.body,
        createdAt: t.created_at,
        rating,
        ratingNote,
        sampleOrder,
        sampleOrderSends,
      };
    });

    // v325: join intent state onto every send that carries an intent_token.
    // One bulk query — cheaper than per-send. RLS scopes by rep_user_id so
    // even though we're using the service-role client, we filter explicitly
    // to be defense-in-depth.
    const tokens = rawTurns
      .flatMap((t) => t.sampleOrderSends.map((s) => s.intent_token))
      .filter((v): v is string => typeof v === "string" && v.length > 0);

    if (tokens.length > 0) {
      const { data: intents } = await sb
        .from("sample_order_intents")
        .select("token, first_viewed_at, confirmed_at, confirmed_by_name, revoked_at")
        .eq("rep_user_id", userId)
        .in("token", tokens);
      const byToken = new Map(
        (intents ?? []).map((r) => [r.token, r] as const),
      );
      for (const t of rawTurns) {
        t.sampleOrderSends = t.sampleOrderSends.map((s) => {
          if (!s.intent_token) return s;
          const row = byToken.get(s.intent_token);
          if (!row) return s;
          return {
            ...s,
            intent_first_viewed_at: row.first_viewed_at ?? null,
            intent_confirmed_at: row.confirmed_at ?? null,
            intent_confirmed_by_name: row.confirmed_by_name ?? null,
            intent_revoked: !!row.revoked_at,
          };
        });
      }
    }

    return rawTurns;
  });

// ── getLizDiagFeed ─────────────────────────────────────────────────────────
// Layer 3 of the eval loop: in-app diag surface at /app/rep/diag. Pulls
// the same data scripts/diag-liz.ts pulls (recent turn pairs + matching
// _diag_tool_call rows + ratings) and runs the same anti-pattern detectors,
// but as a JSON server fn so the UI can render it.

export type LizDiagToolCall = {
  /** The exact body Gemini sent to the query tool (JSON-stringified). */
  incomingBody: string;
  resultCount: number;
  createdAt: string;
};

export type LizDiagFlag = {
  kind:
    | "EMPTY-PREAMBLE"
    | "CLIFFHANGER"
    | "DATA-CLAIM-NO-QUERY"
    | "MISSING-PULLBACK"
    | "HARD-TRUNCATION";
  detail: string;
};

export type LizDiagPair = {
  /** Stable id — uses agent turn id when present, else user turn id. */
  id: string;
  userPrompt: string | null;
  userAt: string | null;
  agentReply: string | null;
  agentAt: string | null;
  rating: LizTurnRating | null;
  ratingNote: string | null;
  toolCalls: LizDiagToolCall[];
  flags: LizDiagFlag[];
};

export type LizDiagFeed = {
  sessionId: string | null;
  lastUsedAt: string | null;
  pairs: LizDiagPair[];
};

const diagInput = authedInput.extend({
  lastN: z.number().int().min(1).max(50).optional(),
});

const PREAMBLE_PATTERNS: RegExp[] = [
  /\bi'?ve pulled\b/i,
  /\bhere are your (top|best|top \w+|key)\b/i,
  /\blet me (check|pull|look|grab)\b/i,
  /\bi (just )?queried (your|the)\b/i,
  /\bof course\.? (i'?ve|let me)\b/i,
  /\bgreat question\.? (based on|i'?ve|let me)\b/i,
];
const CLIFFHANGER_PATTERNS: RegExp[] = [
  /:\s*$/,
  /\bfor each\.?\s*$/i,
  /\bas follows\.?\s*$/i,
  /\bbelow\.?\s*$/i,
  /\bbroken down\b[^.]*\.?\s*$/i,
];
const CROSS_ACCOUNT_PROMPTS: RegExp[] = [
  /top targets/i,
  /who'?s at risk/i,
  /who'?s close/i,
  /rank my book/i,
  /my book/i,
  /my territory/i,
  /across.*accounts/i,
];
const DATA_CLAIM_PATTERNS: RegExp[] = [
  /\$[\d,]+/,
  /\d+ units?\b/i,
  /\b(diamond|platinum|gold|silver|bronze)\b/i,
];

// Reply ends in proper terminal punctuation / markdown close / list-item-ish
// character. If a reply doesn't match this AND is short, the runtime likely
// hard-cut it (MAX_TOKENS, etc) — see HARD-TRUNCATION detector below.
const TERMINAL_END_PATTERN = /[.!?"')\]\*”’]\s*$/;

function detectFlags(
  prompt: string,
  reply: string,
  toolCallCount: number,
  finishReason?: string | null,
): LizDiagFlag[] {
  const flags: LizDiagFlag[] = [];
  const r = (reply ?? "").trim();
  const len = r.length;

  if (toolCallCount === 0) {
    for (const p of PREAMBLE_PATTERNS) {
      if (p.test(r)) {
        flags.push({ kind: "EMPTY-PREAMBLE", detail: `Reply claims data action but 0 tool calls fired (matched /${p.source}/)` });
        break;
      }
    }
  }
  if (len < 400) {
    for (const p of CLIFFHANGER_PATTERNS) {
      if (p.test(r)) {
        flags.push({ kind: "CLIFFHANGER", detail: `Reply ends matching /${p.source}/ — promised content, didn't deliver` });
        break;
      }
    }
  }
  if (toolCallCount === 0) {
    for (const p of DATA_CLAIM_PATTERNS) {
      if (p.test(r)) {
        flags.push({ kind: "DATA-CLAIM-NO-QUERY", detail: `Reply contains data-looking content (matched /${p.source}/) but 0 tool calls fired` });
        break;
      }
    }
  }
  const isCrossAccount = CROSS_ACCOUNT_PROMPTS.some((p) => p.test(prompt ?? ""));
  const hasPullback = /pull[- ]?back|\| account \| tiers? \|/i.test(r);
  if (isCrossAccount && toolCallCount > 0 && !hasPullback && len > 200) {
    flags.push({ kind: "MISSING-PULLBACK", detail: "Cross-account question + tool calls fired, but reply has no Pull-back citation table (v290 rule)" });
  }

  // Hard mid-sentence truncation: either the runtime told us so via
  // finishReason, or the reply syntactically lacks a terminal character.
  if (finishReason && finishReason !== "STOP") {
    flags.push({ kind: "HARD-TRUNCATION", detail: `Gemini finishReason=${finishReason} — model didn't stop on its own (likely MAX_TOKENS or SAFETY)` });
  } else if (len > 0 && len < 800 && !TERMINAL_END_PATTERN.test(r)) {
    flags.push({ kind: "HARD-TRUNCATION", detail: `Reply ends without terminal punctuation ('${r.slice(-40)}') — likely mid-sentence cut` });
  }
  return flags;
}

export const getLizDiagFeed = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => diagInput.parse(input))
  .handler(async ({ data }): Promise<LizDiagFeed> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();
    const lastN = data.lastN ?? 8;

    // Find this user's Liz session (one per user, unique).
    const { data: session } = await sb
      .from("agent_chat_sessions")
      .select("id, last_used_at")
      .eq("user_id", userId)
      .eq("persona", "liz")
      .maybeSingle();

    if (!session) {
      return { sessionId: null, lastUsedAt: null, pairs: [] };
    }

    // Pull recent turns (over-fetch to ensure we get full pairs).
    const { data: turns } = await sb
      .from("agent_chat_turns")
      .select("id, role, body, created_at, metadata")
      .eq("session_id", session.id)
      .order("created_at", { ascending: false })
      .limit(lastN * 3);
    const allTurns = (turns ?? []).reverse();

    // Pull diag rows in the past hour.
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: diags } = await sb
      .from("knowledge_nodes")
      .select("content, created_at")
      .eq("user_id", userId)
      .eq("node_type", "_diag_tool_call")
      .gte("created_at", oneHourAgo)
      .order("created_at", { ascending: true });
    const allDiags = (diags ?? []).map((d) => {
      try {
        const c = JSON.parse(d.content) as { incoming_body?: unknown; result_count?: number };
        return {
          incoming_body: c.incoming_body ?? {},
          result_count: typeof c.result_count === "number" ? c.result_count : 0,
          created_at: d.created_at,
        };
      } catch {
        return { incoming_body: {}, result_count: 0, created_at: d.created_at };
      }
    });

    // Group turns into (user, agent) pairs.
    type RawTurn = typeof allTurns[0];
    type RawPair = { user?: RawTurn; agent?: RawTurn };
    const pairs: RawPair[] = [];
    for (const t of allTurns) {
      if (t.role === "user") {
        pairs.push({ user: t });
      } else if (t.role === "agent") {
        const last = pairs[pairs.length - 1];
        if (last && !last.agent) last.agent = t;
        else pairs.push({ agent: t });
      }
    }
    const recentPairs = pairs.slice(-lastN);

    // Build final shape.
    const out: LizDiagPair[] = recentPairs.map((p) => {
      const userBody = p.user?.body ?? null;
      const agentBody = p.agent?.body ?? null;
      const userAt = p.user?.created_at ?? null;
      const agentAt = p.agent?.created_at ?? null;
      const id = p.agent?.id ?? p.user?.id ?? `pair-${Math.random().toString(36).slice(2, 8)}`;

      const meta = (p.agent?.metadata ?? {}) as Record<string, unknown>;
      const rating: LizTurnRating | null =
        meta.rating === "up" || meta.rating === "down" ? (meta.rating as LizTurnRating) : null;
      const ratingNote = typeof meta.rating_note === "string" ? meta.rating_note : null;

      // Tool calls in window: from userAt - 5s to agentAt + 60s
      const startMs = userAt ? new Date(userAt).getTime() - 5000 : agentAt ? new Date(agentAt).getTime() - 5000 : 0;
      const endMs = agentAt ? new Date(agentAt).getTime() + 60000 : startMs + 60000;
      const matched = allDiags.filter((d) => {
        const t = new Date(d.created_at).getTime();
        return t >= startMs && t <= endMs;
      });

      const toolCalls: LizDiagToolCall[] = matched.map((m) => ({
        incomingBody: JSON.stringify(m.incoming_body),
        resultCount: m.result_count,
        createdAt: m.created_at,
      }));

      const finishReason =
        typeof meta.finish_reason === "string" ? meta.finish_reason : null;
      const flags = detectFlags(
        userBody ?? "",
        agentBody ?? "",
        toolCalls.length,
        finishReason,
      );

      return { id, userPrompt: userBody, userAt, agentReply: agentBody, agentAt, rating, ratingNote, toolCalls, flags };
    });

    return {
      sessionId: session.id,
      lastUsedAt: session.last_used_at,
      pairs: out,
    };
  });

// ── rateLizTurn ────────────────────────────────────────────────────────────
// Set / change / clear a rating on a Liz reply. Stored in
// agent_chat_turns.metadata as { rating, rating_note, rated_at } — no schema
// migration needed (existing jsonb column). Feeds diag-liz.ts and the future
// golden-case eval harness.

const rateInput = authedInput.extend({
  turnId: z.string().uuid(),
  /** Pass null to clear an existing rating. */
  rating: z.enum(["up", "down"]).nullable(),
  /** Optional "why" line, mostly captured on 👎. Cleared along with rating=null. */
  note: z.string().max(800).nullable().optional(),
});

export const rateLizTurn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => rateInput.parse(input))
  .handler(async ({ data }): Promise<{ ok: true; rating: LizTurnRating | null; note: string | null }> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();

    // Load the turn + its session so we can verify the caller owns the session
    // AND that the turn is an agent turn (rating user turns makes no sense).
    const { data: row, error: rowErr } = await sb
      .from("agent_chat_turns")
      .select("id, role, metadata, session_id, agent_chat_sessions!inner(user_id, persona)")
      .eq("id", data.turnId)
      .maybeSingle();

    if (rowErr || !row) {
      throw new Error("Couldn't find that reply to rate.");
    }
    const sess = row.agent_chat_sessions as unknown as { user_id: string; persona: string };
    if (sess.user_id !== userId) {
      throw new Error("That reply doesn't belong to you.");
    }
    if (sess.persona !== "liz") {
      throw new Error("Ratings are only for Liz replies right now.");
    }
    if (row.role !== "agent") {
      throw new Error("Only agent replies can be rated.");
    }

    const existing = (row.metadata ?? {}) as Record<string, unknown>;
    const nextMeta: Record<string, unknown> = { ...existing };
    if (data.rating === null) {
      delete nextMeta.rating;
      delete nextMeta.rating_note;
      delete nextMeta.rated_at;
    } else {
      nextMeta.rating = data.rating;
      if (data.note !== undefined) {
        if (data.note === null || data.note.trim() === "") delete nextMeta.rating_note;
        else nextMeta.rating_note = data.note.trim();
      }
      nextMeta.rated_at = new Date().toISOString();
    }

    const { error: upErr } = await sb
      .from("agent_chat_turns")
      .update({ metadata: nextMeta as Json })
      .eq("id", data.turnId);
    if (upErr) throw new Error(`Couldn't save the rating: ${upErr.message}`);

    return {
      ok: true,
      rating: (nextMeta.rating ?? null) as LizTurnRating | null,
      note: typeof nextMeta.rating_note === "string" ? nextMeta.rating_note : null,
    };
  });

// ── sendLizMessage ─────────────────────────────────────────────────────────

const sendInput = authedInput.extend({
  message: z.string().min(1).max(8000),
  actingAs: z
    .enum(["allergan-rep", "galderma-rep", "evolus-rep", "merz-rep"])
    .nullable()
    .optional(),
});

export const sendLizMessage = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => sendInput.parse(input))
  .handler(async ({ data }): Promise<SendLizMessageResult> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();

    // Setup — both auto-create on first send.
    const sessionId = await ensureLizSession(userId);
    const agent = await ensureLizAgent(userId);

    // Load history (BEFORE appending the new user turn so callAgent gets the
    // history that EXCLUDES the message we're about to add — we pass that
    // separately as userMessage).
    const { data: history, error: histErr } = await sb
      .from("agent_chat_turns")
      .select("role, body")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: true })
      .limit(HISTORY_LIMIT);
    if (histErr) {
      throw new Error(`Couldn't load history: ${histErr.message}`);
    }

    const turns: AgentTurn[] = (history ?? []).map((t) => ({
      role: t.role as "user" | "agent",
      body: t.body,
    }));

    // Append user turn first so it's persisted even if Liz fails.
    const { data: userRow, error: userErr } = await sb
      .from("agent_chat_turns")
      .insert({
        session_id: sessionId,
        role: "user",
        body: data.message,
      })
      .select("id, role, body, created_at")
      .single();
    if (userErr || !userRow) {
      throw new Error(`Couldn't save your message: ${userErr?.message ?? "no row"}`);
    }

    // Call Liz, optionally with the rep-persona scope prefix prepended.
    let { replyText, iterations, finishReason } = await callAgent(
      agent,
      turns,
      data.message,
      configFor(data.actingAs),
    );

    // v333 — Server-side [VERIFIED] enforcement at the chat-handler layer.
    // Detector runs over the first reply; if findings (fabricated threshold,
    // YTD mismatch, OR missing [VERIFIED] line on a tier-math reply), call
    // the agent again with the bad reply + corrective instruction in
    // history. Max 1 retry — bounded cost/latency. If retry still has
    // findings, we ship anyway but tag the metadata so diag picks it up.
    // The structural promise: a reply that reaches the user has been
    // validated by the same detector that scripts/diag-liz-confabulation.ts
    // runs against past turns. "Zero hallucination" is now a server-side
    // contract, not a prompt request.
    let detectorFindings = await detectConfabulations(
      extractSampleOrder(replyText).body,
      userId,
      sb,
    );
    let autoRetryCount = 0;
    if (detectorFindings.length > 0) {
      const retryHistory: AgentTurn[] = [
        ...turns,
        { role: "user", body: data.message },
        { role: "agent", body: replyText },
      ];
      const retryInstruction = buildRetryInstruction(detectorFindings);
      const retried = await callAgent(
        agent,
        retryHistory,
        retryInstruction,
        configFor(data.actingAs),
      );
      replyText = retried.replyText;
      iterations += retried.iterations;
      finishReason = retried.finishReason;
      autoRetryCount = 1;
      // Re-validate the retry. Any remaining findings get persisted so
      // diag surfaces "auto-retry didn't fully resolve" cases for review.
      detectorFindings = await detectConfabulations(
        extractSampleOrder(replyText).body,
        userId,
        sb,
      );
    }

    const rawReply =
      replyText.trim() ||
      "I didn't quite catch that — try asking again with a bit more detail?";

    // v323 — extract structured sample-order artifact (if present) and strip
    // the hidden marker out of the body before persistence. The parsed JSON
    // rides on metadata.sample_order; the chat UI uses it to surface the
    // "Send to practice" button.
    const { body: finalReply, sampleOrder } = extractSampleOrder(rawReply);

    const agentMetadata: Record<string, unknown> = {
      iterations,
      finish_reason: finishReason,
    };
    if (sampleOrder) {
      agentMetadata.sample_order = sampleOrder;
    }
    if (autoRetryCount > 0) {
      agentMetadata.auto_retried_count = autoRetryCount;
    }
    if (detectorFindings.length > 0) {
      // Findings AFTER the (possible) retry — i.e. things the auto-retry
      // didn't manage to fix. Persisted so the diag feed can surface them
      // for manual review without re-running the detector each time.
      agentMetadata.confabulation_findings = detectorFindings as unknown as Json;
    }

    // Append agent turn. finishReason persisted so diag can flag silent
    // truncations (MAX_TOKENS / SAFETY etc) — v299.
    const { data: agentRow, error: agentErr } = await sb
      .from("agent_chat_turns")
      .insert({
        session_id: sessionId,
        role: "agent",
        body: finalReply,
        metadata: agentMetadata as Json,
      })
      .select("id, role, body, created_at")
      .single();
    if (agentErr || !agentRow) {
      throw new Error(`Couldn't save Liz's reply: ${agentErr?.message ?? "no row"}`);
    }

    // Update session timestamp.
    await sb
      .from("agent_chat_sessions")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", sessionId);

    return {
      userTurn: {
        id: userRow.id,
        role: "user",
        body: userRow.body,
        createdAt: userRow.created_at,
      },
      agentTurn: {
        id: agentRow.id,
        role: "agent",
        body: agentRow.body,
        createdAt: agentRow.created_at,
        sampleOrder,
        sampleOrderSends: [],
      },
      iterations,
    };
  });
