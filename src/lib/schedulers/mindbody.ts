/**
 * Mindbody Public API connector (v1.37.0).
 *
 * Mirror of src/lib/schedulers/{acuity,square}.ts in shape (pure
 * functions, no Supabase coupling). Mindbody divergences worth knowing
 * before reading:
 *
 *   - OAuth: 3-legged flow (closer to Square than Boulevard's paste-
 *     Application-ID). Authorize at https://signin.mindbodyonline.com/
 *     connect/authorize; token exchange at /connect/token. The
 *     `offline_access` scope is MANDATORY to receive a refresh_token
 *     — leave it out and you get a one-shot access token only.
 *   - Activation: per-spa activation step required BEFORE first OAuth.
 *     Spa owner clicks an activation link Mindbody generates, signs in
 *     with the owner account, grants Refill. Activation-link path
 *     (Refill default per feedback_setup_wizards_auto_advance) beats
 *     activation-code paste fallback every time.
 *   - Webhook URL: per-spa secret in path (back to Acuity's pattern,
 *     NOT Square's single-global). `/api/webhooks/scheduler/mindbody/
 *     :secret`. Mindbody validates the URL with a HEAD request when
 *     the subscription is created — receiver MUST respond 2xx to
 *     HEAD or subscription create fails.
 *   - HMAC verification: HMAC-SHA256 over raw body, signed with the
 *     `messageSignatureKey` returned from POST /Subscription. Header:
 *     X-Mindbody-Signature. NO URL prefix in the HMAC input (vs
 *     Square's notification_url + body concatenation).
 *   - Admin override: bookings on behalf of the spa owner use
 *     `Execute: "Force"` field in the addappointment POST body. Analog
 *     to Acuity's `?admin=true` query param.
 *   - Client model: Mindbody requires a ClientId on booking POST — no
 *     inline name/email/phone. Roster-miss path: addclient first,
 *     stamp the returned ClientId back to the patient node for fast
 *     future writebacks.
 *   - Per-site context: every API call needs a `SiteId` header. The
 *     spa's site_id arrives via the id_token claims in the OAuth
 *     callback + persists on the connection row's platform_account_id.
 *   - API-Key header REQUIRED in addition to OAuth Bearer token —
 *     Mindbody's auth model is "OAuth proves the user, API-Key proves
 *     the partner app." Double-header on every call.
 *
 * What's stubbed pending OAuth-client-provisioning Support ticket
 * clearance (per platforms-pre-built doctrine, this lands ARCHITECTURE-
 * COMPLETE; one-line edits expected when sandbox surfaces real values):
 *   - Exact API base URL host (pinned to api.mindbodyonline.com/public/v6
 *     from spec — verify at sandbox)
 *   - Exact event payload shapes for the 5 subscribed events
 *   - Exact return shapes from POST /Subscription (messageSignatureKey
 *     placement, subscription_id field name)
 *   - id_token claim keys for site_id + effectiveUserId
 *
 * Docs:
 *   https://developers.mindbodyonline.com/PublicDocumentation/V6
 *   https://developers.mindbodyonline.com/Webhooks/
 *   https://developers.mindbodyonline.com/OAuth
 */

// ─── Constants ─────────────────────────────────────────────────────────────

const MINDBODY_API_BASE = "https://api.mindbodyonline.com/public/v6";
const MINDBODY_SIGNIN_BASE = "https://signin.mindbodyonline.com";

/**
 * Mindbody Public API version is pinned to v6 in the URL path itself —
 * no version header (vs Square's Square-Version). The version is the
 * URL, so a Mindbody-side v7 release is a constant-string edit here.
 */
export const MINDBODY_API_VERSION = "v6";

export type MindbodyEnv = "production" | "sandbox";

/**
 * v1.35.x doctrine: single source of truth for env resolution. Defensive
 * trim + lowercase + strict equality in one place; all consumers route
 * through here. Mirrors resolveSquareEnv + resolveBoulevardEnv.
 */
export function resolveMindbodyEnv(): MindbodyEnv {
  const raw = (process.env.MINDBODY_ENV ?? "").trim().toLowerCase();
  return raw === "sandbox" ? "sandbox" : "production";
}

/**
 * Mindbody sandbox vs production: production hits api.mindbodyonline.com
 * directly; Mindbody's sandbox uses the same hostname with a sandbox
 * site assignment + sandbox OAuth client. There's no separate sandbox
 * host (unlike Square's connect.squareupsandbox.com). Sandbox routing
 * happens via the OAuth client + site_id Mindbody Support provisions.
 *
 * This function exists for parity with apiBase() in square.ts — it
 * always returns the same URL but routes through the resolver so
 * sandbox debug logs surface the env discriminator.
 */
export function mindbodyApiBase(_env: MindbodyEnv): string {
  return MINDBODY_API_BASE;
}

// ─── Types ─────────────────────────────────────────────────────────────────

export type MindbodyOAuthCredentials = {
  clientId: string;
  clientSecret: string;
  apiKey: string; // Partner-level API key, sent on every call as API-Key header
  redirectUri: string;
  env: MindbodyEnv;
};

export type MindbodyTokenResponse = {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresAt: string;
  siteId: string; // From id_token claims, identifies the spa's MB site
  effectiveUserId: string; // From id_token claims, identifies the OAuth-authorizing user
  scope: string[];
};

export type MindbodyAppointment = {
  id: string;
  status: MindbodyAppointmentStatus;
  startDateTime: string;
  endDateTime: string;
  clientId: string | null;
  staffId: string | null;
  sessionTypeId: string | null;
  locationId: string | null;
  notes: string | null;
};

export type MindbodyAppointmentStatus =
  | "Confirmed"
  | "Requested"
  | "Arrived"
  | "Started"
  | "Completed"
  | "Cancelled"
  | "LateCancelled"
  | "NoShow";

export type MindbodyClient = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
};

export type MindbodyWebhookSubscription = {
  subscriptionId: string;
  eventIds: string[];
  webhookUrl: string;
  messageSignatureKey: string;
  status: string;
};

export type MindbodyWebhookEvent =
  | "appointmentBooking.created"
  | "appointmentBooking.updated"
  | "appointmentBooking.cancelled"
  | "appointmentBooking.noShow"
  | "client.created";

export const MINDBODY_WEBHOOK_EVENTS: MindbodyWebhookEvent[] = [
  "appointmentBooking.created",
  "appointmentBooking.updated",
  "appointmentBooking.cancelled",
  "appointmentBooking.noShow",
  "client.created",
];

/**
 * Mindbody OAuth scope set — pinned to the minimum required by the v0.3
 * spec. `offline_access` is MANDATORY for refresh_token issuance;
 * dropping it gives one-shot access tokens that expire in an hour.
 */
export const MINDBODY_OAUTH_SCOPES = [
  "email",
  "profile",
  "openid",
  "offline_access",
  "Mindbody.Api.Public.v6",
] as const;

export const MINDBODY_WEBHOOK_SIGNATURE_HEADER = "x-mindbody-signature";

// ─── OAuth ─────────────────────────────────────────────────────────────────

export function buildMindbodyAuthorizeUrl(args: {
  clientId: string;
  redirectUri: string;
  state: string;
  subscriberId?: string; // Per-spa subscriber identifier (a.k.a. site_id)
  scopes?: readonly string[];
}): string {
  const params = new URLSearchParams({
    response_type: "code id_token",
    response_mode: "form_post",
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    scope: (args.scopes ?? MINDBODY_OAUTH_SCOPES).join(" "),
    state: args.state,
    nonce: crypto.randomUUID(),
  });
  if (args.subscriberId) {
    params.set("subscriberId", args.subscriberId);
  }
  return `${MINDBODY_SIGNIN_BASE}/connect/authorize?${params.toString()}`;
}

export async function exchangeMindbodyCodeForToken(args: {
  code: string;
  credentials: MindbodyOAuthCredentials;
}): Promise<MindbodyTokenResponse> {
  // v1.35.7 doctrine: form-encoded body per OAuth 2.0 RFC 6749. Every
  // major OAuth server accepts this unambiguously.
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: args.credentials.clientId,
    client_secret: args.credentials.clientSecret,
    code: args.code,
    redirect_uri: args.credentials.redirectUri,
  });
  const resp = await fetch(`${MINDBODY_SIGNIN_BASE}/connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `Mindbody token exchange failed (${resp.status}): ${text.slice(0, 500)}`,
    );
  }
  return parseTokenResponse(await resp.json());
}

export async function refreshMindbodyAccessToken(args: {
  refreshToken: string;
  credentials: MindbodyOAuthCredentials;
}): Promise<MindbodyTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: args.credentials.clientId,
    client_secret: args.credentials.clientSecret,
    refresh_token: args.refreshToken,
  });
  const resp = await fetch(`${MINDBODY_SIGNIN_BASE}/connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `Mindbody token refresh failed (${resp.status}): ${text.slice(0, 500)}`,
    );
  }
  return parseTokenResponse(await resp.json());
}

function parseTokenResponse(raw: unknown): MindbodyTokenResponse {
  const j = raw as {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    token_type?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!j.access_token) {
    throw new Error("Mindbody token response missing access_token.");
  }
  // Decode id_token claims to extract siteId + effectiveUserId.
  // id_token is a JWT — base64url-decode the middle segment. We don't
  // verify the signature here (token came from Mindbody over TLS); we
  // just need the claim values.
  const claims = j.id_token ? decodeJwtClaims(j.id_token) : {};
  const siteId =
    (claims.siteId as string | undefined) ??
    (claims.SiteId as string | undefined) ??
    (claims.site_id as string | undefined) ??
    "";
  const effectiveUserId =
    (claims.effectiveUserId as string | undefined) ??
    (claims.EffectiveUserId as string | undefined) ??
    (claims.sub as string | undefined) ??
    "";

  const expiresAt = new Date(
    Date.now() + ((j.expires_in ?? 3600) - 60) * 1000,
  ).toISOString();

  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token ?? "",
    tokenType: j.token_type ?? "bearer",
    expiresAt,
    siteId,
    effectiveUserId,
    scope: (j.scope ?? "").split(/\s+/).filter(Boolean),
  };
}

function decodeJwtClaims(jwt: string): Record<string, unknown> {
  try {
    const parts = jwt.split(".");
    if (parts.length < 2) return {};
    // base64url → base64
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const json =
      typeof atob === "function"
        ? atob(padded)
        : Buffer.from(padded, "base64").toString("utf-8");
    return JSON.parse(json);
  } catch {
    return {};
  }
}

// ─── API client ────────────────────────────────────────────────────────────

async function mindbodyFetch<T>(args: {
  accessToken: string;
  apiKey: string;
  siteId: string;
  env: MindbodyEnv;
  path: string;
  init?: RequestInit;
}): Promise<T> {
  const resp = await fetch(`${mindbodyApiBase(args.env)}${args.path}`, {
    ...args.init,
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      "Api-Key": args.apiKey,
      SiteId: args.siteId,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(args.init?.headers ?? {}),
    },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `Mindbody API ${args.path} ${resp.status}: ${text.slice(0, 500)}`,
    );
  }
  return (await resp.json()) as T;
}

// ─── Reads ─────────────────────────────────────────────────────────────────

/**
 * v1.42.3 fixes (per sandbox-verify smoke 2026-06-03):
 *   - `staffIds` is REQUIRED on /appointment/staffappointments. Without it
 *     the endpoint still returns 200 but with empty Appointments[]. With
 *     staff scoping we get real data.
 *   - Response top-level key is `Appointments` (NOT `StaffAppointments`
 *     as v1.37.0 guessed). The empty-array regression was silent — every
 *     prior call returned 0 appointments because the response-key path
 *     mismatched.
 *   - Pagination params are case-sensitive `Limit` + `Offset` (capital);
 *     lowercase was being ignored, server defaulted to Limit=100.
 *   - Repeated-key serialization for array params: `StaffIds=1&StaffIds=2`,
 *     NOT `StaffIds[]=1` or `StaffIds=1,2` (URLSearchParams comma-encoding).
 */
export async function listMindbodyAppointments(args: {
  accessToken: string;
  apiKey: string;
  siteId: string;
  env: MindbodyEnv;
  startDate: string; // YYYY-MM-DD
  endDate: string;
  staffIds: ReadonlyArray<number | string>; // required per v1.42.3
  limit?: number;
  offset?: number;
}): Promise<{ appointments: MindbodyAppointment[]; nextOffset: number | null }> {
  const params = new URLSearchParams();
  params.append("StartDate", args.startDate);
  params.append("EndDate", args.endDate);
  params.append("Limit", String(args.limit ?? 200));
  params.append("Offset", String(args.offset ?? 0));
  for (const id of args.staffIds) {
    params.append("StaffIds", String(id));
  }
  type Raw = {
    Appointments?: MindbodyAppointmentRaw[];
    PaginationResponse?: {
      RequestedLimit?: number;
      RequestedOffset?: number;
      PageSize?: number;
      TotalResults?: number;
    };
  };
  const raw = await mindbodyFetch<Raw>({
    accessToken: args.accessToken,
    apiKey: args.apiKey,
    siteId: args.siteId,
    env: args.env,
    path: `/appointment/staffappointments?${params.toString()}`,
  });
  const appointments = (raw.Appointments ?? []).map(rawToAppointment);
  const total = raw.PaginationResponse?.TotalResults ?? appointments.length;
  const consumed = (args.offset ?? 0) + appointments.length;
  return {
    appointments,
    nextOffset: consumed < total ? consumed : null,
  };
}

/**
 * v1.42.3 fix: route single-appointment fetch through the corrected
 * /appointment/staffappointments endpoint with AppointmentIds filter.
 * The v1.37.0 path `/appointment/appointments?AppointmentIds=X` returns
 * 404 HTML — confirmed via sandbox smoke 2026-06-03.
 *
 * `staffIds` is OPTIONAL. When omitted (typical for rescue-flow callers
 * that only know the appointment ID), the function fetches the spa's
 * staff roster via listMindbodyStaff first and queries against all IDs.
 * This keeps the caller surface clean — they don't need to know about
 * Mindbody's staff-scoped endpoint constraint.
 */
export async function getMindbodyAppointment(args: {
  accessToken: string;
  apiKey: string;
  siteId: string;
  env: MindbodyEnv;
  appointmentId: string;
  staffIds?: ReadonlyArray<number | string>;
}): Promise<MindbodyAppointment> {
  let resolvedStaffIds: ReadonlyArray<number | string>;
  if (args.staffIds && args.staffIds.length > 0) {
    resolvedStaffIds = args.staffIds;
  } else {
    // Auto-resolve: pull staff roster once. Typical med-spa has <10
    // staff so this is one page + cheap. Larger gyms may need
    // pagination — handled in listMindbodyStaff already.
    const allStaff: Array<{ id: string }> = [];
    let offset: number | null = 0;
    for (let page = 0; page < 20; page++) {
      if (offset === null) break;
      const { staff, nextOffset } = await listMindbodyStaff({
        accessToken: args.accessToken,
        apiKey: args.apiKey,
        siteId: args.siteId,
        env: args.env,
        limit: 200,
        offset,
      });
      allStaff.push(...staff);
      offset = nextOffset;
    }
    resolvedStaffIds = allStaff.map((s) => s.id).filter((id) => id !== "");
  }

  type Raw = { Appointments?: MindbodyAppointmentRaw[] };
  const params = new URLSearchParams();
  params.append("AppointmentIds", args.appointmentId);
  for (const id of resolvedStaffIds) {
    params.append("StaffIds", String(id));
  }
  const raw = await mindbodyFetch<Raw>({
    accessToken: args.accessToken,
    apiKey: args.apiKey,
    siteId: args.siteId,
    env: args.env,
    path: `/appointment/staffappointments?${params.toString()}`,
  });
  const match = (raw.Appointments ?? []).find(
    (a) =>
      String(a.Id ?? "") === args.appointmentId ||
      String(a.AppointmentId ?? "") === args.appointmentId,
  );
  if (!match) {
    throw new Error(`Mindbody appointment ${args.appointmentId} not found.`);
  }
  return rawToAppointment(match);
}

/**
 * v1.42.3 NEW: enumerate staff so backfill can iterate per staff.
 * `/staff/staff` is the canonical Mindbody v6 endpoint; confirmed
 * 200 with PaginationResponse + StaffMembers in sandbox smoke
 * (141 staff in -99 test site).
 */
export async function listMindbodyStaff(args: {
  accessToken: string;
  apiKey: string;
  siteId: string;
  env: MindbodyEnv;
  limit?: number;
  offset?: number;
}): Promise<{
  staff: ReadonlyArray<{ id: string; name: string | null }>;
  nextOffset: number | null;
}> {
  const params = new URLSearchParams();
  params.append("Limit", String(args.limit ?? 200));
  params.append("Offset", String(args.offset ?? 0));
  type Raw = {
    StaffMembers?: Array<{
      Id?: number | string;
      Name?: string | null;
      DisplayName?: string | null;
    }>;
    PaginationResponse?: { TotalResults?: number };
  };
  const raw = await mindbodyFetch<Raw>({
    accessToken: args.accessToken,
    apiKey: args.apiKey,
    siteId: args.siteId,
    env: args.env,
    path: `/staff/staff?${params.toString()}`,
  });
  const staff = (raw.StaffMembers ?? []).map((s) => ({
    id: String(s.Id ?? ""),
    name: s.DisplayName ?? s.Name ?? null,
  }));
  const total = raw.PaginationResponse?.TotalResults ?? staff.length;
  const consumed = (args.offset ?? 0) + staff.length;
  return { staff, nextOffset: consumed < total ? consumed : null };
}

type MindbodyAppointmentRaw = {
  Id?: number | string;
  AppointmentId?: number | string;
  Status?: string;
  StartDateTime?: string;
  EndDateTime?: string;
  ClientId?: number | string;
  StaffId?: number | string;
  SessionTypeId?: number | string;
  LocationId?: number | string;
  Notes?: string;
  NoShow?: boolean;
};

function rawToAppointment(raw: MindbodyAppointmentRaw): MindbodyAppointment {
  // Mindbody's NoShow boolean takes precedence over Status when both
  // are populated — the spec calls out the synthesized-noShow mapping.
  const status: MindbodyAppointmentStatus = raw.NoShow
    ? "NoShow"
    : ((raw.Status as MindbodyAppointmentStatus | undefined) ?? "Confirmed");
  const id =
    raw.Id !== undefined ? String(raw.Id) : String(raw.AppointmentId ?? "");
  return {
    id,
    status,
    startDateTime: raw.StartDateTime ?? "",
    endDateTime: raw.EndDateTime ?? raw.StartDateTime ?? "",
    clientId: raw.ClientId !== undefined ? String(raw.ClientId) : null,
    staffId: raw.StaffId !== undefined ? String(raw.StaffId) : null,
    sessionTypeId:
      raw.SessionTypeId !== undefined ? String(raw.SessionTypeId) : null,
    locationId: raw.LocationId !== undefined ? String(raw.LocationId) : null,
    notes: raw.Notes ?? null,
  };
}

export async function listMindbodyClients(args: {
  accessToken: string;
  apiKey: string;
  siteId: string;
  env: MindbodyEnv;
  limit?: number;
  offset?: number;
}): Promise<{ clients: MindbodyClient[]; nextOffset: number | null }> {
  const params = new URLSearchParams({
    limit: String(args.limit ?? 200),
    offset: String(args.offset ?? 0),
  });
  type Raw = {
    Clients?: {
      Id?: number | string;
      FirstName?: string;
      LastName?: string;
      Email?: string;
      MobilePhone?: string;
      HomePhone?: string;
      WorkPhone?: string;
    }[];
    PaginationResponse?: { TotalResults?: number };
  };
  const raw = await mindbodyFetch<Raw>({
    accessToken: args.accessToken,
    apiKey: args.apiKey,
    siteId: args.siteId,
    env: args.env,
    path: `/client/clients?${params.toString()}`,
  });
  const clients = (raw.Clients ?? []).map((c) => ({
    id: c.Id !== undefined ? String(c.Id) : "",
    firstName: c.FirstName ?? null,
    lastName: c.LastName ?? null,
    email: c.Email ?? null,
    phone: c.MobilePhone || c.HomePhone || c.WorkPhone || null,
  }));
  const total = raw.PaginationResponse?.TotalResults ?? clients.length;
  const consumed = (args.offset ?? 0) + clients.length;
  return {
    clients,
    nextOffset: consumed < total ? consumed : null,
  };
}

// ─── Writes ────────────────────────────────────────────────────────────────

/**
 * Book a new appointment on the spa's Mindbody calendar.
 *
 * Used by claimRescueSlot to write the new patient's booking back to
 * Mindbody after a rescue offer is claimed — mirror of bookAcuity-
 * Appointment + createSquareBooking + createBoulevardAppointment.
 *
 * `Execute: "Force"` is the admin-override flag (analog to Acuity's
 * `?admin=true`). Without it the POST gets evaluated against the spa's
 * business rules (availability, staff hours, double-booking, etc.) and
 * frequently rejects rescue-flow bookings that override a just-cancelled
 * slot. With it, the partner-app-on-behalf-of-owner authority short-
 * circuits the business-rule layer and the booking lands.
 *
 * Mindbody fires `appointmentBooking.created` back to the webhook
 * receiver for the new booking. The receiver's upsert is keyed on
 * (user_id, external_id, source) so the round-trip is a near-no-op
 * once this call has already stamped the new external_id on the row.
 */
export async function bookMindbodyAppointment(args: {
  accessToken: string;
  apiKey: string;
  siteId: string;
  env: MindbodyEnv;
  startDateTime: string;
  clientId: string;
  sessionTypeId: string;
  staffId: string;
  locationId?: string;
  notes?: string;
}): Promise<MindbodyAppointment> {
  type Raw = { Appointment?: MindbodyAppointmentRaw };
  const body = {
    ClientId: args.clientId,
    SessionTypeId: args.sessionTypeId,
    StaffId: args.staffId,
    StartDateTime: args.startDateTime,
    LocationId: args.locationId,
    Notes: args.notes,
    Execute: "Force",
  };
  const raw = await mindbodyFetch<Raw>({
    accessToken: args.accessToken,
    apiKey: args.apiKey,
    siteId: args.siteId,
    env: args.env,
    path: "/appointment/addappointment",
    init: { method: "POST", body: JSON.stringify(body) },
  });
  if (!raw.Appointment) {
    throw new Error("Mindbody addappointment response missing Appointment.");
  }
  return rawToAppointment(raw.Appointment);
}

/**
 * Find-or-create a client on the spa's Mindbody account.
 *
 * Roster-miss path: a CSV-uploaded waitlist patient claims a rescue
 * slot, but the spa has no Mindbody client record for them. We call
 * addclient first, take the returned ClientId, and use it in the
 * booking POST. Returned ClientId gets stamped back onto the patient
 * node so future writebacks hit the fast path (roster-hit).
 *
 * Mirror of upsertSquareCustomer + upsertBoulevardClient.
 */
export async function addMindbodyClient(args: {
  accessToken: string;
  apiKey: string;
  siteId: string;
  env: MindbodyEnv;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
}): Promise<MindbodyClient> {
  type Raw = {
    Client?: {
      Id?: number | string;
      FirstName?: string;
      LastName?: string;
      Email?: string;
      MobilePhone?: string;
    };
  };
  const body = {
    Client: {
      FirstName: args.firstName,
      LastName: args.lastName,
      Email: args.email || undefined,
      MobilePhone: args.phone || undefined,
    },
  };
  const raw = await mindbodyFetch<Raw>({
    accessToken: args.accessToken,
    apiKey: args.apiKey,
    siteId: args.siteId,
    env: args.env,
    path: "/client/addclient",
    init: { method: "POST", body: JSON.stringify(body) },
  });
  if (!raw.Client) {
    throw new Error("Mindbody addclient response missing Client.");
  }
  return {
    id: raw.Client.Id !== undefined ? String(raw.Client.Id) : "",
    firstName: raw.Client.FirstName ?? null,
    lastName: raw.Client.LastName ?? null,
    email: raw.Client.Email ?? null,
    phone: raw.Client.MobilePhone ?? null,
  };
}

// ─── Webhook subscription lifecycle ────────────────────────────────────────

/**
 * Register a webhook subscription on the spa's Mindbody site.
 *
 * Mindbody's webhook API lives at a different host than the Public API
 * (signin.mindbodyonline.com is OAuth; api.mindbodyonline.com/public/v6
 * is data; webhooks.mindbody.io is webhook lifecycle). Pinned here so
 * a Mindbody-side host change is a one-line edit.
 *
 * Returns the subscription resource with the messageSignatureKey —
 * stored on the connection row's webhook_secret column for HMAC
 * verification on inbound deliveries.
 *
 * IMPORTANT: Mindbody validates the webhookUrl with a HEAD request as
 * part of subscription create. The receiver route MUST respond 2xx to
 * HEAD or this call returns an error and the subscription is never
 * created. Receiver scaffold handles this.
 */
const MINDBODY_WEBHOOKS_API_BASE = "https://mb-api.mindbodyonline.com/platform/webhooks/api/v1";

export async function createMindbodyWebhookSubscription(args: {
  apiKey: string;
  siteId: string;
  webhookUrl: string;
  eventIds: readonly string[];
}): Promise<MindbodyWebhookSubscription> {
  // Mindbody's webhook subscription endpoint takes the partner API key
  // (NOT a per-spa OAuth token) — webhook lifecycle is partner-scope.
  const body = {
    eventIds: args.eventIds,
    webhookUrl: args.webhookUrl,
    siteIds: [args.siteId],
  };
  const resp = await fetch(`${MINDBODY_WEBHOOKS_API_BASE}/subscription`, {
    method: "POST",
    headers: {
      "Api-Key": args.apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `Mindbody webhook subscribe failed (${resp.status}): ${text.slice(0, 500)}`,
    );
  }
  const raw = (await resp.json()) as {
    subscriptionId?: string;
    messageSignatureKey?: string;
    status?: string;
    eventIds?: string[];
  };
  return {
    subscriptionId: raw.subscriptionId ?? "",
    eventIds: raw.eventIds ?? [...args.eventIds],
    webhookUrl: args.webhookUrl,
    messageSignatureKey: raw.messageSignatureKey ?? "",
    status: raw.status ?? "Active",
  };
}

export async function deleteMindbodyWebhookSubscription(args: {
  apiKey: string;
  subscriptionId: string;
}): Promise<void> {
  const resp = await fetch(
    `${MINDBODY_WEBHOOKS_API_BASE}/subscription/${args.subscriptionId}`,
    {
      method: "DELETE",
      headers: { "Api-Key": args.apiKey },
    },
  );
  if (!resp.ok && resp.status !== 404) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `Mindbody webhook unsubscribe failed (${resp.status}): ${text.slice(0, 500)}`,
    );
  }
}

/**
 * Generate a per-spa activation link. Spa owner clicks the link, signs
 * in with their owner account, grants Refill access. Activation
 * completes before OAuth handshake can proceed.
 *
 * Per feedback_setup_wizards_auto_advance: activation-link path is the
 * default; activation-code paste is the fallback. The link is one-click;
 * the code is "go find this menu" friction.
 */
export async function createMindbodyActivationLink(args: {
  apiKey: string;
  partnerName: string;
  siteId?: string;
}): Promise<{ activationLink: string; activationCode: string | null }> {
  // Pinned endpoint placeholder — Mindbody Support documents the exact
  // partner-activation-link endpoint on their developer portal; the
  // signature is "POST /platform/partners/activation-link with
  // {partnerName, siteIds}". Sandbox-verify when the OAuth-client-
  // provisioning Support ticket clears.
  const resp = await fetch(
    `${MINDBODY_WEBHOOKS_API_BASE.replace("/webhooks", "/partners")}/activation-link`,
    {
      method: "POST",
      headers: {
        "Api-Key": args.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        partnerName: args.partnerName,
        siteIds: args.siteId ? [args.siteId] : undefined,
      }),
    },
  );
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `Mindbody activation-link request failed (${resp.status}): ${text.slice(0, 500)}`,
    );
  }
  const raw = (await resp.json()) as {
    activationLink?: string;
    activationCode?: string;
  };
  return {
    activationLink: raw.activationLink ?? "",
    activationCode: raw.activationCode ?? null,
  };
}

// ─── Webhook signature verification ────────────────────────────────────────

/**
 * Verify an inbound Mindbody webhook signature.
 *
 * Mindbody signs the raw body with HMAC-SHA256, keyed by the per-
 * subscription messageSignatureKey. Result in X-Mindbody-Signature
 * header. NO URL prefix in the HMAC input (vs Square's
 * notification_url + body concatenation).
 *
 * Constant-time compare. Same shape as verifySquareWebhookSignature +
 * verifyBoulevardWebhookSignature.
 */
export async function verifyMindbodyWebhookSignature(args: {
  rawBody: string;
  signatureHeader: string | null;
  messageSignatureKey: string;
}): Promise<boolean> {
  if (!args.signatureHeader) return false;
  const encoder = new TextEncoder();
  const keyData = encoder.encode(args.messageSignatureKey);
  const msgData = encoder.encode(args.rawBody);
  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, msgData);
  const computed = base64FromBuffer(sigBuf);
  return constantTimeEquals(computed, args.signatureHeader);
}

function base64FromBuffer(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let str = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    str += String.fromCharCode(bytes[i]);
  }
  if (typeof btoa === "function") return btoa(str);
  return Buffer.from(str, "binary").toString("base64");
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

// ─── Webhook payload parsing ───────────────────────────────────────────────

/**
 * Mindbody webhook envelope. Shape per the spec scout — assumed values
 * pinned until sandbox-verify surfaces the actual payload shapes.
 *
 *   {
 *     messageId: "uuid",
 *     eventId: "appointmentBooking.created",
 *     eventInstanceOriginationDateTime: "2026-06-03T12:34:56Z",
 *     siteId: "12345",
 *     eventSchemaVersion: 1,
 *     eventData: {
 *       appointmentId: ...,
 *       clientId: ...,
 *       sessionTypeId: ...,
 *       staffId: ...,
 *       startDateTime: ...,
 *       endDateTime: ...,
 *       status: "Confirmed"
 *     }
 *   }
 */
export type MindbodyWebhookPayload = {
  messageId: string;
  eventId: MindbodyWebhookEvent;
  siteId: string;
  occurredAt: string;
  appointment: MindbodyAppointment | null;
  client: MindbodyClient | null;
};

export function parseMindbodyWebhookBody(
  rawBody: string,
): MindbodyWebhookPayload | null {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const j = json as Record<string, unknown>;
  const eventId = j.eventId as string | undefined;
  if (!eventId) return null;
  if (!MINDBODY_WEBHOOK_EVENTS.includes(eventId as MindbodyWebhookEvent)) {
    return null;
  }

  const siteId = String(j.siteId ?? "");
  const messageId = (j.messageId ?? j.eventInstanceId ?? "") as string;
  const occurredAt = (j.eventInstanceOriginationDateTime ??
    j.occurredAt ??
    "") as string;
  if (!siteId || !messageId || !occurredAt) return null;

  const data = (j.eventData ?? j.data ?? {}) as Record<string, unknown>;

  let appointment: MindbodyAppointment | null = null;
  if (eventId.startsWith("appointmentBooking.")) {
    appointment = rawToAppointment(data as MindbodyAppointmentRaw);
    if (!appointment.id) appointment = null;
  }

  let client: MindbodyClient | null = null;
  if (eventId === "client.created" && data) {
    const c = data as {
      Id?: number | string;
      ClientId?: number | string;
      FirstName?: string;
      LastName?: string;
      Email?: string;
      MobilePhone?: string;
    };
    const id = c.Id ?? c.ClientId;
    if (id !== undefined) {
      client = {
        id: String(id),
        firstName: c.FirstName ?? null,
        lastName: c.LastName ?? null,
        email: c.Email ?? null,
        phone: c.MobilePhone ?? null,
      };
    }
  }

  return {
    messageId,
    eventId: eventId as MindbodyWebhookEvent,
    siteId,
    occurredAt,
    appointment,
    client,
  };
}

/**
 * Map a Mindbody appointment status to Refill's appointment status union.
 * Folded into one place so the webhook receiver + backfill share it.
 *
 * NoShow priority: rawToAppointment already collapses NoShow=true into
 * status="NoShow" upstream; downstream code just dispatches on status.
 */
export function mindbodyStatusToRefillStatus(
  status: MindbodyAppointmentStatus,
): "scheduled" | "cancelled" | "no_show" | "showed" {
  switch (status) {
    case "Cancelled":
    case "LateCancelled":
      return "cancelled";
    case "NoShow":
      return "no_show";
    case "Arrived":
    case "Started":
    case "Completed":
      return "showed";
    case "Confirmed":
    case "Requested":
    default:
      return "scheduled";
  }
}
