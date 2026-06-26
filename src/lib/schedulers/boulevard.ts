/**
 * Boulevard Admin API connector (v1.36.0).
 *
 * Mirrors `src/lib/schedulers/square.ts` in shape (pure functions, no
 * Supabase coupling) so `src/server/emma-scheduler.functions.ts` can
 * dispatch on `platform` without caring which scheduler is which. The
 * substrate is GraphQL via `src/lib/graphql/boulevard-admin-client.ts`
 * instead of REST, but the connector exports the same surface shape:
 * read appointments, get appointment, create appointment, find-or-
 * create client, register webhook subscription, verify webhook
 * signature, parse webhook body, map provider status to Refill status.
 *
 * Boulevard divergences from Acuity/Square (worth knowing before
 * reading):
 *   - **Install model is paste-Application-ID, NOT 3-legged OAuth.**
 *     Spas install our app inside their Boulevard dashboard at
 *     `dashboard.joinblvd.com/manage-business/apps`. Boulevard then
 *     fires an install event to a callback URL we register on the
 *     dev console; our app credentials are pre-shared (single
 *     api_key + api_secret pair across all our spas). The connection
 *     row stores the businessId URN (returned in the install event)
 *     for tenant routing.
 *   - **GraphQL substrate.** All reads/writes go through the generic
 *     `boulevardGraphQL` POST wrapper. No per-endpoint REST paths.
 *   - **App-level credentials, not per-spa tokens.** No 30-day token
 *     refresh dance. `connection.access_token` stays null; auth is
 *     via app creds + the businessId URN scoping each request.
 *   - **URN-format IDs.** Every Boulevard object identifier is a URN
 *     (`urn:blvd:Business:abc123` etc.). Stored as opaque strings in
 *     Refill's DB; opaque routing happens via exact-match.
 *   - **Single global webhook URL** (same pattern as Square). Tenant
 *     routing happens via businessId URN embedded in the payload, NOT
 *     via per-spa secret in the URL path (which is how Acuity does it).
 *   - **Webhook signature scheme.** Assumed HMAC-SHA256 over raw body
 *     (header name + algorithm pinned at sandbox-verify). The
 *     `verifyBoulevardWebhookSignature` scaffold below mirrors
 *     Square's verifier; the exact header name string lives in a
 *     constant so it's a one-line edit when sandbox confirms.
 *   - **Tier gate**: Boulevard Premier OR Enterprise required (broader
 *     than Boulevard marketing's "Enterprise only" framing — verified
 *     during the Jun 2 spec scout). The createAppointment mutation
 *     will return a clear errors[] entry on Free/Starter tier sellers;
 *     caller fail-degrades with a banner on the Refill dashboard
 *     (same UX pattern as Square Free tier).
 *
 * Pinned: API version (in boulevard-admin-client). GraphQL operation
 * names (e.g. `createAppointment` vs `appointmentCreate`) are constants
 * here — Boulevard's actual mutation names are pinned at sandbox-verify,
 * substrate is otherwise complete.
 *
 * Docs:
 *   https://developers.joinblvd.com/reference/introduction-to-the-admin-api
 *   https://developers.joinblvd.com/reference/authentication
 *   https://developers.joinblvd.com/reference/webhooks
 */

import {
  boulevardGraphQL,
  parseBoulevardUrn,
  type BoulevardEnv,
  type BoulevardUrn,
} from "@/lib/graphql/boulevard-admin-client";

// ─── Env resolution ────────────────────────────────────────────────────────

/**
 * v1.35.x doctrine: single source of truth for env resolution. Defensive
 * trim + lowercase + strict equality in one place; all consumers route
 * through here. Mirrors `resolveSquareEnv()` in src/lib/schedulers/square.ts.
 *
 * Cloudflare's secret/plaintext input field has demonstrated whitespace
 * contamination on stored values across the v1.35.x debug arc; the same
 * defensive pattern applies to BLVD_ENV.
 */
export function resolveBoulevardEnv(): BoulevardEnv {
  const raw = (process.env.BLVD_ENV ?? "").trim().toLowerCase();
  return raw === "sandbox" ? "sandbox" : "production";
}

// ─── Types ─────────────────────────────────────────────────────────────────

export type BoulevardOAuthCredentials = {
  applicationId: string; // pre-shared, displayed to spa for paste-install
  apiKey: string;
  apiSecret: string;
  env: BoulevardEnv;
};

export type BoulevardTokenResponse = {
  // Boulevard doesn't issue per-spa tokens in the install model;
  // this type exists for connector-shape parity with Square so dispatch
  // code can assume a consistent return shape across platforms. The
  // accessToken slot stays empty (auth happens via app-level creds at
  // call time) but businessId is the real load-bearing identifier.
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresAt: string; // ISO 8601
  businessId: BoulevardUrn;
  scope: string[];
};

export type BoulevardBusiness = {
  id: BoulevardUrn;
  name: string | null;
  status: string | null;
  tier: string | null; // "Free" | "Starter" | "Premier" | "Enterprise" — verify at sandbox
};

export type BoulevardLocation = {
  id: BoulevardUrn;
  name: string | null;
  tz: string | null;
};

export type BoulevardAppointment = {
  id: BoulevardUrn;
  status: BoulevardAppointmentStatus;
  startAt: string; // ISO 8601
  endAt: string;
  locationId: BoulevardUrn | null;
  clientId: BoulevardUrn | null;
  staffId: BoulevardUrn | null;
  serviceIds: BoulevardUrn[];
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

export type BoulevardAppointmentStatus =
  | "BOOKED"
  | "CONFIRMED"
  | "ARRIVED"
  | "STARTED"
  | "COMPLETED"
  | "CANCELLED"
  | "NO_SHOW"
  | "RESCHEDULED";

export type BoulevardClient = {
  id: BoulevardUrn;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
};

export type BoulevardWebhookSubscription = {
  id: BoulevardUrn;
  enabled: boolean;
  eventTypes: string[];
  notificationUrl: string;
  signingSecret: string;
};

export type BoulevardWebhookEvent =
  | "CLIENT_CREATED"
  | "APPOINTMENT_CREATED"
  | "APPOINTMENT_CONFIRMED"
  | "APPOINTMENT_COMPLETED"
  | "APPOINTMENT_CANCELLED"
  | "APPOINTMENT_RESCHEDULED";

export const BOULEVARD_WEBHOOK_EVENTS: BoulevardWebhookEvent[] = [
  "CLIENT_CREATED",
  "APPOINTMENT_CREATED",
  "APPOINTMENT_CONFIRMED",
  "APPOINTMENT_COMPLETED",
  "APPOINTMENT_CANCELLED",
  "APPOINTMENT_RESCHEDULED",
];

/**
 * Boulevard scope list. App-level scopes granted at app-approval time —
 * NOT per-OAuth-flow consent like Square. Pinned here for reference; the
 * developer console at developers.joinblvd.com is the source of truth.
 */
export const BOULEVARD_OAUTH_SCOPES = [
  "READ_APPOINTMENTS",
  "WRITE_APPOINTMENTS",
  "READ_CLIENTS",
  "WRITE_CLIENTS",
  "READ_BUSINESS",
  "READ_LOCATIONS",
  "READ_STAFF",
  "READ_SERVICES",
  "MANAGE_WEBHOOKS",
] as const;

// ─── Webhook header name (sandbox-verify pin) ──────────────────────────────

/**
 * The HTTP header name Boulevard uses to carry the HMAC signature on
 * inbound webhooks. Pinned here so it's a one-line edit when sandbox
 * surfaces the actual name. Best guess from spec scout + provider
 * convention: `X-Boulevard-Signature`.
 *
 * Until sandbox-verify: signature verification still runs but the
 * receiver fail-degrades to "log + accept" on missing header (vs
 * "reject hard") because the wrong header name would cause every legit
 * webhook to fail and we'd never get observability into the actual
 * shape. The receiver scaffold encodes this as warn-then-accept.
 */
export const BOULEVARD_WEBHOOK_SIGNATURE_HEADER = "x-boulevard-signature";

// ─── Install model (Application-ID paste) ──────────────────────────────────

/**
 * Boulevard's spa-side install flow: the spa pastes our app's
 * Application ID into their Boulevard dashboard at
 * `dashboard.joinblvd.com/manage-business/apps` → Custom Apps → Install.
 * Boulevard then sends us an install event with the businessId URN.
 *
 * This helper builds the deep link the spa-facing wizard renders +
 * the clipboard text they paste. No OAuth authorize URL (vs Square's
 * 3-legged flow). Mirrors `buildSquareAuthorizeUrl` in shape so dispatch
 * code can dispatch on platform without special-casing.
 *
 * Returns the wizard URL — Refill-internal, not Boulevard-hosted. The
 * wizard page renders the Application ID for clipboard-copy + a
 * deep-link CTA to Boulevard's dashboard.
 */
export function buildBoulevardInstallUrl(args: {
  origin: string;
  applicationId: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    application_id: args.applicationId,
    state: args.state,
  });
  // Lives under the Calendar Solution (v2.3.18 IA reorg). Calendar is already
  // a pure <Outlet> shell with its own .index, so this dot-child is safe
  // (feedback_tanstack_outlet_trap satisfied).
  return `${args.origin}/app/refill/calendar/boulevard-install?${params.toString()}`;
}

/**
 * Deep link to the spa-side install screen inside the Boulevard
 * dashboard. The wizard page uses this as the CTA target after the spa
 * copies the Application ID to clipboard.
 */
export function boulevardSpaDashboardAppsUrl(): string {
  return "https://dashboard.joinblvd.com/manage-business/apps";
}

// ─── Reads ─────────────────────────────────────────────────────────────────

/**
 * Fetch the connected business — used post-install to populate the
 * connection row's display fields (business name, currency, etc.) and
 * to detect tier-gate on first sync.
 *
 * Mutation names are pinned constants pending sandbox-verify. The
 * GraphQL operation strings live as constants below the function bodies
 * so a Boulevard-side rename (e.g. `business` → `currentBusiness`) is
 * a one-line edit.
 */
export async function getBoulevardBusiness(args: {
  credentials: BoulevardOAuthCredentials;
  businessId: BoulevardUrn;
}): Promise<BoulevardBusiness> {
  type Raw = {
    business: {
      id: string;
      name?: string | null;
      status?: string | null;
      tier?: string | null;
    } | null;
  };
  const data = await boulevardGraphQL<Raw>({
    env: args.credentials.env,
    apiKey: args.credentials.apiKey,
    apiSecret: args.credentials.apiSecret,
    query: BOULEVARD_QUERY_BUSINESS,
    variables: { id: args.businessId },
    businessId: args.businessId,
  });
  if (!data.business) {
    throw new Error(`Boulevard business ${args.businessId} not found.`);
  }
  return {
    id: data.business.id,
    name: data.business.name ?? null,
    status: data.business.status ?? null,
    tier: data.business.tier ?? null,
  };
}

export async function listBoulevardLocations(args: {
  credentials: BoulevardOAuthCredentials;
  businessId: BoulevardUrn;
}): Promise<BoulevardLocation[]> {
  type Raw = {
    business: {
      locations: { id: string; name?: string | null; tz?: string | null }[];
    } | null;
  };
  const data = await boulevardGraphQL<Raw>({
    env: args.credentials.env,
    apiKey: args.credentials.apiKey,
    apiSecret: args.credentials.apiSecret,
    query: BOULEVARD_QUERY_LOCATIONS,
    variables: { id: args.businessId },
    businessId: args.businessId,
  });
  const locs = data.business?.locations ?? [];
  return locs.map((l) => ({
    id: l.id,
    name: l.name ?? null,
    tz: l.tz ?? null,
  }));
}

export async function listBoulevardAppointments(args: {
  credentials: BoulevardOAuthCredentials;
  businessId: BoulevardUrn;
  startAtMin: string; // ISO 8601
  startAtMax: string;
  locationId?: BoulevardUrn;
  limit?: number;
  cursor?: string;
}): Promise<{ appointments: BoulevardAppointment[]; cursor: string | null }> {
  type Raw = {
    appointments: {
      nodes: BoulevardAppointmentRaw[];
      pageInfo: { endCursor: string | null; hasNextPage: boolean };
    };
  };
  const data = await boulevardGraphQL<Raw>({
    env: args.credentials.env,
    apiKey: args.credentials.apiKey,
    apiSecret: args.credentials.apiSecret,
    query: BOULEVARD_QUERY_APPOINTMENTS,
    variables: {
      businessId: args.businessId,
      startAtMin: args.startAtMin,
      startAtMax: args.startAtMax,
      locationId: args.locationId,
      first: args.limit ?? 200,
      after: args.cursor,
    },
    businessId: args.businessId,
  });
  return {
    appointments: data.appointments.nodes.map(rawToAppointment),
    cursor: data.appointments.pageInfo.hasNextPage
      ? data.appointments.pageInfo.endCursor
      : null,
  };
}

export async function getBoulevardAppointment(args: {
  credentials: BoulevardOAuthCredentials;
  businessId: BoulevardUrn;
  appointmentId: BoulevardUrn;
}): Promise<BoulevardAppointment> {
  type Raw = { appointment: BoulevardAppointmentRaw | null };
  const data = await boulevardGraphQL<Raw>({
    env: args.credentials.env,
    apiKey: args.credentials.apiKey,
    apiSecret: args.credentials.apiSecret,
    query: BOULEVARD_QUERY_APPOINTMENT,
    variables: { id: args.appointmentId },
    businessId: args.businessId,
  });
  if (!data.appointment) {
    throw new Error(
      `Boulevard appointment ${args.appointmentId} not found.`,
    );
  }
  return rawToAppointment(data.appointment);
}

type BoulevardAppointmentRaw = {
  id: string;
  status: string;
  startAt: string;
  endAt?: string;
  location?: { id?: string } | null;
  client?: { id?: string } | null;
  staff?: { id?: string } | null;
  services?: { id?: string }[] | null;
  notes?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

function rawToAppointment(raw: BoulevardAppointmentRaw): BoulevardAppointment {
  return {
    id: raw.id,
    status: (raw.status as BoulevardAppointmentStatus) ?? "BOOKED",
    startAt: raw.startAt,
    endAt: raw.endAt ?? raw.startAt,
    locationId: raw.location?.id ?? null,
    clientId: raw.client?.id ?? null,
    staffId: raw.staff?.id ?? null,
    serviceIds: (raw.services ?? []).map((s) => s.id ?? "").filter(Boolean),
    notes: raw.notes ?? null,
    createdAt: raw.createdAt ?? raw.startAt,
    updatedAt: raw.updatedAt ?? raw.startAt,
  };
}

// ─── Writes ────────────────────────────────────────────────────────────────

/**
 * Book a new appointment on the spa's Boulevard calendar.
 *
 * Used by `claimRescueSlot` to write the new patient's booking back to
 * Boulevard after a rescue offer is claimed — mirror of `bookAcuity-
 * Appointment` + `createSquareBooking`.
 *
 * Boulevard fires `APPOINTMENT_CREATED` back to the webhook receiver
 * for the new appointment. The receiver's upsert is keyed on (user_id,
 * external_id, source) so the round-trip is a near-no-op once this
 * call has already stamped the new external_id on the row.
 *
 * Tier gate: this call REQUIRES the seller to be on Boulevard Premier
 * or Enterprise. Free/Starter sellers get a clear errors[] entry from
 * the mutation; caller must handle fail-degraded (claim stays committed
 * in Refill; banner instructs manual rebooking on the spa's dashboard).
 */
export async function createBoulevardAppointment(args: {
  credentials: BoulevardOAuthCredentials;
  businessId: BoulevardUrn;
  startAt: string; // ISO 8601
  locationId: BoulevardUrn;
  clientId: BoulevardUrn;
  serviceIds: BoulevardUrn[];
  staffId?: BoulevardUrn;
  notes?: string;
  idempotencyKey: string;
}): Promise<BoulevardAppointment> {
  type Raw = {
    appointmentCreate: {
      appointment: BoulevardAppointmentRaw | null;
      userErrors?: { message: string; path?: string[] }[];
    };
  };
  const data = await boulevardGraphQL<Raw>({
    env: args.credentials.env,
    apiKey: args.credentials.apiKey,
    apiSecret: args.credentials.apiSecret,
    query: BOULEVARD_MUTATION_CREATE_APPOINTMENT,
    variables: {
      input: {
        startAt: args.startAt,
        locationId: args.locationId,
        clientId: args.clientId,
        serviceIds: args.serviceIds,
        staffId: args.staffId,
        notes: args.notes,
        idempotencyKey: args.idempotencyKey,
      },
    },
    businessId: args.businessId,
  });
  const userErrors = data.appointmentCreate.userErrors ?? [];
  if (userErrors.length > 0) {
    throw new Error(
      `Boulevard appointmentCreate userErrors: ${userErrors.map((e) => e.message).join("; ")}`,
    );
  }
  if (!data.appointmentCreate.appointment) {
    throw new Error("Boulevard appointmentCreate returned no appointment.");
  }
  return rawToAppointment(data.appointmentCreate.appointment);
}

/**
 * Find-or-create a client on the seller's Boulevard account.
 *
 * Roster-miss path: a CSV-uploaded waitlist patient claims a rescue
 * slot, but the seller has no Boulevard client record for them. We
 * search by phone (or email if no phone), and if no match, create.
 *
 * Returns the BoulevardClient.id (URN) which the caller stamps on the
 * knowledge_node and passes into createBoulevardAppointment. Mirrors
 * `upsertSquareCustomer` in shape.
 */
export async function upsertBoulevardClient(args: {
  credentials: BoulevardOAuthCredentials;
  businessId: BoulevardUrn;
  phone: string | null;
  email: string | null;
  firstName: string;
  lastName: string;
}): Promise<BoulevardClient> {
  // Try search first — phone is more reliable than email.
  const searchKey = args.phone ?? args.email;
  if (searchKey) {
    type SearchRaw = {
      clients: {
        nodes: {
          id: string;
          firstName?: string | null;
          lastName?: string | null;
          email?: string | null;
          phone?: string | null;
        }[];
      };
    };
    const data = await boulevardGraphQL<SearchRaw>({
      env: args.credentials.env,
      apiKey: args.credentials.apiKey,
      apiSecret: args.credentials.apiSecret,
      query: BOULEVARD_QUERY_CLIENTS_BY_CONTACT,
      variables: {
        businessId: args.businessId,
        phone: args.phone,
        email: args.email,
        first: 1,
      },
      businessId: args.businessId,
    });
    const hit = data.clients.nodes[0];
    if (hit) {
      return {
        id: hit.id,
        firstName: hit.firstName ?? null,
        lastName: hit.lastName ?? null,
        email: hit.email ?? null,
        phone: hit.phone ?? null,
      };
    }
  }

  // No hit — create.
  type CreateRaw = {
    clientCreate: {
      client: {
        id: string;
        firstName?: string | null;
        lastName?: string | null;
        email?: string | null;
        phone?: string | null;
      } | null;
      userErrors?: { message: string }[];
    };
  };
  const data = await boulevardGraphQL<CreateRaw>({
    env: args.credentials.env,
    apiKey: args.credentials.apiKey,
    apiSecret: args.credentials.apiSecret,
    query: BOULEVARD_MUTATION_CREATE_CLIENT,
    variables: {
      input: {
        firstName: args.firstName,
        lastName: args.lastName,
        phone: args.phone,
        email: args.email,
      },
    },
    businessId: args.businessId,
  });
  const userErrors = data.clientCreate.userErrors ?? [];
  if (userErrors.length > 0) {
    throw new Error(
      `Boulevard clientCreate userErrors: ${userErrors.map((e) => e.message).join("; ")}`,
    );
  }
  if (!data.clientCreate.client) {
    throw new Error("Boulevard clientCreate returned no client.");
  }
  return {
    id: data.clientCreate.client.id,
    firstName: data.clientCreate.client.firstName ?? null,
    lastName: data.clientCreate.client.lastName ?? null,
    email: data.clientCreate.client.email ?? null,
    phone: data.clientCreate.client.phone ?? null,
  };
}

// ─── Webhook subscription lifecycle ────────────────────────────────────────

/**
 * Register a webhook subscription on the spa's Boulevard business.
 *
 * Same single-global-URL pattern as Square — every Boulevard spa fires
 * to the same receiver path; tenant routing happens via businessId URN
 * in the payload, NOT via per-spa secret in the URL.
 *
 * Returns the subscription resource with the `signingSecret` Boulevard
 * issues — stored on the connection row's `webhook_secret` column for
 * HMAC verification on inbound webhooks. Mirror of
 * `createSquareWebhookSubscription`.
 */
export async function createBoulevardWebhookSubscription(args: {
  credentials: BoulevardOAuthCredentials;
  businessId: BoulevardUrn;
  notificationUrl: string;
}): Promise<BoulevardWebhookSubscription> {
  type Raw = {
    webhookSubscriptionCreate: {
      subscription: {
        id: string;
        enabled?: boolean;
        eventTypes?: string[];
        notificationUrl?: string;
        signingSecret?: string;
      } | null;
      userErrors?: { message: string }[];
    };
  };
  const data = await boulevardGraphQL<Raw>({
    env: args.credentials.env,
    apiKey: args.credentials.apiKey,
    apiSecret: args.credentials.apiSecret,
    query: BOULEVARD_MUTATION_CREATE_WEBHOOK_SUBSCRIPTION,
    variables: {
      input: {
        notificationUrl: args.notificationUrl,
        eventTypes: BOULEVARD_WEBHOOK_EVENTS,
      },
    },
    businessId: args.businessId,
  });
  const userErrors = data.webhookSubscriptionCreate.userErrors ?? [];
  if (userErrors.length > 0) {
    throw new Error(
      `Boulevard webhookSubscriptionCreate userErrors: ${userErrors.map((e) => e.message).join("; ")}`,
    );
  }
  const sub = data.webhookSubscriptionCreate.subscription;
  if (!sub) {
    throw new Error(
      "Boulevard webhookSubscriptionCreate returned no subscription.",
    );
  }
  return {
    id: sub.id,
    enabled: sub.enabled ?? true,
    eventTypes: sub.eventTypes ?? [...BOULEVARD_WEBHOOK_EVENTS],
    notificationUrl: sub.notificationUrl ?? args.notificationUrl,
    signingSecret: sub.signingSecret ?? "",
  };
}

export async function deleteBoulevardWebhookSubscription(args: {
  credentials: BoulevardOAuthCredentials;
  businessId: BoulevardUrn;
  subscriptionId: BoulevardUrn;
}): Promise<void> {
  type Raw = {
    webhookSubscriptionDelete: {
      deletedId: string | null;
      userErrors?: { message: string }[];
    };
  };
  const data = await boulevardGraphQL<Raw>({
    env: args.credentials.env,
    apiKey: args.credentials.apiKey,
    apiSecret: args.credentials.apiSecret,
    query: BOULEVARD_MUTATION_DELETE_WEBHOOK_SUBSCRIPTION,
    variables: { id: args.subscriptionId },
    businessId: args.businessId,
  });
  const userErrors = data.webhookSubscriptionDelete.userErrors ?? [];
  if (userErrors.length > 0) {
    throw new Error(
      `Boulevard webhookSubscriptionDelete userErrors: ${userErrors.map((e) => e.message).join("; ")}`,
    );
  }
}

// ─── Webhook signature verification ────────────────────────────────────────

/**
 * Verify an inbound Boulevard webhook signature.
 *
 * Assumed scheme (pinned at sandbox-verify): HMAC-SHA256 over the raw
 * body keyed by the per-subscription `signingSecret`. Result base64-
 * encoded in the `X-Boulevard-Signature` header. Constant-time compare.
 *
 * If sandbox-verify surfaces a different scheme (e.g. SHA-1, or
 * signature includes the URL like Square), this function is the only
 * place that needs editing — the receiver wraps it transparently.
 */
export async function verifyBoulevardWebhookSignature(args: {
  rawBody: string;
  signatureHeader: string | null;
  signingSecret: string;
}): Promise<boolean> {
  if (!args.signatureHeader) return false;
  const encoder = new TextEncoder();
  const keyData = encoder.encode(args.signingSecret);
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
 * Boulevard webhook envelope (assumed shape; verify at sandbox).
 *
 * Spec-scout assumption:
 *   {
 *     id: "evt_abc123",                              // event id for idempotency
 *     type: "APPOINTMENT_CREATED",
 *     businessId: "urn:blvd:Business:xyz",
 *     occurredAt: "2026-06-03T12:34:56Z",
 *     data: { appointment: {...} } | { client: {...} }
 *   }
 *
 * Boulevard's actual envelope may use different field names — the
 * parser is generous on what it accepts and surfaces `eventId`,
 * `businessId`, `type`, `occurredAt`, plus typed appointment/client
 * payloads when present.
 */
export type BoulevardWebhookPayload = {
  eventId: string;
  type: BoulevardWebhookEvent;
  businessId: BoulevardUrn;
  occurredAt: string;
  appointmentId: BoulevardUrn | null;
  appointment: BoulevardAppointment | null;
  clientId: BoulevardUrn | null;
  client: BoulevardClient | null;
};

export function parseBoulevardWebhookBody(
  rawBody: string,
): BoulevardWebhookPayload | null {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const j = json as Record<string, unknown>;
  const type = j.type as string | undefined;
  if (!type) return null;
  if (!BOULEVARD_WEBHOOK_EVENTS.includes(type as BoulevardWebhookEvent)) {
    return null;
  }

  const businessId = (j.businessId ?? j.business_id) as string | undefined;
  const eventId = (j.id ?? j.eventId ?? j.event_id) as string | undefined;
  const occurredAt = (j.occurredAt ?? j.occurred_at ?? j.createdAt) as
    | string
    | undefined;

  if (!businessId || !eventId || !occurredAt) return null;
  if (!parseBoulevardUrn(businessId)) return null;

  const data = (j.data ?? {}) as Record<string, unknown>;
  const apptRaw = (data.appointment ?? null) as BoulevardAppointmentRaw | null;
  const clientRaw = (data.client ?? null) as
    | {
        id: string;
        firstName?: string | null;
        lastName?: string | null;
        email?: string | null;
        phone?: string | null;
      }
    | null;

  return {
    eventId,
    type: type as BoulevardWebhookEvent,
    businessId,
    occurredAt,
    appointmentId: apptRaw?.id ?? null,
    appointment: apptRaw ? rawToAppointment(apptRaw) : null,
    clientId: clientRaw?.id ?? null,
    client: clientRaw
      ? {
          id: clientRaw.id,
          firstName: clientRaw.firstName ?? null,
          lastName: clientRaw.lastName ?? null,
          email: clientRaw.email ?? null,
          phone: clientRaw.phone ?? null,
        }
      : null,
  };
}

/**
 * Map a Boulevard appointment status to Refill's appointment status
 * union. Folded into one place so the webhook receiver + backfill
 * share it. Mirror of `squareStatusToRefillStatus`.
 */
export function boulevardStatusToRefillStatus(
  status: BoulevardAppointmentStatus,
): "scheduled" | "cancelled" | "no_show" | "showed" {
  switch (status) {
    case "CANCELLED":
      return "cancelled";
    case "NO_SHOW":
      return "no_show";
    case "COMPLETED":
    case "ARRIVED":
    case "STARTED":
      return "showed";
    case "BOOKED":
    case "CONFIRMED":
    case "RESCHEDULED":
    default:
      return "scheduled";
  }
}

// ─── GraphQL operation constants ───────────────────────────────────────────
//
// Pinned here so a Boulevard-side rename is a one-line edit. All
// substrate code routes through these constants; no inline GraphQL
// elsewhere in the connector.

const BOULEVARD_QUERY_BUSINESS = /* GraphQL */ `
  query GetBusiness($id: ID!) {
    business(id: $id) {
      id
      name
      status
      tier
    }
  }
`;

const BOULEVARD_QUERY_LOCATIONS = /* GraphQL */ `
  query GetLocations($id: ID!) {
    business(id: $id) {
      locations {
        id
        name
        tz
      }
    }
  }
`;

const BOULEVARD_QUERY_APPOINTMENTS = /* GraphQL */ `
  query ListAppointments(
    $businessId: ID!
    $startAtMin: DateTime!
    $startAtMax: DateTime!
    $locationId: ID
    $first: Int
    $after: String
  ) {
    appointments(
      businessId: $businessId
      startAtMin: $startAtMin
      startAtMax: $startAtMax
      locationId: $locationId
      first: $first
      after: $after
    ) {
      nodes {
        id
        status
        startAt
        endAt
        location { id }
        client { id }
        staff { id }
        services { id }
        notes
        createdAt
        updatedAt
      }
      pageInfo {
        endCursor
        hasNextPage
      }
    }
  }
`;

const BOULEVARD_QUERY_APPOINTMENT = /* GraphQL */ `
  query GetAppointment($id: ID!) {
    appointment(id: $id) {
      id
      status
      startAt
      endAt
      location { id }
      client { id }
      staff { id }
      services { id }
      notes
      createdAt
      updatedAt
    }
  }
`;

const BOULEVARD_QUERY_CLIENTS_BY_CONTACT = /* GraphQL */ `
  query ClientsByContact(
    $businessId: ID!
    $phone: String
    $email: String
    $first: Int
  ) {
    clients(
      businessId: $businessId
      phone: $phone
      email: $email
      first: $first
    ) {
      nodes {
        id
        firstName
        lastName
        email
        phone
      }
    }
  }
`;

const BOULEVARD_MUTATION_CREATE_APPOINTMENT = /* GraphQL */ `
  mutation CreateAppointment($input: AppointmentCreateInput!) {
    appointmentCreate(input: $input) {
      appointment {
        id
        status
        startAt
        endAt
        location { id }
        client { id }
        staff { id }
        services { id }
        notes
        createdAt
        updatedAt
      }
      userErrors { message path }
    }
  }
`;

const BOULEVARD_MUTATION_CREATE_CLIENT = /* GraphQL */ `
  mutation CreateClient($input: ClientCreateInput!) {
    clientCreate(input: $input) {
      client {
        id
        firstName
        lastName
        email
        phone
      }
      userErrors { message }
    }
  }
`;

const BOULEVARD_MUTATION_CREATE_WEBHOOK_SUBSCRIPTION = /* GraphQL */ `
  mutation CreateWebhookSubscription($input: WebhookSubscriptionCreateInput!) {
    webhookSubscriptionCreate(input: $input) {
      subscription {
        id
        enabled
        eventTypes
        notificationUrl
        signingSecret
      }
      userErrors { message }
    }
  }
`;

const BOULEVARD_MUTATION_DELETE_WEBHOOK_SUBSCRIPTION = /* GraphQL */ `
  mutation DeleteWebhookSubscription($id: ID!) {
    webhookSubscriptionDelete(id: $id) {
      deletedId
      userErrors { message }
    }
  }
`;
