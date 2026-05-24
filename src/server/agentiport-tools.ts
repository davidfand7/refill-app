/**
 * Shared core logic for the three Agentiport tool endpoints.
 *
 * Both the public HTTP routes (/api/escalate, /api/memory-graph/query,
 * /api/memory-graph/upsert) AND the MCP wrapper (/api/mcp) call these
 * helpers. The MCP wrapper used to dispatch via internal subrequest
 * (fetch back to its own host), which fails in Cloudflare Workers when
 * the runtime can't safely route a self-fetch through the edge —
 * silent 5xx that our error path then wraps as `isError: true` to the
 * agent. Result: tool calls show ✓ in Vertex's trace but escalations
 * never reach the database.
 *
 * Every helper signature is:
 *   (agent: ConnectedAgentRow, args: unknown) => Promise<HelperResult>
 *
 * where HelperResult mirrors an HTTP response shape so the public
 * routes can pass the result straight through, and the MCP wrapper
 * can map status code → tool error vs success without any HTTP hop.
 */

import { createClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";
import type { ConnectedAgentRow } from "@/server/vertex-platform";
import { deliverResolution } from "@/server/vertex-platform";

export type HelperResult = {
  status: number;
  body: Record<string, unknown>;
};

function admin() {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) return null;
  return createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown, max = 4000): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

// ── /api/escalate ───────────────────────────────────────────────────────────

const PENDING_QUOTA_PER_AGENT = 30;

export async function executeEscalate(
  agent: ConnectedAgentRow,
  body: unknown,
): Promise<HelperResult> {
  const b = isPlainObject(body) ? body : {};

  const prompt = typeof b.prompt === "string" ? b.prompt.trim() : "";
  if (!prompt) {
    return { status: 400, body: { error: "`prompt` is required." } };
  }
  if (prompt.length > 4000) {
    return {
      status: 400,
      body: { error: "`prompt` must be 4000 chars or fewer." },
    };
  }

  const reasoning =
    typeof b.reasoning === "string" ? b.reasoning.trim().slice(0, 16000) : null;

  const urgencyRaw = typeof b.urgency === "string" ? b.urgency : "normal";
  const urgency =
    urgencyRaw === "low" || urgencyRaw === "high" ? urgencyRaw : "normal";

  const contextKey =
    typeof b.contextKey === "string" && b.contextKey.trim()
      ? b.contextKey.trim().slice(0, 240)
      : null;

  const contextPayload = isPlainObject(b.contextPayload) ? b.contextPayload : {};

  const agentConfidence =
    typeof b.agentConfidence === "number" && Number.isFinite(b.agentConfidence)
      ? Math.max(0, Math.min(1, b.agentConfidence))
      : null;

  // Phase 3.5.3 — channel + customerPhone let SMS-originated escalations
  // tag themselves so /app/repos can render the doorway and resolveEscalation
  // can dispatch the resolution back via SMS instead of webhook.
  const channelRaw = typeof b.channel === "string" ? b.channel.toLowerCase() : "vertex";
  const channel = channelRaw === "sms" ? "sms" : "vertex";
  const customerPhoneRaw =
    typeof b.customerPhone === "string" ? b.customerPhone.trim() : "";
  // Loose E.164 sanity — Karen sends what the gateway told her, we just
  // bound the length so a stray paste can't blow up the column.
  const customerPhone =
    channel === "sms" && /^\+?[1-9]\d{6,18}$/.test(customerPhoneRaw)
      ? customerPhoneRaw
      : null;

  const sb = admin();
  if (!sb) return { status: 500, body: { error: "Server not configured." } };

  const { count: pendingCount, error: countErr } = await sb
    .from("escalations")
    .select("id", { count: "exact", head: true })
    .eq("user_id", agent.user_id)
    .eq("connected_agent_id", agent.id)
    .eq("status", "pending");
  if (countErr) {
    return { status: 500, body: { error: "Couldn't check pending queue." } };
  }
  if ((pendingCount ?? 0) >= PENDING_QUOTA_PER_AGENT) {
    return {
      status: 429,
      body: {
        error: `Pending escalation quota reached (${PENDING_QUOTA_PER_AGENT}). Resolve some inbox items first.`,
      },
    };
  }

  const { data: row, error: insErr } = await sb
    .from("escalations")
    .insert({
      user_id: agent.user_id,
      connected_agent_id: agent.id,
      prompt,
      reasoning,
      urgency,
      context_key: contextKey,
      context_payload: contextPayload as Json,
      agent_confidence: agentConfidence,
      channel,
      customer_phone: customerPhone,
    })
    .select("id, raised_at")
    .single();
  if (insErr || !row) {
    return {
      status: 500,
      body: {
        error: `Couldn't create escalation: ${insErr?.message ?? "no row returned"}`,
      },
    };
  }

  return {
    status: 201,
    body: {
      escalationId: row.id,
      raisedAt: row.raised_at,
      inboxUrl: "https://agentiport.com/app/repos",
      status: "pending",
    },
  };
}

// ── /api/memory-graph/query ─────────────────────────────────────────────────

export async function executeMemoryGraphQuery(
  agent: ConnectedAgentRow,
  body: unknown,
): Promise<HelperResult> {
  const b = isPlainObject(body) ? body : {};

  const context = asString(b.context, 240);
  const lookupKey = asString(b.lookupKey, 240);
  const lookupType = asString(b.lookupType, 60);
  const nodeType = asString(b.nodeType, 60);
  const queryText = asString(b.query, 240);
  const repAssignment = asString(b.repAssignment, 60);

  // v313: limit policy. The old default of 30 silently truncated Liz's "rank
  // my whole book" queries — Grasshopper's 106-account Galderma book lost the
  // top 5 spenders because limit=30 + ordering-by-last_referenced_at with
  // ties (all 86 projected nodes have the same created_at) returned some-30-
  // of-106 in insert order, not by relevance.
  //
  // Policy now:
  //   - Open-ended query (no filters) → default 30 (still cheap; an agent
  //     foraging without context shouldn't pull the whole graph).
  //   - Filtered query (nodeType / lookupType / context / lookupKey set) →
  //     default 200. A filter narrows the result space dramatically; "all
  //     accounts in my territory" should return every account, not a slice.
  //   - Explicit user-set `limit` is honored up to a hard cap of 500
  //     (was 100). 500 covers large-enterprise books without uncapping.
  const hasFilter = !!(nodeType || lookupType || context || lookupKey);
  const DEFAULT_FILTERED = 200;
  const DEFAULT_OPEN = 30;
  const HARD_CAP = 500;
  const limit =
    typeof b.limit === "number" && Number.isFinite(b.limit)
      ? Math.max(1, Math.min(HARD_CAP, Math.floor(b.limit)))
      : hasFilter
        ? DEFAULT_FILTERED
        : DEFAULT_OPEN;

  const sb = admin();
  if (!sb) return { status: 500, body: { error: "Server not configured." } };

  let q = sb
    .from("knowledge_nodes")
    .select(
      "id, node_type, title, content, context, lookup_key, lookup_type, weight, attachments, source, source_ref, created_at, last_referenced_at",
    )
    .eq("user_id", agent.user_id);

  if (context) q = q.eq("context", context);
  if (lookupKey) q = q.eq("lookup_key", lookupKey);
  if (lookupType) q = q.eq("lookup_type", lookupType);
  if (nodeType) q = q.eq("node_type", nodeType);
  // v300: Scope account-level queries to the rep's territory when the
  // acting-as persona is set. Filters on the attachments.rep_assignment
  // JSON field via PostgREST's arrow syntax. Without this, a Galderma rep
  // asking "my top accounts" gets all 4 reps' books and rankings hallucinate.
  if (repAssignment) q = q.eq("attachments->>rep_assignment", repAssignment);
  if (queryText) {
    // Em-dash / hyphen flexibility (v298): a Liz query like "Galderma Mid-Tier"
    // used to miss the seed title "Galderma — Mid-Tier Spend" because ILIKE is
    // a literal substring match and the em-dash didn't appear in the query.
    // Surfaced by audit-liz-seed.ts (Layer A) on every tier-rule title.
    //
    // Fix: when the query contains ANY run of separators (space, hyphen,
    // en-dash U+2013, em-dash U+2014), build a Postgres POSIX regex pattern
    // where each separator run becomes a flexible class accepting any of
    // those four. Use ~* (PostgREST operator `imatch`) for case-insensitive
    // matching. Single-word queries keep the cheaper ILIKE substring path.
    const hasSeparator = /[\s–—-]/.test(queryText);
    if (hasSeparator) {
      // Strip any literal double-quotes / commas from input — they'd break
      // PostgREST `or()` value parsing (we wrap pattern in "..." below).
      const cleaned = queryText.replace(/["',]/g, " ");
      const escaped = cleaned.replace(/[\\^$.|?*+()[\]{}]/g, "\\$&");
      const pattern = escaped.replace(
        /[\s–—-]+/g,
        "[[:space:]–—-]+",
      );
      // PostgREST requires quoting values that contain reserved chars
      // (`.` `,` `:` `(` `)` `*` `[` `]`) — our regex has plenty.
      q = q.or(`title.imatch."${pattern}",content.imatch."${pattern}"`);
    } else {
      const safe = queryText.replace(/[%_]/g, (c) => `\\${c}`);
      q = q.or(`title.ilike.%${safe}%,content.ilike.%${safe}%`);
    }
  }

  const { data: nodes, error } = await q
    .order("last_referenced_at", { ascending: false })
    // v313: stable secondary sort. Without this, batch-projected nodes that
    // share `last_referenced_at` came back in implementation-defined order,
    // which meant Liz's "top spenders" ranking depended on Postgres's
    // physical row order on any given query. id is uuid; deterministic.
    .order("id", { ascending: true })
    .limit(limit);

  if (error) {
    return {
      status: 500,
      body: { error: `Memory Graph query failed: ${error.message}` },
    };
  }

  const nodeRows = nodes ?? [];

  // ── DIAG (v255): record incoming params + result count for tool-call audit.
  // Lets us inspect exactly what Gemini is sending without depending on worker
  // log streaming. Read back via:
  //   select * from knowledge_nodes where node_type='_diag_tool_call'
  //     order by created_at desc limit 5;
  // Tagged with source='diag' so it's filterable. v373.5: must await on Workers
  // (isolate dies at response time and fire-and-forget no-ops the row).
  try {
    await sb
      .from("knowledge_nodes")
      .insert({
        user_id: agent.user_id,
        node_type: "_diag_tool_call",
        title: `memory_graph_query`,
        content: JSON.stringify({
          incoming_body: b,
          parsed: { context, lookupKey, lookupType, nodeType, queryText, repAssignment, limit },
          result_count: nodeRows.length,
          agent_platform: agent.platform,
          agent_id: agent.id,
        }),
        source: "diag",
        connected_agent_id: agent.id,
      });
  } catch {
    /* diag should never break production */
  }
  const nodeIds = nodeRows.map((n) => n.id);

  let edges: Array<{
    id: string;
    source_node_id: string;
    target_node_id: string;
    edge_type: string;
    weight: number;
  }> = [];
  if (nodeIds.length > 0) {
    const { data: edgeData } = await sb
      .from("knowledge_edges")
      .select("id, source_node_id, target_node_id, edge_type, weight")
      .eq("user_id", agent.user_id)
      .or(
        `source_node_id.in.(${nodeIds.join(",")}),target_node_id.in.(${nodeIds.join(",")})`,
      );
    edges = (edgeData ?? []) as typeof edges;
  }

  if (nodeIds.length > 0) {
    // Recency bump. v373.5: must await on Workers — fire-and-forget silently
    // no-ops as the isolate terminates at HTTP response time. ~30ms latency
    // cost is acceptable for the cache-warmth signal it preserves.
    try {
      await sb
        .from("knowledge_nodes")
        .update({ last_referenced_at: new Date().toISOString() })
        .in("id", nodeIds);
    } catch (e) {
      console.error(
        "knowledge_nodes recency bump failed:",
        e instanceof Error ? e.message : e,
      );
    }
  }

  return {
    status: 200,
    body: {
      nodes: nodeRows.map((n) => ({
        id: n.id,
        nodeType: n.node_type,
        title: n.title,
        content: n.content,
        context: n.context,
        lookupKey: n.lookup_key,
        lookupType: n.lookup_type,
        weight: n.weight,
        attachments: n.attachments,
        source: n.source,
        sourceRef: n.source_ref,
        createdAt: n.created_at,
        lastReferencedAt: n.last_referenced_at,
      })),
      edges: edges.map((e) => ({
        id: e.id,
        sourceNodeId: e.source_node_id,
        targetNodeId: e.target_node_id,
        edgeType: e.edge_type,
        weight: e.weight,
      })),
    },
  };
}

// ── /api/memory-graph/upsert ────────────────────────────────────────────────

const MAX_NODES_PER_CALL = 25;
const MAX_EDGES_PER_CALL = 50;

const VALID_EDGE_TYPES = new Set([
  "reinforces",
  "contradicts",
  "extends",
  "caused_by",
  "applies_to",
]);

export async function executeMemoryGraphUpsert(
  agent: ConnectedAgentRow,
  body: unknown,
): Promise<HelperResult> {
  const b = isPlainObject(body) ? body : {};

  const nodesIn = Array.isArray(b.nodes) ? (b.nodes as Record<string, unknown>[]) : [];
  const edgesIn = Array.isArray(b.edges) ? (b.edges as Record<string, unknown>[]) : [];

  if (nodesIn.length === 0 && edgesIn.length === 0) {
    return {
      status: 400,
      body: { error: "Provide at least one node or edge." },
    };
  }
  if (nodesIn.length > MAX_NODES_PER_CALL) {
    return {
      status: 400,
      body: { error: `Too many nodes in one call (max ${MAX_NODES_PER_CALL}).` },
    };
  }
  if (edgesIn.length > MAX_EDGES_PER_CALL) {
    return {
      status: 400,
      body: { error: `Too many edges in one call (max ${MAX_EDGES_PER_CALL}).` },
    };
  }

  const sb = admin();
  if (!sb) return { status: 500, body: { error: "Server not configured." } };

  const nodeIds: string[] = [];
  const titleToId = new Map<string, string>();

  for (const raw of nodesIn) {
    const nodeType = asString(raw.nodeType, 60);
    const title = asString(raw.title, 240);
    const content = asString(raw.content, 16000);
    if (!nodeType || !title || !content) {
      return {
        status: 400,
        body: { error: "Each node needs nodeType, title, and content." },
      };
    }
    const context = asString(raw.context, 120);
    const lookupKey = asString(raw.lookupKey, 240);
    const lookupType = asString(raw.lookupType, 60);
    const sourceRef = asString(raw.sourceRef, 240);
    const weight =
      typeof raw.weight === "number" && Number.isFinite(raw.weight)
        ? raw.weight
        : 1.0;
    const attachments = Array.isArray(raw.attachments) ? raw.attachments : [];

    let existingId: string | null = null;
    if (lookupKey || lookupType) {
      const probe = sb
        .from("knowledge_nodes")
        .select("id")
        .eq("user_id", agent.user_id)
        .eq("title", title);
      if (lookupKey) probe.eq("lookup_key", lookupKey);
      if (lookupType) probe.eq("lookup_type", lookupType);
      const { data: hit } = await probe.maybeSingle();
      if (hit?.id) existingId = hit.id;
    }

    if (existingId) {
      await sb
        .from("knowledge_nodes")
        .update({
          node_type: nodeType,
          content,
          context,
          weight,
          attachments: attachments as Json,
          source: "agent-upsert",
          source_ref: sourceRef,
          connected_agent_id: agent.id,
          updated_at: new Date().toISOString(),
          last_referenced_at: new Date().toISOString(),
        })
        .eq("id", existingId);
      nodeIds.push(existingId);
      titleToId.set(title, existingId);
    } else {
      const { data: ins, error: insErr } = await sb
        .from("knowledge_nodes")
        .insert({
          user_id: agent.user_id,
          node_type: nodeType,
          title,
          content,
          context,
          lookup_key: lookupKey,
          lookup_type: lookupType,
          weight,
          attachments: attachments as Json,
          source: "agent-upsert",
          source_ref: sourceRef,
          connected_agent_id: agent.id,
        })
        .select("id")
        .single();
      if (insErr || !ins) {
        return {
          status: 500,
          body: {
            error: `Couldn't insert node: ${insErr?.message ?? "no row"}`,
          },
        };
      }
      nodeIds.push(ins.id);
      titleToId.set(title, ins.id);
    }
  }

  const edgeIds: string[] = [];
  for (const raw of edgesIn) {
    const sourceTitle = asString(raw.sourceTitle, 240);
    const targetTitle = asString(raw.targetTitle, 240);
    const edgeType = asString(raw.edgeType, 60);
    if (!sourceTitle || !targetTitle || !edgeType) {
      return {
        status: 400,
        body: {
          error: "Each edge needs sourceTitle, targetTitle, and edgeType.",
        },
      };
    }
    if (!VALID_EDGE_TYPES.has(edgeType)) {
      return {
        status: 400,
        body: {
          error: `edgeType must be one of: ${Array.from(VALID_EDGE_TYPES).join(", ")}.`,
        },
      };
    }

    const sourceId = await resolveTitle(
      sb,
      agent.user_id,
      sourceTitle,
      titleToId,
    );
    const targetId = await resolveTitle(
      sb,
      agent.user_id,
      targetTitle,
      titleToId,
    );
    if (!sourceId || !targetId) {
      return {
        status: 400,
        body: {
          error: `Couldn't find a node with title "${!sourceId ? sourceTitle : targetTitle}". Upsert the node first.`,
        },
      };
    }

    const weight =
      typeof raw.weight === "number" && Number.isFinite(raw.weight)
        ? raw.weight
        : 1.0;

    const { data: existingEdge } = await sb
      .from("knowledge_edges")
      .select("id, weight")
      .eq("source_node_id", sourceId)
      .eq("target_node_id", targetId)
      .eq("edge_type", edgeType)
      .maybeSingle();

    if (existingEdge) {
      await sb
        .from("knowledge_edges")
        .update({ weight: Number(existingEdge.weight) + 0.1 })
        .eq("id", existingEdge.id);
      edgeIds.push(existingEdge.id);
    } else {
      const { data: ins, error: insErr } = await sb
        .from("knowledge_edges")
        .insert({
          user_id: agent.user_id,
          source_node_id: sourceId,
          target_node_id: targetId,
          edge_type: edgeType,
          weight,
        })
        .select("id")
        .single();
      if (insErr || !ins) {
        return {
          status: 500,
          body: { error: `Couldn't insert edge: ${insErr?.message ?? "no row"}` },
        };
      }
      edgeIds.push(ins.id);
    }
  }

  return { status: 201, body: { nodeIds, edgeIds } };
}

async function resolveTitle(
  sb: ReturnType<typeof admin>,
  userId: string,
  title: string,
  cache: Map<string, string>,
): Promise<string | null> {
  if (!sb) return null;
  const cached = cache.get(title);
  if (cached) return cached;
  const { data } = await sb
    .from("knowledge_nodes")
    .select("id")
    .eq("user_id", userId)
    .eq("title", title)
    .order("last_referenced_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (data?.id) {
    cache.set(title, data.id);
    return data.id;
  }
  return null;
}

// ── Resolution callback (used by inbox approve/reject/discuss) ──────────────
// Re-exported here so the API layer doesn't need to know about the helper
// vs. transport split.
export { deliverResolution };
