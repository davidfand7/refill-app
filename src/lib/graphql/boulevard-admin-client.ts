/**
 * Boulevard Admin API GraphQL client (v1.36.0).
 *
 * Boulevard's Admin API is a GraphQL endpoint at dapi.joinblvd.com (vs
 * Acuity/Mindbody/Square's REST). This file is the substrate that makes
 * the GraphQL divergence absorbable by the existing connector pattern
 * — `src/lib/schedulers/boulevard.ts` builds typed query/mutation
 * functions on top of this generic POST wrapper, so the connector keeps
 * the same shape as `src/lib/schedulers/{acuity,square}.ts`.
 *
 * Boulevard divergences from Acuity/Square (relevant to this wrapper):
 *   - All Admin operations POST to a single endpoint (NOT REST paths)
 *     with `{query, variables}` JSON body.
 *   - Auth: Basic auth header `Basic base64(api_key:api_secret)` —
 *     app-level credentials, NOT per-spa access tokens. The businessId
 *     URN scopes the operation, passed as a query param OR variable.
 *   - GraphQL errors land in a top-level `errors[]` array alongside
 *     `data`. HTTP 200 + errors[] means "request was syntactically
 *     valid but rejected" — we surface those as exceptions just like a
 *     non-2xx REST status.
 *   - Boulevard IDs are URN-format strings (e.g.
 *     `urn:blvd:Business:abc123`). Helpers below normalize them to
 *     opaque strings + extract typed parts when needed.
 *
 * Pinned: Boulevard API version, sent as URL path component. Boulevard
 * uses date-style versions (e.g. /2020-01); we pin one constant here
 * and rev deliberately during quarterly maintenance, not silently per
 * request — same discipline as Square's Square-Version header.
 *
 * What's stubbed pending sandbox-verify (per platforms-pre-built
 * doctrine, this lands ARCHITECTURE-COMPLETE; the specific endpoint
 * host + path may need a one-line edit once Boulevard's 48hr approval
 * clears + we can hit the sandbox):
 *   - Exact API endpoint host (assumed `https://dapi.joinblvd.com`)
 *   - Exact version path component (assumed `/2020-01`)
 *   - Whether business scoping happens via URL or variable
 *
 * Docs:
 *   https://developers.joinblvd.com/reference/introduction-to-the-admin-api
 *   https://developers.joinblvd.com/reference/authentication
 */

// ─── Constants ─────────────────────────────────────────────────────────────

const BOULEVARD_API_BASE_PROD = "https://dapi.joinblvd.com";
const BOULEVARD_API_BASE_SANDBOX = "https://sandbox-dapi.joinblvd.com";

/**
 * Boulevard API version — pinned to a known-stable date and revved
 * deliberately, NOT silently per request. Boulevard appends this to
 * the URL path (e.g. /2020-01/admin) per their reference docs.
 *
 * v1.36.0 lands with the same value as the spec scout; revisit during
 * sandbox-verify if Boulevard's docs surface a newer pin we want.
 */
export const BOULEVARD_API_VERSION = "2020-01";

export type BoulevardEnv = "production" | "sandbox";

export function boulevardApiBase(env: BoulevardEnv): string {
  return env === "sandbox"
    ? BOULEVARD_API_BASE_SANDBOX
    : BOULEVARD_API_BASE_PROD;
}

export function boulevardAdminPath(): string {
  return `/${BOULEVARD_API_VERSION}/admin`;
}

// ─── URN handling ──────────────────────────────────────────────────────────

/**
 * Boulevard IDs are URN-format strings like `urn:blvd:Business:abc123`.
 * Callers occasionally need the trailing opaque part (for display, for
 * idempotency keys); occasionally need the type prefix (for routing).
 * Both helpers tolerate non-URN inputs — they return the input
 * unchanged. That makes the connector code robust against Boulevard
 * sometimes returning bare IDs in nested fields.
 */
export type BoulevardUrn = string;

export function isBoulevardUrn(s: string | null | undefined): s is BoulevardUrn {
  return typeof s === "string" && s.startsWith("urn:blvd:");
}

export function parseBoulevardUrn(
  urn: string,
): { type: string; id: string } | null {
  if (!isBoulevardUrn(urn)) return null;
  const parts = urn.split(":");
  if (parts.length < 4) return null;
  return { type: parts[2], id: parts.slice(3).join(":") };
}

export function boulevardUrnTail(urn: string): string {
  const parsed = parseBoulevardUrn(urn);
  return parsed?.id ?? urn;
}

// ─── Errors ────────────────────────────────────────────────────────────────

export type BoulevardGraphQLError = {
  message: string;
  path?: (string | number)[];
  extensions?: Record<string, unknown>;
};

export class BoulevardGraphQLException extends Error {
  readonly errors: BoulevardGraphQLError[];
  readonly httpStatus: number;
  constructor(httpStatus: number, errors: BoulevardGraphQLError[]) {
    const summary = errors.map((e) => e.message).join("; ") || "GraphQL error";
    super(`Boulevard GraphQL [${httpStatus}]: ${summary}`);
    this.name = "BoulevardGraphQLException";
    this.errors = errors;
    this.httpStatus = httpStatus;
  }
}

// ─── Auth header ───────────────────────────────────────────────────────────

/**
 * Boulevard Admin API uses HTTP Basic auth with api_key:api_secret.
 * The businessId URN scopes the operation and is passed as a variable
 * or query param, NOT as an auth identifier. App-level credentials
 * (single key pair for all our spas) — divergent from Square's per-spa
 * 30-day OAuth tokens.
 */
export function boulevardBasicAuth(apiKey: string, apiSecret: string): string {
  const pair = `${apiKey}:${apiSecret}`;
  if (typeof btoa === "function") return `Basic ${btoa(pair)}`;
  // Node fallback for SSR / Worker environments where btoa is present
  // but not globally typed.
  return `Basic ${Buffer.from(pair, "utf-8").toString("base64")}`;
}

// ─── Generic POST ──────────────────────────────────────────────────────────

export type BoulevardGraphQLResponse<T> = {
  data: T | null;
  errors: BoulevardGraphQLError[] | null;
};

/**
 * Generic GraphQL POST. All Boulevard Admin calls route through here
 * so error normalization + auth header + version pinning happen in one
 * place — mirror of `squareFetch` in `src/lib/schedulers/square.ts`.
 *
 * On any 4xx/5xx OR on a 200 with non-empty `errors[]` array, throws
 * `BoulevardGraphQLException` so callers can catch + handle uniformly.
 */
export async function boulevardGraphQL<T>(args: {
  env: BoulevardEnv;
  apiKey: string;
  apiSecret: string;
  query: string;
  variables?: Record<string, unknown>;
  businessId?: BoulevardUrn;
}): Promise<T> {
  const url = `${boulevardApiBase(args.env)}${boulevardAdminPath()}`;
  // v1.35.x doctrine: bubble provider error text into thrown messages
  // so the OAuth callback layer can sanitize + surface in redirect URLs.
  // Same pattern that v1.35.4 added to the Square token exchange.
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: boulevardBasicAuth(args.apiKey, args.apiSecret),
      "Content-Type": "application/json",
      Accept: "application/json",
      // Boulevard scopes Admin operations to a single business via
      // a header. The exact header name is pinned at sandbox-verify;
      // assumption from the spec scout is `Business`. If Boulevard
      // actually wants the URN in a variable instead, this header is
      // a no-op + the connector passes businessId in variables.
      ...(args.businessId ? { Business: args.businessId } : {}),
    },
    body: JSON.stringify({
      query: args.query,
      variables: args.variables ?? {},
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new BoulevardGraphQLException(resp.status, [
      { message: text.slice(0, 500) || `HTTP ${resp.status}` },
    ]);
  }

  const json = (await resp.json()) as BoulevardGraphQLResponse<T>;
  if (json.errors && json.errors.length > 0) {
    throw new BoulevardGraphQLException(resp.status, json.errors);
  }
  if (json.data == null) {
    throw new BoulevardGraphQLException(resp.status, [
      { message: "Boulevard returned 200 but `data` was null." },
    ]);
  }
  return json.data;
}
