/**
 * Vertex / non-repo agent platform helpers.
 *
 * Phase 3.5 — first non-repo platform link. The pattern mirrors github-app.ts
 * but the auth model is different: instead of an OAuth round-trip, the user
 * pastes the agent's identifier into Agentiport and receives a bearer key
 * scoped to that one connected_agents row. The agent then carries that key
 * when calling our public endpoints (/api/escalate, /api/memory-graph/*).
 *
 * Storage rule: we never store the raw key. Only the first 8 chars (for UI
 * display + DB index lookup) and a sha256 hash. Verification is constant-time
 * against the hash.
 */
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

export type ConnectedAgentRow = {
  id: string;
  user_id: string;
  platform: "vertex";
  agent_name: string;
  agent_identifier: string;
  invoke_endpoint: string | null;
  deeplink_url: string | null;
  callback_secret: string | null;
  metadata: Record<string, unknown>;
  installed_at: string;
};

const KEY_PREFIX_TAG = "agp_v_";
const KEY_PREFIX_LEN = 8;
const CALLBACK_SECRET_TAG = "agp_cb_";
const WEBHOOK_TIMEOUT_MS = 5_000;

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

/**
 * Mint a fresh bearer key for a connected agent.
 *
 * Returns { rawKey, prefix, hash } — rawKey is shown to the user once at
 * link time. After that, only prefix + hash live in the database, so an
 * attacker reading the table can't impersonate the agent.
 */
export function mintAgentApiKey(): {
  rawKey: string;
  prefix: string;
  hash: string;
} {
  // 32 random bytes → base64url (43 chars), tagged so a leaked key is
  // identifiable in logs / git history grep.
  const random = crypto.randomBytes(32).toString("base64url");
  const rawKey = `${KEY_PREFIX_TAG}${random}`;
  const prefix = rawKey.slice(0, KEY_PREFIX_LEN);
  const hash = sha256Hex(rawKey);
  return { rawKey, prefix, hash };
}

export function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

/**
 * Mint an outbound-webhook signing secret.
 *
 * Stored plaintext (we need to recompute HMAC at delivery time, can't hash).
 * Surfaced to the user once at link time — they configure their relay to
 * verify `X-Agentiport-Signature` against the same secret. Rotation = remove +
 * re-link the agent.
 */
export function mintCallbackSecret(): string {
  return `${CALLBACK_SECRET_TAG}${crypto.randomBytes(32).toString("base64url")}`;
}

/**
 * Pull the bearer key from an incoming Request.
 *
 * Accepts (in order of preference):
 *   1. `Authorization: Bearer <key>` — standard
 *   2. `X-Agentiport-Key: <key>` — some agent platforms reserve Authorization
 *   3. `?key=<key>` query param — for MCP clients that don't yet support
 *      auth headers (Vertex Agent Studio's MCP config as of 2026-05-07
 *      has auth options gated as "Coming soon"). This is a documented
 *      MCP pattern — the URL with embedded token is stored once at
 *      configuration time, sent over HTTPS, and the key remains scoped +
 *      revocable. Tradeoff: URL may appear in server access logs (we
 *      control those). Mitigation: rotate the key if the URL leaks.
 */
export function readBearerKey(request: Request): string | null {
  const auth = request.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    const tok = auth.slice("Bearer ".length).trim();
    if (tok) return tok;
  }
  const xKey = request.headers.get("x-agentiport-key");
  if (xKey?.trim()) return xKey.trim();
  try {
    const qKey = new URL(request.url).searchParams.get("key");
    if (qKey?.trim()) return qKey.trim();
  } catch {
    // Bad URL — fall through to null
  }
  return null;
}

/**
 * Verify a raw bearer key against the hashed key on a connected_agents row.
 *
 * Indexed lookup is by api_key_prefix (cheap, narrow). Final compare is
 * constant-time against the hash so an attacker can't time-attack their way
 * to a valid key.
 *
 * Returns the row on success, null on any failure path. We never throw —
 * the caller decides whether to 401 or do something subtler.
 */
export async function verifyAgentBearer(
  rawKey: string,
): Promise<ConnectedAgentRow | null> {
  if (!rawKey || !rawKey.startsWith(KEY_PREFIX_TAG)) return null;
  const prefix = rawKey.slice(0, KEY_PREFIX_LEN);
  const expectedHash = sha256Hex(rawKey);

  const sb = admin();
  const { data, error } = await sb
    .from("connected_agents")
    .select(
      "id, user_id, platform, agent_name, agent_identifier, invoke_endpoint, deeplink_url, callback_secret, metadata, installed_at, api_key_hash",
    )
    .eq("api_key_prefix", prefix)
    .is("removed_at", null);

  if (error || !data || data.length === 0) return null;

  // Constant-time compare across all matching prefixes (collision unlikely
  // but possible — handle correctly).
  const expectedBuf = Buffer.from(expectedHash, "utf8");
  for (const row of data) {
    const stored = (row as { api_key_hash: string }).api_key_hash;
    if (!stored) continue;
    const storedBuf = Buffer.from(stored, "utf8");
    if (storedBuf.length !== expectedBuf.length) continue;
    if (crypto.timingSafeEqual(storedBuf, expectedBuf)) {
      // Touch last_used_at — must be awaited. Fire-and-forget (`void ...`)
      // doesn't survive Cloudflare Worker termination: when the request
      // returns, any unawaited Promise gets killed and the update never
      // commits. Cost is ~30ms per auth call, which is fine.
      await sb
        .from("connected_agents")
        .update({ last_used_at: new Date().toISOString() })
        .eq("id", (row as { id: string }).id);

      const r = row as unknown as ConnectedAgentRow & { api_key_hash: string };
      const { api_key_hash: _ignored, ...rest } = r;
      void _ignored;
      return rest as ConnectedAgentRow;
    }
  }
  return null;
}

/**
 * Reject callback URLs that point at private / loopback / link-local space.
 *
 * Cloudflare Workers' fetch() can't generally route to private IPs anyway, but
 * a defense-in-depth check at the URL layer catches obvious misconfigs early
 * (and returns a clearer error than a generic network failure). Note: this is
 * a string-form check only — DNS rebinding can return a public IP at insert
 * time and a private one at delivery. Acceptable for v1; the Worker runtime
 * is the real boundary.
 */
export function isPublicHttpsUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (/^127\./.test(host)) return false;
  if (/^10\./.test(host)) return false;
  if (/^192\.168\./.test(host)) return false;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)) return false;
  if (/^169\.254\./.test(host)) return false;
  if (/^0\./.test(host)) return false;
  if (host === "::1") return false;
  if (host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) {
    return false;
  }
  return true;
}

export type DeliverResolutionPayload = {
  escalationId: string;
  status: "approved" | "rejected" | "discussed";
  resolution: string | null;
  originalPayload?: Record<string, unknown>;
};

/**
 * Outbound resolution webhook.
 *
 * One inline attempt with a 5s timeout — if it fails, the piggyback path on
 * the agent's next MCP tools/call will deliver the same resolution in-band
 * (see api.mcp.ts). The two channels are complementary, so we don't need a
 * retry queue here.
 *
 * Body is HMAC-SHA256 signed when callback_secret is set:
 *
 *   X-Agentiport-Signature: sha256=<hex(hmac(secret, "<ts>." + body))>
 *   X-Agentiport-Timestamp: <unix-seconds>
 *
 * Receivers should reject if |now - timestamp| > 300s and the signature
 * doesn't constant-time match. Pre-existing agents with a null secret get
 * unsigned posts (legacy compat); rotation = remove + re-link.
 */
export async function deliverResolution(
  agent: Pick<
    ConnectedAgentRow,
    "id" | "agent_name" | "invoke_endpoint" | "callback_secret"
  >,
  payload: DeliverResolutionPayload,
): Promise<{ delivered: boolean; error?: string }> {
  if (!agent.invoke_endpoint) return { delivered: false };
  if (!isPublicHttpsUrl(agent.invoke_endpoint)) {
    return {
      delivered: false,
      error: "Callback URL must be public HTTPS (private/loopback rejected).",
    };
  }

  const body = JSON.stringify({
    event: "escalation.resolved",
    escalationId: payload.escalationId,
    agentId: agent.id,
    agentName: agent.agent_name,
    resolution: payload.status,
    resolutionNote: payload.resolution,
    resolvedAt: new Date().toISOString(),
    originalPayload: payload.originalPayload ?? {},
  });

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "Agentiport/1.0",
    "X-Agentiport-Event": "escalation.resolved",
    "X-Agentiport-Timestamp": timestamp,
  };
  if (agent.callback_secret) {
    const sig = crypto
      .createHmac("sha256", agent.callback_secret)
      .update(`${timestamp}.${body}`)
      .digest("hex");
    headers["X-Agentiport-Signature"] = `sha256=${sig}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const res = await fetch(agent.invoke_endpoint, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      return {
        delivered: false,
        error: `endpoint returned ${res.status}`,
      };
    }
    return { delivered: true };
  } catch (e) {
    return {
      delivered: false,
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(timer);
  }
}
