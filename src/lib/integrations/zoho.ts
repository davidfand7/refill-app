/**
 * Zoho CRM OAuth + REST helpers (v1.46.0).
 *
 * Pure helpers — no Supabase, no server-fn registration. Imported by both
 * the OAuth callback route and the server-fn module that handles sync.
 *
 * Region handling: Zoho hosts customer data in multiple datacenters (US,
 * EU, IN, AU, JP, CA). The OAuth callback returns an `accounts-server`
 * query param indicating which datacenter — we derive the API base from
 * that and store BOTH so token refresh and CRM calls hit the right region.
 *
 * Auth model: standard OAuth2 with access_type=offline so we get a
 * long-lived refresh token. Access tokens are 1-hour TTL; refresh exchange
 * is cheap and idempotent. No partner approval gate — Refill registers
 * a Server-based App once at api-console.zoho.com, customers consent via
 * the standard OAuth grant screen.
 */

// Scope set chosen for the recall workflow:
//   - contacts.READ + leads.READ → pull the customer book
//   - notes.CREATE → write a recall-touch note when we send a message
//   - tasks.CREATE → optionally create a follow-up reminder on the rep's side
//   - users.READ → identify which Zoho user authorized (display only)
//   - aaaserver.profile.READ → basic profile (email/name)
// offline_access is NOT a scope — refresh tokens are issued by passing
// access_type=offline on the authorize URL.
export const ZOHO_SCOPES = [
  "ZohoCRM.modules.contacts.READ",
  "ZohoCRM.modules.leads.READ",
  "ZohoCRM.modules.notes.CREATE",
  "ZohoCRM.modules.tasks.CREATE",
  "ZohoCRM.users.READ",
  "aaaserver.profile.READ",
].join(",");

// Map Zoho's accounts-server (returned in callback query string) to the
// matching API base. Defaults to US (.com) when missing or unrecognized.
const REGION_MAP: Record<string, string> = {
  "https://accounts.zoho.com": "https://www.zohoapis.com",
  "https://accounts.zoho.eu": "https://www.zohoapis.eu",
  "https://accounts.zoho.in": "https://www.zohoapis.in",
  "https://accounts.zoho.com.au": "https://www.zohoapis.com.au",
  "https://accounts.zoho.jp": "https://www.zohoapis.jp",
  "https://accounts.zohocloud.ca": "https://www.zohoapis.ca",
};

export function deriveApiDomain(accountsServer: string): string {
  return REGION_MAP[accountsServer] ?? "https://www.zohoapis.com";
}

export function normalizeAccountsServer(raw: string | null | undefined): string {
  if (!raw) return "https://accounts.zoho.com";
  // Strip trailing slash + lowercase the host portion.
  const trimmed = raw.replace(/\/+$/, "").trim();
  return REGION_MAP[trimmed] ? trimmed : "https://accounts.zoho.com";
}

// ─── Authorize URL ───────────────────────────────────────────────────────

export interface BuildAuthorizeUrlArgs {
  clientId: string;
  redirectUri: string;
  state: string;
}

export function buildZohoAuthorizeUrl(args: BuildAuthorizeUrlArgs): string {
  const params = new URLSearchParams({
    client_id: args.clientId,
    response_type: "code",
    redirect_uri: args.redirectUri,
    scope: ZOHO_SCOPES,
    access_type: "offline",
    prompt: "consent",
    state: args.state,
  });
  // Default to US accounts host. Zoho will auto-redirect a EU/IN user to
  // their region during the flow; the callback's accounts-server query
  // param tells us which region the user actually authorized on.
  return `https://accounts.zoho.com/oauth/v2/auth?${params.toString()}`;
}

// ─── Code exchange ───────────────────────────────────────────────────────

export interface ExchangeCodeArgs {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  accountsServer: string;
}

export interface ZohoTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number; // seconds
  api_domain?: string;
  token_type?: string;
  scope?: string;
}

export async function exchangeCodeForTokens(
  args: ExchangeCodeArgs,
): Promise<ZohoTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: args.clientId,
    client_secret: args.clientSecret,
    redirect_uri: args.redirectUri,
    code: args.code,
  });

  const res = await fetch(`${args.accountsServer}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Zoho code exchange failed (${res.status}): ${text.slice(0, 300)}`,
    );
  }
  const parsed = JSON.parse(text) as ZohoTokenResponse & { error?: string };
  if (parsed.error) {
    throw new Error(`Zoho code exchange returned error: ${parsed.error}`);
  }
  return parsed;
}

// ─── Refresh ─────────────────────────────────────────────────────────────

export interface RefreshTokenArgs {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  accountsServer: string;
}

export async function refreshAccessToken(
  args: RefreshTokenArgs,
): Promise<{ accessToken: string; expiresInSeconds: number; scope: string | null }> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: args.refreshToken,
    client_id: args.clientId,
    client_secret: args.clientSecret,
  });

  const res = await fetch(`${args.accountsServer}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Zoho refresh failed (${res.status}): ${text.slice(0, 300)}`,
    );
  }
  const parsed = JSON.parse(text) as ZohoTokenResponse & { error?: string };
  if (parsed.error || !parsed.access_token) {
    throw new Error(
      `Zoho refresh returned error: ${parsed.error ?? "no access_token"}`,
    );
  }
  return {
    accessToken: parsed.access_token,
    expiresInSeconds: parsed.expires_in ?? 3600,
    scope: parsed.scope ?? null,
  };
}

// ─── User info (called once after first connect to populate display) ─────

export interface ZohoCurrentUser {
  email: string | null;
  fullName: string | null;
  orgName: string | null;
  orgId: string | null;
}

export async function fetchZohoCurrentUser(args: {
  accessToken: string;
  apiDomain: string;
}): Promise<ZohoCurrentUser> {
  // /crm/v8/users?type=CurrentUser returns the authenticated rep + nested org info.
  const res = await fetch(`${args.apiDomain}/crm/v8/users?type=CurrentUser`, {
    headers: { Authorization: `Zoho-oauthtoken ${args.accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Zoho user fetch failed (${res.status}): ${text.slice(0, 300)}`,
    );
  }
  const json = (await res.json()) as {
    users?: Array<Record<string, unknown>>;
  };
  const me = json.users?.[0] ?? {};
  const email = (me.email as string | undefined) ?? null;
  const fullName =
    (me.full_name as string | undefined) ??
    ([(me.first_name as string | undefined), (me.last_name as string | undefined)]
      .filter(Boolean)
      .join(" ") ||
      null);
  const orgRaw = me.role ?? me.profile ?? null;
  // The v8 user payload doesn't always include org metadata. Org-id is on
  // /crm/v8/org but that requires a second call; defer to keep first-connect
  // fast.
  return {
    email: email ? String(email) : null,
    fullName: fullName ? String(fullName) : null,
    orgName: typeof orgRaw === "object" && orgRaw && "name" in orgRaw
      ? String((orgRaw as { name: unknown }).name)
      : null,
    orgId: null,
  };
}

export async function fetchZohoOrgName(args: {
  accessToken: string;
  apiDomain: string;
}): Promise<{ name: string | null; id: string | null }> {
  const res = await fetch(`${args.apiDomain}/crm/v8/org`, {
    headers: { Authorization: `Zoho-oauthtoken ${args.accessToken}` },
  });
  if (!res.ok) {
    return { name: null, id: null };
  }
  const json = (await res.json()) as {
    org?: Array<{ company_name?: string; id?: string | number }>;
  };
  const first = json.org?.[0];
  return {
    name: first?.company_name ?? null,
    id: first?.id != null ? String(first.id) : null,
  };
}

// ─── Contacts ────────────────────────────────────────────────────────────

export interface ZohoContact {
  id: string;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  email: string | null;
  phone: string | null;
  accountName: string | null;
  title: string | null;
  createdAt: string | null;
}

export async function fetchZohoContacts(args: {
  accessToken: string;
  apiDomain: string;
  perPage?: number;
  page?: number;
}): Promise<{ contacts: ZohoContact[]; moreRecords: boolean }> {
  const params = new URLSearchParams({
    per_page: String(Math.min(Math.max(args.perPage ?? 25, 1), 200)),
    page: String(args.page ?? 1),
  });
  const res = await fetch(
    `${args.apiDomain}/crm/v8/Contacts?${params.toString()}`,
    {
      headers: { Authorization: `Zoho-oauthtoken ${args.accessToken}` },
    },
  );
  if (res.status === 204) {
    // Zoho returns 204 No Content when the module is empty for this user.
    return { contacts: [], moreRecords: false };
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Zoho contacts fetch failed (${res.status}): ${text.slice(0, 300)}`,
    );
  }
  const json = (await res.json()) as {
    data?: Array<Record<string, unknown>>;
    info?: { more_records?: boolean };
  };
  const list = Array.isArray(json.data) ? json.data : [];
  return {
    contacts: list.map(normalizeZohoContact),
    moreRecords: Boolean(json.info?.more_records),
  };
}

function normalizeZohoContact(c: Record<string, unknown>): ZohoContact {
  const firstName = strOrNull(c.First_Name);
  const lastName = strOrNull(c.Last_Name);
  const fullName =
    strOrNull(c.Full_Name) ??
    ([firstName, lastName].filter(Boolean).join(" ").trim() || null);
  return {
    id: String(c.id ?? ""),
    firstName,
    lastName,
    fullName,
    email: strOrNull(c.Email),
    phone: strOrNull(c.Phone) ?? strOrNull(c.Mobile),
    accountName: extractNamed(c.Account_Name),
    title: strOrNull(c.Title),
    createdAt: strOrNull(c.Created_Time),
  };
}

function strOrNull(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") {
    const trimmed = v.trim();
    return trimmed || null;
  }
  return null;
}

function extractNamed(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "object" && "name" in (v as Record<string, unknown>)) {
    const name = (v as { name: unknown }).name;
    return typeof name === "string" ? name.trim() || null : null;
  }
  return null;
}
