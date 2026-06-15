/**
 * Acuity Scheduling API client (v381).
 *
 * Pure functions, no Supabase coupling. The shape is intentionally
 * generalizable — future ships add src/lib/schedulers/mindbody.ts /
 * jane.ts / square.ts with the same export signatures, and the higher-
 * level code in src/server/emma-scheduler.functions.ts dispatches by
 * platform.
 *
 * Acuity OAuth2 specifics worth knowing before reading this file:
 *   - Tokens are long-lived (no expiry, no refresh_token returned).
 *     We still store expires_at as a hint but it'll be null for Acuity.
 *   - Scope `api-v1` covers everything we need (read appointments,
 *     read clients, manage webhooks). There is no finer-grained scope.
 *   - Webhook payloads are application/x-www-form-urlencoded, NOT JSON,
 *     and are thin (action + id + a few IDs) — to act on an event we
 *     fetch the full appointment via the API.
 *   - Webhook signature is HMAC-SHA256 of the raw body, keyed with the
 *     OAuth app's client_secret, sent in the X-ACUITY-SIGNATURE header.
 *
 * Docs: https://developers.acuityscheduling.com/reference
 */

const ACUITY_API_BASE = "https://acuityscheduling.com/api/v1";
const ACUITY_OAUTH_AUTHORIZE = "https://acuityscheduling.com/oauth2/authorize";
const ACUITY_OAUTH_TOKEN = "https://acuityscheduling.com/oauth2/token";

export type AcuityOAuthCredentials = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

export type AcuityTokenResponse = {
  accessToken: string;
  tokenType: string;
  scope: string;
  refreshToken: string | null;
  expiresAt: string | null;
};

export type AcuityMe = {
  userId: number;
  email: string;
  firstName: string | null;
  lastName: string | null;
  businessName: string | null;
  timezone: string | null;
  currency: string | null;
};

export type AcuityAppointment = {
  id: number;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  datetime: string; // ISO-ish; Acuity returns "2026-05-19T11:00:00-0600" style
  endTime: string | null;
  type: string;
  appointmentTypeID: number;
  calendar: string;
  calendarID: number;
  duration: string;
  price: string;
  paid: string;
  canceled: boolean;
  canceledDate: string | null;
  noShow: boolean | null;
  notes: string | null;
};

export type AcuityClient = {
  id: number | null;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  notes: string | null;
};

// Structure types — used by the SmartSpa staging mirror (calendars →
// scheduling_providers, appointment-types → services).
export type AcuityCalendar = {
  id: number;
  name: string;
  email: string | null;
  timezone: string | null;
};

export type AcuityAppointmentType = {
  id: number;
  name: string;
  active: boolean;
  private: boolean;
  category: string | null;
  /** Minutes. */
  duration: number;
  /** Acuity returns price as a string. */
  price: string;
  /** Which calendars offer this type. */
  calendarIDs: number[];
};

export type AcuityWebhookSubscription = {
  id: number;
  event: string;
  target: string;
};

export type AcuityWebhookEvent =
  | "appointment.scheduled"
  | "appointment.canceled"
  | "appointment.rescheduled"
  | "appointment.changed";

export const ACUITY_WEBHOOK_EVENTS: AcuityWebhookEvent[] = [
  "appointment.scheduled",
  "appointment.canceled",
  "appointment.rescheduled",
  "appointment.changed",
];

// ─── OAuth ─────────────────────────────────────────────────────────────────

export function buildAcuityAuthorizeUrl(args: {
  clientId: string;
  redirectUri: string;
  state: string;
  scope?: string;
}): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    scope: args.scope ?? "api-v1",
    state: args.state,
  });
  return `${ACUITY_OAUTH_AUTHORIZE}?${params.toString()}`;
}

export async function exchangeAcuityCodeForToken(args: {
  code: string;
  credentials: AcuityOAuthCredentials;
}): Promise<AcuityTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.credentials.redirectUri,
    client_id: args.credentials.clientId,
    client_secret: args.credentials.clientSecret,
  });
  const resp = await fetch(ACUITY_OAUTH_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Acuity token exchange failed (${resp.status}): ${text.slice(0, 500)}`);
  }
  const json = (await resp.json()) as {
    access_token: string;
    token_type?: string;
    scope?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!json.access_token) {
    throw new Error("Acuity token response missing access_token.");
  }
  const expiresAt = json.expires_in
    ? new Date(Date.now() + json.expires_in * 1000).toISOString()
    : null;
  return {
    accessToken: json.access_token,
    tokenType: json.token_type ?? "bearer",
    scope: json.scope ?? "api-v1",
    refreshToken: json.refresh_token ?? null,
    expiresAt,
  };
}

// ─── API client ────────────────────────────────────────────────────────────

async function acuityFetch<T>(
  accessToken: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const resp = await fetch(`${ACUITY_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Acuity API ${path} ${resp.status}: ${text.slice(0, 500)}`);
  }
  return (await resp.json()) as T;
}

/** GET /calendars — the spa's calendars. Each Acuity calendar is the
 *  provider/resource dimension (matches parseAcuity()'s "Calendar" column),
 *  so these mirror into scheduling_providers. */
export async function listAcuityCalendars(
  accessToken: string,
): Promise<AcuityCalendar[]> {
  type Raw = {
    id?: number | string;
    name?: string;
    email?: string;
    timezone?: string;
  };
  const raw = await acuityFetch<Raw[]>(accessToken, "/calendars");
  return (raw ?? []).map((c) => ({
    id: typeof c.id === "string" ? Number(c.id) : (c.id ?? 0),
    name: (c.name ?? "").trim(),
    email: c.email ?? null,
    timezone: c.timezone ?? null,
  }));
}

/** GET /appointment-types — the services the spa offers. These mirror into
 *  the services catalog (name, duration, price, online_bookable). */
export async function listAcuityAppointmentTypes(
  accessToken: string,
): Promise<AcuityAppointmentType[]> {
  type Raw = {
    id?: number | string;
    name?: string;
    active?: boolean;
    private?: boolean;
    category?: string;
    duration?: number | string;
    price?: string | number;
    calendarIDs?: number[];
  };
  const raw = await acuityFetch<Raw[]>(accessToken, "/appointment-types");
  return (raw ?? []).map((t) => ({
    id: typeof t.id === "string" ? Number(t.id) : (t.id ?? 0),
    name: (t.name ?? "").trim(),
    active: t.active ?? true,
    private: t.private ?? false,
    category: t.category && t.category.trim() ? t.category.trim() : null,
    duration:
      typeof t.duration === "string" ? Number(t.duration) : (t.duration ?? 30),
    price: t.price != null ? String(t.price) : "0",
    calendarIDs: Array.isArray(t.calendarIDs) ? t.calendarIDs : [],
  }));
}

export async function getAcuityMe(accessToken: string): Promise<AcuityMe> {
  type Raw = {
    userID?: number | string;
    email?: string;
    firstName?: string;
    lastName?: string;
    name?: string;
    timezone?: string;
    currency?: string;
  };
  const raw = await acuityFetch<Raw>(accessToken, "/me");
  return {
    userId: typeof raw.userID === "string" ? Number(raw.userID) : raw.userID ?? 0,
    email: raw.email ?? "",
    firstName: raw.firstName ?? null,
    lastName: raw.lastName ?? null,
    businessName: raw.name ?? null,
    timezone: raw.timezone ?? null,
    currency: raw.currency ?? null,
  };
}

export async function listAcuityAppointments(
  accessToken: string,
  args: { minDate?: string; maxDate?: string; max?: number; canceled?: boolean } = {},
): Promise<AcuityAppointment[]> {
  const params = new URLSearchParams();
  if (args.minDate) params.set("minDate", args.minDate);
  if (args.maxDate) params.set("maxDate", args.maxDate);
  if (args.max) params.set("max", String(args.max));
  if (args.canceled !== undefined) params.set("canceled", args.canceled ? "true" : "false");
  const qs = params.toString();
  return acuityFetch<AcuityAppointment[]>(
    accessToken,
    `/appointments${qs ? `?${qs}` : ""}`,
  );
}

/**
 * Pull EVERY appointment in a date window, paging past Acuity's per-request
 * `max` cap — the truncation-safe replacement for a raw `listAcuityAppointments`
 * with a fixed `max`.
 *
 * Acuity's GET /appointments has NO offset/page/cursor parameter (verified
 * against developers.acuityscheduling.com 2026-06-15 — only `max` plus the
 * minDate/maxDate date filters). So a window holding more than one page can
 * ONLY be paged by SUBDIVIDING the date range: if a pull comes back full
 * (length >= pageMax), we split [minDate, maxDate] in half and recurse on each
 * half until every sub-window returns a short (= complete) page. The halves are
 * disjoint ([min, mid] + [mid+1, max]) so no double-count; we also dedupe by id
 * defensively.
 *
 * Cost: the common case is ONE request per call (a normal spa's window holds
 * < pageMax → no split), so it pays nothing extra; only high-volume windows
 * subdivide. The floor is a single day — if ONE day still returns >= pageMax we
 * cannot split further, so `hitFloor=true` reports that honestly rather than
 * pretend completeness (Connection-Health doctrine: never silently truncate).
 * >1000 appts in a single day is implausible for a med spa, but we surface it.
 */
export async function listAllAcuityAppointmentsInWindow(
  accessToken: string,
  args: { minDate: string; maxDate: string; canceled: boolean; pageMax?: number },
): Promise<{ appointments: AcuityAppointment[]; hitFloor: boolean }> {
  const pageMax = args.pageMax ?? 1000;
  const dayMs = 86400000;
  const toMs = (s: string) => new Date(`${s}T00:00:00.000Z`).getTime();
  const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);

  const byId = new Map<number, AcuityAppointment>();
  let hitFloor = false;

  async function pull(minDate: string, maxDate: string): Promise<void> {
    const page = await listAcuityAppointments(accessToken, {
      minDate,
      maxDate,
      max: pageMax,
      canceled: args.canceled,
    });
    for (const a of page) byId.set(a.id, a);
    if (page.length < pageMax) return; // short page = window fully drained

    const minMs = toMs(minDate);
    const maxMs = toMs(maxDate);
    if (minMs >= maxMs) {
      // Single day (date-only granularity) — cannot subdivide further. This is
      // the only place a true cap survives; report it instead of dropping rows.
      hitFloor = true;
      return;
    }
    const midMs = minMs + Math.floor((maxMs - minMs) / 2 / dayMs) * dayMs;
    await pull(minDate, fmt(midMs));
    await pull(fmt(midMs + dayMs), maxDate);
  }

  await pull(args.minDate, args.maxDate);
  return { appointments: [...byId.values()], hitFloor };
}

export async function getAcuityAppointment(
  accessToken: string,
  appointmentId: string | number,
): Promise<AcuityAppointment> {
  return acuityFetch<AcuityAppointment>(accessToken, `/appointments/${appointmentId}`);
}

/**
 * Book a new appointment on the spa's Acuity calendar.
 *
 * Used by `claimRescueSlot` to write the new patient's booking back to
 * the source-of-truth scheduler after a rescue offer is claimed. Without
 * this call the slot is only "booked" in Refill's DB; Acuity still shows
 * the original cancellation with no replacement, and the spa has to
 * manually add the new patient to the calendar.
 *
 * Acuity will fire `appointment.scheduled` back to our webhook receiver
 * for the new appointment — the per-spa upsert in
 * `api.webhooks.scheduler.acuity.$secret.ts` is keyed on
 * (user_id, external_id, source) and will be a near-no-op once
 * `claimRescueSlot` has already stamped the new external_id on the row.
 *
 * Required: datetime (use the original cancelled appointment's `datetime`
 * field verbatim — Acuity's expected format, TZ-correct on its side),
 * appointmentTypeID, firstName, lastName.
 *
 * Optional: calendarID (Acuity picks one if omitted, but on multi-
 * provider spas you almost always want to pin to the original slot's
 * calendar), email, phone, notes.
 */
export async function bookAcuityAppointment(
  accessToken: string,
  args: {
    datetime: string;
    appointmentTypeID: number;
    calendarID?: number;
    firstName: string;
    lastName: string;
    email?: string;
    phone?: string;
    notes?: string;
  },
): Promise<AcuityAppointment> {
  const body: Record<string, unknown> = {
    datetime: args.datetime,
    appointmentTypeID: args.appointmentTypeID,
    firstName: args.firstName,
    lastName: args.lastName,
  };
  if (args.calendarID) body.calendarID = args.calendarID;
  if (args.email) body.email = args.email;
  if (args.phone) body.phone = args.phone;
  if (args.notes) body.notes = args.notes;

  // v382.1: `admin=true` bypasses Acuity's public-availability rules.
  // Without this, slots that were JUST cancelled in Acuity are flagged
  // "not_available" for ~minutes because Acuity's public booking path
  // treats cancelled-then-immediately-rebooked as suspicious. We're not
  // the public client — we're the spa admin booking on the spa's behalf
  // — so the admin flag is the correct semantic. Caught on the second
  // live test at 2026-05-19 6:29 PM MT (Karen's Tue May 26 3:30 PM slot
  // rejected with 400 "not_available" despite being visibly empty on
  // the calendar).
  return acuityFetch<AcuityAppointment>(accessToken, `/appointments?admin=true`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function listAcuityClients(
  accessToken: string,
  args: { search?: string; max?: number } = {},
): Promise<AcuityClient[]> {
  const params = new URLSearchParams();
  if (args.search) params.set("search", args.search);
  if (args.max) params.set("max", String(args.max));
  const qs = params.toString();
  return acuityFetch<AcuityClient[]>(accessToken, `/clients${qs ? `?${qs}` : ""}`);
}

// ─── Webhooks ──────────────────────────────────────────────────────────────

export async function listAcuityWebhooks(
  accessToken: string,
): Promise<AcuityWebhookSubscription[]> {
  return acuityFetch<AcuityWebhookSubscription[]>(
    accessToken,
    "/webhooks",
  );
}

export async function registerAcuityWebhook(args: {
  accessToken: string;
  event: AcuityWebhookEvent;
  target: string;
}): Promise<AcuityWebhookSubscription> {
  return acuityFetch<AcuityWebhookSubscription>(
    args.accessToken,
    "/webhooks",
    {
      method: "POST",
      body: JSON.stringify({ event: args.event, target: args.target }),
    },
  );
}

export async function deleteAcuityWebhook(args: {
  accessToken: string;
  webhookId: string | number;
}): Promise<void> {
  await acuityFetch<unknown>(
    args.accessToken,
    `/webhooks/${args.webhookId}`,
    { method: "DELETE" },
  );
}

/**
 * Register all four appointment lifecycle webhooks for a connection.
 * Idempotent — if an existing webhook with the same (event, target)
 * is found, we skip rather than duplicate.
 */
export async function ensureAcuityWebhooks(args: {
  accessToken: string;
  webhookBaseUrl: string;
}): Promise<{ registered: AcuityWebhookSubscription[]; skipped: number }> {
  const existing = await listAcuityWebhooks(args.accessToken);
  const matchTarget = (event: AcuityWebhookEvent) =>
    existing.find(
      (w) => w.event === event && w.target === args.webhookBaseUrl,
    );

  const registered: AcuityWebhookSubscription[] = [];
  let skipped = 0;
  for (const event of ACUITY_WEBHOOK_EVENTS) {
    const found = matchTarget(event);
    if (found) {
      skipped++;
      continue;
    }
    const sub = await registerAcuityWebhook({
      accessToken: args.accessToken,
      event,
      target: args.webhookBaseUrl,
    });
    registered.push(sub);
  }
  return { registered, skipped };
}

/**
 * Tear down every webhook on this account that targets our base URL.
 * Run on disconnect so we don't keep firing webhooks the spa explicitly
 * disconnected. We delete by URL match (not by ID) so a stale connection
 * record can't leave orphan subscriptions in their Acuity account.
 */
export async function tearDownAcuityWebhooksForTarget(args: {
  accessToken: string;
  webhookBaseUrl: string;
}): Promise<number> {
  const existing = await listAcuityWebhooks(args.accessToken);
  const ours = existing.filter((w) => w.target === args.webhookBaseUrl);
  for (const w of ours) {
    try {
      await deleteAcuityWebhook({
        accessToken: args.accessToken,
        webhookId: w.id,
      });
    } catch {
      // Best-effort tear-down — token may already be invalidated. Continue.
    }
  }
  return ours.length;
}

// ─── Webhook signature verification ────────────────────────────────────────

/**
 * Verify an inbound Acuity webhook signature.
 *
 * Acuity signs the raw request body with HMAC-SHA256 keyed by the OAuth
 * app's client_secret and sends the base64-encoded digest in the
 * `X-Acuity-Signature` header.
 *
 * Returns true when the computed signature matches the header.
 * Constant-time compare to avoid timing attacks.
 */
export async function verifyAcuityWebhookSignature(args: {
  rawBody: string;
  signatureHeader: string | null;
  clientSecret: string;
}): Promise<boolean> {
  if (!args.signatureHeader) return false;
  const encoder = new TextEncoder();
  const keyData = encoder.encode(args.clientSecret);
  const bodyData = encoder.encode(args.rawBody);
  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, bodyData);
  const computed = base64FromBuffer(sigBuf);
  return constantTimeEquals(computed, args.signatureHeader);
}

/**
 * Decide what to do with an inbound webhook given its signature result and
 * whether this connection's signing key has ever been proven (v2.47.0).
 *
 * Self-calibrating enforcement that can never silently drop a legitimate feed:
 *   - First valid signature on a connection → STAMP it proven (latch on).
 *   - Invalid signature on an ALREADY-proven connection → REJECT (forgery: we
 *     know the right key for this account and this body wasn't signed with it).
 *   - Otherwise (valid+proven, or invalid-but-never-proven) → process. An
 *     unproven connection stays advisory because we can't yet distinguish a
 *     forgery from Acuity signing with a key other than our client_secret; the
 *     48-char path secret remains the primary gate until the key is proven.
 *
 * Pure + side-effect-free so the policy can be unit-verified directly.
 */
export type WebhookSignatureDecision = {
  /** Hard-reject the request (401) — forgery on a key-proven connection. */
  reject: boolean;
  /** Stamp webhook_signature_verified_at = now() (first proof of the key). */
  stampVerified: boolean;
};

export function decideWebhookSignatureAction(args: {
  sigOk: boolean;
  alreadyVerified: boolean;
}): WebhookSignatureDecision {
  if (args.sigOk && !args.alreadyVerified) {
    return { reject: false, stampVerified: true };
  }
  if (!args.sigOk && args.alreadyVerified) {
    return { reject: true, stampVerified: false };
  }
  return { reject: false, stampVerified: false };
}

/**
 * Discover which key + encoding Acuity actually signs this account's webhooks
 * with (v2.47.0). Acuity's docs say dynamic (OAuth) webhooks are signed with
 * the *account API key* — which an OAuth integration doesn't hold — and real
 * deliveries don't validate against our OAuth client_secret (confirmed: 772/772
 * fail). Rather than keep guessing, probe every credential we DO possess on a
 * live delivery and report which scheme matched, so a single real webhook
 * reveals the truth in the audit trail. Once known, verification hardens to the
 * one proven scheme and the enforcement latch arms.
 *
 * Returns the matching scheme as "<keyName>:<encoding>" (e.g. "access_token:base64")
 * or null when no candidate matches.
 */
export type AcuitySignatureCandidate = { keyName: string; key: string | null };
export type AcuitySignatureProbe = { matched: boolean; scheme: string | null };

export async function probeAcuityWebhookSignature(args: {
  rawBody: string;
  signatureHeader: string | null;
  candidates: AcuitySignatureCandidate[];
}): Promise<AcuitySignatureProbe> {
  if (!args.signatureHeader) return { matched: false, scheme: null };
  const encoder = new TextEncoder();
  const bodyData = encoder.encode(args.rawBody);
  for (const cand of args.candidates) {
    if (!cand.key) continue;
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(cand.key),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sigBuf = await crypto.subtle.sign("HMAC", key, bodyData);
    if (constantTimeEquals(base64FromBuffer(sigBuf), args.signatureHeader)) {
      return { matched: true, scheme: `${cand.keyName}:base64` };
    }
    if (constantTimeEquals(hexFromBuffer(sigBuf), args.signatureHeader)) {
      return { matched: true, scheme: `${cand.keyName}:hex` };
    }
  }
  return { matched: false, scheme: null };
}

function base64FromBuffer(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let str = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    str += String.fromCharCode(bytes[i]);
  }
  return btoa(str);
}

function hexFromBuffer(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let str = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    str += bytes[i].toString(16).padStart(2, "0");
  }
  return str;
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

export type AcuityWebhookPayload = {
  action: AcuityWebhookEvent;
  appointmentId: string;
  calendarId: string | null;
  appointmentTypeId: string | null;
};

/**
 * Parse the form-encoded webhook body Acuity POSTs to our receiver.
 *
 * Body shape (per Acuity docs + real-world observation):
 *   `action=scheduled&id=12345&calendarID=678&appointmentTypeID=9`
 *
 * Note: subscription registration uses dotted event names like
 * "appointment.scheduled", but webhook DELIVERY bodies emit the short
 * form like "scheduled". Normalize to the dotted form so consumers
 * can switch on a single set of constants.
 */
export function parseAcuityWebhookBody(rawBody: string): AcuityWebhookPayload | null {
  const params = new URLSearchParams(rawBody);
  const rawAction = params.get("action");
  const id = params.get("id");
  if (!rawAction || !id) return null;

  const normalized = rawAction.includes(".")
    ? rawAction
    : `appointment.${rawAction}`;
  if (!ACUITY_WEBHOOK_EVENTS.includes(normalized as AcuityWebhookEvent)) {
    return null;
  }
  return {
    action: normalized as AcuityWebhookEvent,
    appointmentId: id,
    calendarId: params.get("calendarID"),
    appointmentTypeId: params.get("appointmentTypeID"),
  };
}
