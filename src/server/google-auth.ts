/**
 * Shared Google service-account auth — JWT-Bearer token mint with caching.
 *
 * v267: extracted from agent-runtime.ts + gemini-extract.ts which independently
 * implemented the same Vertex / Google APIs auth flow. Service-account auth is
 * security-sensitive — code duplication increases the chance of divergent
 * fixes (e.g., a constant-time comparison hardening would have to land in two
 * places). Single helper means one place to update.
 *
 * Bonus: the token cache is now shared across both callers (previously each
 * file maintained an independent cache, doubling token-mint requests every
 * 55 minutes). One cached token now serves both Karen's runtime and the
 * spa-claim Gemini extraction.
 *
 * Required env: VERTEX_SA_JSON — Cloudflare Worker secret containing the
 * full Google service-account JSON key.
 */

import crypto from "node:crypto";

const TOKEN_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const TOKEN_AUDIENCE = "https://oauth2.googleapis.com/token";
const TOKEN_TTL_SECONDS = 3600;
const TOKEN_REFRESH_LEAD_MS = 5 * 60 * 1000;

type CachedToken = { token: string; expiresAt: number };
let tokenCache: CachedToken | null = null;

export type ServiceAccountKey = {
  client_email: string;
  private_key: string;
  project_id: string;
  token_uri?: string;
};

/**
 * Parse + validate the VERTEX_SA_JSON env var. Exposed so callers that need
 * the project_id (for constructing Vertex endpoint URLs) can reuse it.
 */
export function loadServiceAccount(): ServiceAccountKey {
  const raw = process.env.VERTEX_SA_JSON;
  if (!raw) {
    throw new Error(
      "Missing VERTEX_SA_JSON Cloudflare secret — Google APIs unavailable.",
    );
  }
  const parsed = JSON.parse(raw) as ServiceAccountKey;
  if (!parsed.client_email || !parsed.private_key || !parsed.project_id) {
    throw new Error(
      "VERTEX_SA_JSON is missing client_email, private_key, or project_id.",
    );
  }
  return parsed;
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function signServiceAccountJwt(sa: ServiceAccountKey): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: sa.client_email,
    scope: TOKEN_SCOPE,
    aud: sa.token_uri ?? TOKEN_AUDIENCE,
    iat: now - 30,
    exp: now + TOKEN_TTL_SECONDS,
  };
  const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = crypto
    .createSign("RSA-SHA256")
    .update(data)
    .sign(sa.private_key)
    .toString("base64url");
  return `${data}.${sig}`;
}

/**
 * Get a (cached) Google API access token. Mints a fresh one only when the
 * cached token is within `TOKEN_REFRESH_LEAD_MS` of expiry.
 *
 * Pass a service-account object if you've already called `loadServiceAccount`
 * for the project_id; otherwise this loads it for you.
 */
export async function getVertexAccessToken(
  sa?: ServiceAccountKey,
): Promise<string> {
  if (tokenCache && tokenCache.expiresAt - TOKEN_REFRESH_LEAD_MS > Date.now()) {
    return tokenCache.token;
  }
  const account = sa ?? loadServiceAccount();
  const assertion = signServiceAccountJwt(account);
  const res = await fetch(account.token_uri ?? TOKEN_AUDIENCE, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `Google token exchange failed (${res.status}): ${errText.slice(0, 400)}`,
    );
  }
  const json = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!json.access_token) {
    throw new Error("Google token exchange returned no access_token.");
  }
  tokenCache = {
    token: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? TOKEN_TTL_SECONDS) * 1000,
  };
  return json.access_token;
}
