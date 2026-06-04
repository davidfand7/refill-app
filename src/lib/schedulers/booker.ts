/**
 * Booker API connector (v1.39.0).
 *
 * Booker = the spa/salon platform Mindbody acquired in 2018 for ~$150M.
 * Despite the corporate unification under "Playlist" (June 2025), Booker
 * operates COMPLETELY SEPARATE API infrastructure from Mindbody:
 *   - Different base URL: api.booker.com (vs api.mindbodyonline.com)
 *   - Different developer portal: developers.booker.com (vs developers.mindbodyonline.com)
 *   - Different auth: client_id + client_secret + api_subscription_key
 *     (vs Mindbody's 3-legged OAuth + Api-Key)
 *   - Different webhook scheme (verify at sandbox)
 *
 * Because of this, Booker needs its own connector — cannot reuse the
 * Mindbody substrate as the original spec scout hoped. This connector
 * mirrors src/lib/schedulers/{mindbody,square}.ts shape with Booker-
 * specific endpoints + auth flow.
 *
 * Booker auth model (verified at developers.booker.com):
 *   - app-level client_id + client_secret pair
 *   - app-level api_subscription_key (Azure API Management gateway)
 *   - per-spa "access token" obtained by POSTing client_credentials
 *     against /oauth2/token (server-to-server OAuth client_credentials
 *     flow, NOT user-consent 3-legged)
 *
 * What's stubbed pending sandbox-verify (per platforms-pre-built doctrine):
 *   - Exact webhook subscription endpoint path
 *   - Exact webhook signature algorithm + header name
 *   - Exact appointment/customer payload field names
 *   - Whether Booker offers per-spa session tokens or just shared app creds
 *
 * Docs:
 *   https://developers.booker.com/
 *   https://api.booker.com/ (production)
 *   https://api-staging.booker.com/ (sandbox)
 */

// ─── Constants ─────────────────────────────────────────────────────────────

const BOOKER_API_BASE_PROD = "https://api.booker.com";
const BOOKER_API_BASE_SANDBOX = "https://api-staging.booker.com";
export const BOOKER_API_VERSION = "v1";

export type BookerEnv = "production" | "sandbox";

export function resolveBookerEnv(): BookerEnv {
  const raw = (process.env.BOOKER_ENV ?? "").trim().toLowerCase();
  return raw === "sandbox" ? "sandbox" : "production";
}

export function bookerApiBase(env: BookerEnv): string {
  return env === "sandbox" ? BOOKER_API_BASE_SANDBOX : BOOKER_API_BASE_PROD;
}

// ─── Types ─────────────────────────────────────────────────────────────────

export type BookerCredentials = {
  clientId: string;
  clientSecret: string;
  subscriptionKey: string;
  env: BookerEnv;
};

export type BookerTokenResponse = {
  accessToken: string;
  tokenType: string;
  expiresAt: string;
};

export type BookerBusiness = {
  id: string;
  name: string | null;
  email: string | null;
};

export type BookerAppointment = {
  id: string;
  status: BookerAppointmentStatus;
  startDateTime: string;
  endDateTime: string;
  customerId: string | null;
  employeeId: string | null;
  treatmentId: string | null;
  notes: string | null;
};

export type BookerAppointmentStatus =
  | "Booked"
  | "Confirmed"
  | "CheckedIn"
  | "Completed"
  | "Cancelled"
  | "NoShow"
  | "Rescheduled";

export type BookerCustomer = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
};

export type BookerWebhookSubscription = {
  subscriptionId: string;
  webhookUrl: string;
  events: string[];
  signingSecret: string;
};

export type BookerWebhookEvent =
  | "appointment.created"
  | "appointment.updated"
  | "appointment.cancelled"
  | "appointment.noshow"
  | "customer.created";

export const BOOKER_WEBHOOK_EVENTS: BookerWebhookEvent[] = [
  "appointment.created",
  "appointment.updated",
  "appointment.cancelled",
  "appointment.noshow",
  "customer.created",
];

export const BOOKER_WEBHOOK_SIGNATURE_HEADER = "x-booker-signature";

// ─── Auth (server-to-server OAuth client_credentials) ──────────────────────

export async function getBookerAccessToken(args: {
  credentials: BookerCredentials;
}): Promise<BookerTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: args.credentials.clientId,
    client_secret: args.credentials.clientSecret,
  });
  const resp = await fetch(`${bookerApiBase(args.credentials.env)}/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Ocp-Apim-Subscription-Key": args.credentials.subscriptionKey,
    },
    body: body.toString(),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `Booker token request failed (${resp.status}): ${text.slice(0, 500)}`,
    );
  }
  const json = (await resp.json()) as {
    access_token?: string;
    token_type?: string;
    expires_in?: number;
  };
  if (!json.access_token) {
    throw new Error("Booker token response missing access_token.");
  }
  return {
    accessToken: json.access_token,
    tokenType: json.token_type ?? "bearer",
    expiresAt: new Date(
      Date.now() + ((json.expires_in ?? 3600) - 60) * 1000,
    ).toISOString(),
  };
}

// ─── API client ────────────────────────────────────────────────────────────

async function bookerFetch<T>(args: {
  accessToken: string;
  credentials: BookerCredentials;
  path: string;
  init?: RequestInit;
}): Promise<T> {
  const resp = await fetch(
    `${bookerApiBase(args.credentials.env)}/${BOOKER_API_VERSION}${args.path}`,
    {
      ...args.init,
      headers: {
        Authorization: `Bearer ${args.accessToken}`,
        "Ocp-Apim-Subscription-Key": args.credentials.subscriptionKey,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(args.init?.headers ?? {}),
      },
    },
  );
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `Booker API ${args.path} ${resp.status}: ${text.slice(0, 500)}`,
    );
  }
  return (await resp.json()) as T;
}

// ─── Reads ─────────────────────────────────────────────────────────────────

export async function getBookerBusiness(args: {
  accessToken: string;
  credentials: BookerCredentials;
}): Promise<BookerBusiness> {
  type Raw = {
    location?: { id?: string; name?: string; email?: string };
  };
  const raw = await bookerFetch<Raw>({
    accessToken: args.accessToken,
    credentials: args.credentials,
    path: "/location",
  });
  if (!raw.location?.id) {
    throw new Error("Booker location lookup returned no id.");
  }
  return {
    id: raw.location.id,
    name: raw.location.name ?? null,
    email: raw.location.email ?? null,
  };
}

export async function listBookerAppointments(args: {
  accessToken: string;
  credentials: BookerCredentials;
  startDate: string;
  endDate: string;
  pageSize?: number;
  pageNumber?: number;
}): Promise<{ appointments: BookerAppointment[]; nextPage: number | null }> {
  const params = new URLSearchParams({
    StartDate: args.startDate,
    EndDate: args.endDate,
    PageSize: String(args.pageSize ?? 200),
    PageNumber: String(args.pageNumber ?? 1),
  });
  type Raw = {
    Results?: BookerAppointmentRaw[];
    TotalResults?: number;
    PageNumber?: number;
    PageSize?: number;
  };
  const raw = await bookerFetch<Raw>({
    accessToken: args.accessToken,
    credentials: args.credentials,
    path: `/appointments?${params.toString()}`,
  });
  const appointments = (raw.Results ?? []).map(rawToAppointment);
  const total = raw.TotalResults ?? appointments.length;
  const page = args.pageNumber ?? 1;
  const size = raw.PageSize ?? args.pageSize ?? 200;
  const consumed = page * size;
  return {
    appointments,
    nextPage: consumed < total ? page + 1 : null,
  };
}

export async function getBookerAppointment(args: {
  accessToken: string;
  credentials: BookerCredentials;
  appointmentId: string;
}): Promise<BookerAppointment> {
  type Raw = { Appointment?: BookerAppointmentRaw };
  const raw = await bookerFetch<Raw>({
    accessToken: args.accessToken,
    credentials: args.credentials,
    path: `/appointments/${args.appointmentId}`,
  });
  if (!raw.Appointment) {
    throw new Error(`Booker appointment ${args.appointmentId} not found.`);
  }
  return rawToAppointment(raw.Appointment);
}

type BookerAppointmentRaw = {
  Id?: string | number;
  AppointmentId?: string | number;
  Status?: string;
  StartDateTime?: string;
  EndDateTime?: string;
  CustomerId?: string | number;
  EmployeeId?: string | number;
  TreatmentId?: string | number;
  Notes?: string;
};

function rawToAppointment(raw: BookerAppointmentRaw): BookerAppointment {
  const id = raw.Id ?? raw.AppointmentId ?? "";
  return {
    id: String(id),
    status: (raw.Status as BookerAppointmentStatus | undefined) ?? "Booked",
    startDateTime: raw.StartDateTime ?? "",
    endDateTime: raw.EndDateTime ?? raw.StartDateTime ?? "",
    customerId: raw.CustomerId !== undefined ? String(raw.CustomerId) : null,
    employeeId: raw.EmployeeId !== undefined ? String(raw.EmployeeId) : null,
    treatmentId: raw.TreatmentId !== undefined ? String(raw.TreatmentId) : null,
    notes: raw.Notes ?? null,
  };
}

// ─── Writes ────────────────────────────────────────────────────────────────

export async function createBookerAppointment(args: {
  accessToken: string;
  credentials: BookerCredentials;
  startDateTime: string;
  customerId: string;
  employeeId: string;
  treatmentId: string;
  notes?: string;
}): Promise<BookerAppointment> {
  type Raw = { Appointment?: BookerAppointmentRaw };
  const body = {
    StartDateTime: args.startDateTime,
    CustomerId: args.customerId,
    EmployeeId: args.employeeId,
    TreatmentId: args.treatmentId,
    Notes: args.notes,
  };
  const raw = await bookerFetch<Raw>({
    accessToken: args.accessToken,
    credentials: args.credentials,
    path: "/appointments",
    init: { method: "POST", body: JSON.stringify(body) },
  });
  if (!raw.Appointment) {
    throw new Error("Booker createAppointment returned no appointment.");
  }
  return rawToAppointment(raw.Appointment);
}

export async function upsertBookerCustomer(args: {
  accessToken: string;
  credentials: BookerCredentials;
  phone: string | null;
  email: string | null;
  firstName: string;
  lastName: string;
}): Promise<BookerCustomer> {
  const searchKey = args.phone ?? args.email;
  if (searchKey) {
    type SearchRaw = { Results?: BookerCustomerRaw[] };
    const params = new URLSearchParams();
    if (args.phone) params.set("Phone", args.phone);
    if (args.email) params.set("Email", args.email);
    params.set("PageSize", "1");
    const raw = await bookerFetch<SearchRaw>({
      accessToken: args.accessToken,
      credentials: args.credentials,
      path: `/customers?${params.toString()}`,
    });
    const hit = (raw.Results ?? [])[0];
    if (hit) return rawToCustomer(hit);
  }
  type CreateRaw = { Customer?: BookerCustomerRaw };
  const create = await bookerFetch<CreateRaw>({
    accessToken: args.accessToken,
    credentials: args.credentials,
    path: "/customers",
    init: {
      method: "POST",
      body: JSON.stringify({
        FirstName: args.firstName,
        LastName: args.lastName,
        Phone: args.phone || undefined,
        Email: args.email || undefined,
      }),
    },
  });
  if (!create.Customer) {
    throw new Error("Booker createCustomer returned no customer.");
  }
  return rawToCustomer(create.Customer);
}

type BookerCustomerRaw = {
  Id?: string | number;
  FirstName?: string;
  LastName?: string;
  Email?: string;
  Phone?: string;
};

function rawToCustomer(raw: BookerCustomerRaw): BookerCustomer {
  return {
    id: raw.Id !== undefined ? String(raw.Id) : "",
    firstName: raw.FirstName ?? null,
    lastName: raw.LastName ?? null,
    email: raw.Email ?? null,
    phone: raw.Phone ?? null,
  };
}

// ─── Webhook subscription lifecycle ────────────────────────────────────────

export async function createBookerWebhookSubscription(args: {
  accessToken: string;
  credentials: BookerCredentials;
  webhookUrl: string;
  events: readonly string[];
}): Promise<BookerWebhookSubscription> {
  type Raw = {
    Subscription?: {
      Id?: string;
      WebhookUrl?: string;
      Events?: string[];
      SigningSecret?: string;
    };
  };
  const raw = await bookerFetch<Raw>({
    accessToken: args.accessToken,
    credentials: args.credentials,
    path: "/webhooks/subscriptions",
    init: {
      method: "POST",
      body: JSON.stringify({
        WebhookUrl: args.webhookUrl,
        Events: args.events,
      }),
    },
  });
  if (!raw.Subscription?.Id) {
    throw new Error("Booker webhook subscription returned no id.");
  }
  return {
    subscriptionId: raw.Subscription.Id,
    webhookUrl: raw.Subscription.WebhookUrl ?? args.webhookUrl,
    events: raw.Subscription.Events ?? [...args.events],
    signingSecret: raw.Subscription.SigningSecret ?? "",
  };
}

export async function deleteBookerWebhookSubscription(args: {
  accessToken: string;
  credentials: BookerCredentials;
  subscriptionId: string;
}): Promise<void> {
  await bookerFetch<unknown>({
    accessToken: args.accessToken,
    credentials: args.credentials,
    path: `/webhooks/subscriptions/${args.subscriptionId}`,
    init: { method: "DELETE" },
  });
}

// ─── Webhook signature verification ────────────────────────────────────────

export async function verifyBookerWebhookSignature(args: {
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
  const bytes = new Uint8Array(sigBuf);
  let computed = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    computed += String.fromCharCode(bytes[i]);
  }
  const b64 =
    typeof btoa === "function"
      ? btoa(computed)
      : Buffer.from(computed, "binary").toString("base64");
  if (b64.length !== args.signatureHeader.length) return false;
  let mismatch = 0;
  for (let i = 0; i < b64.length; i++) {
    mismatch |= b64.charCodeAt(i) ^ args.signatureHeader.charCodeAt(i);
  }
  return mismatch === 0;
}

// ─── Webhook payload parsing ───────────────────────────────────────────────

export type BookerWebhookPayload = {
  eventId: string;
  type: BookerWebhookEvent;
  locationId: string;
  occurredAt: string;
  appointment: BookerAppointment | null;
  customer: BookerCustomer | null;
};

export function parseBookerWebhookBody(
  rawBody: string,
): BookerWebhookPayload | null {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const j = json as Record<string, unknown>;
  const type = (j.event ?? j.Event ?? j.eventType) as string | undefined;
  if (!type) return null;
  if (!BOOKER_WEBHOOK_EVENTS.includes(type as BookerWebhookEvent)) return null;

  const locationId = String(j.locationId ?? j.LocationId ?? "");
  const eventId = String(j.eventId ?? j.EventId ?? j.id ?? "");
  const occurredAt = String(j.occurredAt ?? j.OccurredAt ?? j.timestamp ?? "");
  if (!locationId || !eventId || !occurredAt) return null;

  const data = (j.data ?? j.Data ?? {}) as Record<string, unknown>;
  const appointment = type.startsWith("appointment.")
    ? rawToAppointment(data as BookerAppointmentRaw)
    : null;
  const customer = type.startsWith("customer.")
    ? rawToCustomer(data as BookerCustomerRaw)
    : null;

  return {
    eventId,
    type: type as BookerWebhookEvent,
    locationId,
    occurredAt,
    appointment: appointment && appointment.id ? appointment : null,
    customer: customer && customer.id ? customer : null,
  };
}

export function bookerStatusToRefillStatus(
  status: BookerAppointmentStatus,
): "scheduled" | "cancelled" | "no_show" | "showed" {
  switch (status) {
    case "Cancelled":
      return "cancelled";
    case "NoShow":
      return "no_show";
    case "CheckedIn":
    case "Completed":
      return "showed";
    case "Booked":
    case "Confirmed":
    case "Rescheduled":
    default:
      return "scheduled";
  }
}
