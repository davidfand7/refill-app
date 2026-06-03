/**
 * Square Appointments API client (v1.35.0).
 *
 * Mirrors src/lib/schedulers/acuity.ts in shape (pure functions, no
 * Supabase coupling) so src/server/emma-scheduler.functions.ts can
 * dispatch on `platform` without caring which scheduler is which.
 *
 * Square divergences from Acuity (worth knowing before reading):
 *   - OAuth tokens expire after 30 days; refresh_token is returned and
 *     used to mint new pairs. Acuity tokens are long-lived; this file
 *     adds refresh logic.
 *   - Auth code expiry is 5 min (vs Acuity's effective open window).
 *     The callback handler must exchange immediately.
 *   - Webhook subscriptions hit a SINGLE GLOBAL notification URL per
 *     app, not a per-spa secret path. Tenant routing happens via
 *     merchant_id in the payload. Receiver must look up by
 *     (platform="square", platform_account_id=merchant_id).
 *   - Webhook signature is HMAC-SHA256 of (notification_url + raw_body)
 *     concatenation, base64-encoded, in x-square-hmacsha256-signature.
 *     NOTE: the URL is part of the HMAC input — mismatched
 *     registered-URL vs received-URL breaks verification.
 *   - Bookings API requires Square-Version header on every call. We
 *     pin one constant here and rev it deliberately, not silently.
 *   - Only 2 booking events: booking.created + booking.updated. The
 *     latter folds cancel + reschedule + no-show via the status enum
 *     on the payload. Receiver must inspect status to classify.
 *   - createBooking requires the seller to be on Appointments Plus or
 *     Premium subscription tier. Free-tier sellers can authorize OAuth
 *     + receive read webhooks, but the writeback POST fails with
 *     UNAUTHORIZED / forbidden. We surface this as a fail-degraded
 *     state on the spa's Rescue dashboard, not a hard disconnect.
 *
 * Docs:
 *   https://developer.squareup.com/docs/bookings-api/what-it-is
 *   https://developer.squareup.com/docs/oauth-api/overview
 *   https://developer.squareup.com/docs/webhooks/step3validate
 */

// ─── Constants ─────────────────────────────────────────────────────────────

const SQUARE_API_BASE_PROD = "https://connect.squareup.com";
const SQUARE_API_BASE_SANDBOX = "https://connect.squareupsandbox.com";

/**
 * Square API version — sent on every request as Square-Version header.
 * Square versions in YYYY-MM-DD; we pin a recent stable and rev
 * deliberately during quarterly maintenance, NOT silently per request.
 */
const SQUARE_API_VERSION = "2024-12-18";

export type SquareEnv = "production" | "sandbox";

function apiBase(env: SquareEnv): string {
  return env === "sandbox" ? SQUARE_API_BASE_SANDBOX : SQUARE_API_BASE_PROD;
}

/**
 * v1.35.2 — single source of truth for SQUARE_ENV resolution. Cloudflare's
 * secret/plaintext input field has demonstrated whitespace contamination
 * on stored values (caught when the OAuth URL routed to PROD instead of
 * sandbox because SQUARE_ENV was stored as " sandbox" with a leading
 * space). All 7 call sites that previously did `process.env.SQUARE_ENV
 * === "sandbox" ? ...` route through here so the defensive trim +
 * lowercase happens in one place.
 */
export function resolveSquareEnv(): SquareEnv {
  const raw = (process.env.SQUARE_ENV ?? "").trim().toLowerCase();
  return raw === "sandbox" ? "sandbox" : "production";
}

// ─── Types ─────────────────────────────────────────────────────────────────

export type SquareOAuthCredentials = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  env: SquareEnv;
};

export type SquareTokenResponse = {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresAt: string; // ISO 8601
  merchantId: string;
  scope: string[];
};

export type SquareMerchant = {
  id: string;
  businessName: string | null;
  country: string | null;
  language: string | null;
  currency: string | null;
  status: string | null;
};

export type SquareBooking = {
  id: string;
  version: number;
  status: SquareBookingStatus;
  startAt: string; // RFC 3339 with TZ
  locationId: string;
  customerId: string | null;
  customerNote: string | null;
  sellerNote: string | null;
  appointmentSegments: SquareAppointmentSegment[];
  createdAt: string;
  updatedAt: string;
};

export type SquareBookingStatus =
  | "PENDING"
  | "CANCELLED_BY_CUSTOMER"
  | "CANCELLED_BY_SELLER"
  | "DECLINED"
  | "ACCEPTED"
  | "NO_SHOW";

export type SquareAppointmentSegment = {
  durationMinutes: number;
  serviceVariationId: string;
  teamMemberId: string;
  serviceVariationVersion: number;
};

export type SquareCustomer = {
  id: string;
  givenName: string | null;
  familyName: string | null;
  emailAddress: string | null;
  phoneNumber: string | null;
};

export type SquareWebhookSubscription = {
  id: string;
  name: string;
  enabled: boolean;
  eventTypes: string[];
  notificationUrl: string;
  apiVersion: string;
  signatureKey: string;
};

export type SquareWebhookEvent = "booking.created" | "booking.updated";

export const SQUARE_WEBHOOK_EVENTS: SquareWebhookEvent[] = [
  "booking.created",
  "booking.updated",
];

/**
 * The OAuth scopes Refill requests. ALL_WRITE scopes are required for
 * the claim writeback path (book on the seller's behalf, not as a
 * client). MERCHANT_PROFILE_READ resolves merchant_id for tenant
 * routing.
 *
 * v1.35.1 added DEVELOPER_APPLICATION_WEBHOOKS_{READ,WRITE} after the
 * first live test hit INSUFFICIENT_SCOPES on webhook subscribe.
 *
 * v1.35.6 removed those two scopes as a diagnostic: Square's token
 * exchange started returning 401 service.not_authorized once we
 * requested them. Hypothesis: these are partner-level scopes that
 * require app-level approval from Square; requesting them on an
 * unapproved app rejects the entire token exchange. Confirmed by
 * the consent screen rendering 7 scopes instead of 9 (Square's auth
 * UI silently dropped the webhook scopes). The webhook subscription
 * step is currently a non-goal until we either get app approval OR
 * switch to a polling-based sync model.
 */
export const SQUARE_OAUTH_SCOPES = [
  "APPOINTMENTS_READ",
  "APPOINTMENTS_ALL_READ",
  "APPOINTMENTS_WRITE",
  "APPOINTMENTS_ALL_WRITE",
  "CUSTOMERS_READ",
  "CUSTOMERS_WRITE",
  "MERCHANT_PROFILE_READ",
] as const;

// ─── OAuth ─────────────────────────────────────────────────────────────────

export function buildSquareAuthorizeUrl(args: {
  clientId: string;
  env: SquareEnv;
  state: string;
  scopes?: readonly string[];
}): string {
  const params = new URLSearchParams({
    client_id: args.clientId,
    scope: (args.scopes ?? SQUARE_OAUTH_SCOPES).join("+"),
    session: "false",
    state: args.state,
  });
  // URLSearchParams encodes + as %2B — Square wants literal + between
  // scopes, not %2B. Re-encode after toString().
  const qs = params.toString().replace(/%2B/g, "+");
  return `${apiBase(args.env)}/oauth2/authorize?${qs}`;
}

export async function exchangeSquareCodeForToken(args: {
  code: string;
  credentials: SquareOAuthCredentials;
}): Promise<SquareTokenResponse> {
  // v1.35.7: switch to application/x-www-form-urlencoded body per OAuth 2.0
  // RFC 6749 Section 4.1.3. Square's docs say JSON works but sandbox
  // /oauth2/token has returned persistent 401 service.not_authorized with
  // JSON body across v1.35.4-6 debug iterations. Form-encoded is the
  // OAuth 2.0 spec-compliant format and what every major OAuth server
  // accepts unambiguously.
  const body = new URLSearchParams({
    client_id: args.credentials.clientId,
    client_secret: args.credentials.clientSecret,
    code: args.code,
    grant_type: "authorization_code",
    redirect_uri: args.credentials.redirectUri,
  });
  const resp = await fetch(`${apiBase(args.credentials.env)}/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Square-Version": SQUARE_API_VERSION,
    },
    body: body.toString(),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `Square token exchange failed (${resp.status}): ${text.slice(0, 500)}`,
    );
  }
  return parseTokenResponse(await resp.json());
}

export async function refreshSquareAccessToken(args: {
  refreshToken: string;
  credentials: SquareOAuthCredentials;
}): Promise<SquareTokenResponse> {
  // v1.35.7: same form-encoded switch as exchangeSquareCodeForToken.
  const body = new URLSearchParams({
    client_id: args.credentials.clientId,
    client_secret: args.credentials.clientSecret,
    refresh_token: args.refreshToken,
    grant_type: "refresh_token",
  });
  const resp = await fetch(`${apiBase(args.credentials.env)}/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Square-Version": SQUARE_API_VERSION,
    },
    body: body.toString(),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `Square token refresh failed (${resp.status}): ${text.slice(0, 500)}`,
    );
  }
  return parseTokenResponse(await resp.json());
}

function parseTokenResponse(raw: unknown): SquareTokenResponse {
  const j = raw as {
    access_token?: string;
    refresh_token?: string;
    token_type?: string;
    expires_at?: string;
    merchant_id?: string;
    scope?: string;
  };
  if (!j.access_token || !j.refresh_token || !j.merchant_id) {
    throw new Error(
      "Square token response missing access_token / refresh_token / merchant_id.",
    );
  }
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    tokenType: j.token_type ?? "bearer",
    expiresAt: j.expires_at ?? thirtyDaysFromNow(),
    merchantId: j.merchant_id,
    scope: (j.scope ?? "").split(/\s+/).filter(Boolean),
  };
}

function thirtyDaysFromNow(): string {
  return new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
}

// ─── API client ────────────────────────────────────────────────────────────

async function squareFetch<T>(
  accessToken: string,
  env: SquareEnv,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const resp = await fetch(`${apiBase(env)}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "Square-Version": SQUARE_API_VERSION,
      ...(init?.headers ?? {}),
    },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `Square API ${path} ${resp.status}: ${text.slice(0, 500)}`,
    );
  }
  return (await resp.json()) as T;
}

// ─── Reads ─────────────────────────────────────────────────────────────────

export async function getSquareMerchant(
  accessToken: string,
  env: SquareEnv,
  merchantId: string,
): Promise<SquareMerchant> {
  type Raw = {
    merchant?: {
      id?: string;
      business_name?: string;
      country?: string;
      language_code?: string;
      currency?: string;
      status?: string;
    };
  };
  const raw = await squareFetch<Raw>(
    accessToken,
    env,
    `/v2/merchants/${merchantId}`,
  );
  return {
    id: raw.merchant?.id ?? merchantId,
    businessName: raw.merchant?.business_name ?? null,
    country: raw.merchant?.country ?? null,
    language: raw.merchant?.language_code ?? null,
    currency: raw.merchant?.currency ?? null,
    status: raw.merchant?.status ?? null,
  };
}

/**
 * Probe whether the seller has Bookings API write access (i.e. is on
 * Appointments Plus or Premium). Call once on connect-callback to
 * surface tier-block UX. Heuristic: list locations, then probe
 * /v2/bookings/availability/search; the latter requires the booking
 * permission tier and returns a clear error code when the tier is
 * insufficient.
 *
 * Returns:
 *   "writeable" — Plus or Premium; writebacks will succeed
 *   "read_only" — Free; webhooks + reads OK but writebacks will fail
 *   "unknown"   — couldn't determine; default to attempting writeback
 */
export async function probeSquareBookingsTier(args: {
  accessToken: string;
  env: SquareEnv;
}): Promise<"writeable" | "read_only" | "unknown"> {
  try {
    // First location is enough; the actual probe doesn't depend on
    // which location, just whether the seller is on a tier where
    // Bookings reads succeed at all.
    type LocResp = { locations?: { id?: string }[] };
    const locs = await squareFetch<LocResp>(
      args.accessToken,
      args.env,
      "/v2/locations",
    );
    const locationId = locs.locations?.[0]?.id;
    if (!locationId) return "unknown";

    // The /list endpoint is the cheapest tier-probing call. Plus +
    // Premium sellers get 200 even with no bookings. Free sellers
    // get 403 + FORBIDDEN with subscription-related detail.
    const url = `/v2/bookings?location_id=${encodeURIComponent(locationId)}&limit=1`;
    const resp = await fetch(`${apiBase(args.env)}${url}`, {
      headers: {
        Authorization: `Bearer ${args.accessToken}`,
        "Square-Version": SQUARE_API_VERSION,
      },
    });
    if (resp.ok) return "writeable";
    if (resp.status === 403) return "read_only";
    return "unknown";
  } catch {
    return "unknown";
  }
}

export async function listSquareBookings(args: {
  accessToken: string;
  env: SquareEnv;
  locationId?: string;
  startAtMin?: string;
  startAtMax?: string;
  limit?: number;
  cursor?: string;
}): Promise<{ bookings: SquareBooking[]; cursor: string | null }> {
  const params = new URLSearchParams();
  if (args.locationId) params.set("location_id", args.locationId);
  if (args.startAtMin) params.set("start_at_min", args.startAtMin);
  if (args.startAtMax) params.set("start_at_max", args.startAtMax);
  if (args.limit) params.set("limit", String(args.limit));
  if (args.cursor) params.set("cursor", args.cursor);
  type Raw = { bookings?: unknown[]; cursor?: string };
  const raw = await squareFetch<Raw>(
    args.accessToken,
    args.env,
    `/v2/bookings?${params.toString()}`,
  );
  return {
    bookings: (raw.bookings ?? []).map(rawToBooking),
    cursor: raw.cursor ?? null,
  };
}

export async function getSquareBooking(args: {
  accessToken: string;
  env: SquareEnv;
  bookingId: string;
}): Promise<SquareBooking> {
  type Raw = { booking?: unknown };
  const raw = await squareFetch<Raw>(
    args.accessToken,
    args.env,
    `/v2/bookings/${args.bookingId}`,
  );
  if (!raw.booking) {
    throw new Error(`Square booking ${args.bookingId} not found.`);
  }
  return rawToBooking(raw.booking);
}

function rawToBooking(raw: unknown): SquareBooking {
  const b = raw as Record<string, unknown>;
  const segs = (b.appointment_segments as unknown[] | undefined) ?? [];
  return {
    id: (b.id as string) ?? "",
    version: (b.version as number) ?? 0,
    status: ((b.status as string) ?? "PENDING") as SquareBookingStatus,
    startAt: (b.start_at as string) ?? "",
    locationId: (b.location_id as string) ?? "",
    customerId: (b.customer_id as string) ?? null,
    customerNote: (b.customer_note as string) ?? null,
    sellerNote: (b.seller_note as string) ?? null,
    appointmentSegments: segs.map((s) => {
      const seg = s as Record<string, unknown>;
      return {
        durationMinutes: (seg.duration_minutes as number) ?? 0,
        serviceVariationId: (seg.service_variation_id as string) ?? "",
        teamMemberId: (seg.team_member_id as string) ?? "",
        serviceVariationVersion:
          (seg.service_variation_version as number) ?? 0,
      };
    }),
    createdAt: (b.created_at as string) ?? "",
    updatedAt: (b.updated_at as string) ?? "",
  };
}

// ─── Writes ────────────────────────────────────────────────────────────────

/**
 * Book a new appointment on the spa's Square calendar.
 *
 * Used by `claimRescueSlot` to write the new patient's booking back to
 * Square after a rescue offer is claimed — mirror of bookAcuityAppointment.
 *
 * Square will fire `booking.created` back to the webhook receiver for
 * the new booking. The receiver's upsert is keyed on (user_id,
 * external_id, source) so the round-trip is a near-no-op once this
 * call has already stamped the new external_id on the row.
 *
 * Tier gate: this call REQUIRES the seller to be on Appointments Plus
 * or Premium. Free-tier sellers get 403 FORBIDDEN; caller must handle
 * fail-degraded (claim stays committed in Refill; banner instructs
 * manual rebooking on the spa's Square dashboard).
 */
export async function createSquareBooking(args: {
  accessToken: string;
  env: SquareEnv;
  startAt: string; // RFC 3339
  locationId: string;
  customerId: string;
  appointmentSegments: SquareAppointmentSegment[];
  customerNote?: string;
  sellerNote?: string;
  idempotencyKey: string;
}): Promise<SquareBooking> {
  type Raw = { booking?: unknown };
  const body = {
    booking: {
      start_at: args.startAt,
      location_id: args.locationId,
      customer_id: args.customerId,
      appointment_segments: args.appointmentSegments.map((s) => ({
        duration_minutes: s.durationMinutes,
        service_variation_id: s.serviceVariationId,
        team_member_id: s.teamMemberId,
        service_variation_version: s.serviceVariationVersion,
      })),
      customer_note: args.customerNote,
      seller_note: args.sellerNote,
    },
    idempotency_key: args.idempotencyKey,
  };
  const raw = await squareFetch<Raw>(args.accessToken, args.env, "/v2/bookings", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!raw.booking) {
    throw new Error("Square createBooking response missing booking.");
  }
  return rawToBooking(raw.booking);
}

/**
 * Find-or-create a customer on the seller's Square account.
 *
 * Roster-miss path: a CSV-uploaded waitlist patient claims a rescue
 * slot, but the seller has no Square customer record for them. We
 * Search by phone (or email if no phone), and if no match, create.
 *
 * Returns the SquareCustomer.id which the caller stamps on the
 * knowledge_node and passes into createSquareBooking.
 */
export async function upsertSquareCustomer(args: {
  accessToken: string;
  env: SquareEnv;
  phone: string | null;
  email: string | null;
  givenName: string;
  familyName: string;
}): Promise<SquareCustomer> {
  // Try search first — phone is more reliable than email for matching.
  const searchKey = args.phone ?? args.email;
  if (searchKey) {
    type Raw = { customers?: unknown[] };
    const raw = await squareFetch<Raw>(
      args.accessToken,
      args.env,
      "/v2/customers/search",
      {
        method: "POST",
        body: JSON.stringify({
          query: {
            filter: args.phone
              ? { phone_number: { exact: args.phone } }
              : { email_address: { exact: args.email! } },
          },
          limit: 1,
        }),
      },
    );
    const hit = (raw.customers ?? [])[0];
    if (hit) return rawToCustomer(hit);
  }

  // No hit — create.
  type CreateRaw = { customer?: unknown };
  const create = await squareFetch<CreateRaw>(
    args.accessToken,
    args.env,
    "/v2/customers",
    {
      method: "POST",
      body: JSON.stringify({
        given_name: args.givenName,
        family_name: args.familyName,
        phone_number: args.phone || undefined,
        email_address: args.email || undefined,
      }),
    },
  );
  if (!create.customer) {
    throw new Error("Square createCustomer response missing customer.");
  }
  return rawToCustomer(create.customer);
}

function rawToCustomer(raw: unknown): SquareCustomer {
  const c = raw as Record<string, unknown>;
  return {
    id: (c.id as string) ?? "",
    givenName: (c.given_name as string) ?? null,
    familyName: (c.family_name as string) ?? null,
    emailAddress: (c.email_address as string) ?? null,
    phoneNumber: (c.phone_number as string) ?? null,
  };
}

// ─── Webhooks ──────────────────────────────────────────────────────────────

export async function createSquareWebhookSubscription(args: {
  accessToken: string;
  env: SquareEnv;
  notificationUrl: string;
  name?: string;
}): Promise<SquareWebhookSubscription> {
  type Raw = { subscription?: Record<string, unknown> };
  const raw = await squareFetch<Raw>(
    args.accessToken,
    args.env,
    "/v2/webhooks/subscriptions",
    {
      method: "POST",
      body: JSON.stringify({
        subscription: {
          name: args.name ?? "Refill booking events",
          event_types: SQUARE_WEBHOOK_EVENTS,
          notification_url: args.notificationUrl,
          api_version: SQUARE_API_VERSION,
        },
        idempotency_key: crypto.randomUUID(),
      }),
    },
  );
  const s = raw.subscription ?? {};
  return {
    id: (s.id as string) ?? "",
    name: (s.name as string) ?? "",
    enabled: (s.enabled as boolean) ?? true,
    eventTypes: (s.event_types as string[]) ?? [],
    notificationUrl: (s.notification_url as string) ?? args.notificationUrl,
    apiVersion: (s.api_version as string) ?? SQUARE_API_VERSION,
    signatureKey: (s.signature_key as string) ?? "",
  };
}

export async function deleteSquareWebhookSubscription(args: {
  accessToken: string;
  env: SquareEnv;
  subscriptionId: string;
}): Promise<void> {
  await squareFetch<unknown>(
    args.accessToken,
    args.env,
    `/v2/webhooks/subscriptions/${args.subscriptionId}`,
    { method: "DELETE" },
  );
}

// ─── Webhook signature verification ────────────────────────────────────────

/**
 * Verify an inbound Square webhook signature.
 *
 * Square signs (notification_url + raw_body) concatenation with
 * HMAC-SHA256, keyed by the per-subscription `signature_key` returned
 * from createSquareWebhookSubscription. Result is base64-encoded in
 * the `x-square-hmacsha256-signature` header.
 *
 * Constant-time compare. The notification_url MUST match the URL
 * registered on the subscription EXACTLY — protocol, host, path. A
 * trailing slash mismatch breaks verification.
 */
export async function verifySquareWebhookSignature(args: {
  rawBody: string;
  signatureHeader: string | null;
  signatureKey: string;
  notificationUrl: string;
}): Promise<boolean> {
  if (!args.signatureHeader) return false;
  const encoder = new TextEncoder();
  const keyData = encoder.encode(args.signatureKey);
  const msg = args.notificationUrl + args.rawBody;
  const msgData = encoder.encode(msg);
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
  return btoa(str);
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
 * Square webhook envelope. Fully JSON (unlike Acuity's form-encoded).
 *
 * Shape per https://developer.squareup.com/docs/webhooks/payloads:
 *   {
 *     merchant_id: "string",
 *     type: "booking.created" | "booking.updated",
 *     event_id: "uuid",
 *     created_at: "RFC 3339",
 *     data: { type: "booking", id: "string", object: { booking: {...} } }
 *   }
 */
export type SquareWebhookPayload = {
  merchantId: string;
  type: SquareWebhookEvent;
  eventId: string;
  createdAt: string;
  bookingId: string;
  booking: SquareBooking | null;
};

export function parseSquareWebhookBody(
  rawBody: string,
): SquareWebhookPayload | null {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const j = json as Record<string, unknown>;
  const type = j.type as string | undefined;
  if (type !== "booking.created" && type !== "booking.updated") {
    return null;
  }
  const merchantId = j.merchant_id as string | undefined;
  const eventId = j.event_id as string | undefined;
  const createdAt = j.created_at as string | undefined;
  if (!merchantId || !eventId || !createdAt) return null;

  const data = j.data as Record<string, unknown> | undefined;
  const bookingId = (data?.id as string) ?? "";
  const obj = data?.object as Record<string, unknown> | undefined;
  const bookingRaw = obj?.booking;

  return {
    merchantId,
    type,
    eventId,
    createdAt,
    bookingId,
    booking: bookingRaw ? rawToBooking(bookingRaw) : null,
  };
}

/**
 * Map a Square booking status to Refill's appointment status union.
 * Folded into one place so the webhook receiver + backfill share it.
 */
export function squareStatusToRefillStatus(
  status: SquareBookingStatus,
): "scheduled" | "cancelled" | "no_show" {
  switch (status) {
    case "CANCELLED_BY_CUSTOMER":
    case "CANCELLED_BY_SELLER":
    case "DECLINED":
      return "cancelled";
    case "NO_SHOW":
      return "no_show";
    case "PENDING":
    case "ACCEPTED":
    default:
      return "scheduled";
  }
}
