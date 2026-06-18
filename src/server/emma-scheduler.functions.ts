/**
 * Emma(OS) scheduler-platform integration (v381).
 *
 * Handles the spa-facing OAuth wizard for connecting third-party
 * scheduling platforms (Acuity first; Mindbody / JaneApp / Square /
 * Boulevard slot in as future ships using the same pattern). The
 * wizard principle (see [[feedback-setup-wizards-auto-advance]]):
 * one button → OAuth redirect → done. No user-facing API key.
 *
 * Surfaces:
 *   initiateAcuityOAuth      — UI server fn that returns the OAuth
 *                              redirect URL. Generates a state token
 *                              + ensures a pending connection row.
 *   getSchedulerConnection   — read connection status for settings UI
 *   disconnectScheduler      — revoke connection: tears down webhooks
 *                              on the platform side + soft-deletes row
 *
 * The actual code exchange + webhook registration + backfill happen
 * in the OAuth callback route handler (src/routes/api.integrations.
 * acuity.oauth-callback.ts) where we have access to the request URL.
 */

import { createServerFn } from "@tanstack/react-start";
import { admin } from "./admin-client";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { getTenantIdForUser, verifyAuth } from "@/server/auth-helpers";
import {
  buildAcuityAuthorizeUrl,
  listAllAcuityAppointmentsInWindow,
  listAcuityClients,
  tearDownAcuityWebhooksForTarget,
  type AcuityAppointment,
  type AcuityClient,
} from "@/lib/schedulers/acuity";
import {
  buildSquareAuthorizeUrl,
  deleteSquareWebhookSubscription,
  listSquareBookings,
  refreshSquareAccessToken,
  resolveSquareEnv,
  squareStatusToRefillStatus,
  type SquareBooking,
  type SquareEnv,
} from "@/lib/schedulers/square";
import {
  buildBoulevardInstallUrl,
  resolveBoulevardEnv,
  type BoulevardEnv,
} from "@/lib/schedulers/boulevard";
import {
  buildMindbodyAuthorizeUrl,
  deleteMindbodyWebhookSubscription,
  listMindbodyAppointments,
  listMindbodyStaff,
  mindbodyStatusToRefillStatus,
  refreshMindbodyAccessToken,
  resolveMindbodyEnv,
  type MindbodyAppointment,
  type MindbodyEnv,
} from "@/lib/schedulers/mindbody";
import {
  buildVagaroInstallUrl,
  deleteVagaroWebhookSubscription,
  listVagaroAppointments,
  vagaroStatusToRefillStatus,
  type VagaroAppointment,
} from "@/lib/schedulers/vagaro";
import {
  bookerStatusToRefillStatus,
  deleteBookerWebhookSubscription,
  getBookerAccessToken,
  listBookerAppointments,
  resolveBookerEnv,
  type BookerAppointment,
  type BookerCredentials,
  type BookerEnv,
} from "@/lib/schedulers/booker";
import {
  buildJaneAuthorizeUrl,
  generateJanePkcePair,
  janeStatusToRefillStatus,
  listJaneAppointments,
  refreshJaneAccessToken,
  resolveJaneEnv,
  type JaneAppointment,
  type JaneEnv,
  type JaneOAuthCredentials,
} from "@/lib/schedulers/jane";
import {
  deleteZenotiWebhookSubscription,
  listZenotiAppointments,
  resolveZenotiEnv,
  zenotiStatusToRefillStatus,
  type ZenotiAppointment,
  type ZenotiCredentials,
  type ZenotiEnv,
} from "@/lib/schedulers/zenoti";
import {
  buildPatientIndex,
  matchPatientFromIndex,
} from "@/server/emma-appointments.functions";
import {
  doIngestClientList,
  type ClientListReceipt,
} from "@/server/patient-ingest.functions";

// ─── Types ─────────────────────────────────────────────────────────────────

export type SchedulerPlatform = "acuity" | "mindbody" | "jane" | "square" | "boulevard" | "vagaro" | "booker" | "zenoti";

export type SchedulerStatus = "connected" | "pending" | "reauth_needed" | "error" | "disconnected";

export type SchedulerConnection = {
  id: string;
  platform: SchedulerPlatform;
  platformAccountId: string | null;
  platformAccountEmail: string | null;
  status: SchedulerStatus;
  lastSyncAt: string | null;
  lastError: string | null;
  connectedAt: string | null;
  disconnectedAt: string | null;
};

// ─── Admin client ──────────────────────────────────────────────────────────

type SupabaseAdmin = ReturnType<typeof admin>;

// State payload signed into the OAuth `state` parameter so the callback
// can identify which user kicked off the flow + where to send them back.
type OAuthState = {
  userId: string;
  platform: SchedulerPlatform;
  returnTo: string;
  nonce: string;
};

export function encodeOAuthState(state: OAuthState): string {
  return Buffer.from(JSON.stringify(state), "utf-8").toString("base64url");
}

export function decodeOAuthState(raw: string): OAuthState | null {
  try {
    const json = Buffer.from(raw, "base64url").toString("utf-8");
    const obj = JSON.parse(json);
    if (!obj.userId || !obj.platform) return null;
    return obj as OAuthState;
  } catch {
    return null;
  }
}

// ─── initiateAcuityOAuth ───────────────────────────────────────────────────

const initiateInput = z.object({
  accessToken: z.string().min(1),
  origin: z.string().min(1),
  returnTo: z.string().default("/app/refill/calendar/connections"),
});

// v415.2: returnTo allowlist. The OAuth state round-trip writes this
// into a signed state blob and the callback reads it back as the
// post-OAuth navigation target. Without an allowlist, a malicious
// caller could pass `returnTo: "https://evil.com"` and trick the
// callback into redirecting users off-domain. Allowlist by path
// prefix — internal paths only.
const RETURN_TO_ALLOWLIST_PREFIXES = [
  "/app/refill/calendar/connections", // canonical since v2.1.0 Calendar Solution reorg
  "/app/refill/settings/scheduler", // legacy stub path — kept for in-flight OAuth state
  "/onboard",
] as const;

function isAllowedReturnTo(returnTo: string): boolean {
  if (!returnTo.startsWith("/")) return false; // reject protocol-relative + absolute
  if (returnTo.startsWith("//")) return false; // explicit reject of //evil.com
  return RETURN_TO_ALLOWLIST_PREFIXES.some(
    (prefix) =>
      returnTo === prefix ||
      returnTo.startsWith(prefix + "?") ||
      returnTo.startsWith(prefix + "/") ||
      returnTo.startsWith(prefix + "#"),
  );
}

export const initiateAcuityOAuth = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => initiateInput.parse(raw))
  .handler(async ({ data }): Promise<{ redirectUrl: string }> => {
    const userId = await verifyAuth(data.accessToken);

    if (!isAllowedReturnTo(data.returnTo)) {
      throw new Error(
        `returnTo "${data.returnTo}" is not in the OAuth allowlist`,
      );
    }

    const CLIENT_ID = process.env.ACUITY_CLIENT_ID;
    if (!CLIENT_ID) {
      throw new Error(
        "Acuity OAuth is not configured on the server. ACUITY_CLIENT_ID is missing.",
      );
    }

    const redirectUri = `${data.origin}/api/integrations/acuity/oauth-callback`;
    const nonce =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const state = encodeOAuthState({
      userId,
      platform: "acuity",
      returnTo: data.returnTo,
      nonce,
    });

    const redirectUrl = buildAcuityAuthorizeUrl({
      clientId: CLIENT_ID,
      redirectUri,
      state,
      scope: "api-v1",
    });

    return { redirectUrl };
  });

// ─── initiateSquareOAuth ───────────────────────────────────────────────────
//
// Mirrors initiateAcuityOAuth: returns a redirectUrl the UI navigates
// the spa to so they authorize Refill on Square's side. Square's
// authorize-code TTL is 5 minutes, so the callback handler exchanges
// immediately. We default to production env; sandbox path uses
// SQUARE_ENV=sandbox + the sandbox app credentials (separate Square
// app per environment).

export const initiateSquareOAuth = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => initiateInput.parse(raw))
  .handler(async ({ data }): Promise<{ redirectUrl: string }> => {
    const userId = await verifyAuth(data.accessToken);

    if (!isAllowedReturnTo(data.returnTo)) {
      throw new Error(
        `returnTo "${data.returnTo}" is not in the OAuth allowlist`,
      );
    }

    const env: SquareEnv = resolveSquareEnv();
    // v1.35.4: defensive whitespace strip mirrors the callback. CF input
    // fields wrap long values visually + can leak embedded whitespace.
    const CLIENT_ID = (
      env === "sandbox"
        ? process.env.SQUARE_SANDBOX_APP_ID
        : process.env.SQUARE_APP_ID
    )?.replace(/\s+/g, "");
    console.log(
      `[square/oauth-start] SQUARE_ENV raw="${process.env.SQUARE_ENV}" resolved="${env}" client_id_len=${CLIENT_ID?.length ?? 0}`,
    );
    if (!CLIENT_ID) {
      throw new Error(
        `Square OAuth is not configured on the server. ${env === "sandbox" ? "SQUARE_SANDBOX_APP_ID" : "SQUARE_APP_ID"} is missing.`,
      );
    }

    const nonce =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const state = encodeOAuthState({
      userId,
      platform: "square",
      returnTo: data.returnTo,
      nonce,
    });

    const redirectUrl = buildSquareAuthorizeUrl({
      clientId: CLIENT_ID,
      env,
      state,
    });

    return { redirectUrl };
  });

// ─── initiateZenotiConnect ─────────────────────────────────────────────────
//
// Zenoti is API-key-based (no user-consent OAuth). The wizard collects
// the spa's center_id; the API key itself lives on the Refill server
// (issued during Zenoti API package CSM onboarding). Per-center scope.

export const initiateZenotiConnect = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => initiateInput.parse(raw))
  .handler(async ({ data }): Promise<{ redirectUrl: string }> => {
    const userId = await verifyAuth(data.accessToken);
    if (!isAllowedReturnTo(data.returnTo)) {
      throw new Error(`returnTo "${data.returnTo}" is not in the OAuth allowlist`);
    }

    const env: ZenotiEnv = resolveZenotiEnv();
    const stripWs = (v: string | undefined) => v?.replace(/\s+/g, "");
    const API_KEY = stripWs(env === "sandbox" ? process.env.ZENOTI_SANDBOX_API_KEY : process.env.ZENOTI_API_KEY);
    console.log(
      `[zenoti/connect-start] ZENOTI_ENV raw="${process.env.ZENOTI_ENV}" resolved="${env}" api_key_len=${API_KEY?.length ?? 0}`,
    );
    if (!API_KEY) {
      throw new Error(
        `Zenoti is not configured on the server. Missing ${env === "sandbox" ? "ZENOTI_SANDBOX_API_KEY" : "ZENOTI_API_KEY"}. CSM-led API package onboarding may still be pending.`,
      );
    }

    const nonce = typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const state = encodeOAuthState({
      userId,
      platform: "zenoti",
      returnTo: data.returnTo,
      nonce,
    });

    const params = new URLSearchParams({ state });
    const redirectUrl = `${data.origin}/app/refill/calendar/zenoti-install?${params.toString()}`;
    return { redirectUrl };
  });

// ─── initiateJaneOAuth ─────────────────────────────────────────────────────
//
// Jane uses OAuth 2.0 + PKCE (mandatory). Generates a code_verifier +
// code_challenge pair; the verifier is embedded in the state token (no
// separate DB storage) so the callback can complete the exchange.
//
// 5-min token TTL means aggressive refresh; per-clinic base URLs mean
// the connection row's platform_account_email stores the clinic_url
// (NOT the user email like other platforms).

// State type for Jane includes the PKCE code_verifier so the OAuth
// callback can complete the exchange without separate storage. The
// state is already base64-encoded JSON; we just add the verifier as
// a field. The verifier protects against auth-code intercept, not
// state intercept, so embedding in state is safe.
type JaneOAuthState = {
  userId: string;
  platform: "jane";
  returnTo: string;
  nonce: string;
  codeVerifier: string;
};

export const initiateJaneOAuth = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => initiateInput.parse(raw))
  .handler(async ({ data }): Promise<{ redirectUrl: string }> => {
    const userId = await verifyAuth(data.accessToken);
    if (!isAllowedReturnTo(data.returnTo)) {
      throw new Error(`returnTo "${data.returnTo}" is not in the OAuth allowlist`);
    }

    const env: JaneEnv = resolveJaneEnv();
    const stripWs = (v: string | undefined) => v?.replace(/\s+/g, "");
    const CLIENT_ID = stripWs(env === "sandbox" ? process.env.JANE_SANDBOX_CLIENT_ID : process.env.JANE_CLIENT_ID);
    const CLIENT_SECRET = stripWs(env === "sandbox" ? process.env.JANE_SANDBOX_CLIENT_SECRET : process.env.JANE_CLIENT_SECRET);
    const IAM_BASE_URL = stripWs(env === "sandbox" ? process.env.JANE_SANDBOX_IAM_BASE_URL : process.env.JANE_IAM_BASE_URL);
    console.log(
      `[jane/oauth-start] JANE_ENV raw="${process.env.JANE_ENV}" resolved="${env}" client_id_len=${CLIENT_ID?.length ?? 0} client_secret_len=${CLIENT_SECRET?.length ?? 0} iam_base_url_len=${IAM_BASE_URL?.length ?? 0}`,
    );
    if (!CLIENT_ID || !CLIENT_SECRET || !IAM_BASE_URL) {
      const missing = [
        !CLIENT_ID && (env === "sandbox" ? "JANE_SANDBOX_CLIENT_ID" : "JANE_CLIENT_ID"),
        !CLIENT_SECRET && (env === "sandbox" ? "JANE_SANDBOX_CLIENT_SECRET" : "JANE_CLIENT_SECRET"),
        !IAM_BASE_URL && (env === "sandbox" ? "JANE_SANDBOX_IAM_BASE_URL" : "JANE_IAM_BASE_URL"),
      ].filter(Boolean).join(", ");
      throw new Error(
        `Jane OAuth is not configured on the server. Missing: ${missing}. Jane partnership approval pending — apply at developers.jane.app.`,
      );
    }

    const pkce = await generateJanePkcePair();
    const nonce = typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // Encode Jane-specific state with the PKCE verifier inline. Falls
    // through decodeOAuthState's generic check (which only validates
    // userId + platform); the additional codeVerifier field is preserved
    // on the round-trip.
    const stateObj: JaneOAuthState = {
      userId,
      platform: "jane",
      returnTo: data.returnTo,
      nonce,
      codeVerifier: pkce.codeVerifier,
    };
    const state = Buffer.from(JSON.stringify(stateObj), "utf-8").toString("base64url");

    const redirectUri = `${data.origin}/api/integrations/jane/oauth-callback`;
    const credentials: JaneOAuthCredentials = {
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      iamBaseUrl: IAM_BASE_URL,
      redirectUri,
      env,
    };

    const redirectUrl = buildJaneAuthorizeUrl({
      credentials,
      state,
      codeChallenge: pkce.codeChallenge,
    });

    return { redirectUrl };
  });

// ─── initiateBookerConnect ─────────────────────────────────────────────────
//
// Booker uses server-to-server OAuth client_credentials (app-level creds,
// NOT user-consent 3-legged OAuth). The spa identifies their Booker
// location to us — install wizard collects the LocationId, callback
// validates by minting an access_token + fetching that location.
//
// Architecture-only: throws "not configured" until BOOKER_CLIENT_ID +
// BOOKER_CLIENT_SECRET + BOOKER_SUBSCRIPTION_KEY land in CF secrets
// after Booker dev portal approval.

export const initiateBookerConnect = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => initiateInput.parse(raw))
  .handler(async ({ data }): Promise<{ redirectUrl: string }> => {
    const userId = await verifyAuth(data.accessToken);
    if (!isAllowedReturnTo(data.returnTo)) {
      throw new Error(`returnTo "${data.returnTo}" is not in the OAuth allowlist`);
    }

    const env: BookerEnv = resolveBookerEnv();
    const stripWs = (v: string | undefined) => v?.replace(/\s+/g, "");
    const CLIENT_ID = stripWs(
      env === "sandbox" ? process.env.BOOKER_SANDBOX_CLIENT_ID : process.env.BOOKER_CLIENT_ID,
    );
    const CLIENT_SECRET = stripWs(
      env === "sandbox" ? process.env.BOOKER_SANDBOX_CLIENT_SECRET : process.env.BOOKER_CLIENT_SECRET,
    );
    const SUBSCRIPTION_KEY = stripWs(
      env === "sandbox" ? process.env.BOOKER_SANDBOX_SUBSCRIPTION_KEY : process.env.BOOKER_SUBSCRIPTION_KEY,
    );
    console.log(
      `[booker/oauth-start] BOOKER_ENV raw="${process.env.BOOKER_ENV}" resolved="${env}" client_id_len=${CLIENT_ID?.length ?? 0} client_secret_len=${CLIENT_SECRET?.length ?? 0} sub_key_len=${SUBSCRIPTION_KEY?.length ?? 0}`,
    );
    if (!CLIENT_ID || !CLIENT_SECRET || !SUBSCRIPTION_KEY) {
      const missing = [
        !CLIENT_ID && (env === "sandbox" ? "BOOKER_SANDBOX_CLIENT_ID" : "BOOKER_CLIENT_ID"),
        !CLIENT_SECRET && (env === "sandbox" ? "BOOKER_SANDBOX_CLIENT_SECRET" : "BOOKER_CLIENT_SECRET"),
        !SUBSCRIPTION_KEY && (env === "sandbox" ? "BOOKER_SANDBOX_SUBSCRIPTION_KEY" : "BOOKER_SUBSCRIPTION_KEY"),
      ].filter(Boolean).join(", ");
      throw new Error(
        `Booker is not configured on the server. Missing: ${missing}. Developer app approval at developers.booker.com may still be pending.`,
      );
    }

    const nonce = typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const state = encodeOAuthState({
      userId,
      platform: "booker",
      returnTo: data.returnTo,
      nonce,
    });

    const params = new URLSearchParams({ state });
    const redirectUrl = `${data.origin}/app/refill/calendar/booker-install?${params.toString()}`;
    return { redirectUrl };
  });

// ─── initiateVagaroConnect ─────────────────────────────────────────────────
//
// Vagaro is paste-API-key (no OAuth). The wizard launcher returns a URL
// to a Refill-internal install page where the spa pastes their merchant-
// generated API key. NO Refill-side app credentials — every spa is its
// own mini-tenant relationship with Vagaro.

export const initiateVagaroConnect = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => initiateInput.parse(raw))
  .handler(async ({ data }): Promise<{ redirectUrl: string }> => {
    const userId = await verifyAuth(data.accessToken);

    if (!isAllowedReturnTo(data.returnTo)) {
      throw new Error(
        `returnTo "${data.returnTo}" is not in the OAuth allowlist`,
      );
    }

    const nonce =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const state = encodeOAuthState({
      userId,
      platform: "vagaro",
      returnTo: data.returnTo,
      nonce,
    });

    const redirectUrl = buildVagaroInstallUrl({
      origin: data.origin,
      state,
    });

    return { redirectUrl };
  });

// ─── initiateMindbodyOAuth ─────────────────────────────────────────────────
//
// Standard 3-legged OAuth launcher. Mindbody's authorize endpoint takes
// response_type=code id_token + response_mode=form_post — the callback
// is a POST from Mindbody's server, not a redirect with ?code= in the
// URL. The callback route handles both shapes.
//
// Activation-link UX path: per feedback_setup_wizards_auto_advance, if
// the spa hasn't yet activated Refill on their Mindbody account, this
// fn generates the activation link first + sends the spa to it before
// the authorize round-trip. Code-paste fallback is for the rare case
// where activation-link generation fails (spa-side admin permission
// quirks).
//
// Architecture-only: this server fn throws "not configured" until the
// Mindbody API Support ticket clears + MINDBODY_OAUTH_CLIENT_ID lands
// in CF secrets. Per platforms-pre-built doctrine, code ships now; UI
// button stays disabled.

export const initiateMindbodyOAuth = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => initiateInput.parse(raw))
  .handler(async ({ data }): Promise<{ redirectUrl: string }> => {
    const userId = await verifyAuth(data.accessToken);

    if (!isAllowedReturnTo(data.returnTo)) {
      throw new Error(
        `returnTo "${data.returnTo}" is not in the OAuth allowlist`,
      );
    }

    const env: MindbodyEnv = resolveMindbodyEnv();
    // v1.35.x doctrine: defensive whitespace strip on credentials at every
    // read site. MB credentials are alphanumeric — no legitimate whitespace.
    const stripWs = (v: string | undefined) => v?.replace(/\s+/g, "");
    const CLIENT_ID = stripWs(
      env === "sandbox"
        ? process.env.MINDBODY_SANDBOX_OAUTH_CLIENT_ID
        : process.env.MINDBODY_OAUTH_CLIENT_ID,
    );
    const API_KEY = stripWs(
      env === "sandbox"
        ? process.env.MINDBODY_SANDBOX_API_KEY
        : process.env.MINDBODY_API_KEY,
    );
    // v1.35.x doctrine: length-logging on credential reads.
    console.log(
      `[mindbody/oauth-start] MINDBODY_ENV raw="${process.env.MINDBODY_ENV}" resolved="${env}" client_id_len=${CLIENT_ID?.length ?? 0} api_key_len=${API_KEY?.length ?? 0}`,
    );
    if (!CLIENT_ID || !API_KEY) {
      const missing = [
        !CLIENT_ID &&
          (env === "sandbox"
            ? "MINDBODY_SANDBOX_OAUTH_CLIENT_ID"
            : "MINDBODY_OAUTH_CLIENT_ID"),
        !API_KEY &&
          (env === "sandbox"
            ? "MINDBODY_SANDBOX_API_KEY"
            : "MINDBODY_API_KEY"),
      ]
        .filter(Boolean)
        .join(", ");
      throw new Error(
        `Mindbody OAuth is not configured on the server. Missing: ${missing}. The OAuth-client-provisioning Support ticket may still be open at Mindbody API Support — check status before retrying.`,
      );
    }

    const redirectUri = `${data.origin}/api/integrations/mindbody/oauth-callback`;
    const nonce =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const state = encodeOAuthState({
      userId,
      platform: "mindbody",
      returnTo: data.returnTo,
      nonce,
    });

    const redirectUrl = buildMindbodyAuthorizeUrl({
      clientId: CLIENT_ID,
      redirectUri,
      state,
    });

    return { redirectUrl };
  });

// ─── initiateBoulevardOAuth ────────────────────────────────────────────────
//
// Mirrors initiateSquareOAuth in shape so the settings page can dispatch
// on platform without special-casing. Boulevard's install model is
// fundamentally divergent though: NOT a 3-legged OAuth, but a paste-
// Application-ID model where the spa installs our app inside their
// Boulevard dashboard. The returned redirectUrl points to a Refill-
// internal wizard page (NOT Boulevard's authorize) that displays the
// Application ID for clipboard-copy + deep-links the spa to
// `https://dashboard.joinblvd.com/manage-business/apps`.
//
// Architecture-only: this server fn will throw "not configured" until
// Grasshopper pastes BLVD_APPLICATION_ID + BLVD_API_KEY + BLVD_API_SECRET
// to CF secrets when the 48hr app-approval clock ends. That's the
// platforms-pre-built doctrine in action — engineering ships now, the
// flip-switch happens when credentials arrive.

export const initiateBoulevardOAuth = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => initiateInput.parse(raw))
  .handler(async ({ data }): Promise<{ redirectUrl: string }> => {
    const userId = await verifyAuth(data.accessToken);

    if (!isAllowedReturnTo(data.returnTo)) {
      throw new Error(
        `returnTo "${data.returnTo}" is not in the OAuth allowlist`,
      );
    }

    const env: BoulevardEnv = resolveBoulevardEnv();
    // v1.35.x doctrine: defensive whitespace strip on credentials at every
    // read site. Boulevard credentials are alphanumeric — no legitimate
    // whitespace possible — so stripping all whitespace is safe and
    // defends against CF input-field multi-line paste artifacts.
    const stripWs = (v: string | undefined) => v?.replace(/\s+/g, "");
    const APPLICATION_ID = stripWs(
      env === "sandbox"
        ? process.env.BLVD_SANDBOX_APPLICATION_ID
        : process.env.BLVD_APPLICATION_ID,
    );
    const API_KEY = stripWs(
      env === "sandbox"
        ? process.env.BLVD_SANDBOX_API_KEY
        : process.env.BLVD_API_KEY,
    );
    const API_SECRET = stripWs(
      env === "sandbox"
        ? process.env.BLVD_SANDBOX_API_SECRET
        : process.env.BLVD_API_SECRET,
    );
    // v1.35.x doctrine: length-logging on credential reads. Surfaces
    // type-confusion (wrong field pasted) before code-fix iterations.
    console.log(
      `[boulevard/oauth-start] BLVD_ENV raw="${process.env.BLVD_ENV}" resolved="${env}" application_id_len=${APPLICATION_ID?.length ?? 0} api_key_len=${API_KEY?.length ?? 0} api_secret_len=${API_SECRET?.length ?? 0}`,
    );
    if (!APPLICATION_ID || !API_KEY || !API_SECRET) {
      const missing = [
        !APPLICATION_ID && (env === "sandbox" ? "BLVD_SANDBOX_APPLICATION_ID" : "BLVD_APPLICATION_ID"),
        !API_KEY && (env === "sandbox" ? "BLVD_SANDBOX_API_KEY" : "BLVD_API_KEY"),
        !API_SECRET && (env === "sandbox" ? "BLVD_SANDBOX_API_SECRET" : "BLVD_API_SECRET"),
      ]
        .filter(Boolean)
        .join(", ");
      throw new Error(
        `Boulevard install is not configured on the server. Missing: ${missing}. The 48hr Boulevard app-approval clock may still be running — check developers.joinblvd.com for status.`,
      );
    }

    const nonce =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const state = encodeOAuthState({
      userId,
      platform: "boulevard",
      returnTo: data.returnTo,
      nonce,
    });

    const redirectUrl = buildBoulevardInstallUrl({
      origin: data.origin,
      applicationId: APPLICATION_ID,
      state,
    });

    return { redirectUrl };
  });

// ─── getSchedulerConnection ────────────────────────────────────────────────

const getConnectionInput = z.object({ accessToken: z.string().min(1) });

export const getSchedulerConnection = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => getConnectionInput.parse(raw))
  .handler(async ({ data }): Promise<SchedulerConnection | null> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();

    // Types not regenerated yet — types.ts will pick up the new tables
    // on the next supabase-typegen pass after the migration is applied.
    const { data: row, error } = await (sb as unknown as {
      from: (t: string) => {
        select: (cols: string) => {
          eq: (col: string, val: string) => {
            in: (col: string, vals: string[]) => {
              order: (col: string, opts: { ascending: boolean }) => {
                limit: (n: number) => {
                  maybeSingle: () => Promise<{ data: SchedulerConnectionRow | null; error: { message: string } | null }>;
                };
              };
            };
          };
        };
      };
    })
      .from("scheduler_connections")
      .select(
        "id, platform, platform_account_id, platform_account_email, status, last_sync_at, last_error, connected_at, disconnected_at",
      )
      .eq("user_id", userId)
      .in("status", ["connected", "pending", "reauth_needed", "error"])
      .order("connected_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw new Error(`Couldn't load connection: ${error.message}`);
    if (!row) return null;
    return rowToConnection(row);
  });

type SchedulerConnectionRow = {
  id: string;
  platform: string;
  platform_account_id: string | null;
  platform_account_email: string | null;
  status: string;
  last_sync_at: string | null;
  last_error: string | null;
  connected_at: string | null;
  disconnected_at: string | null;
};

function rowToConnection(row: SchedulerConnectionRow): SchedulerConnection {
  return {
    id: row.id,
    platform: row.platform as SchedulerPlatform,
    platformAccountId: row.platform_account_id,
    platformAccountEmail: row.platform_account_email,
    status: row.status as SchedulerStatus,
    lastSyncAt: row.last_sync_at,
    lastError: row.last_error,
    connectedAt: row.connected_at,
    disconnectedAt: row.disconnected_at,
  };
}

// ─── disconnectScheduler ───────────────────────────────────────────────────

const disconnectInput = z.object({
  accessToken: z.string().min(1),
  origin: z.string().min(1),
});

export const disconnectScheduler = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => disconnectInput.parse(raw))
  .handler(async ({ data }): Promise<{ disconnected: boolean; webhooksRemoved: number }> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();

    const { data: row, error } = await (sb as unknown as {
      from: (t: string) => {
        select: (cols: string) => {
          eq: (col: string, val: string) => {
            in: (col: string, vals: string[]) => {
              order: (col: string, opts: { ascending: boolean }) => {
                limit: (n: number) => {
                  maybeSingle: () => Promise<{
                    data: (SchedulerConnectionRow & {
                      access_token: string | null;
                      webhook_secret: string;
                      webhook_subscription_id: string | null;
                    }) | null;
                    error: { message: string } | null;
                  }>;
                };
              };
            };
          };
        };
      };
    })
      .from("scheduler_connections")
      .select("id, platform, access_token, webhook_secret, webhook_subscription_id, status, platform_account_id, platform_account_email, last_sync_at, last_error, connected_at, disconnected_at")
      .eq("user_id", userId)
      .in("status", ["connected", "pending", "reauth_needed", "error"])
      .order("connected_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw new Error(`Couldn't load connection: ${error.message}`);
    if (!row) return { disconnected: false, webhooksRemoved: 0 };

    let webhooksRemoved = 0;
    if (row.platform === "acuity" && row.access_token) {
      try {
        const webhookBaseUrl = `${data.origin}/api/webhooks/scheduler/acuity/${row.webhook_secret}`;
        webhooksRemoved = await tearDownAcuityWebhooksForTarget({
          accessToken: row.access_token,
          webhookBaseUrl,
        });
      } catch (e) {
        // Token may already be invalidated. Continue with the disconnect.
        // We log via the connection row's last_error so it shows in UI.
        await (sb as unknown as { from: (t: string) => { update: (v: object) => { eq: (c: string, v: string) => Promise<unknown> } } })
          .from("scheduler_connections")
          .update({
            last_error: `Webhook teardown failed: ${e instanceof Error ? e.message : "unknown"}`,
          })
          .eq("id", row.id);
      }
    } else if (
      row.platform === "square" &&
      row.access_token &&
      row.webhook_subscription_id
    ) {
      // Square teardown is targeted: delete the per-spa subscription
      // resource by ID (the notification URL is single-global, shared
      // across all Square spas, so URL-match teardown isn't an option).
      // Fail-open if the token is already revoked — Square will GC the
      // subscription anyway once the receiver stops being reachable.
      try {
        const env: SquareEnv =
          resolveSquareEnv();
        await deleteSquareWebhookSubscription({
          accessToken: row.access_token,
          env,
          subscriptionId: row.webhook_subscription_id,
        });
        webhooksRemoved = 1;
      } catch (e) {
        await (sb as unknown as { from: (t: string) => { update: (v: object) => { eq: (c: string, v: string) => Promise<unknown> } } })
          .from("scheduler_connections")
          .update({
            last_error: `Square webhook teardown failed: ${e instanceof Error ? e.message : "unknown"}`,
          })
          .eq("id", row.id);
      }
    } else if (
      row.platform === "zenoti" &&
      row.webhook_subscription_id
    ) {
      try {
        const env: ZenotiEnv = resolveZenotiEnv();
        const stripWs = (v: string | undefined) => v?.replace(/\s+/g, "");
        const API_KEY = stripWs(env === "sandbox" ? process.env.ZENOTI_SANDBOX_API_KEY : process.env.ZENOTI_API_KEY);
        if (!API_KEY || !row.platform_account_id) {
          throw new Error("Zenoti API key or center_id missing");
        }
        const credentials: ZenotiCredentials = { apiKey: API_KEY, centerId: row.platform_account_id, env };
        await deleteZenotiWebhookSubscription({ credentials, subscriptionId: row.webhook_subscription_id });
        webhooksRemoved = 1;
      } catch (e) {
        await (sb as unknown as { from: (t: string) => { update: (v: object) => { eq: (c: string, v: string) => Promise<unknown> } } })
          .from("scheduler_connections")
          .update({ last_error: `Zenoti webhook teardown failed: ${e instanceof Error ? e.message : "unknown"}` })
          .eq("id", row.id);
      }
    } else if (
      row.platform === "booker" &&
      row.webhook_subscription_id
    ) {
      try {
        const env: BookerEnv = resolveBookerEnv();
        const stripWs = (v: string | undefined) => v?.replace(/\s+/g, "");
        const CLIENT_ID = stripWs(env === "sandbox" ? process.env.BOOKER_SANDBOX_CLIENT_ID : process.env.BOOKER_CLIENT_ID);
        const CLIENT_SECRET = stripWs(env === "sandbox" ? process.env.BOOKER_SANDBOX_CLIENT_SECRET : process.env.BOOKER_CLIENT_SECRET);
        const SUBSCRIPTION_KEY = stripWs(env === "sandbox" ? process.env.BOOKER_SANDBOX_SUBSCRIPTION_KEY : process.env.BOOKER_SUBSCRIPTION_KEY);
        if (!CLIENT_ID || !CLIENT_SECRET || !SUBSCRIPTION_KEY) {
          throw new Error("Booker app credentials are not configured on the server.");
        }
        const credentials: BookerCredentials = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, subscriptionKey: SUBSCRIPTION_KEY, env };
        const tok = await getBookerAccessToken({ credentials });
        await deleteBookerWebhookSubscription({
          accessToken: tok.accessToken,
          credentials,
          subscriptionId: row.webhook_subscription_id,
        });
        webhooksRemoved = 1;
      } catch (e) {
        await (sb as unknown as { from: (t: string) => { update: (v: object) => { eq: (c: string, v: string) => Promise<unknown> } } })
          .from("scheduler_connections")
          .update({ last_error: `Booker webhook teardown failed: ${e instanceof Error ? e.message : "unknown"}` })
          .eq("id", row.id);
      }
    } else if (
      row.platform === "vagaro" &&
      row.access_token &&
      row.webhook_subscription_id
    ) {
      // Vagaro teardown: per-spa API key (stored in access_token) deletes
      // its own webhook subscription. Fail-open if API key already revoked.
      try {
        await deleteVagaroWebhookSubscription({
          credentials: {
            apiKey: row.access_token,
            merchantId: row.platform_account_id ?? "",
          },
          subscriptionId: row.webhook_subscription_id,
        });
        webhooksRemoved = 1;
      } catch (e) {
        await (sb as unknown as { from: (t: string) => { update: (v: object) => { eq: (c: string, v: string) => Promise<unknown> } } })
          .from("scheduler_connections")
          .update({
            last_error: `Vagaro webhook teardown failed: ${e instanceof Error ? e.message : "unknown"}`,
          })
          .eq("id", row.id);
      }
    } else if (
      row.platform === "mindbody" &&
      row.webhook_subscription_id
    ) {
      // Mindbody teardown: delete the per-spa subscription by ID.
      // Webhook lifecycle uses partner-level API-Key (NOT per-spa OAuth
      // token) so this still works after the spa's OAuth grant gets
      // revoked. Fail-open if MB API rejects.
      try {
        const env: MindbodyEnv = resolveMindbodyEnv();
        const stripWs = (v: string | undefined) => v?.replace(/\s+/g, "");
        const API_KEY = stripWs(
          env === "sandbox"
            ? process.env.MINDBODY_SANDBOX_API_KEY
            : process.env.MINDBODY_API_KEY,
        );
        if (!API_KEY) {
          throw new Error("Mindbody API key is not configured on the server.");
        }
        await deleteMindbodyWebhookSubscription({
          apiKey: API_KEY,
          subscriptionId: row.webhook_subscription_id,
        });
        webhooksRemoved = 1;
      } catch (e) {
        await (sb as unknown as { from: (t: string) => { update: (v: object) => { eq: (c: string, v: string) => Promise<unknown> } } })
          .from("scheduler_connections")
          .update({
            last_error: `Mindbody webhook teardown failed: ${e instanceof Error ? e.message : "unknown"}`,
          })
          .eq("id", row.id);
      }
    } else if (
      row.platform === "boulevard" &&
      row.webhook_subscription_id &&
      row.platform_account_id
    ) {
      // Boulevard teardown: delete the per-spa subscription resource by
      // ID. Boulevard auth is app-level (no per-spa access_token);
      // credentials come from env vars + the businessId URN scopes the
      // mutation. Fail-open if app creds aren't configured (rare; would
      // indicate the spa connected while creds were live + then creds
      // got rotated) or if Boulevard rejects the delete.
      try {
        const env: BoulevardEnv = resolveBoulevardEnv();
        const stripWs = (v: string | undefined) => v?.replace(/\s+/g, "");
        const APPLICATION_ID = stripWs(
          env === "sandbox"
            ? process.env.BLVD_SANDBOX_APPLICATION_ID
            : process.env.BLVD_APPLICATION_ID,
        );
        const API_KEY = stripWs(
          env === "sandbox"
            ? process.env.BLVD_SANDBOX_API_KEY
            : process.env.BLVD_API_KEY,
        );
        const API_SECRET = stripWs(
          env === "sandbox"
            ? process.env.BLVD_SANDBOX_API_SECRET
            : process.env.BLVD_API_SECRET,
        );
        if (!APPLICATION_ID || !API_KEY || !API_SECRET) {
          throw new Error(
            "Boulevard app credentials are not configured on the server.",
          );
        }
        const { deleteBoulevardWebhookSubscription } = await import(
          "@/lib/schedulers/boulevard"
        );
        await deleteBoulevardWebhookSubscription({
          credentials: { applicationId: APPLICATION_ID, apiKey: API_KEY, apiSecret: API_SECRET, env },
          businessId: row.platform_account_id,
          subscriptionId: row.webhook_subscription_id,
        });
        webhooksRemoved = 1;
      } catch (e) {
        await (sb as unknown as { from: (t: string) => { update: (v: object) => { eq: (c: string, v: string) => Promise<unknown> } } })
          .from("scheduler_connections")
          .update({
            last_error: `Boulevard webhook teardown failed: ${e instanceof Error ? e.message : "unknown"}`,
          })
          .eq("id", row.id);
      }
    }

    await (sb as unknown as { from: (t: string) => { update: (v: object) => { eq: (c: string, v: string) => Promise<{ error: { message: string } | null }> } } })
      .from("scheduler_connections")
      .update({
        status: "disconnected",
        disconnected_at: new Date().toISOString(),
        access_token: null,
        refresh_token: null,
      })
      .eq("id", row.id);

    return { disconnected: true, webhooksRemoved };
  });

// ─── resyncSchedulerConnection ─────────────────────────────────────────────
//
// v381.6 — manual "re-pull from the platform" trigger for an already-
// connected spa. Same backfill logic the OAuth callback runs at first
// connect, exposed as a server fn so the settings page can offer a
// Re-sync button. The primary use case is recovering from v381's
// patient_node_id null bug (rows already in the DB without resolved
// names) — re-running the backfill applies the v381.5 matcher to every
// row in the 30d-back + 90d-forward window. Idempotent under
// (user_id, external_id, source) upsert.

const resyncInput = z.object({ accessToken: z.string().min(1) });

export const resyncSchedulerConnection = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => resyncInput.parse(raw))
  .handler(async ({ data }): Promise<{
    platform: string;
    totalAppointments: number;
    resolvedPatientNames: number;
  }> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();

    const { data: row } = await (sb as unknown as {
      from: (t: string) => {
        select: (cols: string) => {
          eq: (c: string, v: string) => {
            in: (c: string, vals: string[]) => {
              order: (c: string, opts: { ascending: boolean }) => {
                limit: (n: number) => {
                  maybeSingle: () => Promise<{
                    data: {
                      id: string;
                      platform: string;
                      access_token: string | null;
                      platform_account_id: string | null;
                    } | null;
                  }>;
                };
              };
            };
          };
        };
      };
    })
      .from("scheduler_connections")
      .select("id, platform, access_token, platform_account_id")
      .eq("user_id", userId)
      .in("status", ["connected", "reauth_needed", "error"])
      .order("connected_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!row) {
      throw new Error(
        "No active scheduler connection — connect a scheduler first.",
      );
    }
    // Boulevard auth is app-level (no per-spa access_token), so the
    // access_token gate doesn't apply for that platform — instead we
    // gate on businessId presence (platform_account_id).
    if (row.platform !== "boulevard" && !row.access_token) {
      throw new Error(
        "Connection is missing an access token — please reconnect.",
      );
    }
    if (
      row.platform !== "acuity" &&
      row.platform !== "square" &&
      row.platform !== "boulevard" &&
      row.platform !== "mindbody" &&
      row.platform !== "vagaro" &&
      row.platform !== "booker" &&
      row.platform !== "jane" &&
      row.platform !== "zenoti"
    ) {
      throw new Error(
        `Re-sync is only available for Acuity, Square, Boulevard, Mindbody, Vagaro, Booker, Jane, and Zenoti right now (your connection is ${row.platform}).`,
      );
    }

    let result: { totalAppointments: number; resolvedPatientNames: number };
    if (row.platform === "zenoti") {
      if (!row.platform_account_id) {
        throw new Error("Zenoti connection is missing the center_id — please reconnect.");
      }
      result = await backfillZenotiAppointments({
        sb,
        userId,
        centerId: row.platform_account_id,
      });
    } else if (row.platform === "jane") {
      if (!row.access_token || !row.platform_account_id) {
        throw new Error("Jane connection is missing token or clinicUrl — please reconnect.");
      }
      result = await backfillJaneAppointments({
        sb,
        userId,
        connectionId: row.id,
        accessToken: row.access_token,
        clinicUrl: row.platform_account_id, // overload: Jane stores clinic_url here
      });
    } else if (row.platform === "booker") {
      if (!row.platform_account_id) {
        throw new Error("Booker connection is missing the LocationId — please reconnect.");
      }
      result = await backfillBookerAppointments({
        sb,
        userId,
        locationId: row.platform_account_id,
      });
    } else if (row.platform === "vagaro") {
      result = await backfillVagaroAppointments({
        sb,
        userId,
        apiKey: row.access_token!,
      });
    } else if (row.platform === "mindbody") {
      if (!row.platform_account_id) {
        throw new Error(
          "Mindbody connection is missing the siteId — please reconnect.",
        );
      }
      result = await backfillMindbodyAppointments({
        sb,
        userId,
        connectionId: row.id,
        accessToken: row.access_token!,
        siteId: row.platform_account_id,
      });
    } else if (row.platform === "boulevard") {
      if (!row.platform_account_id) {
        throw new Error(
          "Boulevard connection is missing the businessId — please reconnect.",
        );
      }
      result = await backfillBoulevardAppointments({
        sb,
        userId,
        businessId: row.platform_account_id,
      });
    } else if (row.platform === "square") {
      result = await backfillSquareBookings({
        sb,
        userId,
        accessToken: row.access_token!,
      });
    } else {
      result = await backfillAcuityAppointments({
        sb,
        userId,
        accessToken: row.access_token!,
      });
    }

    // v1.35.11: Stamp last_sync_at AND clear last_error on success.
    // Previously Re-sync left stale last_error frozen even when the
    // backfill succeeded under newer code (caught when v1.35.10's
    // chunked-backfill fix resolved the underlying issue but the prior
    // error message persisted in the UI until the connection got
    // dis/reconnected to fully refresh).
    await (sb as unknown as {
      from: (t: string) => {
        update: (v: object) => {
          eq: (c: string, v: string) => Promise<unknown>;
        };
      };
    })
      .from("scheduler_connections")
      .update({
        last_sync_at: new Date().toISOString(),
        last_error: null,
      })
      .eq("id", row.id);

    return {
      platform: row.platform,
      totalAppointments: result.totalAppointments,
      resolvedPatientNames: result.resolvedPatientNames,
    };
  });

// ─── Backfill helper (shared with OAuth callback) ──────────────────────────
//
// v381.6: extracted from src/routes/api.integrations.acuity.oauth-callback.ts
// so resyncSchedulerConnection can run the same backfill on an already-
// connected spa without re-running OAuth. Idempotent: upserts on
// (user_id, external_id, source). Pre-migrates any leftover
// csv-acuity-source rows to acuity-source first so patient_node_id and
// recovery_event_id FKs survive.

const BACKFILL_DAYS_BACK = 30;
const BACKFILL_DAYS_FORWARD = 90;

export async function backfillAcuityAppointments(args: {
  sb: SupabaseAdmin;
  userId: string;
  accessToken: string;
}): Promise<{
  totalAppointments: number;
  resolvedPatientNames: number;
  windowCapHit: boolean;
}> {
  const { sb, userId, accessToken } = args;

  const now = new Date();
  const minDate = new Date(now.getTime() - BACKFILL_DAYS_BACK * 86400000);
  const maxDate = new Date(now.getTime() + BACKFILL_DAYS_FORWARD * 86400000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  // Date-window paged pull (not a raw max:1000) so a spa with >1000 appts in
  // the backfill window doesn't silently lose half its history on connect.
  const [active, canceled] = await Promise.all([
    listAllAcuityAppointmentsInWindow(accessToken, {
      minDate: fmt(minDate),
      maxDate: fmt(maxDate),
      canceled: false,
    }),
    listAllAcuityAppointmentsInWindow(accessToken, {
      minDate: fmt(minDate),
      maxDate: fmt(maxDate),
      canceled: true,
    }),
  ]);
  const windowCapHit = active.hitFloor || canceled.hitFloor;
  if (windowCapHit) {
    console.warn(
      `[acuity-backfill] single-day cap hit for user ${userId} — backfill may be partial (>1000 appts in one day).`,
    );
  }

  const all = [...active.appointments, ...canceled.appointments];

  // Pre-migrate any leftover csv-acuity-sourced rows so the upsert
  // dedupes correctly on the (user_id, external_id, source) composite.
  await (sb as unknown as {
    from: (t: string) => {
      update: (v: object) => {
        eq: (c: string, v: string) => {
          eq: (c: string, v: string) => Promise<unknown>;
        };
      };
    };
  })
    .from("appointments")
    .update({ source: "acuity" })
    .eq("user_id", userId)
    .eq("source", "csv-acuity");

  // Build the patient + provider indexes ONCE for the whole batch.
  const patientIndex = await buildPatientIndex(sb, userId);
  const providerIndex = await buildAcuityProviderIndex(sb, userId);

  let resolvedPatientNames = 0;
  const rows = all.map((apt) => {
    const patientNodeId = matchPatientFromIndex(
      {
        patientFirstName: apt.firstName || null,
        patientLastName: apt.lastName || null,
        patientPhone: apt.phone || null,
        patientEmail: apt.email || null,
      },
      patientIndex,
    );
    if (patientNodeId) resolvedPatientNames++;
    return acuityAppointmentToRow(
      apt,
      userId,
      patientNodeId,
      providerIndex.get(String(apt.calendarID)) ?? null,
    );
  });

  const BATCH = 200;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const { error } = await sb
      .from("appointments")
      .upsert(slice, { onConflict: "user_id,external_id,source" });
    if (error) {
      throw new Error(`Appointment upsert batch ${i}: ${error.message}`);
    }
  }

  return {
    totalAppointments: rows.length,
    resolvedPatientNames,
    windowCapHit,
  };
}

// ─── reconcileAcuityForConnection (the self-healing backstop, v2.41.0) ────────
//
// The realtime webhook is the primary path; this is the safety net. A few-hour
// cron (api.cron.acuity-reconcile) re-pulls a RECENT window and upserts
// idempotently on (user_id, external_id, source) — so a webhook the realtime
// path dropped is caught and the calendar can never go SILENTLY stale (the #1
// trust risk per the Connection-Health doctrine). It fires the SAME trigger
// graph as the webhook (rescue + reliability) but ONLY on a genuine status
// TRANSITION vs. the stored row, so it never double-acts on a change the
// webhook already handled (idempotent by construction). A narrow window keeps
// each run cheap; far-future drift is covered by the webhook + on-connect
// backfill.
const RECONCILE_DAYS_BACK = 7;
const RECONCILE_DAYS_FORWARD = 45;

export async function reconcileAcuityForConnection(args: {
  sb: SupabaseAdmin;
  userId: string;
  accessToken: string;
}): Promise<{
  pulled: number;
  changed: number;
  rescued: number;
  reliabilityRecomputed: number;
  windowCapHit: boolean;
}> {
  const { sb, userId, accessToken } = args;
  const now = new Date();
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const minDate = fmt(new Date(now.getTime() - RECONCILE_DAYS_BACK * 86400000));
  const maxDate = fmt(new Date(now.getTime() + RECONCILE_DAYS_FORWARD * 86400000));

  // Date-window paged pull (not a raw max:1000). This is the calendar-trust
  // KEYSTONE cron — a high-volume spa silently capped at 1000 would mean the
  // self-healing reconcile sweep quietly stops covering its own window.
  const [active, canceled] = await Promise.all([
    listAllAcuityAppointmentsInWindow(accessToken, { minDate, maxDate, canceled: false }),
    listAllAcuityAppointmentsInWindow(accessToken, { minDate, maxDate, canceled: true }),
  ]);
  const windowCapHit = active.hitFloor || canceled.hitFloor;
  if (windowCapHit) {
    console.warn(
      `[acuity-reconcile] single-day cap hit for user ${userId} — reconcile window may be partial (>1000 appts in one day).`,
    );
  }
  const all = [...active.appointments, ...canceled.appointments];
  if (all.length === 0) {
    return { pulled: 0, changed: 0, rescued: 0, reliabilityRecomputed: 0, windowCapHit };
  }

  // Bulk-load the stored state for the pulled external ids (chunked .in()),
  // so transition detection is one query per 200 instead of one per appt.
  const ids = all.map((a) => String(a.id));
  const prior = new Map<
    string,
    { id: string; status: string; patient_node_id: string | null; scheduled_at: string }
  >();
  const CHUNK = 200;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data } = await sb
      .from("appointments")
      .select("id, external_id, status, patient_node_id, scheduled_at")
      .eq("user_id", userId)
      .eq("source", "acuity")
      .in("external_id", ids.slice(i, i + CHUNK));
    for (const r of data ?? []) {
      if (r.external_id) {
        prior.set(r.external_id, {
          id: r.id,
          status: r.status,
          patient_node_id: r.patient_node_id,
          scheduled_at: r.scheduled_at,
        });
      }
    }
  }

  const patientIndex = await buildPatientIndex(sb, userId);
  const providerIndex = await buildAcuityProviderIndex(sb, userId);

  let changed = 0;
  let rescued = 0;
  let reliabilityRecomputed = 0;

  for (const apt of all) {
    const p = prior.get(String(apt.id));
    const patientNodeId =
      p?.patient_node_id ??
      matchPatientFromIndex(
        {
          patientFirstName: apt.firstName || null,
          patientLastName: apt.lastName || null,
          patientPhone: apt.phone || null,
          patientEmail: apt.email || null,
        },
        patientIndex,
      );

    const row = acuityAppointmentToRow(
      apt,
      userId,
      patientNodeId,
      providerIndex.get(String(apt.calendarID)) ?? null,
    );
    const { data: upserted } = await sb
      .from("appointments")
      .upsert(row, { onConflict: "user_id,external_id,source" })
      .select("id, status, patient_node_id, scheduled_at")
      .single();
    if (!upserted) continue;

    const priorStatus = p?.status ?? null;
    if (priorStatus === upserted.status) continue; // no transition → webhook already handled (or unchanged)
    changed++;

    await sb.from("appointment_status_events").insert({
      user_id: userId,
      appointment_id: upserted.id,
      from_status: priorStatus ?? "scheduled",
      to_status: upserted.status,
      triggered_by: "acuity-reconcile",
      reason: `acuity:reconcile:${apt.canceled ? "canceled" : apt.noShow ? "noshow" : "scheduled"}`,
    });

    const future = new Date(upserted.scheduled_at).getTime() > Date.now();
    if ((upserted.status === "cancelled" || upserted.status === "no_show") && future) {
      try {
        const { dispatchRescueAttempt } = await import("@/server/emma-rescue.functions");
        await dispatchRescueAttempt({ sb, userId, appointmentId: upserted.id });
        rescued++;
      } catch (e) {
        console.error("[acuity-reconcile] rescue dispatch failed:", e instanceof Error ? e.message : e);
      }
    }
    if (
      upserted.patient_node_id &&
      ["showed", "no_show", "cancelled"].includes(upserted.status)
    ) {
      try {
        const { recomputeReliabilityForPatient } = await import("@/server/emma-reliability.functions");
        await recomputeReliabilityForPatient({ sb, userId, patientNodeId: upserted.patient_node_id });
        reliabilityRecomputed++;
      } catch (e) {
        console.error("[acuity-reconcile] reliability recompute failed:", e instanceof Error ? e.message : e);
      }
    }
  }

  // Stamp the connection's freshness pulse (so Connection Health sees the
  // reconcile heartbeat even during a webhook outage).
  await sb
    .from("scheduler_connections")
    .update({ last_sync_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("platform", "acuity");

  return { pulled: all.length, changed, rescued, reliabilityRecomputed, windowCapHit };
}

/**
 * Build the Acuity calendar-id → native provider_id index for a spa (v2.42.0).
 * The staging mirror anchors each scheduling_providers row by external_id =
 * the Acuity calendar id (external_source='acuity'). Resolving provider_id at
 * INGEST from the appointment's calendarID means new appointments are linked
 * continuously — no dependence on re-running the one-shot staging mirror.
 * external_source/external_id aren't in generated types yet → loose view.
 */
export async function buildAcuityProviderIndex(
  sb: SupabaseAdmin,
  userId: string,
): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  const tenantId = await getTenantIdForUser(sb, userId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (sb as unknown as { from(t: string): any })
    .from("scheduling_providers")
    .select("id, external_id")
    .eq("tenant_id", tenantId)
    .eq("external_source", "acuity");
  for (const r of (data ?? []) as Array<{ id: string; external_id: string | null }>) {
    if (r.external_id) m.set(r.external_id, r.id);
  }
  return m;
}

// ─── wideRelinkAcuityProviders (one-time historical backlink, v2.47.0) ────────
//
// The reconcile cron only re-pulls a RECENT window (7d back / 45d fwd), so
// historical appointments beyond it keep whatever provider_id the one-shot
// staging mirror could resolve BY NAME — structurally weaker than calendarID
// linking (appointments stores provider_name, not calendarID; only a live
// Acuity pull carries calendarID — see the S2 finding: calendarID linked +172
// rows exact name-match physically can't). This is the one-time / on-demand
// WIDE pass that closes that gap for any spa with deep history.
//
// It deliberately does NOT reuse the full reconcile: acuityAppointmentToRow
// force-sets status from Acuity flags, which over deep history would revert
// in-app `showed`/`rescheduled` markings back to `scheduled` and corrupt the
// reliability signal. So this is SURGICAL — it re-pulls the wide window purely
// to learn each appointment's external_id → calendarID, then updates
// provider_id and NOTHING else (no status, no patient links). calendarID is
// authoritative, so it fills nulls AND overwrites weaker name-matched links.
// Idempotent (only rows whose provider_id actually changes are written).
const WIDE_RELINK_DAYS_BACK = 730;
const WIDE_RELINK_DAYS_FORWARD = 365;

export async function wideRelinkAcuityProviders(args: {
  sb: SupabaseAdmin;
  userId: string;
  accessToken: string;
  daysBack?: number;
  daysForward?: number;
}): Promise<{
  pulled: number;
  resolvable: number;
  relinked: number;
  apiCapHit: boolean;
}> {
  const { sb, userId, accessToken } = args;
  const daysBack = args.daysBack ?? WIDE_RELINK_DAYS_BACK;
  const daysForward = args.daysForward ?? WIDE_RELINK_DAYS_FORWARD;
  const now = new Date();
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const minDate = fmt(new Date(now.getTime() - daysBack * 86400000));
  const maxDate = fmt(new Date(now.getTime() + daysForward * 86400000));

  // Date-window paged pull — the wide window (730d back / 365d fwd) is exactly
  // where a deep-history spa exceeds one page, so this PAGES it rather than just
  // flagging the cap. `apiCapHit` now means the unrecoverable single-day floor.
  const [active, canceled] = await Promise.all([
    listAllAcuityAppointmentsInWindow(accessToken, { minDate, maxDate, canceled: false }),
    listAllAcuityAppointmentsInWindow(accessToken, { minDate, maxDate, canceled: true }),
  ]);
  const apiCapHit = active.hitFloor || canceled.hitFloor;
  const all = [...active.appointments, ...canceled.appointments];
  if (all.length === 0) {
    return { pulled: 0, resolvable: 0, relinked: 0, apiCapHit };
  }

  const providerIndex = await buildAcuityProviderIndex(sb, userId);

  // Group external_ids by their calendarID-resolved provider_id so we relink
  // with one UPDATE per provider group instead of one per row.
  const byProvider = new Map<string, string[]>();
  let resolvable = 0;
  for (const apt of all) {
    const providerId = providerIndex.get(String(apt.calendarID));
    if (!providerId) continue;
    resolvable++;
    const list = byProvider.get(providerId) ?? [];
    list.push(String(apt.id));
    byProvider.set(providerId, list);
  }

  let relinked = 0;
  const CHUNK = 200;
  for (const [providerId, extIds] of byProvider) {
    for (let i = 0; i < extIds.length; i += CHUNK) {
      const slice = extIds.slice(i, i + CHUNK);
      // Only touch rows whose provider_id is null or different → honest count,
      // idempotent, never a no-op write.
      const { data, error } = await sb
        .from("appointments")
        .update({ provider_id: providerId, updated_at: new Date().toISOString() })
        .eq("user_id", userId)
        .eq("source", "acuity")
        .in("external_id", slice)
        .or(`provider_id.is.null,provider_id.neq.${providerId}`)
        .select("id");
      if (error) {
        console.error("[acuity-wide-relink] update failed:", error.message);
        continue;
      }
      relinked += data?.length ?? 0;
    }
  }

  return { pulled: all.length, resolvable, relinked, apiCapHit };
}

function acuityAppointmentToRow(
  apt: AcuityAppointment,
  userId: string,
  patientNodeId: string | null,
  providerId: string | null = null,
): Database["public"]["Tables"]["appointments"]["Insert"] {
  // v1.4.3: parse Acuity's timezone-aware datetime properly. The old
  // regex .replace(/[+-]\d{4}$/, "Z") STRIPPED the offset without
  // applying it — so "2026-05-26T16:00:00-0600" (4 PM MT) became
  // "2026-05-26T16:00:00Z" (4 PM UTC = 10 AM MT), shifting every Karen
  // appointment 6 hours too early. Caught 2026-05-26 during Karen's live
  // Acuity cancel test: she booked for 4 PM MT, dispatcher saw it as
  // already 2.5h in the past, skipped rescue. new Date().toISOString()
  // handles all Acuity formats (with or without colon in offset, Z, etc.).
  const scheduledAt = new Date(apt.datetime ?? "").toISOString();
  const status: Database["public"]["Tables"]["appointments"]["Insert"]["status"] = apt.canceled
    ? "cancelled"
    : apt.noShow
      ? "no_show"
      : "scheduled";

  const base: Database["public"]["Tables"]["appointments"]["Insert"] = {
    user_id: userId,
    external_id: String(apt.id),
    source: "acuity",
    scheduled_at: scheduledAt,
    duration_min: Number(apt.duration) || 0,
    treatment_type: apt.type || null,
    provider_name: apt.calendar || null,
    status,
    notes: apt.notes || null,
  };
  // v2.46.0: persist the patient's identity from the Acuity payload so the
  // calendar shows a name even when the patient hasn't matched a knowledge_node
  // yet (the old behavior left every unmatched import nameless). Conditional
  // (omit-when-absent) follows the same upsert-preserve idiom as patient_node_id
  // below — a re-delivery missing a field never wipes a value already on the row.
  const fullName = `${apt.firstName ?? ""} ${apt.lastName ?? ""}`.trim();
  if (fullName) base.booking_name = fullName;
  if (apt.email) base.booking_email = apt.email;
  if (apt.phone) base.booking_phone = apt.phone;
  if (patientNodeId) {
    base.patient_node_id = patientNodeId;
  }
  if (providerId) {
    base.provider_id = providerId;
  }
  return base;
}

// ─── importAcuityClients (v415.3) ──────────────────────────────────────────
//
// Pull the spa's full client roster from Acuity via the OAuth token saved
// on the user's scheduler_connections row, synthesize a CSV in the
// shape parseClientListCsv expects, and run it through the existing
// doIngestClientList pipeline. Reuses every line of the ingest /
// matching / enrichment code (patient-ingest.functions.ts:966) without
// touching it — the synthesized CSV is the contract surface, so neither
// caller needs to know about the other's storage format.
//
// Returns a tagged union so the wizard Step 3 can render each state
// cleanly: no Acuity connection (degrade to CSV upload), empty Acuity
// roster (also degrade to CSV), or imported (show count + advance).

const importAcuityClientsInput = z.object({
  accessToken: z.string().min(1),
});

export type ImportAcuityClientsResult =
  | { kind: "no-connection" }
  | { kind: "empty"; reason: "no-clients" }
  | { kind: "imported"; receipt: ClientListReceipt; rawCount: number };

export const importAcuityClients = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => importAcuityClientsInput.parse(raw))
  .handler(async ({ data }): Promise<ImportAcuityClientsResult> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();

    // Look up the active Acuity connection + its OAuth access token.
    // Same shape as getSchedulerConnection but we need access_token
    // back (it's stripped from the public SchedulerConnection type
    // because the client side never gets to see it).
    const { data: row, error } = await (sb as unknown as {
      from: (t: string) => {
        select: (cols: string) => {
          eq: (col: string, val: string) => {
            eq: (col: string, val: string) => {
              eq: (col: string, val: string) => {
                order: (col: string, opts: { ascending: boolean }) => {
                  limit: (n: number) => {
                    maybeSingle: () => Promise<{
                      data: { access_token: string | null } | null;
                      error: { message: string } | null;
                    }>;
                  };
                };
              };
            };
          };
        };
      };
    })
      .from("scheduler_connections")
      .select("access_token")
      .eq("user_id", userId)
      .eq("platform", "acuity")
      .eq("status", "connected")
      .order("connected_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      throw new Error(`Couldn't read your Acuity connection: ${error.message}`);
    }
    if (!row || !row.access_token) {
      return { kind: "no-connection" };
    }

    // Pull the roster. Acuity's /clients endpoint returns the full list
    // in one response (no pagination cursor in their API). For very large
    // spas (5k+ clients) this can take 5-15s; we surface the elapsed
    // time hint in Step 3's UI rather than chunking.
    let clients: AcuityClient[];
    try {
      clients = await listAcuityClients(row.access_token);
    } catch (err) {
      throw new Error(
        `Couldn't pull your Acuity client roster: ${
          err instanceof Error ? err.message : "unknown error"
        }`,
      );
    }

    if (clients.length === 0) {
      return { kind: "empty", reason: "no-clients" };
    }

    // Synthesize CSV with the headers parseClientListCsv recognizes
    // ("First Name,Last Name,Phone,Email,Notes"). This sidesteps having
    // to refactor doIngestClientList to accept pre-parsed rows — the
    // CSV-string surface is the existing contract, and Acuity's
    // AcuityClient shape maps 1:1 to those columns.
    const csv = acuityClientsToCsv(clients);
    const receipt = await doIngestClientList(
      sb,
      userId,
      csv,
      "acuity://clients",
    );

    return { kind: "imported", receipt, rawCount: clients.length };
  });

/**
 * Build a RFC-4180-ish CSV string from Acuity client objects. The header
 * row uses the names parseClientListCsv recognizes (case-insensitive,
 * order-tolerant per its column-resolution logic). Values get
 * quote-wrapped + double-quote escaped for any field that might contain
 * commas, quotes, or newlines (notes in particular).
 */
function acuityClientsToCsv(clients: AcuityClient[]): string {
  const escape = (v: string | null | undefined): string => {
    const s = (v ?? "").toString();
    if (s === "") return "";
    const needsQuoting = /[",\r\n]/.test(s);
    if (!needsQuoting) return s;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const header = "First Name,Last Name,Phone,Email,Notes";
  const lines = clients.map((c) =>
    [
      escape(c.firstName),
      escape(c.lastName),
      escape(c.phone),
      escape(c.email),
      escape(c.notes),
    ].join(","),
  );
  return [header, ...lines].join("\n");
}

// ─── Backfill helper for Square (shared with OAuth callback + resync) ──────
//
// Same shape as backfillAcuityAppointments: pulls a 30d-back + 90d-
// forward window, upserts on (user_id, external_id, source). The
// pagination cursor is Square's idiom — we follow until the API stops
// returning one.

export async function backfillSquareBookings(args: {
  sb: SupabaseAdmin;
  userId: string;
  accessToken: string;
}): Promise<{ totalAppointments: number; resolvedPatientNames: number }> {
  const { sb, userId, accessToken } = args;
  const env: SquareEnv =
    resolveSquareEnv();

  const now = new Date();
  const windowStart = new Date(now.getTime() - 30 * 86400000);
  const windowEnd = new Date(now.getTime() + 90 * 86400000);

  // v1.35.9: Square's /v2/bookings requires AT LEAST ONE of location_id,
  // team_member_id, or customer_id. Fetch /v2/locations first then
  // iterate per location_id.
  const apiBaseUrl =
    env === "sandbox"
      ? "https://connect.squareupsandbox.com"
      : "https://connect.squareup.com";
  type LocResp = { locations?: { id?: string }[] };
  const locResp = await fetch(`${apiBaseUrl}/v2/locations`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Square-Version": "2024-12-18",
    },
  });
  if (!locResp.ok) {
    const text = await locResp.text().catch(() => "");
    throw new Error(
      `Square /v2/locations ${locResp.status}: ${text.slice(0, 500)}`,
    );
  }
  const locJson = (await locResp.json()) as LocResp;
  const locationIds = (locJson.locations ?? [])
    .map((l) => l.id)
    .filter((id): id is string => !!id);

  if (locationIds.length === 0) {
    return { totalAppointments: 0, resolvedPatientNames: 0 };
  }

  // v1.35.10: Square's /v2/bookings additionally constrains the window
  // between start_at_min and start_at_max to <31 days. Chunk the
  // 120-day backfill window (30 back + 90 forward) into ≤30-day slices
  // and iterate per (location, slice).
  const SLICE_DAYS = 30;
  const slices: { startAtMin: string; startAtMax: string }[] = [];
  let sliceCursor = windowStart;
  while (sliceCursor < windowEnd) {
    const sliceNext = new Date(sliceCursor.getTime() + SLICE_DAYS * 86400000);
    const sliceEnd = sliceNext < windowEnd ? sliceNext : windowEnd;
    slices.push({
      startAtMin: sliceCursor.toISOString(),
      startAtMax: sliceEnd.toISOString(),
    });
    sliceCursor = sliceEnd;
  }

  const all: SquareBooking[] = [];
  for (const locationId of locationIds) {
    for (const slice of slices) {
      let cursor: string | null = null;
      for (let page = 0; page < 50; page++) {
        const { bookings, cursor: next } = await listSquareBookings({
          accessToken,
          env,
          locationId,
          startAtMin: slice.startAtMin,
          startAtMax: slice.startAtMax,
          limit: 200,
          cursor: cursor ?? undefined,
        });
        all.push(...bookings);
        if (!next) break;
        cursor = next;
      }
    }
  }

  // Pre-migrate any leftover csv-square-sourced rows so the upsert
  // dedupes correctly on (user_id, external_id, source) — same pattern
  // backfillAcuityAppointments uses for csv-acuity rows.
  await (sb as unknown as {
    from: (t: string) => {
      update: (v: object) => {
        eq: (c: string, v: string) => {
          eq: (c: string, v: string) => Promise<unknown>;
        };
      };
    };
  })
    .from("appointments")
    .update({ source: "square" })
    .eq("user_id", userId)
    .eq("source", "csv-square");

  const patientIndex = await buildPatientIndex(sb, userId);

  // Square bookings carry customer_id but not the customer's name on
  // the booking response — we'd need a join or a follow-up to /v2/
  // customers/:id to enrich. For v1 we pass empty name/phone/email to
  // the matcher (it gracefully returns null when nothing's known) and
  // rely on the inbound-webhook path to populate the patient_node_id
  // when a known customer's booking changes. The Acuity pattern of
  // resolving via webhook payload covers ongoing changes; bulk-initial
  // backfill enrichment is queued for a follow-up ship.
  let resolvedPatientNames = 0;
  const rows = all.map((b) => {
    const patientNodeId = matchPatientFromIndex(
      {
        patientFirstName: null,
        patientLastName: null,
        patientPhone: null,
        patientEmail: null,
      },
      patientIndex,
    );
    if (patientNodeId) resolvedPatientNames++;
    return squareBookingToRow(b, userId, patientNodeId);
  });

  const BATCH = 200;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const { error } = await sb
      .from("appointments")
      .upsert(slice, { onConflict: "user_id,external_id,source" });
    if (error) {
      throw new Error(`Square appointment upsert batch ${i}: ${error.message}`);
    }
  }

  return {
    totalAppointments: rows.length,
    resolvedPatientNames,
  };
}

export function squareBookingToRow(
  b: SquareBooking,
  userId: string,
  patientNodeId: string | null,
): Database["public"]["Tables"]["appointments"]["Insert"] {
  const scheduledAt = new Date(b.startAt).toISOString();
  const seg = b.appointmentSegments[0];
  const durationMin = b.appointmentSegments.reduce(
    (sum, s) => sum + (s.durationMinutes ?? 0),
    0,
  );
  const base: Database["public"]["Tables"]["appointments"]["Insert"] = {
    user_id: userId,
    external_id: b.id,
    source: "square",
    scheduled_at: scheduledAt,
    duration_min: durationMin,
    treatment_type: seg?.serviceVariationId ?? null,
    provider_name: seg?.teamMemberId ?? null,
    status: squareStatusToRefillStatus(b.status),
    notes: b.sellerNote || b.customerNote || null,
  };
  if (patientNodeId) base.patient_node_id = patientNodeId;
  return base;
}

// ─── Square token refresh helper (used by webhook + writeback paths) ───────
//
// Square access tokens last 30 days; refresh_token reissues a fresh pair.
// Centralized here so the webhook receiver, the rescue writeback, and the
// resync path all use the same just-in-time refresh logic.

export async function withFreshSquareToken<T>(args: {
  sb: SupabaseAdmin;
  connectionId: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  fn: (accessToken: string) => Promise<T>;
}): Promise<T> {
  const expiresAtMs = args.expiresAt ? Date.parse(args.expiresAt) : null;
  const needsRefresh =
    !!args.refreshToken &&
    expiresAtMs !== null &&
    expiresAtMs - Date.now() < 3 * 86400000; // refresh ~3 days before expiry

  if (!needsRefresh) {
    return args.fn(args.accessToken);
  }

  const env: SquareEnv =
    resolveSquareEnv();
  const CLIENT_ID =
    env === "sandbox"
      ? process.env.SQUARE_SANDBOX_APP_ID
      : process.env.SQUARE_APP_ID;
  const CLIENT_SECRET =
    env === "sandbox"
      ? process.env.SQUARE_SANDBOX_APP_SECRET
      : process.env.SQUARE_APP_SECRET;
  if (!CLIENT_ID || !CLIENT_SECRET) {
    // Misconfigured — fall through with the old token; let the caller
    // see the failure if it does fail.
    return args.fn(args.accessToken);
  }

  const fresh = await refreshSquareAccessToken({
    refreshToken: args.refreshToken!,
    credentials: {
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: "", // not used by refresh
      env,
    },
  });

  await (args.sb as unknown as {
    from: (t: string) => {
      update: (v: object) => {
        eq: (c: string, v: string) => Promise<unknown>;
      };
    };
  })
    .from("scheduler_connections")
    .update({
      access_token: fresh.accessToken,
      refresh_token: fresh.refreshToken,
      token_expires_at: fresh.expiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.connectionId);

  return args.fn(fresh.accessToken);
}

// ─── Zenoti backfill helper (shared with install callback + resync) ──────
//
// API key + center_id path-param tenant routing. Offset (page/size)
// pagination. Page size 100 = Zenoti's max.

const ZENOTI_BACKFILL_DAYS_BACK = 30;
const ZENOTI_BACKFILL_DAYS_FORWARD = 90;

export async function backfillZenotiAppointments(args: {
  sb: SupabaseAdmin;
  userId: string;
  centerId: string;
}): Promise<{ totalAppointments: number; resolvedPatientNames: number }> {
  const { sb, userId, centerId } = args;

  const env: ZenotiEnv = resolveZenotiEnv();
  const stripWs = (v: string | undefined) => v?.replace(/\s+/g, "");
  const API_KEY = stripWs(env === "sandbox" ? process.env.ZENOTI_SANDBOX_API_KEY : process.env.ZENOTI_API_KEY);
  if (!API_KEY) throw new Error("Zenoti API key is not configured on the server.");
  const credentials: ZenotiCredentials = { apiKey: API_KEY, centerId, env };

  const now = new Date();
  const startDate = new Date(now.getTime() - ZENOTI_BACKFILL_DAYS_BACK * 86400000).toISOString().slice(0, 10);
  const endDate = new Date(now.getTime() + ZENOTI_BACKFILL_DAYS_FORWARD * 86400000).toISOString().slice(0, 10);

  const all: ZenotiAppointment[] = [];
  let page: number | null = 1;
  for (let i = 0; i < 50; i++) {
    if (page === null) break;
    const { appointments, nextPage } = await listZenotiAppointments({
      credentials,
      startDate,
      endDate,
      page,
      size: 100,
    });
    all.push(...appointments);
    page = nextPage;
  }

  await (sb as unknown as {
    from: (t: string) => { update: (v: object) => { eq: (c: string, v: string) => { eq: (c: string, v: string) => Promise<unknown> } } };
  })
    .from("appointments")
    .update({ source: "zenoti" })
    .eq("user_id", userId)
    .eq("source", "csv-zenoti");

  const patientIndex = await buildPatientIndex(sb, userId);

  let resolvedPatientNames = 0;
  const rows = all.map((apt) => {
    const patientNodeId = matchPatientFromIndex(
      { patientFirstName: null, patientLastName: null, patientPhone: null, patientEmail: null },
      patientIndex,
    );
    if (patientNodeId) resolvedPatientNames++;
    return zenotiAppointmentToRow(apt, userId, patientNodeId);
  });

  const BATCH = 200;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const { error } = await sb
      .from("appointments")
      .upsert(slice, { onConflict: "user_id,external_id,source" });
    if (error) throw new Error(`Zenoti appointment upsert batch ${i}: ${error.message}`);
  }

  return { totalAppointments: rows.length, resolvedPatientNames };
}

export function zenotiAppointmentToRow(
  apt: ZenotiAppointment,
  userId: string,
  patientNodeId: string | null,
): Database["public"]["Tables"]["appointments"]["Insert"] {
  const scheduledAt = new Date(apt.startTime).toISOString();
  const durationMin = Math.round(
    (new Date(apt.endTime).getTime() - new Date(apt.startTime).getTime()) / 60000,
  );
  const base: Database["public"]["Tables"]["appointments"]["Insert"] = {
    user_id: userId,
    external_id: apt.id,
    source: "zenoti",
    scheduled_at: scheduledAt,
    duration_min: Number.isFinite(durationMin) && durationMin > 0 ? durationMin : 0,
    treatment_type: apt.serviceId,
    provider_name: apt.therapistId,
    status: zenotiStatusToRefillStatus(apt.status),
    notes: apt.notes,
  };
  if (patientNodeId) base.patient_node_id = patientNodeId;
  return base;
}

// ─── Jane backfill helper (shared with install callback + resync) ─────────
//
// Jane is POLLING-ONLY (no webhooks). 5-min token TTL means aggressive
// refresh via withFreshJaneToken. Per-clinic base URL stored in
// connection.platform_account_id (overload — clinic_url is the load-
// bearing tenant identifier, not a UUID).

const JANE_BACKFILL_DAYS_BACK = 30;
const JANE_BACKFILL_DAYS_FORWARD = 90;

export async function backfillJaneAppointments(args: {
  sb: SupabaseAdmin;
  userId: string;
  connectionId: string;
  accessToken: string;
  clinicUrl: string;
}): Promise<{ totalAppointments: number; resolvedPatientNames: number }> {
  const { sb, userId, clinicUrl } = args;

  const now = new Date();
  const startDate = new Date(now.getTime() - JANE_BACKFILL_DAYS_BACK * 86400000).toISOString().slice(0, 10);
  const endDate = new Date(now.getTime() + JANE_BACKFILL_DAYS_FORWARD * 86400000).toISOString().slice(0, 10);

  const all: JaneAppointment[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 50; page++) {
    const { appointments, nextCursor } = await listJaneAppointments({
      accessToken: args.accessToken,
      clinicUrl,
      startDate,
      endDate,
      pageSize: 200,
      cursor: cursor ?? undefined,
    });
    all.push(...appointments);
    if (!nextCursor) break;
    cursor = nextCursor;
  }

  await (sb as unknown as {
    from: (t: string) => { update: (v: object) => { eq: (c: string, v: string) => { eq: (c: string, v: string) => Promise<unknown> } } };
  })
    .from("appointments")
    .update({ source: "jane" })
    .eq("user_id", userId)
    .eq("source", "csv-jane");

  const patientIndex = await buildPatientIndex(sb, userId);

  let resolvedPatientNames = 0;
  const rows = all.map((apt) => {
    const patientNodeId = matchPatientFromIndex(
      { patientFirstName: null, patientLastName: null, patientPhone: null, patientEmail: null },
      patientIndex,
    );
    if (patientNodeId) resolvedPatientNames++;
    return janeAppointmentToRow(apt, userId, patientNodeId);
  });

  const BATCH = 200;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const { error } = await sb
      .from("appointments")
      .upsert(slice, { onConflict: "user_id,external_id,source" });
    if (error) throw new Error(`Jane appointment upsert batch ${i}: ${error.message}`);
  }

  return { totalAppointments: rows.length, resolvedPatientNames };
}

export function janeAppointmentToRow(
  apt: JaneAppointment,
  userId: string,
  patientNodeId: string | null,
): Database["public"]["Tables"]["appointments"]["Insert"] {
  const scheduledAt = new Date(apt.startAt).toISOString();
  const durationMin = Math.round(
    (new Date(apt.endAt).getTime() - new Date(apt.startAt).getTime()) / 60000,
  );
  const base: Database["public"]["Tables"]["appointments"]["Insert"] = {
    user_id: userId,
    external_id: apt.id,
    source: "jane",
    scheduled_at: scheduledAt,
    duration_min: Number.isFinite(durationMin) && durationMin > 0 ? durationMin : 0,
    treatment_type: apt.treatmentId,
    provider_name: apt.staffMemberId,
    status: janeStatusToRefillStatus(apt.status),
    notes: apt.notes,
  };
  if (patientNodeId) base.patient_node_id = patientNodeId;
  return base;
}

// Jane uses 5-min token TTL — refresh much earlier than Square's 3-day
// or MB's 5-min window. Helper refreshes ~30s before expiry.
export async function withFreshJaneToken<T>(args: {
  sb: SupabaseAdmin;
  connectionId: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  fn: (accessToken: string) => Promise<T>;
}): Promise<T> {
  const expiresAtMs = args.expiresAt ? Date.parse(args.expiresAt) : null;
  const needsRefresh =
    !!args.refreshToken &&
    expiresAtMs !== null &&
    expiresAtMs - Date.now() < 30 * 1000;

  if (!needsRefresh) return args.fn(args.accessToken);

  const env: JaneEnv = resolveJaneEnv();
  const stripWs = (v: string | undefined) => v?.replace(/\s+/g, "");
  const CLIENT_ID = stripWs(env === "sandbox" ? process.env.JANE_SANDBOX_CLIENT_ID : process.env.JANE_CLIENT_ID);
  const CLIENT_SECRET = stripWs(env === "sandbox" ? process.env.JANE_SANDBOX_CLIENT_SECRET : process.env.JANE_CLIENT_SECRET);
  const IAM_BASE_URL = stripWs(env === "sandbox" ? process.env.JANE_SANDBOX_IAM_BASE_URL : process.env.JANE_IAM_BASE_URL);
  if (!CLIENT_ID || !CLIENT_SECRET || !IAM_BASE_URL) {
    return args.fn(args.accessToken);
  }

  const fresh = await refreshJaneAccessToken({
    refreshToken: args.refreshToken!,
    credentials: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, iamBaseUrl: IAM_BASE_URL, redirectUri: "", env },
  });

  await (args.sb as unknown as {
    from: (t: string) => { update: (v: object) => { eq: (c: string, v: string) => Promise<unknown> } };
  })
    .from("scheduler_connections")
    .update({
      access_token: fresh.accessToken,
      refresh_token: fresh.refreshToken || args.refreshToken,
      token_expires_at: fresh.expiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.connectionId);

  return args.fn(fresh.accessToken);
}

// ─── Booker backfill helper (shared with install callback + resync) ───────
//
// Booker uses server-to-server OAuth: mint access_token per call (1hr TTL),
// scope by LocationId in path/params. PageNumber-based pagination.

const BOOKER_BACKFILL_DAYS_BACK = 30;
const BOOKER_BACKFILL_DAYS_FORWARD = 90;

export async function backfillBookerAppointments(args: {
  sb: SupabaseAdmin;
  userId: string;
  locationId: string;
}): Promise<{ totalAppointments: number; resolvedPatientNames: number }> {
  const { sb, userId } = args;

  const env: BookerEnv = resolveBookerEnv();
  const stripWs = (v: string | undefined) => v?.replace(/\s+/g, "");
  const CLIENT_ID = stripWs(env === "sandbox" ? process.env.BOOKER_SANDBOX_CLIENT_ID : process.env.BOOKER_CLIENT_ID);
  const CLIENT_SECRET = stripWs(env === "sandbox" ? process.env.BOOKER_SANDBOX_CLIENT_SECRET : process.env.BOOKER_CLIENT_SECRET);
  const SUBSCRIPTION_KEY = stripWs(env === "sandbox" ? process.env.BOOKER_SANDBOX_SUBSCRIPTION_KEY : process.env.BOOKER_SUBSCRIPTION_KEY);
  if (!CLIENT_ID || !CLIENT_SECRET || !SUBSCRIPTION_KEY) {
    throw new Error("Booker app credentials are not configured on the server.");
  }
  const credentials: BookerCredentials = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, subscriptionKey: SUBSCRIPTION_KEY, env };
  const tok = await getBookerAccessToken({ credentials });

  const now = new Date();
  const startDate = new Date(now.getTime() - BOOKER_BACKFILL_DAYS_BACK * 86400000).toISOString().slice(0, 10);
  const endDate = new Date(now.getTime() + BOOKER_BACKFILL_DAYS_FORWARD * 86400000).toISOString().slice(0, 10);

  const all: BookerAppointment[] = [];
  let page: number | null = 1;
  for (let i = 0; i < 50; i++) {
    if (page === null) break;
    const { appointments, nextPage } = await listBookerAppointments({
      accessToken: tok.accessToken,
      credentials,
      startDate,
      endDate,
      pageSize: 200,
      pageNumber: page,
    });
    all.push(...appointments);
    page = nextPage;
  }

  await (sb as unknown as {
    from: (t: string) => { update: (v: object) => { eq: (c: string, v: string) => { eq: (c: string, v: string) => Promise<unknown> } } };
  })
    .from("appointments")
    .update({ source: "booker" })
    .eq("user_id", userId)
    .eq("source", "csv-booker");

  const patientIndex = await buildPatientIndex(sb, userId);

  let resolvedPatientNames = 0;
  const rows = all.map((apt) => {
    const patientNodeId = matchPatientFromIndex(
      { patientFirstName: null, patientLastName: null, patientPhone: null, patientEmail: null },
      patientIndex,
    );
    if (patientNodeId) resolvedPatientNames++;
    return bookerAppointmentToRow(apt, userId, patientNodeId);
  });

  const BATCH = 200;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const { error } = await sb
      .from("appointments")
      .upsert(slice, { onConflict: "user_id,external_id,source" });
    if (error) throw new Error(`Booker appointment upsert batch ${i}: ${error.message}`);
  }

  // Suppress unused-warning for the helper that will be used by webhook receivers
  void bookerStatusToRefillStatus;
  return { totalAppointments: rows.length, resolvedPatientNames };
}

export function bookerAppointmentToRow(
  apt: BookerAppointment,
  userId: string,
  patientNodeId: string | null,
): Database["public"]["Tables"]["appointments"]["Insert"] {
  const scheduledAt = new Date(apt.startDateTime).toISOString();
  const durationMin = Math.round(
    (new Date(apt.endDateTime).getTime() - new Date(apt.startDateTime).getTime()) / 60000,
  );
  const base: Database["public"]["Tables"]["appointments"]["Insert"] = {
    user_id: userId,
    external_id: apt.id,
    source: "booker",
    scheduled_at: scheduledAt,
    duration_min: Number.isFinite(durationMin) && durationMin > 0 ? durationMin : 0,
    treatment_type: apt.treatmentId,
    provider_name: apt.employeeId,
    status: bookerStatusToRefillStatus(apt.status),
    notes: apt.notes,
  };
  if (patientNodeId) base.patient_node_id = patientNodeId;
  return base;
}

// ─── Vagaro backfill helper (shared with install callback + resync) ───────
//
// Vagaro auth is per-spa API key (no OAuth tokens to refresh). Otherwise
// same shape as backfillSquareBookings — pages until consumed >= total,
// idempotent upsert, 50-page hard cap.

const VAGARO_BACKFILL_DAYS_BACK = 30;
const VAGARO_BACKFILL_DAYS_FORWARD = 90;

export async function backfillVagaroAppointments(args: {
  sb: SupabaseAdmin;
  userId: string;
  apiKey: string;
}): Promise<{ totalAppointments: number; resolvedPatientNames: number }> {
  const { sb, userId, apiKey } = args;

  const now = new Date();
  const startDate = new Date(now.getTime() - VAGARO_BACKFILL_DAYS_BACK * 86400000)
    .toISOString()
    .slice(0, 10);
  const endDate = new Date(now.getTime() + VAGARO_BACKFILL_DAYS_FORWARD * 86400000)
    .toISOString()
    .slice(0, 10);

  const all: VagaroAppointment[] = [];
  let offset: number | null = 0;
  for (let page = 0; page < 50; page++) {
    if (offset === null) break;
    const { appointments, nextOffset } = await listVagaroAppointments({
      credentials: { apiKey, merchantId: "" },
      startDate,
      endDate,
      limit: 200,
      offset,
    });
    all.push(...appointments);
    offset = nextOffset;
  }

  await (sb as unknown as {
    from: (t: string) => {
      update: (v: object) => {
        eq: (c: string, v: string) => {
          eq: (c: string, v: string) => Promise<unknown>;
        };
      };
    };
  })
    .from("appointments")
    .update({ source: "vagaro" })
    .eq("user_id", userId)
    .eq("source", "csv-vagaro");

  const patientIndex = await buildPatientIndex(sb, userId);

  let resolvedPatientNames = 0;
  const rows = all.map((apt) => {
    const patientNodeId = matchPatientFromIndex(
      {
        patientFirstName: null,
        patientLastName: null,
        patientPhone: null,
        patientEmail: null,
      },
      patientIndex,
    );
    if (patientNodeId) resolvedPatientNames++;
    return vagaroAppointmentToRow(apt, userId, patientNodeId);
  });

  const BATCH = 200;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const { error } = await sb
      .from("appointments")
      .upsert(slice, { onConflict: "user_id,external_id,source" });
    if (error) {
      throw new Error(`Vagaro appointment upsert batch ${i}: ${error.message}`);
    }
  }

  return { totalAppointments: rows.length, resolvedPatientNames };
}

export function vagaroAppointmentToRow(
  apt: VagaroAppointment,
  userId: string,
  patientNodeId: string | null,
): Database["public"]["Tables"]["appointments"]["Insert"] {
  const scheduledAt = new Date(apt.startDateTime).toISOString();
  const durationMin = Math.round(
    (new Date(apt.endDateTime).getTime() - new Date(apt.startDateTime).getTime()) / 60000,
  );
  const base: Database["public"]["Tables"]["appointments"]["Insert"] = {
    user_id: userId,
    external_id: apt.id,
    source: "vagaro",
    scheduled_at: scheduledAt,
    duration_min: Number.isFinite(durationMin) && durationMin > 0 ? durationMin : 0,
    treatment_type: apt.serviceId,
    provider_name: apt.staffId,
    status: vagaroStatusToRefillStatus(apt.status),
    notes: apt.notes,
  };
  if (patientNodeId) base.patient_node_id = patientNodeId;
  return base;
}

// ─── Boulevard backfill helper (shared with install callback + resync) ─────
//
// Mirror of backfillSquareBookings / backfillAcuityAppointments. Reads the
// spa's appointment window (30d-back + 90d-forward) through Boulevard's
// GraphQL connector and upserts idempotently on (user_id, external_id,
// source). The connector handles pagination via GraphQL cursor (vs Square's
// REST cursor) so the loop shape stays the same.
//
// Boulevard auth is app-level: API_KEY + API_SECRET come from env vars,
// businessId URN scopes each call. No per-spa token refresh.

const BLVD_BACKFILL_DAYS_BACK = 30;
const BLVD_BACKFILL_DAYS_FORWARD = 90;

export async function backfillBoulevardAppointments(args: {
  sb: SupabaseAdmin;
  userId: string;
  businessId: string; // URN: urn:blvd:Business:abc
}): Promise<{ totalAppointments: number; resolvedPatientNames: number }> {
  const { sb, userId, businessId } = args;

  const env: BoulevardEnv = resolveBoulevardEnv();
  const stripWs = (v: string | undefined) => v?.replace(/\s+/g, "");
  const APPLICATION_ID = stripWs(
    env === "sandbox"
      ? process.env.BLVD_SANDBOX_APPLICATION_ID
      : process.env.BLVD_APPLICATION_ID,
  );
  const API_KEY = stripWs(
    env === "sandbox"
      ? process.env.BLVD_SANDBOX_API_KEY
      : process.env.BLVD_API_KEY,
  );
  const API_SECRET = stripWs(
    env === "sandbox"
      ? process.env.BLVD_SANDBOX_API_SECRET
      : process.env.BLVD_API_SECRET,
  );
  if (!APPLICATION_ID || !API_KEY || !API_SECRET) {
    throw new Error(
      "Boulevard app credentials are not configured on the server (BLVD_APPLICATION_ID + BLVD_API_KEY + BLVD_API_SECRET).",
    );
  }

  const {
    listBoulevardAppointments,
    boulevardStatusToRefillStatus,
  } = await import("@/lib/schedulers/boulevard");
  type BlvdAppointment = Awaited<
    ReturnType<typeof listBoulevardAppointments>
  >["appointments"][number];

  const now = new Date();
  const windowStart = new Date(
    now.getTime() - BLVD_BACKFILL_DAYS_BACK * 86400000,
  );
  const windowEnd = new Date(
    now.getTime() + BLVD_BACKFILL_DAYS_FORWARD * 86400000,
  );

  const credentials = {
    applicationId: APPLICATION_ID,
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    env,
  };

  // Pull pages until the cursor stops returning hasNextPage. 50-page
  // hard cap mirrors backfillSquareBookings — defense against
  // pathological cursor loops at the provider layer.
  const all: BlvdAppointment[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 50; page++) {
    const { appointments, cursor: next } = await listBoulevardAppointments({
      credentials,
      businessId,
      startAtMin: windowStart.toISOString(),
      startAtMax: windowEnd.toISOString(),
      limit: 200,
      cursor: cursor ?? undefined,
    });
    all.push(...appointments);
    if (!next) break;
    cursor = next;
  }

  // Pre-migrate any leftover csv-boulevard-sourced rows so the upsert
  // dedupes correctly on (user_id, external_id, source). Same pattern
  // backfillAcuityAppointments + backfillSquareBookings use.
  await (sb as unknown as {
    from: (t: string) => {
      update: (v: object) => {
        eq: (c: string, v: string) => {
          eq: (c: string, v: string) => Promise<unknown>;
        };
      };
    };
  })
    .from("appointments")
    .update({ source: "boulevard" })
    .eq("user_id", userId)
    .eq("source", "csv-boulevard");

  const patientIndex = await buildPatientIndex(sb, userId);

  // Boulevard appointments carry clientId (URN) but not the client's
  // name on the appointment response — we'd need a separate query OR
  // we accept rows landing with patient_node_id null and rely on
  // CLIENT_CREATED webhook events to enrich. Mirrors Square pattern.
  let resolvedPatientNames = 0;
  const rows = all.map((apt) => {
    const patientNodeId = matchPatientFromIndex(
      {
        patientFirstName: null,
        patientLastName: null,
        patientPhone: null,
        patientEmail: null,
      },
      patientIndex,
    );
    if (patientNodeId) resolvedPatientNames++;
    return boulevardAppointmentToRow(apt, userId, patientNodeId, boulevardStatusToRefillStatus);
  });

  const BATCH = 200;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const { error } = await sb
      .from("appointments")
      .upsert(slice, { onConflict: "user_id,external_id,source" });
    if (error) {
      throw new Error(
        `Boulevard appointment upsert batch ${i}: ${error.message}`,
      );
    }
  }

  return {
    totalAppointments: rows.length,
    resolvedPatientNames,
  };
}

type BoulevardAppointmentShape = {
  id: string;
  status: string;
  startAt: string;
  endAt: string;
  locationId: string | null;
  clientId: string | null;
  staffId: string | null;
  serviceIds: string[];
  notes: string | null;
};

export function boulevardAppointmentToRow(
  apt: BoulevardAppointmentShape,
  userId: string,
  patientNodeId: string | null,
  statusMap: (s: string) => "scheduled" | "cancelled" | "no_show" | "showed",
): Database["public"]["Tables"]["appointments"]["Insert"] {
  const scheduledAt = new Date(apt.startAt).toISOString();
  const durationMin = Math.round(
    (new Date(apt.endAt).getTime() - new Date(apt.startAt).getTime()) / 60000,
  );
  const base: Database["public"]["Tables"]["appointments"]["Insert"] = {
    user_id: userId,
    external_id: apt.id,
    source: "boulevard",
    scheduled_at: scheduledAt,
    duration_min: Number.isFinite(durationMin) && durationMin > 0 ? durationMin : 0,
    treatment_type: apt.serviceIds[0] ?? null,
    provider_name: apt.staffId ?? null,
    status: statusMap(apt.status),
    notes: apt.notes,
  };
  if (patientNodeId) base.patient_node_id = patientNodeId;
  return base;
}

// ─── Mindbody backfill helper (shared with OAuth callback + resync) ────────
//
// Mirror of backfillSquareBookings / backfillBoulevardAppointments. Reads
// the spa's appointment window (30d-back + 90d-forward) through Mindbody's
// REST connector and upserts idempotently on (user_id, external_id, source).
// Token refresh handled via withFreshMindbodyToken so a token mid-expiry
// during a long backfill doesn't fail the whole batch.

const MB_BACKFILL_DAYS_BACK = 30;
const MB_BACKFILL_DAYS_FORWARD = 90;

export async function backfillMindbodyAppointments(args: {
  sb: SupabaseAdmin;
  userId: string;
  connectionId: string;
  accessToken: string;
  siteId: string;
}): Promise<{ totalAppointments: number; resolvedPatientNames: number }> {
  const { sb, userId, accessToken, siteId } = args;
  const env: MindbodyEnv = resolveMindbodyEnv();
  const stripWs = (v: string | undefined) => v?.replace(/\s+/g, "");
  const API_KEY = stripWs(
    env === "sandbox"
      ? process.env.MINDBODY_SANDBOX_API_KEY
      : process.env.MINDBODY_API_KEY,
  );
  if (!API_KEY) {
    throw new Error("Mindbody API key is not configured on the server.");
  }

  const now = new Date();
  const startDate = new Date(now.getTime() - MB_BACKFILL_DAYS_BACK * 86400000)
    .toISOString()
    .slice(0, 10);
  const endDate = new Date(
    now.getTime() + MB_BACKFILL_DAYS_FORWARD * 86400000,
  )
    .toISOString()
    .slice(0, 10);

  // v1.42.3 — Mindbody's /appointment/staffappointments endpoint
  // requires StaffIds scoping (confirmed via sandbox smoke 2026-06-03;
  // v1.37.0 omitted StaffIds and got back empty Appointments[] silently).
  // Pre-fetch the spa's staff roster, then iterate appointment list
  // per staff. 20-page hard cap on staff pagination; 50-page hard cap
  // on appointment pagination per staff.
  const allStaff: Array<{ id: string; name: string | null }> = [];
  let staffOffset: number | null = 0;
  for (let page = 0; page < 20; page++) {
    if (staffOffset === null) break;
    const { staff, nextOffset } = await listMindbodyStaff({
      accessToken,
      apiKey: API_KEY,
      siteId,
      env,
      limit: 200,
      offset: staffOffset,
    });
    allStaff.push(...staff);
    staffOffset = nextOffset;
  }
  const staffIdsAll = allStaff.map((s) => s.id).filter((id) => id !== "");

  // Per-staff appointment pagination. Batch up to 20 staff IDs per call
  // to reduce round-trips (Mindbody accepts repeated StaffIds params).
  const all: MindbodyAppointment[] = [];
  const STAFF_BATCH = 20;
  for (let i = 0; i < staffIdsAll.length; i += STAFF_BATCH) {
    const staffBatch = staffIdsAll.slice(i, i + STAFF_BATCH);
    let offset: number | null = 0;
    for (let page = 0; page < 50; page++) {
      if (offset === null) break;
      const { appointments, nextOffset } = await listMindbodyAppointments({
        accessToken,
        apiKey: API_KEY,
        siteId,
        env,
        startDate,
        endDate,
        staffIds: staffBatch,
        limit: 200,
        offset,
      });
      all.push(...appointments);
      offset = nextOffset;
    }
  }

  // Pre-migrate any leftover csv-mindbody-sourced rows so upsert dedupes
  // correctly on (user_id, external_id, source).
  await (sb as unknown as {
    from: (t: string) => {
      update: (v: object) => {
        eq: (c: string, v: string) => {
          eq: (c: string, v: string) => Promise<unknown>;
        };
      };
    };
  })
    .from("appointments")
    .update({ source: "mindbody" })
    .eq("user_id", userId)
    .eq("source", "csv-mindbody");

  const patientIndex = await buildPatientIndex(sb, userId);

  // Mindbody appointments carry ClientId but not the client's name on
  // the appointment response — mirrors Square + Boulevard pattern.
  // Rely on client.created webhooks + initial roster pull (separate
  // ship) to populate patient_node_id; for the appointment backfill
  // accept rows landing with null patient_node_id.
  let resolvedPatientNames = 0;
  const rows = all.map((apt) => {
    const patientNodeId = matchPatientFromIndex(
      {
        patientFirstName: null,
        patientLastName: null,
        patientPhone: null,
        patientEmail: null,
      },
      patientIndex,
    );
    if (patientNodeId) resolvedPatientNames++;
    return mindbodyAppointmentToRow(apt, userId, patientNodeId);
  });

  const BATCH = 200;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const { error } = await sb
      .from("appointments")
      .upsert(slice, { onConflict: "user_id,external_id,source" });
    if (error) {
      throw new Error(
        `Mindbody appointment upsert batch ${i}: ${error.message}`,
      );
    }
  }

  return {
    totalAppointments: rows.length,
    resolvedPatientNames,
  };
}

export function mindbodyAppointmentToRow(
  apt: MindbodyAppointment,
  userId: string,
  patientNodeId: string | null,
): Database["public"]["Tables"]["appointments"]["Insert"] {
  const scheduledAt = new Date(apt.startDateTime).toISOString();
  const durationMin = Math.round(
    (new Date(apt.endDateTime).getTime() -
      new Date(apt.startDateTime).getTime()) /
      60000,
  );
  const base: Database["public"]["Tables"]["appointments"]["Insert"] = {
    user_id: userId,
    external_id: apt.id,
    source: "mindbody",
    scheduled_at: scheduledAt,
    duration_min:
      Number.isFinite(durationMin) && durationMin > 0 ? durationMin : 0,
    treatment_type: apt.sessionTypeId,
    provider_name: apt.staffId,
    status: mindbodyStatusToRefillStatus(apt.status),
    notes: apt.notes,
  };
  if (patientNodeId) base.patient_node_id = patientNodeId;
  return base;
}

// ─── Mindbody token refresh helper (used by webhook + writeback paths) ─────
//
// Mindbody access tokens last ~1 hour; refresh_token (requires offline_access
// scope) reissues a fresh pair. Centralized so the webhook receiver, the
// rescue writeback, and the resync path all use the same just-in-time
// refresh. Mirrors withFreshSquareToken in shape.

export async function withFreshMindbodyToken<T>(args: {
  sb: SupabaseAdmin;
  connectionId: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  fn: (accessToken: string) => Promise<T>;
}): Promise<T> {
  const expiresAtMs = args.expiresAt ? Date.parse(args.expiresAt) : null;
  const needsRefresh =
    !!args.refreshToken &&
    expiresAtMs !== null &&
    expiresAtMs - Date.now() < 5 * 60 * 1000; // refresh ~5 min before expiry

  if (!needsRefresh) {
    return args.fn(args.accessToken);
  }

  const env: MindbodyEnv = resolveMindbodyEnv();
  const stripWs = (v: string | undefined) => v?.replace(/\s+/g, "");
  const CLIENT_ID = stripWs(
    env === "sandbox"
      ? process.env.MINDBODY_SANDBOX_OAUTH_CLIENT_ID
      : process.env.MINDBODY_OAUTH_CLIENT_ID,
  );
  const CLIENT_SECRET = stripWs(
    env === "sandbox"
      ? process.env.MINDBODY_SANDBOX_OAUTH_CLIENT_SECRET
      : process.env.MINDBODY_OAUTH_CLIENT_SECRET,
  );
  const API_KEY = stripWs(
    env === "sandbox"
      ? process.env.MINDBODY_SANDBOX_API_KEY
      : process.env.MINDBODY_API_KEY,
  );
  if (!CLIENT_ID || !CLIENT_SECRET || !API_KEY) {
    // Misconfigured — fall through with old token; caller sees failure.
    return args.fn(args.accessToken);
  }

  const fresh = await refreshMindbodyAccessToken({
    refreshToken: args.refreshToken!,
    credentials: {
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      apiKey: API_KEY,
      redirectUri: "",
      env,
    },
  });

  await (args.sb as unknown as {
    from: (t: string) => {
      update: (v: object) => {
        eq: (c: string, v: string) => Promise<unknown>;
      };
    };
  })
    .from("scheduler_connections")
    .update({
      access_token: fresh.accessToken,
      refresh_token: fresh.refreshToken || args.refreshToken,
      token_expires_at: fresh.expiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.connectionId);

  return args.fn(fresh.accessToken);
}

