/**
 * Zenoti API connector (v1.41.0).
 *
 * Zenoti = enterprise wellness/spa SaaS, serves large multi-location chains.
 * Significant divergences from prior schedulers:
 *
 *   - **API key OR JWT auth — NO user-consent OAuth.** Zenoti is app-to-app
 *     (server-to-server). Two valid auth methods:
 *       1. API Key: `Authorization: apikey {key}` (non-expiring)
 *       2. JWT: `Authorization: bearer {access_token}` (24h TTL,
 *          minted via POST /v1/tokens with grant_type=password +
 *          account_name + user_name + password)
 *     For Refill we default to API key (simpler, no refresh dance).
 *   - **Multi-center via path param.** All endpoints scope by center_id
 *     in the URL path: `/v1/centers/{center_id}/appointments`. Spa chains
 *     can have multiple centers under one org; each connection row
 *     represents ONE center.
 *   - **API Groups (NOT OAuth scopes).** Backend app permissions are
 *     checkbox-selected per API group (Guest, Appointment, Invoice, etc.)
 *     in Zenoti admin UI. Two-tier validation: user role + API group.
 *   - **Webhook URL = single global** (like Square/Boulevard). Payloads
 *     carry center_id; filtering app-side.
 *   - **Webhook signature: HMAC (algorithm PENDING SANDBOX-VERIFY)**.
 *     Best guess HMAC-SHA256 in X-Zenoti-Signature header per industry
 *     convention; verify at sandbox.
 *   - **Offset-based pagination** (page + size, NOT cursor).
 *   - **CSM-gated.** API package subscription required; not default.
 *     Approval timeline likely sales-led, 1-2 weeks.
 *   - **API Key 1yr expiry.** Renewal recommended ~1wk before.
 *
 * Docs:
 *   https://docs.zenoti.com/docs
 */

// ─── Constants ─────────────────────────────────────────────────────────────

const ZENOTI_API_BASE = "https://api.zenoti.com";
export const ZENOTI_API_VERSION = "v1";

export type ZenotiEnv = "production" | "sandbox";

export function resolveZenotiEnv(): ZenotiEnv {
  const raw = (process.env.ZENOTI_ENV ?? "").trim().toLowerCase();
  return raw === "sandbox" ? "sandbox" : "production";
}

export function zenotiApiBase(_env: ZenotiEnv): string {
  // Zenoti uses the same hostname for sandbox + production; sandbox
  // routing happens via the API key + center_id provisioned by CSM.
  return ZENOTI_API_BASE;
}

// ─── Types ─────────────────────────────────────────────────────────────────

export type ZenotiCredentials = {
  apiKey: string;
  centerId: string;
  env: ZenotiEnv;
};

export type ZenotiCenter = {
  id: string;
  name: string | null;
  code: string | null;
  email: string | null;
};

export type ZenotiAppointment = {
  id: string;
  status: ZenotiAppointmentStatus;
  startTime: string;
  endTime: string;
  guestId: string | null;
  therapistId: string | null;
  serviceId: string | null;
  notes: string | null;
};

export type ZenotiAppointmentStatus =
  | "Booked"
  | "Checked-In"
  | "Started"
  | "Closed"
  | "Cancelled"
  | "NoShow"
  | "Rescheduled";

export type ZenotiGuest = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
};

export type ZenotiWebhookSubscription = {
  subscriptionId: string;
  webhookUrl: string;
  events: string[];
  secret: string;
};

export type ZenotiWebhookEvent =
  | "appointment.created"
  | "appointment.updated"
  | "appointment.cancelled"
  | "appointment.no_show"
  | "guest.created";

export const ZENOTI_WEBHOOK_EVENTS: ZenotiWebhookEvent[] = [
  "appointment.created",
  "appointment.updated",
  "appointment.cancelled",
  "appointment.no_show",
  "guest.created",
];

export const ZENOTI_WEBHOOK_SIGNATURE_HEADER = "x-zenoti-signature";

// ─── API client ────────────────────────────────────────────────────────────

async function zenotiFetch<T>(args: {
  credentials: ZenotiCredentials;
  path: string;
  init?: RequestInit;
}): Promise<T> {
  const resp = await fetch(
    `${zenotiApiBase(args.credentials.env)}/${ZENOTI_API_VERSION}${args.path}`,
    {
      ...args.init,
      headers: {
        Authorization: `apikey ${args.credentials.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(args.init?.headers ?? {}),
      },
    },
  );
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `Zenoti API ${args.path} ${resp.status}: ${text.slice(0, 500)}`,
    );
  }
  return (await resp.json()) as T;
}

// ─── Reads ─────────────────────────────────────────────────────────────────

export async function getZenotiCenter(args: {
  credentials: ZenotiCredentials;
}): Promise<ZenotiCenter> {
  type Raw = {
    center?: { id?: string; name?: string; code?: string; email?: string };
  };
  const raw = await zenotiFetch<Raw>({
    credentials: args.credentials,
    path: `/centers/${args.credentials.centerId}`,
  });
  if (!raw.center?.id) throw new Error("Zenoti center lookup returned no id.");
  return {
    id: raw.center.id,
    name: raw.center.name ?? null,
    code: raw.center.code ?? null,
    email: raw.center.email ?? null,
  };
}

export async function listZenotiAppointments(args: {
  credentials: ZenotiCredentials;
  startDate: string;
  endDate: string;
  page?: number;
  size?: number;
}): Promise<{ appointments: ZenotiAppointment[]; nextPage: number | null }> {
  const params = new URLSearchParams({
    start_date: args.startDate,
    end_date: args.endDate,
    page: String(args.page ?? 1),
    size: String(args.size ?? 100),
  });
  type Raw = {
    appointments?: ZenotiAppointmentRaw[];
    total?: number;
    page?: number;
    size?: number;
  };
  const raw = await zenotiFetch<Raw>({
    credentials: args.credentials,
    path: `/centers/${args.credentials.centerId}/appointments?${params.toString()}`,
  });
  const appointments = (raw.appointments ?? []).map(rawToAppointment);
  const total = raw.total ?? appointments.length;
  const page = args.page ?? 1;
  const size = raw.size ?? args.size ?? 100;
  return {
    appointments,
    nextPage: page * size < total ? page + 1 : null,
  };
}

export async function getZenotiAppointment(args: {
  credentials: ZenotiCredentials;
  appointmentId: string;
}): Promise<ZenotiAppointment> {
  type Raw = { appointment?: ZenotiAppointmentRaw };
  const raw = await zenotiFetch<Raw>({
    credentials: args.credentials,
    path: `/appointments/${args.appointmentId}`,
  });
  if (!raw.appointment) {
    throw new Error(`Zenoti appointment ${args.appointmentId} not found.`);
  }
  return rawToAppointment(raw.appointment);
}

type ZenotiAppointmentRaw = {
  id?: string;
  status?: string;
  start_time?: string;
  end_time?: string;
  guest_id?: string;
  therapist_id?: string;
  service_id?: string;
  notes?: string;
};

function rawToAppointment(raw: ZenotiAppointmentRaw): ZenotiAppointment {
  return {
    id: raw.id ?? "",
    status: (raw.status as ZenotiAppointmentStatus | undefined) ?? "Booked",
    startTime: raw.start_time ?? "",
    endTime: raw.end_time ?? raw.start_time ?? "",
    guestId: raw.guest_id ?? null,
    therapistId: raw.therapist_id ?? null,
    serviceId: raw.service_id ?? null,
    notes: raw.notes ?? null,
  };
}

// ─── Writes ────────────────────────────────────────────────────────────────

export async function createZenotiAppointment(args: {
  credentials: ZenotiCredentials;
  startTime: string;
  guestId: string;
  therapistId: string;
  serviceId: string;
  notes?: string;
}): Promise<ZenotiAppointment> {
  type Raw = { appointment?: ZenotiAppointmentRaw };
  const body = {
    start_time: args.startTime,
    guest_id: args.guestId,
    therapist_id: args.therapistId,
    service_id: args.serviceId,
    notes: args.notes,
  };
  const raw = await zenotiFetch<Raw>({
    credentials: args.credentials,
    path: `/centers/${args.credentials.centerId}/appointments`,
    init: { method: "POST", body: JSON.stringify(body) },
  });
  if (!raw.appointment) {
    throw new Error("Zenoti createAppointment returned no appointment.");
  }
  return rawToAppointment(raw.appointment);
}

export async function upsertZenotiGuest(args: {
  credentials: ZenotiCredentials;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
}): Promise<ZenotiGuest> {
  const searchKey = args.phone ?? args.email;
  if (searchKey) {
    type SearchRaw = { guests?: ZenotiGuestRaw[] };
    const params = new URLSearchParams({ size: "1" });
    if (args.phone) params.set("phone", args.phone);
    if (args.email) params.set("email", args.email);
    const raw = await zenotiFetch<SearchRaw>({
      credentials: args.credentials,
      path: `/centers/${args.credentials.centerId}/guests?${params.toString()}`,
    });
    const hit = (raw.guests ?? [])[0];
    if (hit) return rawToGuest(hit);
  }
  type CreateRaw = { guest?: ZenotiGuestRaw };
  const create = await zenotiFetch<CreateRaw>({
    credentials: args.credentials,
    path: `/centers/${args.credentials.centerId}/guests`,
    init: {
      method: "POST",
      body: JSON.stringify({
        first_name: args.firstName,
        last_name: args.lastName,
        email: args.email || undefined,
        phone: args.phone || undefined,
      }),
    },
  });
  if (!create.guest) {
    throw new Error("Zenoti createGuest returned no guest.");
  }
  return rawToGuest(create.guest);
}

type ZenotiGuestRaw = {
  id?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
};

function rawToGuest(raw: ZenotiGuestRaw): ZenotiGuest {
  return {
    id: raw.id ?? "",
    firstName: raw.first_name ?? null,
    lastName: raw.last_name ?? null,
    email: raw.email ?? null,
    phone: raw.phone ?? null,
  };
}

// ─── Webhook subscription lifecycle ────────────────────────────────────────

export async function createZenotiWebhookSubscription(args: {
  credentials: ZenotiCredentials;
  webhookUrl: string;
  events: readonly string[];
}): Promise<ZenotiWebhookSubscription> {
  type Raw = {
    subscription?: {
      id?: string;
      webhook_url?: string;
      events?: string[];
      secret?: string;
    };
  };
  const raw = await zenotiFetch<Raw>({
    credentials: args.credentials,
    path: "/webhooks/subscriptions",
    init: {
      method: "POST",
      body: JSON.stringify({
        webhook_url: args.webhookUrl,
        events: args.events,
        center_ids: [args.credentials.centerId],
      }),
    },
  });
  if (!raw.subscription?.id) {
    throw new Error("Zenoti webhook subscription returned no id.");
  }
  return {
    subscriptionId: raw.subscription.id,
    webhookUrl: raw.subscription.webhook_url ?? args.webhookUrl,
    events: raw.subscription.events ?? [...args.events],
    secret: raw.subscription.secret ?? "",
  };
}

export async function deleteZenotiWebhookSubscription(args: {
  credentials: ZenotiCredentials;
  subscriptionId: string;
}): Promise<void> {
  await zenotiFetch<unknown>({
    credentials: args.credentials,
    path: `/webhooks/subscriptions/${args.subscriptionId}`,
    init: { method: "DELETE" },
  });
}

// ─── Webhook signature verification ────────────────────────────────────────

/**
 * Verify Zenoti webhook signature. Best-guess HMAC-SHA256 (PENDING
 * SANDBOX-VERIFY).
 */
export async function verifyZenotiWebhookSignature(args: {
  rawBody: string;
  signatureHeader: string | null;
  secret: string;
}): Promise<boolean> {
  if (!args.signatureHeader) return false;
  const encoder = new TextEncoder();
  const keyData = encoder.encode(args.secret);
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
  let str = "";
  for (let i = 0; i < bytes.byteLength; i++) str += String.fromCharCode(bytes[i]);
  const b64 = typeof btoa === "function" ? btoa(str) : Buffer.from(str, "binary").toString("base64");
  if (b64.length !== args.signatureHeader.length) return false;
  let mismatch = 0;
  for (let i = 0; i < b64.length; i++) {
    mismatch |= b64.charCodeAt(i) ^ args.signatureHeader.charCodeAt(i);
  }
  return mismatch === 0;
}

// ─── Webhook payload parsing ───────────────────────────────────────────────

export type ZenotiWebhookPayload = {
  eventId: string;
  type: ZenotiWebhookEvent;
  centerId: string;
  occurredAt: string;
  appointment: ZenotiAppointment | null;
  guest: ZenotiGuest | null;
};

export function parseZenotiWebhookBody(rawBody: string): ZenotiWebhookPayload | null {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const j = json as Record<string, unknown>;
  const type = j.event as string | undefined;
  if (!type) return null;
  if (!ZENOTI_WEBHOOK_EVENTS.includes(type as ZenotiWebhookEvent)) return null;

  const centerId = String(j.center_id ?? j.centerId ?? "");
  const eventId = String(j.event_id ?? j.eventId ?? j.id ?? "");
  const occurredAt = String(j.occurred_at ?? j.occurredAt ?? "");
  if (!centerId || !eventId || !occurredAt) return null;

  const data = (j.data ?? {}) as Record<string, unknown>;
  const appointment = type.startsWith("appointment.")
    ? rawToAppointment(data as ZenotiAppointmentRaw)
    : null;
  const guest = type === "guest.created" ? rawToGuest(data as ZenotiGuestRaw) : null;

  return {
    eventId,
    type: type as ZenotiWebhookEvent,
    centerId,
    occurredAt,
    appointment: appointment && appointment.id ? appointment : null,
    guest: guest && guest.id ? guest : null,
  };
}

export function zenotiStatusToRefillStatus(
  status: ZenotiAppointmentStatus,
): "scheduled" | "cancelled" | "no_show" | "showed" {
  switch (status) {
    case "Cancelled":
      return "cancelled";
    case "NoShow":
      return "no_show";
    case "Checked-In":
    case "Started":
    case "Closed":
      return "showed";
    case "Booked":
    case "Rescheduled":
    default:
      return "scheduled";
  }
}
