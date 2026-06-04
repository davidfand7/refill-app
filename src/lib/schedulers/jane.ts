/**
 * Jane (jane.app) API connector (v1.40.0).
 *
 * Significant divergences from prior schedulers:
 *
 *   - **OAuth 2.0 + PKCE MANDATORY.** code_challenge + code_verifier
 *     S256 method. Not Acuity/MB/Square's plain code-exchange.
 *   - **5-minute access token TTL.** Aggressive refresh required. Tokens
 *     issued at /protocol/openid-connect/token on a Jane IAM hostname
 *     provisioned per-partner (the hostname itself is provided to
 *     approved partners — not publicly documented).
 *   - **Per-clinic base URLs.** Each Jane clinic has its own subdomain
 *     (e.g., spaname.janeapp.com). API base = `${clinicUrl}/api/${version}/`.
 *     Tokens are clinic-scoped; cannot reuse across clinics.
 *   - **NO WEBHOOKS** (as of scout 2026-06-03). REST polling-only
 *     architecture. We register a cron route per spa that polls
 *     /appointments + /patients at intervals.
 *   - **Approval-gated.** Cannot self-register an app. Must apply via
 *     Jane's partner intake; on approval Jane assigns a contact who
 *     provisions IAM credentials.
 *   - **Date-versioned API.** `/api/2025-02-28-beta/...` style. Versions
 *     pinned constant; bump deliberately.
 *   - **Terminology: "Patient" not "Client".** API uses /patients.
 *
 * Docs:
 *   https://developers.jane.app/docs/getting-started
 *   https://developers.jane.app/reference
 */

// ─── Constants ─────────────────────────────────────────────────────────────

/**
 * Pinned to a known stable date version. Bump deliberately during
 * quarterly maintenance.
 */
export const JANE_API_VERSION = "2025-02-28-beta";

export type JaneEnv = "production" | "sandbox";

export function resolveJaneEnv(): JaneEnv {
  const raw = (process.env.JANE_ENV ?? "").trim().toLowerCase();
  return raw === "sandbox" ? "sandbox" : "production";
}

/**
 * Realm slug for the Jane IAM service. Sandbox = `jane_partner_sandbox`,
 * production = `jane`. Used in the authorize + token URL paths.
 */
export function janeRealm(env: JaneEnv): string {
  return env === "sandbox" ? "jane_partner_sandbox" : "jane";
}

// ─── Types ─────────────────────────────────────────────────────────────────

export type JaneOAuthCredentials = {
  clientId: string;
  clientSecret: string;
  iamBaseUrl: string; // e.g., https://iam.jane.app (provisioned per-partner)
  redirectUri: string;
  env: JaneEnv;
};

export type JaneTokenResponse = {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresAt: string; // 5-min TTL — aggressive refresh required
  clinicUrl: string; // Per-clinic API base
  clinicId: string; // From id_token claims
  scope: string[];
};

export type JaneAppointment = {
  id: string;
  status: JaneAppointmentStatus;
  startAt: string;
  endAt: string;
  patientId: string | null;
  staffMemberId: string | null;
  treatmentId: string | null;
  locationId: string | null;
  notes: string | null;
};

export type JaneAppointmentStatus =
  | "booked"
  | "arrived"
  | "completed"
  | "cancelled"
  | "no_show";

export type JanePatient = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
};

export type JanePkcePair = {
  codeVerifier: string;
  codeChallenge: string;
};

/**
 * Scope set — date-versioned Jane API uses resource:read / resource:create
 * convention. Verified scopes from public docs.
 */
export const JANE_OAUTH_SCOPES = [
  "appointments:read",
  "appointments:create",
  "patients:read",
  "patients:create",
  "staff-members:read",
  "treatments:read",
  "locations:read",
  "company:read",
] as const;

// ─── PKCE helpers ──────────────────────────────────────────────────────────

/**
 * Generate a PKCE code_verifier + code_challenge pair. Per RFC 7636:
 * verifier = 43-128 char URL-safe random; challenge = base64url(SHA-256(verifier)).
 */
export async function generateJanePkcePair(): Promise<JanePkcePair> {
  // 32 bytes = ~43 char URL-safe base64
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const codeVerifier = base64UrlEncodeBytes(bytes);

  const challengeBuf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(codeVerifier),
  );
  const codeChallenge = base64UrlEncodeBytes(new Uint8Array(challengeBuf));

  return { codeVerifier, codeChallenge };
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let str = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    str += String.fromCharCode(bytes[i]);
  }
  const b64 =
    typeof btoa === "function"
      ? btoa(str)
      : Buffer.from(str, "binary").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ─── OAuth ─────────────────────────────────────────────────────────────────

export function buildJaneAuthorizeUrl(args: {
  credentials: JaneOAuthCredentials;
  state: string;
  codeChallenge: string;
  scopes?: readonly string[];
}): string {
  const realm = janeRealm(args.credentials.env);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: args.credentials.clientId,
    redirect_uri: args.credentials.redirectUri,
    scope: (args.scopes ?? JANE_OAUTH_SCOPES).join(" "),
    state: args.state,
    code_challenge: args.codeChallenge,
    code_challenge_method: "S256",
  });
  return `${args.credentials.iamBaseUrl}/realms/${realm}/protocol/openid-connect/auth?${params.toString()}`;
}

export async function exchangeJaneCodeForToken(args: {
  code: string;
  codeVerifier: string;
  credentials: JaneOAuthCredentials;
}): Promise<JaneTokenResponse> {
  const realm = janeRealm(args.credentials.env);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: args.credentials.clientId,
    client_secret: args.credentials.clientSecret,
    code: args.code,
    code_verifier: args.codeVerifier,
    redirect_uri: args.credentials.redirectUri,
  });
  const resp = await fetch(
    `${args.credentials.iamBaseUrl}/realms/${realm}/protocol/openid-connect/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
  );
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `Jane token exchange failed (${resp.status}): ${text.slice(0, 500)}`,
    );
  }
  return parseTokenResponse(await resp.json());
}

export async function refreshJaneAccessToken(args: {
  refreshToken: string;
  credentials: JaneOAuthCredentials;
}): Promise<JaneTokenResponse> {
  const realm = janeRealm(args.credentials.env);
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: args.credentials.clientId,
    client_secret: args.credentials.clientSecret,
    refresh_token: args.refreshToken,
  });
  const resp = await fetch(
    `${args.credentials.iamBaseUrl}/realms/${realm}/protocol/openid-connect/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
  );
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `Jane token refresh failed (${resp.status}): ${text.slice(0, 500)}`,
    );
  }
  return parseTokenResponse(await resp.json());
}

function parseTokenResponse(raw: unknown): JaneTokenResponse {
  const j = raw as {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    token_type?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!j.access_token) {
    throw new Error("Jane token response missing access_token.");
  }
  const claims = j.id_token ? decodeJwtClaims(j.id_token) : {};
  const clinicUrl =
    (claims.clinic_url as string | undefined) ??
    (claims.clinicUrl as string | undefined) ??
    "";
  const clinicId =
    (claims.clinic_id as string | undefined) ??
    (claims.clinicId as string | undefined) ??
    (claims.sub as string | undefined) ??
    "";
  const expiresAt = new Date(
    Date.now() + ((j.expires_in ?? 300) - 30) * 1000,
  ).toISOString();
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token ?? "",
    tokenType: j.token_type ?? "bearer",
    expiresAt,
    clinicUrl,
    clinicId,
    scope: (j.scope ?? "").split(/\s+/).filter(Boolean),
  };
}

function decodeJwtClaims(jwt: string): Record<string, unknown> {
  try {
    const parts = jwt.split(".");
    if (parts.length < 2) return {};
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

async function janeFetch<T>(args: {
  accessToken: string;
  clinicUrl: string;
  path: string;
  init?: RequestInit;
}): Promise<T> {
  const resp = await fetch(
    `${args.clinicUrl}/api/${JANE_API_VERSION}${args.path}`,
    {
      ...args.init,
      headers: {
        Authorization: `Bearer ${args.accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(args.init?.headers ?? {}),
      },
    },
  );
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `Jane API ${args.path} ${resp.status}: ${text.slice(0, 500)}`,
    );
  }
  return (await resp.json()) as T;
}

// ─── Reads ─────────────────────────────────────────────────────────────────

export async function getJaneCompany(args: {
  accessToken: string;
  clinicUrl: string;
}): Promise<{ id: string; name: string | null }> {
  type Raw = { company?: { id?: string; name?: string } };
  const raw = await janeFetch<Raw>({
    accessToken: args.accessToken,
    clinicUrl: args.clinicUrl,
    path: "/company",
  });
  if (!raw.company?.id) throw new Error("Jane company lookup returned no id.");
  return { id: raw.company.id, name: raw.company.name ?? null };
}

export async function listJaneAppointments(args: {
  accessToken: string;
  clinicUrl: string;
  startDate: string;
  endDate: string;
  pageSize?: number;
  cursor?: string;
}): Promise<{ appointments: JaneAppointment[]; nextCursor: string | null }> {
  const params = new URLSearchParams({
    start_date: args.startDate,
    end_date: args.endDate,
    page_size: String(args.pageSize ?? 200),
  });
  if (args.cursor) params.set("cursor", args.cursor);
  type Raw = {
    appointments?: JaneAppointmentRaw[];
    next_cursor?: string;
  };
  const raw = await janeFetch<Raw>({
    accessToken: args.accessToken,
    clinicUrl: args.clinicUrl,
    path: `/appointments?${params.toString()}`,
  });
  return {
    appointments: (raw.appointments ?? []).map(rawToAppointment),
    nextCursor: raw.next_cursor ?? null,
  };
}

export async function getJaneAppointment(args: {
  accessToken: string;
  clinicUrl: string;
  appointmentId: string;
}): Promise<JaneAppointment> {
  type Raw = { appointment?: JaneAppointmentRaw };
  const raw = await janeFetch<Raw>({
    accessToken: args.accessToken,
    clinicUrl: args.clinicUrl,
    path: `/appointments/${args.appointmentId}`,
  });
  if (!raw.appointment) {
    throw new Error(`Jane appointment ${args.appointmentId} not found.`);
  }
  return rawToAppointment(raw.appointment);
}

type JaneAppointmentRaw = {
  id?: string;
  status?: string;
  start_at?: string;
  end_at?: string;
  patient_id?: string;
  staff_member_id?: string;
  treatment_id?: string;
  location_id?: string;
  notes?: string;
};

function rawToAppointment(raw: JaneAppointmentRaw): JaneAppointment {
  return {
    id: raw.id ?? "",
    status: (raw.status as JaneAppointmentStatus | undefined) ?? "booked",
    startAt: raw.start_at ?? "",
    endAt: raw.end_at ?? raw.start_at ?? "",
    patientId: raw.patient_id ?? null,
    staffMemberId: raw.staff_member_id ?? null,
    treatmentId: raw.treatment_id ?? null,
    locationId: raw.location_id ?? null,
    notes: raw.notes ?? null,
  };
}

// ─── Writes ────────────────────────────────────────────────────────────────

export async function createJaneAppointment(args: {
  accessToken: string;
  clinicUrl: string;
  startAt: string;
  patientId: string;
  staffMemberId: string;
  treatmentId: string;
  locationId?: string;
  notes?: string;
}): Promise<JaneAppointment> {
  type Raw = { appointment?: JaneAppointmentRaw };
  const body = {
    appointment: {
      start_at: args.startAt,
      patient_id: args.patientId,
      staff_member_id: args.staffMemberId,
      treatment_id: args.treatmentId,
      location_id: args.locationId,
      notes: args.notes,
    },
  };
  const raw = await janeFetch<Raw>({
    accessToken: args.accessToken,
    clinicUrl: args.clinicUrl,
    path: "/appointments",
    init: { method: "POST", body: JSON.stringify(body) },
  });
  if (!raw.appointment) {
    throw new Error("Jane createAppointment returned no appointment.");
  }
  return rawToAppointment(raw.appointment);
}

export async function upsertJanePatient(args: {
  accessToken: string;
  clinicUrl: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
}): Promise<JanePatient> {
  const searchKey = args.phone ?? args.email;
  if (searchKey) {
    type SearchRaw = { patients?: JanePatientRaw[] };
    const params = new URLSearchParams({ page_size: "1" });
    if (args.phone) params.set("phone", args.phone);
    if (args.email) params.set("email", args.email);
    const raw = await janeFetch<SearchRaw>({
      accessToken: args.accessToken,
      clinicUrl: args.clinicUrl,
      path: `/patients?${params.toString()}`,
    });
    const hit = (raw.patients ?? [])[0];
    if (hit) return rawToPatient(hit);
  }
  type CreateRaw = { patient?: JanePatientRaw };
  const create = await janeFetch<CreateRaw>({
    accessToken: args.accessToken,
    clinicUrl: args.clinicUrl,
    path: "/patients",
    init: {
      method: "POST",
      body: JSON.stringify({
        patient: {
          first_name: args.firstName,
          last_name: args.lastName,
          email: args.email || undefined,
          phone: args.phone || undefined,
        },
      }),
    },
  });
  if (!create.patient) {
    throw new Error("Jane createPatient returned no patient.");
  }
  return rawToPatient(create.patient);
}

type JanePatientRaw = {
  id?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
};

function rawToPatient(raw: JanePatientRaw): JanePatient {
  return {
    id: raw.id ?? "",
    firstName: raw.first_name ?? null,
    lastName: raw.last_name ?? null,
    email: raw.email ?? null,
    phone: raw.phone ?? null,
  };
}

// ─── Status mapper ─────────────────────────────────────────────────────────

export function janeStatusToRefillStatus(
  status: JaneAppointmentStatus,
): "scheduled" | "cancelled" | "no_show" | "showed" {
  switch (status) {
    case "cancelled":
      return "cancelled";
    case "no_show":
      return "no_show";
    case "arrived":
    case "completed":
      return "showed";
    case "booked":
    default:
      return "scheduled";
  }
}
