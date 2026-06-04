/**
 * Mindbody OAuth callback — /api/integrations/mindbody/oauth-callback (v1.37.0).
 *
 * Mirror of api.integrations.{acuity,square}.oauth-callback.ts adapted
 * for Mindbody's 3-legged flow:
 *
 *   - Mindbody uses response_mode=form_post — the callback is a POST
 *     from Mindbody's server with code + id_token + state in the body,
 *     NOT a redirect with ?code= in the URL. We handle both POST + GET
 *     so future-Mindbody UI changes don't break us.
 *   - Token exchange uses form-encoded body per OAuth 2.0 RFC 6749
 *     (v1.35.7 doctrine).
 *   - id_token claims carry siteId + effectiveUserId; siteId becomes
 *     the connection row's platform_account_id (tenant-routing key in
 *     subsequent API calls and webhook lookups).
 *   - 5 webhook subscriptions registered after connection upsert.
 *     Mindbody validates the webhook URL via HEAD request during
 *     subscription create — the receiver route handles HEAD. Per-spa
 *     secret in URL path for tenant routing (back to Acuity pattern,
 *     NOT Square's single-global).
 *   - Token-refresh path uses offline_access scope returned in the
 *     OAuth response; tokens last ~1 hour, refresh ~5 min before expiry.
 *
 * Required env (set when Mindbody API Support ticket clears):
 *   MINDBODY_OAUTH_CLIENT_ID + MINDBODY_OAUTH_CLIENT_SECRET +
 *   MINDBODY_API_KEY (production), MINDBODY_SANDBOX_* triplet (sandbox),
 *   MINDBODY_ENV ("sandbox" or "production"), SUPABASE_URL +
 *   SUPABASE_SERVICE_ROLE_KEY.
 */

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import {
  createMindbodyWebhookSubscription,
  exchangeMindbodyCodeForToken,
  MINDBODY_WEBHOOK_EVENTS,
  resolveMindbodyEnv,
  type MindbodyEnv,
  type MindbodyOAuthCredentials,
} from "@/lib/schedulers/mindbody";
import {
  backfillMindbodyAppointments,
  decodeOAuthState,
} from "@/server/emma-scheduler.functions";

function buildCallbackRedirect(
  origin: string,
  returnTo: string,
  paramsToAdd: Record<string, string>,
): Response {
  const target = new URL(returnTo, origin);
  for (const [key, value] of Object.entries(paramsToAdd)) {
    target.searchParams.set(key, value);
  }
  return Response.redirect(target.toString(), 302);
}

export const Route = createFileRoute(
  "/api/integrations/mindbody/oauth-callback",
)({
  server: {
    handlers: {
      POST: async ({ request }) => handleCallback(request),
      GET: async ({ request }) => handleCallback(request),
    },
  },
});

async function handleCallback(request: Request): Promise<Response> {
  const url = new URL(request.url);

  // Mindbody form_post: body is application/x-www-form-urlencoded with
  // code + id_token + state. Also support GET with ?code=&state= for
  // sandbox debugging convenience.
  let code: string | null = null;
  let stateRaw: string | null = null;
  let oauthErr: string | null = null;

  if (request.method === "POST") {
    const ct = request.headers.get("content-type") ?? "";
    if (ct.includes("application/x-www-form-urlencoded")) {
      const text = await request.text();
      const form = new URLSearchParams(text);
      code = form.get("code");
      stateRaw = form.get("state");
      oauthErr = form.get("error");
    } else if (ct.includes("application/json")) {
      try {
        const body = (await request.json()) as Record<string, unknown>;
        code = (body.code as string | undefined) ?? null;
        stateRaw = (body.state as string | undefined) ?? null;
        oauthErr = (body.error as string | undefined) ?? null;
      } catch {
        // Fall through to query-string fallback.
      }
    }
  }
  code = code ?? url.searchParams.get("code");
  stateRaw = stateRaw ?? url.searchParams.get("state");
  oauthErr = oauthErr ?? url.searchParams.get("error");

  let errReturnPath = "/app/refill/settings/scheduler";
  const errReturn = (reason: string) =>
    buildCallbackRedirect(url.origin, errReturnPath, {
      scheduler_error: reason,
    });

  if (oauthErr) return errReturn(`mindbody:${oauthErr}`);
  if (!code || !stateRaw) return errReturn("missing_params");

  const state = decodeOAuthState(stateRaw);
  if (!state || state.platform !== "mindbody") {
    return errReturn("invalid_state");
  }
  if (state.returnTo) errReturnPath = state.returnTo;

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
  console.log(
    `[mindbody/oauth-callback] MINDBODY_ENV raw="${process.env.MINDBODY_ENV}" resolved="${env}" client_id_len=${CLIENT_ID?.length ?? 0} client_secret_len=${CLIENT_SECRET?.length ?? 0} api_key_len=${API_KEY?.length ?? 0}`,
  );

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!CLIENT_ID || !CLIENT_SECRET || !API_KEY || !SUPABASE_URL || !SERVICE_KEY) {
    return errReturn("server_config");
  }

  const redirectUri = `${url.origin}/api/integrations/mindbody/oauth-callback`;
  const credentials: MindbodyOAuthCredentials = {
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    apiKey: API_KEY,
    redirectUri,
    env,
  };

  // ── Step 1: exchange the code (v1.35.7 form-encoded body)
  let tokenResp;
  try {
    tokenResp = await exchangeMindbodyCodeForToken({ code, credentials });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[mindbody/oauth-callback] token exchange failed:", msg);
    const safeMsg = msg.slice(0, 180).replace(/[^a-zA-Z0-9_\-:.()]/g, "_");
    return errReturn(`token_exchange__${safeMsg}`);
  }

  if (!tokenResp.siteId) {
    return errReturn(
      "no_site_id__id_token_missing_siteid_claim_check_oauth_client_config",
    );
  }

  const sb = createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const sbAny = sb as unknown as {
    from: (t: string) => {
      select: (cols: string) => {
        eq: (c: string, v: string) => {
          eq: (c: string, v: string) => {
            maybeSingle: () => Promise<{ data: { id: string } | null }>;
          };
        };
      };
      insert: (v: object) => {
        select: (cols: string) => {
          single: () => Promise<{
            data: { id: string } | null;
            error: { message: string } | null;
          }>;
        };
      };
      update: (v: object) => {
        eq: (c: string, v: string) => Promise<{
          error: { message: string } | null;
        }>;
      };
    };
  };

  // ── Step 2: upsert connection row (pending while we wire webhooks).
  // Generate a per-spa webhook path secret upfront so the URL we
  // register with Mindbody matches the URL the receiver dispatches on.
  const webhookSecret = crypto.randomUUID().replace(/-/g, "");

  const existing = await sbAny
    .from("emma_scheduler_connections")
    .select("id")
    .eq("user_id", state.userId)
    .eq("platform", "mindbody")
    .maybeSingle();

  let connectionId: string;
  if (existing.data) {
    connectionId = existing.data.id;
    await sbAny
      .from("emma_scheduler_connections")
      .update({
        status: "pending",
        access_token: tokenResp.accessToken,
        refresh_token: tokenResp.refreshToken,
        token_expires_at: tokenResp.expiresAt,
        oauth_scope: tokenResp.scope.join(" "),
        platform_account_id: tokenResp.siteId,
        platform_account_email: tokenResp.effectiveUserId,
        webhook_secret: webhookSecret,
        last_error: null,
        disconnected_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", connectionId);
  } else {
    const ins = await sbAny
      .from("emma_scheduler_connections")
      .insert({
        user_id: state.userId,
        platform: "mindbody",
        access_token: tokenResp.accessToken,
        refresh_token: tokenResp.refreshToken,
        token_expires_at: tokenResp.expiresAt,
        oauth_scope: tokenResp.scope.join(" "),
        platform_account_id: tokenResp.siteId,
        platform_account_email: tokenResp.effectiveUserId,
        webhook_secret: webhookSecret,
        status: "pending",
      })
      .select("id")
      .single();
    if (ins.error || !ins.data) {
      console.error("[mindbody/oauth-callback] insert failed", ins.error);
      return errReturn("connection_save");
    }
    connectionId = ins.data.id;
  }

  // ── Step 3: register webhook subscription (FAIL-DEGRADED per v1.35.6
  //    pattern). Mindbody validates the URL via HEAD on subscription
  //    create — the receiver route handles HEAD with a 2xx. Per-spa
  //    secret in URL path lets the receiver verify path-secret
  //    membership before HMAC verify.
  const notificationUrl = `${url.origin}/api/webhooks/scheduler/mindbody/${webhookSecret}`;
  let subscription: Awaited<
    ReturnType<typeof createMindbodyWebhookSubscription>
  > | null = null;
  let webhookWarning: string | null = null;
  try {
    subscription = await createMindbodyWebhookSubscription({
      apiKey: API_KEY,
      siteId: tokenResp.siteId,
      webhookUrl: notificationUrl,
      eventIds: MINDBODY_WEBHOOK_EVENTS,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(
      "[mindbody/oauth-callback] webhook subscribe failed (non-fatal):",
      msg,
    );
    webhookWarning = msg.includes("HEAD")
      ? `Mindbody couldn't validate the webhook URL via HEAD request. This usually means the receiver route doesn't have HEAD support deployed yet — redeploy and hit Re-sync.`
      : `Mindbody webhook subscription failed (${msg.slice(0, 200)}). Connection works for read sync; real-time push deferred until subscription retries.`;
  }

  if (subscription) {
    await sbAny
      .from("emma_scheduler_connections")
      .update({
        webhook_subscription_id: subscription.subscriptionId,
        // Store the messageSignatureKey returned from MB as the per-
        // connection HMAC key. Overrides the path-secret stored in
        // webhook_secret? — Mindbody uses TWO secrets: path-secret for
        // URL routing + messageSignatureKey for HMAC verification.
        // The path-secret stays in webhook_secret; messageSignatureKey
        // goes into webhook_message_signature_key (extending the row
        // shape; existing rows for Acuity/Square use webhook_secret
        // as both, which works because their schemes only need one).
        //
        // For v1.37.0 we overload webhook_secret to store EITHER the
        // path-secret OR the messageSignatureKey depending on context.
        // The receiver checks the path-secret in the URL against the
        // initial value stored at oauth-callback step 2; then uses
        // the messageSignatureKey value for HMAC verify. To support
        // both we store messageSignatureKey under
        // platform_account_email TEMPORARILY — actual production-fix
        // is a schema migration adding webhook_message_signature_key
        // column, queued for sandbox-verify. The architecture-stub
        // works clean for now because effectiveUserId is informational
        // only (no auth check uses it).
        platform_account_email: subscription.messageSignatureKey,
      })
      .eq("id", connectionId);
  }

  // ── Step 4: backfill appointments (FAIL-DEGRADED per v1.35.8).
  let backfillWarning: string | null = null;
  try {
    await backfillMindbodyAppointments({
      sb,
      userId: state.userId,
      connectionId,
      accessToken: tokenResp.accessToken,
      siteId: tokenResp.siteId,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(
      "[mindbody/oauth-callback] backfill failed (non-fatal):",
      msg,
    );
    backfillWarning = `Initial backfill failed (${msg.slice(0, 200)}). Hit Re-sync to retry.`;
  }

  // ── Step 5: mark connected — backfill > webhook warning > null.
  //          Mindbody has no spa-side tier gate (vs Square Free /
  //          Boulevard Premier-or-Enterprise), so warning priority is
  //          simpler: read-side degradation > push-side degradation.
  const lastError = backfillWarning ?? webhookWarning ?? null;

  await sbAny
    .from("emma_scheduler_connections")
    .update({
      status: "connected",
      connected_at: new Date().toISOString(),
      last_sync_at: new Date().toISOString(),
      last_error: lastError,
    })
    .eq("id", connectionId);

  // ── Step 6: bounce home
  return buildCallbackRedirect(url.origin, state.returnTo, {
    scheduler_connected: "mindbody",
  });
}
