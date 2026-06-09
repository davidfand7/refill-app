/**
 * Vagaro API connector (v1.38.0).
 *
 * Mirror of src/lib/schedulers/{acuity,square,mindbody,boulevard}.ts in
 * shape (pure functions, no Supabase coupling). Vagaro's divergences
 * worth knowing before reading:
 *
 *   - **Auth model: per-spa API key, NOT OAuth.** Vagaro does NOT support
 *     standard OAuth 2.0. Spa owners generate an API key inside their
 *     paying-merchant Vagaro account (Settings → API → Generate Key) and
 *     paste it into our install wizard. No app-level secret on our side;
 *     no 3-legged dance.
 *   - **No separate developer portal.** Vagaro's "developer access" is
 *     literally a settings panel inside the paying merchant's dashboard.
 *     There's no Refill-side app registration — every spa is its own
 *     mini-tenant relationship with Vagaro.
 *   - **Spa-side gate: 7-business-day form + $10/mo + $0.002/call**
 *     (paid BY the spa to Vagaro, NOT a Refill cost). Spa must use
 *     Vagaro CC Processing + not be on free trial. We don't gate the
 *     connection flow on this — if the spa hasn't completed their
 *     Vagaro-side activation, their API key won't work and the wizard
 *     surfaces a clear error. Self-serve diagnostic.
 *   - **Webhook signature: X-Vagaro-Signature shared token (NOT HMAC).**
 *     Per Vagaro docs the algorithm is undocumented and verification is
 *     "optional but recommended." We treat the value as a strict-equal
 *     token match against the secret returned from subscription create.
 *     Degraded-mode fallback (accept with warning) when missing, just
 *     like Mindbody scaffold.
 *   - **6 outbound IPs to whitelist** (per Vagaro docs). Not relevant
 *     for inbound webhook receivers on CF Workers (which accept any
 *     source), but documenting here so future-Refill operators know
 *     the firewall expectation if Vagaro ever sources from a fixed range.
 *
 * What's stubbed pending sandbox-verify (per platforms-pre-built
 * doctrine; one-line edits expected when a real Vagaro merchant
 * activates their API):
 *   - Exact API base URL host (assumed api.vagaro.com from spec scout)
 *   - Exact webhook subscription endpoint path
 *   - Exact X-Vagaro-Signature algorithm (shared-token vs HMAC)
 *   - Exact response shapes for appointments, customers, webhook
 *     subscriptions
 *
 * Docs (verified June 2026):
 *   https://support.vagaro.com/hc/en-us/sections/115001120428-API
 */

// ─── Constants ─────────────────────────────────────────────────────────────

const VAGARO_API_BASE = "https://api.vagaro.com";
const VAGARO_API_VERSION = "v1";

/**
 * Vagaro does NOT distinguish sandbox vs production at the API layer.
 * The same API key works against the same base URL. The env discriminator
 * exists for parity with other schedulers + future-proofing, but always
 * resolves to "production" today.
 */
export type VagaroEnv = "production";

export function resolveVagaroEnv(): VagaroEnv {
  return "production";
}

// ─── Types ─────────────────────────────────────────────────────────────────

export type VagaroCredentials = {
  apiKey: string; // Per-spa API key from the spa's merchant Vagaro account
  merchantId: string; // Optional context for diagnostics
};

export type VagaroBusiness = {
  id: string;
  name: string | null;
  email: string | null;
  status: string | null;
};

export type VagaroAppointment = {
  id: string;
  status: VagaroAppointmentStatus;
  startDateTime: string;
  endDateTime: string;
  customerId: string | null;
  staffId: string | null;
  serviceId: string | null;
  notes: string | null;
};

/**
 * v1.43.2 — expanded per docs.vagaro.com/public/docs/appointment-events
 * scout 2026-06-03. The 11 verbatim bookingStatus values (with spaces,
 * not camelCase). v1.38.0 guessed at 6 camelCase values; reality is
 * space-separated human-readable strings.
 *
 * Tolerant union: accept all 11 verbatim AND the 6 v1.38.0 guesses
 * as legacy aliases, normalize via vagaroStatusToRefillStatus.
 */
export type VagaroAppointmentStatus =
  // Verbatim Vagaro values (scout-confirmed 2026-06-03)
  | "Accepted"
  | "Awaiting Confirmation"
  | "Cancel"
  | "Confirmed"
  | "Deleted"
  | "Denied"
  | "Need Acceptance"
  | "No Show"
  | "Ready to Start"
  | "Service Completed"
  | "Service In Progress"
  | "Show"
  // v1.38.0 guesses retained as legacy aliases (tolerant normalization
  // — old data already in emma_appointments.status uses these forms).
  | "Booked"
  | "CheckedIn"
  | "Completed"
  | "Cancelled"
  | "NoShow";

export type VagaroCustomer = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
};

export type VagaroWebhookSubscription = {
  subscriptionId: string;
  webhookUrl: string;
  events: string[];
  sharedToken: string;
};

export type VagaroWebhookEvent =
  | "appointment.created"
  | "appointment.updated"
  | "appointment.deleted"
  | "customer.created"
  | "customer.updated";

export const VAGARO_WEBHOOK_EVENTS: VagaroWebhookEvent[] = [
  "appointment.created",
  "appointment.updated",
  "appointment.deleted",
  "customer.created",
  "customer.updated",
];

/**
 * Vagaro webhook signature header. Per docs the token is a shared
 * secret (NOT HMAC). Strict-equal comparison against the value Vagaro
 * returns from subscription create.
 */
export const VAGARO_WEBHOOK_SIGNATURE_HEADER = "x-vagaro-signature";

// ─── Install model (paste-API-key) ─────────────────────────────────────────

/**
 * Vagaro's connect flow: spa pastes their merchant-generated API key
 * into our install wizard. There's no Refill-side OAuth authorize URL;
 * the wizard is Refill-internal end-to-end.
 *
 * This helper builds the wizard URL the settings page navigates to.
 * Mirrors buildBoulevardInstallUrl in shape.
 */
export function buildVagaroInstallUrl(args: {
  origin: string;
  state: string;
}): string {
  const params = new URLSearchParams({ state: args.state });
  return `${args.origin}/app/refill/calendar/vagaro-install?${params.toString()}`;
}

/**
 * Deep link to the spa-side API settings inside Vagaro's merchant
 * dashboard. The wizard page uses this as the "where do I find my API
 * key" CTA target.
 */
export function vagaroSpaApiSettingsUrl(): string {
  return "https://www.vagaro.com/Pro/Settings/api";
}

// ─── API client ────────────────────────────────────────────────────────────

async function vagaroFetch<T>(args: {
  apiKey: string;
  path: string;
  init?: RequestInit;
}): Promise<T> {
  const resp = await fetch(`${VAGARO_API_BASE}/${VAGARO_API_VERSION}${args.path}`, {
    ...args.init,
    headers: {
      "X-Api-Key": args.apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(args.init?.headers ?? {}),
    },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `Vagaro API ${args.path} ${resp.status}: ${text.slice(0, 500)}`,
    );
  }
  return (await resp.json()) as T;
}

// ─── Reads ─────────────────────────────────────────────────────────────────

/**
 * Validate the API key + identify the business. Used by the install
 * wizard's auto-validate step (per feedback_setup_wizards_auto_advance:
 * pre-validate before user submits).
 */
export async function getVagaroBusiness(args: {
  credentials: VagaroCredentials;
}): Promise<VagaroBusiness> {
  type Raw = {
    business?: {
      id?: string;
      name?: string;
      email?: string;
      status?: string;
    };
  };
  const raw = await vagaroFetch<Raw>({
    apiKey: args.credentials.apiKey,
    path: "/business/me",
  });
  if (!raw.business?.id) {
    throw new Error("Vagaro business lookup returned no id.");
  }
  return {
    id: raw.business.id,
    name: raw.business.name ?? null,
    email: raw.business.email ?? null,
    status: raw.business.status ?? null,
  };
}

export async function listVagaroAppointments(args: {
  credentials: VagaroCredentials;
  startDate: string;
  endDate: string;
  limit?: number;
  offset?: number;
}): Promise<{ appointments: VagaroAppointment[]; nextOffset: number | null }> {
  const params = new URLSearchParams({
    startDate: args.startDate,
    endDate: args.endDate,
    limit: String(args.limit ?? 200),
    offset: String(args.offset ?? 0),
  });
  type Raw = {
    appointments?: VagaroAppointmentRaw[];
    totalCount?: number;
  };
  const raw = await vagaroFetch<Raw>({
    apiKey: args.credentials.apiKey,
    path: `/appointments?${params.toString()}`,
  });
  const appointments = (raw.appointments ?? []).map(rawToAppointment);
  const total = raw.totalCount ?? appointments.length;
  const consumed = (args.offset ?? 0) + appointments.length;
  return {
    appointments,
    nextOffset: consumed < total ? consumed : null,
  };
}

export async function getVagaroAppointment(args: {
  credentials: VagaroCredentials;
  appointmentId: string;
}): Promise<VagaroAppointment> {
  type Raw = { appointment?: VagaroAppointmentRaw };
  const raw = await vagaroFetch<Raw>({
    apiKey: args.credentials.apiKey,
    path: `/appointments/${args.appointmentId}`,
  });
  if (!raw.appointment) {
    throw new Error(`Vagaro appointment ${args.appointmentId} not found.`);
  }
  return rawToAppointment(raw.appointment);
}

/**
 * v1.43.2 — tolerant Raw shape covering BOTH the REST API guesses
 * from v1.38.0 (camelCase: id / status / startDateTime) AND the
 * webhook payload field names scout-confirmed 2026-06-03
 * (appointmentId / bookingStatus / startTime / serviceProviderId /
 * businessId / amount / eventType / onlineVsInhouse / etc.).
 *
 * Source of truth for webhook fields: docs.vagaro.com/public/docs/
 * appointment-events. REST field names may differ; the connector
 * accepts both and falls back gracefully.
 */
type VagaroAppointmentRaw = {
  // Webhook envelope (scout-confirmed)
  appointmentId?: string | number;
  bookingStatus?: string;
  startTime?: string;
  endTime?: string;
  serviceProviderId?: string | number;
  serviceTitle?: string | null;
  businessId?: string | number;
  amount?: number;
  eventType?: "Appointment" | "Class" | "PersonalOff";
  onlineVsInhouse?: "Online" | "Inhouse";
  appointmentTypeCode?: string;
  appointmentTypeName?: string;
  bookingSource?: string;
  calendarEventId?: string;
  formResponseIds?: ReadonlyArray<string | number>;
  // REST API / v1.38.0 guesses (kept as fallbacks; un-verified)
  id?: string | number;
  status?: string;
  startDateTime?: string;
  endDateTime?: string;
  customerId?: string | number;
  staffId?: string | number;
  serviceId?: string | number;
  notes?: string;
};

function rawToAppointment(raw: VagaroAppointmentRaw): VagaroAppointment {
  const idValue = raw.appointmentId ?? raw.id ?? "";
  const statusValue = raw.bookingStatus ?? raw.status;
  const startValue = raw.startTime ?? raw.startDateTime ?? "";
  const endValue = raw.endTime ?? raw.endDateTime ?? startValue;
  const staffValue =
    raw.serviceProviderId !== undefined ? raw.serviceProviderId : raw.staffId;
  const serviceValue =
    raw.serviceId !== undefined ? raw.serviceId : raw.appointmentTypeCode;
  return {
    id: String(idValue),
    status:
      (statusValue as VagaroAppointmentStatus | undefined) ?? "Booked",
    startDateTime: String(startValue),
    endDateTime: String(endValue),
    customerId:
      raw.customerId !== undefined ? String(raw.customerId) : null,
    staffId: staffValue !== undefined ? String(staffValue) : null,
    serviceId: serviceValue !== undefined ? String(serviceValue) : null,
    notes: raw.notes ?? raw.serviceTitle ?? null,
  };
}

// ─── Writes ────────────────────────────────────────────────────────────────

export async function createVagaroAppointment(args: {
  credentials: VagaroCredentials;
  startDateTime: string;
  customerId: string;
  serviceId: string;
  staffId: string;
  notes?: string;
}): Promise<VagaroAppointment> {
  type Raw = { appointment?: VagaroAppointmentRaw };
  const body = {
    startDateTime: args.startDateTime,
    customerId: args.customerId,
    serviceId: args.serviceId,
    staffId: args.staffId,
    notes: args.notes,
  };
  const raw = await vagaroFetch<Raw>({
    apiKey: args.credentials.apiKey,
    path: "/appointments",
    init: { method: "POST", body: JSON.stringify(body) },
  });
  if (!raw.appointment) {
    throw new Error("Vagaro createAppointment returned no appointment.");
  }
  return rawToAppointment(raw.appointment);
}

export async function upsertVagaroCustomer(args: {
  credentials: VagaroCredentials;
  phone: string | null;
  email: string | null;
  firstName: string;
  lastName: string;
}): Promise<VagaroCustomer> {
  // Try search first.
  const searchKey = args.phone ?? args.email;
  if (searchKey) {
    type SearchRaw = { customers?: VagaroCustomerRaw[] };
    const params = new URLSearchParams();
    if (args.phone) params.set("phone", args.phone);
    if (args.email) params.set("email", args.email);
    params.set("limit", "1");
    const raw = await vagaroFetch<SearchRaw>({
      apiKey: args.credentials.apiKey,
      path: `/customers?${params.toString()}`,
    });
    const hit = (raw.customers ?? [])[0];
    if (hit) return rawToCustomer(hit);
  }

  type CreateRaw = { customer?: VagaroCustomerRaw };
  const create = await vagaroFetch<CreateRaw>({
    apiKey: args.credentials.apiKey,
    path: "/customers",
    init: {
      method: "POST",
      body: JSON.stringify({
        firstName: args.firstName,
        lastName: args.lastName,
        phone: args.phone || undefined,
        email: args.email || undefined,
      }),
    },
  });
  if (!create.customer) {
    throw new Error("Vagaro createCustomer returned no customer.");
  }
  return rawToCustomer(create.customer);
}

type VagaroCustomerRaw = {
  id?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
};

function rawToCustomer(raw: VagaroCustomerRaw): VagaroCustomer {
  return {
    id: raw.id ?? "",
    firstName: raw.firstName ?? null,
    lastName: raw.lastName ?? null,
    email: raw.email ?? null,
    phone: raw.phone ?? null,
  };
}

// ─── Webhook subscription lifecycle ────────────────────────────────────────

export async function createVagaroWebhookSubscription(args: {
  credentials: VagaroCredentials;
  webhookUrl: string;
  events: readonly string[];
}): Promise<VagaroWebhookSubscription> {
  type Raw = {
    subscription?: {
      id?: string;
      webhookUrl?: string;
      events?: string[];
      sharedToken?: string;
    };
  };
  const raw = await vagaroFetch<Raw>({
    apiKey: args.credentials.apiKey,
    path: "/webhooks/subscriptions",
    init: {
      method: "POST",
      body: JSON.stringify({
        webhookUrl: args.webhookUrl,
        events: args.events,
      }),
    },
  });
  if (!raw.subscription?.id) {
    throw new Error("Vagaro webhook subscription returned no id.");
  }
  return {
    subscriptionId: raw.subscription.id,
    webhookUrl: raw.subscription.webhookUrl ?? args.webhookUrl,
    events: raw.subscription.events ?? [...args.events],
    sharedToken: raw.subscription.sharedToken ?? "",
  };
}

export async function deleteVagaroWebhookSubscription(args: {
  credentials: VagaroCredentials;
  subscriptionId: string;
}): Promise<void> {
  await vagaroFetch<unknown>({
    apiKey: args.credentials.apiKey,
    path: `/webhooks/subscriptions/${args.subscriptionId}`,
    init: { method: "DELETE" },
  });
}

// ─── Webhook signature verification ────────────────────────────────────────

/**
 * Verify an inbound Vagaro webhook signature.
 *
 * Vagaro uses a shared-token model: the value returned from subscription
 * create is included verbatim in the X-Vagaro-Signature header on every
 * inbound delivery. Strict-equal compare. NOT HMAC.
 *
 * Per Vagaro docs verification is "optional but recommended" — degraded
 * mode (accept with warning) handles missing-secret scenarios.
 */
export function verifyVagaroWebhookSignature(args: {
  signatureHeader: string | null;
  sharedToken: string;
}): boolean {
  if (!args.signatureHeader || !args.sharedToken) return false;
  // Constant-time compare.
  if (args.signatureHeader.length !== args.sharedToken.length) return false;
  let mismatch = 0;
  for (let i = 0; i < args.signatureHeader.length; i++) {
    mismatch |=
      args.signatureHeader.charCodeAt(i) ^ args.sharedToken.charCodeAt(i);
  }
  return mismatch === 0;
}

// ─── Webhook payload parsing ───────────────────────────────────────────────

export type VagaroWebhookPayload = {
  eventId: string;
  type: VagaroWebhookEvent;
  merchantId: string;
  occurredAt: string;
  appointment: VagaroAppointment | null;
  customer: VagaroCustomer | null;
};

/**
 * v1.43.2 — envelope shape corrected per docs.vagaro.com scout
 * 2026-06-03. Verbatim envelope: `{ id, createdDate, type, action,
 * payload }` where `type` is the bucket (appointment / customer /
 * formResponse / transaction / business_location / employee) and
 * `action` is the verb (created / updated / deleted). v1.38.0 read
 * `event` as the combined string ("appointment.created"); reality
 * is two separate fields.
 *
 * Backward-compatible: accepts BOTH the new envelope (type + action)
 * and legacy v1.38.0 envelope (event + eventId + occurredAt + data).
 */
export function parseVagaroWebhookBody(
  rawBody: string,
): VagaroWebhookPayload | null {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const j = json as Record<string, unknown>;

  // Combine type+action into the v1.38.0-style "type.action" event string.
  // Scout-confirmed envelope: type=appointment, action=created.
  // Legacy v1.38.0: event=appointment.created (single string).
  let eventType: string | undefined;
  if (typeof j.event === "string") {
    eventType = j.event;
  } else if (typeof j.type === "string" && typeof j.action === "string") {
    eventType = `${j.type}.${j.action}`;
  } else if (typeof j.type === "string") {
    eventType = j.type; // bucket-only, no action — best effort
  }
  if (!eventType) return null;
  if (!VAGARO_WEBHOOK_EVENTS.includes(eventType as VagaroWebhookEvent)) {
    return null;
  }

  const merchantId = String(j.merchantId ?? j.businessId ?? "");
  const eventId = String(j.eventId ?? j.id ?? "");
  // Scout-confirmed envelope uses `createdDate`; legacy used
  // `occurredAt` / `createdAt`. Tolerant fallback chain.
  const occurredAt = String(
    j.createdDate ?? j.occurredAt ?? j.createdAt ?? "",
  );
  if (!merchantId || !eventId || !occurredAt) return null;

  // Scout-confirmed envelope uses `payload`; legacy used `data`.
  const data = (j.payload ?? j.data ?? {}) as Record<string, unknown>;
  const appointment = eventType.startsWith("appointment.")
    ? rawToAppointment(data as VagaroAppointmentRaw)
    : null;
  const customer = eventType.startsWith("customer.")
    ? rawToCustomer(data as VagaroCustomerRaw)
    : null;

  return {
    eventId,
    type: eventType as VagaroWebhookEvent,
    merchantId,
    occurredAt,
    appointment: appointment && appointment.id ? appointment : null,
    customer: customer && customer.id ? customer : null,
  };
}

/**
 * v1.43.2 — expanded to cover all 11 verbatim Vagaro bookingStatus
 * values per docs.vagaro.com scout 2026-06-03, plus the 6 v1.38.0
 * camelCase guesses retained as legacy aliases.
 *
 * Mapping rationale:
 *   - Cancel / Deleted / Denied                → cancelled (firing rescue)
 *   - No Show                                  → no_show (firing rescue)
 *   - Ready to Start / Service In Progress     → scheduled (active, in flight)
 *   - Service Completed / Show                 → showed (terminal-happy)
 *   - Accepted / Confirmed / Awaiting
 *     Confirmation / Need Acceptance           → scheduled (forward-looking)
 *   - Legacy aliases (Booked/CheckedIn/
 *     Completed/Cancelled/NoShow)              → mapped per v1.38.0 semantics
 */
export function vagaroStatusToRefillStatus(
  status: VagaroAppointmentStatus,
): "scheduled" | "cancelled" | "no_show" | "showed" {
  switch (status) {
    // Cancellation family
    case "Cancel":
    case "Deleted":
    case "Denied":
    case "Cancelled": // legacy
      return "cancelled";
    // No-show family
    case "No Show":
    case "NoShow": // legacy
      return "no_show";
    // Terminal-happy family
    case "Service Completed":
    case "Show":
    case "Completed": // legacy
    case "CheckedIn": // legacy (treated as showed in v1.38.0)
      return "showed";
    // Active / forward-looking
    case "Accepted":
    case "Awaiting Confirmation":
    case "Confirmed":
    case "Need Acceptance":
    case "Ready to Start":
    case "Service In Progress":
    case "Booked": // legacy
    default:
      return "scheduled";
  }
}
