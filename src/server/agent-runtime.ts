/**
 * Agent runtime — Gemini-direct generateContent + native function-calling loop.
 *
 * Persona-agnostic: the same runtime serves Spa Karen, Rep Liz, and any
 * future persona on the platform. Caller passes in the system prompt and
 * persona name via AgentConfig; runtime handles auth, model invocation,
 * tool dispatching, and conversation looping.
 *
 * Renamed/refactored from karen-runtime.ts (v248) on 2026-05-09 as part
 * of the productization parallel-dev kickoff. Same Gemini auth, same
 * tool declarations, same function-calling loop — just parameterized so
 * Liz can share the same brain wiring.
 *
 * Auth: VERTEX_SA_JSON Cloudflare secret (Vertex publishers/google/models
 * accepts the same OAuth2 cloud-platform-scope token).
 *
 * Tool calling: Gemini's native function calling. Three tools matching
 * the agentiport_memory_graph_query / escalate / memory_graph_upsert MCP
 * tools, executed via existing executors in agentiport-tools.ts (no MCP
 * round-trip — server-side direct dispatch). Loop max 8 iterations.
 *
 * Required env: VERTEX_SA_JSON
 * Optional env: GEMINI_MODEL (default 'gemini-2.5-pro'), GEMINI_LOCATION
 *               (default 'us-central1')
 */

import {
  executeMemoryGraphQuery,
  executeEscalate,
  executeMemoryGraphUpsert,
  type HelperResult,
} from "@/server/agentiport-tools";
import type { ConnectedAgentRow } from "@/server/vertex-platform";
import {
  loadServiceAccount,
  getVertexAccessToken,
  type ServiceAccountKey,
} from "@/server/google-auth";

// ── Runtime constants ───────────────────────────────────────────────────────
// (Google service-account auth + token caching moved to @/server/google-auth
// as of v267 — single source of truth, shared cache with gemini-extract.)

const RUNTIME_TIMEOUT_MS = 30_000;
const MAX_TOOL_LOOP_ITERATIONS = 8;

// ── Persona configuration ───────────────────────────────────────────────────

export type AgentConfig = {
  /** Full system instruction passed to the model on every call. */
  systemPrompt: string;
  /** Persona name for log identification (e.g. "Karen", "Liz"). */
  personaName: string;
};

// ── Conversation history (persona-agnostic) ─────────────────────────────────

export type AgentTurn = {
  role: "user" | "agent";
  body: string;
};

export type RuntimeReply = {
  replyText: string;
  /** Tool-loop iteration count for diagnostics. */
  iterations: number;
  /**
   * Gemini's terminating finishReason from the last response (e.g. "STOP",
   * "MAX_TOKENS", "SAFETY", "RECITATION"). Stored in agent_chat_turns.metadata
   * so the diag surface can flag silent truncations.
   */
  finishReason?: string;
};

// ── Tool declarations (Gemini function-calling format) ──────────────────────
// Same set for all personas; the system prompt directs which tools to use.

const TOOL_DECLARATIONS = [
  {
    name: "agentiport_memory_graph_query",
    description:
      "Read institutional knowledge from the user's Knowledge Base. Returns nodes (clients, accounts, policies, decisions, patterns, rationales, products, promotions, manufacturer-tier-rule, product-comparison) and edges scoped to the user, ranked by recency × relevance. Call this BEFORE every meaningful reply to ground reasoning in actual institutional memory. Common queries: lookup a client/account by phone/name (lookupKey: '+15555550100' or 'Rejuv', lookupType: 'client' or 'account'), pull active promotions (nodeType: 'promotion'), product knowledge (nodeType: 'product', query: 'Botox'), manufacturer tier rules (nodeType: 'manufacturer-tier-rule', query: 'galderma mid-tier'), product comparisons (nodeType: 'product-comparison', query: 'volbella'), free-text search. CRITICAL: when the rep is acting as one specific manufacturer (the system prompt prefix will say so), ALWAYS pass `repAssignment` to scope account queries to THEIR territory — without it you'll get all 73 accounts across all 4 reps and produce wrong rankings.",
    parameters: {
      type: "OBJECT",
      properties: {
        context: {
          type: "STRING",
          description: "Namespace (e.g. 'rejuv-client', 'rejuv-ethics', 'galderma-promo').",
        },
        lookupKey: {
          type: "STRING",
          description: "Exact-match key — phone, account name, ticket id, etc.",
        },
        lookupType: {
          type: "STRING",
          description:
            "Free-form taxonomy ('client', 'account', 'policy', 'service', 'product', etc.).",
        },
        nodeType: {
          type: "STRING",
          description:
            "Filter by node type ('policy','convention','service','pattern','rationale','decision','preference','product','promotion','note','manufacturer-tier-rule','product-comparison').",
        },
        query: {
          type: "STRING",
          description: "Full-text search fragment (matches title + content).",
        },
        limit: {
          type: "INTEGER",
          description: "Max nodes returned (1..100). Default 30. Bump higher when answering territory-wide questions where the rep has 50+ accounts.",
        },
        repAssignment: {
          type: "STRING",
          description:
            "Filter accounts by rep ownership. One of 'allergan-rep' | 'galderma-rep' | 'evolus-rep' | 'merz-rep'. Matches against attachments.rep_assignment on each node. PASS THIS on every account-level question when the system prompt has told you 'You are talking to a <X> rep right now' — otherwise the result set includes other reps' books and your rankings will be wrong. Leave empty only when (a) the rep is in Generalist mode or (b) they explicitly asked about a different manufacturer's territory.",
        },
      },
    },
  },
  {
    name: "agentiport_memory_graph_upsert",
    description:
      "Crystallize a fact the agent learned this conversation into the user's Knowledge Base. Idempotent — re-asserting the same (lookupType, lookupKey, title) tuple updates the existing node. Use this after every meaningful conversation to make the next message smarter. Keep nodes tight — one node per insight, don't dump the whole conversation.",
    parameters: {
      type: "OBJECT",
      properties: {
        nodes: {
          type: "ARRAY",
          description: "Nodes to upsert (max 25 per call).",
          items: {
            type: "OBJECT",
            properties: {
              nodeType: { type: "STRING" },
              title: { type: "STRING" },
              content: { type: "STRING" },
              context: { type: "STRING" },
              lookupKey: { type: "STRING" },
              lookupType: { type: "STRING" },
              weight: { type: "NUMBER" },
              sourceRef: { type: "STRING" },
            },
            required: ["nodeType", "title", "content"],
          },
        },
        edges: {
          type: "ARRAY",
          description: "Edges to upsert (max 50 per call).",
          items: {
            type: "OBJECT",
            properties: {
              sourceTitle: { type: "STRING" },
              targetTitle: { type: "STRING" },
              edgeType: {
                type: "STRING",
                enum: [
                  "reinforces",
                  "contradicts",
                  "extends",
                  "caused_by",
                  "applies_to",
                ],
              },
              weight: { type: "NUMBER" },
            },
            required: ["sourceTitle", "targetTitle", "edgeType"],
          },
        },
      },
    },
  },
  {
    name: "agentiport_escalate",
    description:
      "Escalate a decision to the user's Agentiport CEO inbox. Use when reasoning hits uncertainty (grey-area ethics, urgent medical concern, upset client, precedent-setting request, agentConfidence < 0.7). When you call this, tell the human client 'let me check with David and circle back' — don't pretend you handled it.",
    parameters: {
      type: "OBJECT",
      properties: {
        prompt: {
          type: "STRING",
          description:
            "One-sentence, decision-shaped question for the human (e.g. 'Should I book Olivia (20yo, mom is VIP) for lip filler?').",
        },
        reasoning: {
          type: "STRING",
          description: "The agent's chain of thought leading to the escalation.",
        },
        urgency: {
          type: "STRING",
          enum: ["low", "normal", "high"],
        },
        contextKey: { type: "STRING" },
        contextPayload: { type: "OBJECT" },
        agentConfidence: { type: "NUMBER" },
        channel: {
          type: "STRING",
          enum: ["sms", "vertex"],
          description:
            "Customer's channel. Set to 'sms' when the user message preamble starts with [CHANNEL: sms] — Agentiport will route the resolution back via SMS to the customer's phone.",
        },
        customerPhone: {
          type: "STRING",
          description:
            "Customer's E.164 phone (e.g. +13035551234). REQUIRED when channel='sms'. Take it verbatim from the [CUSTOMER: +1...] preamble.",
        },
      },
      required: ["prompt"],
    },
  },
] as const;

const TOOL_EXECUTORS: Record<
  string,
  (agent: ConnectedAgentRow, args: unknown) => Promise<HelperResult>
> = {
  agentiport_memory_graph_query: executeMemoryGraphQuery,
  agentiport_memory_graph_upsert: executeMemoryGraphUpsert,
  agentiport_escalate: executeEscalate,
};

// ── Gemini generateContent shape ────────────────────────────────────────────

type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

type GeminiContent = {
  role: "user" | "model" | "function";
  parts: GeminiPart[];
};

type GeminiResponse = {
  candidates?: Array<{
    content?: { parts?: GeminiPart[]; role?: string };
    finishReason?: string;
  }>;
  promptFeedback?: unknown;
};

async function generateContent(
  sa: ServiceAccountKey,
  systemPrompt: string,
  contents: GeminiContent[],
): Promise<GeminiResponse> {
  const model = process.env.GEMINI_MODEL ?? "gemini-2.5-pro";
  const location = process.env.GEMINI_LOCATION ?? "us-central1";
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${sa.project_id}/locations/${location}/publishers/google/models/${model}:generateContent`;

  const accessToken = await getVertexAccessToken(sa);

  const body = JSON.stringify({
    contents,
    systemInstruction: { parts: [{ text: systemPrompt }] },
    tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
    generationConfig: {
      // v302: lowered 0.7 → 0.2 after Grasshopper flagged non-determinism
      // on factual lookups — reps want the same answer to the same question,
      // not a chatty new wrapper every time. 0.2 keeps natural phrasing
      // without inviting the model to embellish or improvise across runs.
      temperature: 0.2,
      // Gemini 2.5 Pro is a thinking model: internal reasoning tokens count
      // against this budget. 1024 was leaving Liz with so little room post-
      // thinking that synthesis responses were getting cut mid-sentence
      // (see v298→v299 cliffhanger bug — "...currently at the 'High-Volume").
      // 8192 leaves comfortable headroom for any normal Liz/Karen reply.
      maxOutputTokens: 8192,
    },
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RUNTIME_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `Gemini generateContent failed (${res.status}): ${errText.slice(0, 600)}`,
    );
  }
  return (await res.json()) as GeminiResponse;
}

// ── The function-calling loop — persona-agnostic ────────────────────────────

/**
 * Run one user-input turn through the agent's tool-using loop.
 *
 * @param agent      The connected_agents row (id + user_id used by tool executors)
 * @param history    Prior turns oldest → newest (role + body); empty for fresh sessions
 * @param userMessage The fresh user input (caller may prepend channel preamble for SMS, etc.)
 * @param config     Persona configuration (system prompt + name)
 */
export async function callAgent(
  agent: ConnectedAgentRow,
  history: AgentTurn[],
  userMessage: string,
  config: AgentConfig,
): Promise<RuntimeReply> {
  const sa = loadServiceAccount();
  const logTag = `[agent-runtime:${config.personaName}]`;

  // Map history into Gemini multi-turn contents, then append the new turn.
  const contents: GeminiContent[] = [
    ...history.map<GeminiContent>((t) => ({
      role: t.role === "user" ? "user" : "model",
      parts: [{ text: t.body }],
    })),
    { role: "user", parts: [{ text: userMessage }] },
  ];

  for (let i = 0; i < MAX_TOOL_LOOP_ITERATIONS; i++) {
    const response = await generateContent(sa, config.systemPrompt, contents);
    const candidate = response.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const finishReason = candidate?.finishReason;

    if (finishReason && finishReason !== "STOP") {
      console.warn(
        `${logTag} non-STOP finishReason=${finishReason} iter=${i + 1}`,
      );
    }

    if (parts.length === 0) {
      console.error(
        `${logTag} empty candidate parts finishReason=${finishReason ?? "?"}`,
        JSON.stringify(response).slice(0, 400),
      );
      return { replyText: "", iterations: i + 1, finishReason };
    }

    const functionCalls = parts.filter(
      (p): p is Extract<GeminiPart, { functionCall: unknown }> =>
        "functionCall" in p,
    );

    if (functionCalls.length === 0) {
      // Pure text reply — collect and return.
      const textParts = parts
        .filter((p): p is Extract<GeminiPart, { text: string }> => "text" in p)
        .map((p) => p.text);
      return {
        replyText: textParts.join("").trim(),
        iterations: i + 1,
        finishReason,
      };
    }

    // Append the model's function-call turn to the conversation.
    contents.push({ role: "model", parts });

    // Execute each function call and assemble a function-response turn.
    const responseParts: GeminiPart[] = [];
    for (const part of functionCalls) {
      const { name, args } = part.functionCall;
      const executor = TOOL_EXECUTORS[name];
      if (!executor) {
        responseParts.push({
          functionResponse: {
            name,
            response: { error: `Unknown tool: ${name}` },
          },
        });
        continue;
      }
      try {
        const result = await executor(agent, args);
        responseParts.push({
          functionResponse: {
            name,
            response: result.body,
          },
        });
      } catch (e) {
        responseParts.push({
          functionResponse: {
            name,
            response: {
              error: e instanceof Error ? e.message : String(e),
            },
          },
        });
      }
    }
    contents.push({ role: "function", parts: responseParts });
  }

  console.error(
    `${logTag} hit MAX_TOOL_LOOP_ITERATIONS=${MAX_TOOL_LOOP_ITERATIONS} without a text reply`,
  );
  return { replyText: "", iterations: MAX_TOOL_LOOP_ITERATIONS };
}
