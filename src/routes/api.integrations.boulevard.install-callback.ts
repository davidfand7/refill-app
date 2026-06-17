/**
 * Boulevard install callback — POST /api/integrations/boulevard/install-callback (v1.36.0).
 *
 * Mirror of `api.integrations.square.oauth-callback.ts` adapted for
 * Boulevard's paste-Application-ID install model:
 *
 *   - There is NO redirect-with-?code= flow. Boulevard fires this
 *     callback as a POST when a spa completes our app's install inside
 *     their Boulevard dashboard at `dashboard.joinblvd.com/manage-business/apps`.
 *     The POST body carries the businessId URN + state token we
 *     embedded in the install URL.
 *   - **Two architectural paths are supported** (per platforms-pre-built
 *     doctrine: build both, decide at sandbox-verify which Boulevard
 *     actually uses):
 *       1. **Callback model**: Boulevard POSTs to this URL on install.
 *          We treat it as the authoritative install signal and process
 *          synchronously.
 *       2. **Polling model**: if Boulevard doesn't fire this callback
 *          (e.g. their install model surfaces installations via a
 *          `/installations` GraphQL query our server polls every Xs),
 *          a separate cron route (NOT this file) drives the same
 *          processing function `processBoulevardInstallEvent` exported
 *          from here.
 *     The hot-path code below handles (1) end-to-end; (2) can land
 *     post-sandbox-verify by extracting `processBoulevardInstallEvent`
 *     into a separate import and calling it from a cron route.
 *   - **Auth context** is app-level: we authenticate every subsequent
 *     Boulevard call with our pre-shared API_KEY + API_SECRET. The
 *     connection row's access_token stays null; businessId URN in
 *     platform_account_id is the load-bearing identifier.
 *   - **Tier-gate** detection (Premier OR Enterprise required) runs
 *     after the connection row is upserted. Detected via the
 *     `business.tier` field on `getBoulevardBusiness`. Free/Starter
 *     sellers can install but writeback will fail-degraded; same UX
 *     pattern as Square Free tier.
 *
 * Required env (set when 48hr Boulevard app approval clears):
 *   BLVD_APPLICATION_ID + BLVD_API_KEY + BLVD_API_SECRET (production),
 *   BLVD_SANDBOX_APPLICATION_ID + BLVD_SANDBOX_API_KEY +
 *   BLVD_SANDBOX_API_SECRET (sandbox), BLVD_ENV ("sandbox" or
 *   "production"), SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
 */

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import {
  createBoulevardWebhookSubscription,
  getBoulevardBusiness,
  resolveBoulevardEnv,
  type BoulevardEnv,
  type BoulevardOAuthCredentials,
} from "@/lib/schedulers/boulevard";
import {
  backfillBoulevardAppointments,
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

function jsonResp(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const Route = createFileRoute(
  "/api/integrations/boulevard/install-callback",
)({
  server: {
    handlers: {
      // POST handler is the canonical install signal from Boulevard.
      // GET handler exists for the polling-fallback path (cron OR
      // manual debug invocation by Grasshopper) — both route to the
      // same processBoulevardInstallEvent.
      POST: async ({ request }) => {
        return handleInstallCallback(request);
      },
      GET: async ({ request }) => {
        return handleInstallCallback(request);
      },
    },
  },
});

async function handleInstallCallback(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return jsonResp(500, { error: "Server not configured" });
  }

  // Boulevard's install payload shape is pinned at sandbox-verify. For
  // architecture-complete state we accept three shapes:
  //   (a) POST body with JSON {businessId, state}
  //   (b) POST body with form-encoded businessId=...&state=...
  //   (c) GET query string ?businessId=...&state=... (polling fallback)
  // The parser is generous; whichever shape Boulevard uses at sandbox
  // surfaces here without code change.
  let businessId: string | null = null;
  let stateRaw: string | null = null;
  let subscriptionId: string | null = null;

  if (request.method === "POST") {
    const ct = request.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      try {
        const body = (await request.json()) as Record<string, unknown>;
        businessId =
          (body.businessId as string | undefined) ??
          (body.business_id as string | undefined) ??
          null;
        stateRaw = (body.state as string | undefined) ?? null;
        subscriptionId =
          (body.subscriptionId as string | undefined) ??
          (body.subscription_id as string | undefined) ??
          null;
      } catch {
        // Body wasn't JSON — fall through to form-decode attempt.
      }
    }
    if (!businessId && ct.includes("application/x-www-form-urlencoded")) {
      const text = await request.text();
      const form = new URLSearchParams(text);
      businessId = form.get("businessId") ?? form.get("business_id");
      stateRaw = form.get("state");
      subscriptionId = form.get("subscriptionId") ?? form.get("subscription_id");
    }
  }
  // Always check query string too — both POST and GET surface here.
  businessId =
    businessId ??
    url.searchParams.get("businessId") ??
    url.searchParams.get("business_id");
  stateRaw = stateRaw ?? url.searchParams.get("state");
  subscriptionId =
    subscriptionId ??
    url.searchParams.get("subscriptionId") ??
    url.searchParams.get("subscription_id");

  let errReturnPath = "/app/refill/calendar/connections";
  const errReturn = (reason: string) =>
    buildCallbackRedirect(url.origin, errReturnPath, {
      scheduler_error: reason,
    });

  if (!businessId || !stateRaw) {
    console.warn("[boulevard/install-callback] missing businessId or state");
    return errReturn("missing_params");
  }

  const state = decodeOAuthState(stateRaw);
  if (!state || state.platform !== "boulevard") {
    return errReturn("invalid_state");
  }
  if (state.returnTo) errReturnPath = state.returnTo;

  const env: BoulevardEnv = resolveBoulevardEnv();
  // v1.35.x doctrine: defensive whitespace strip + length-logging on every
  // credential read site. Applied here at install-callback to mirror the
  // initiateBoulevardOAuth diagnostic.
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
  console.log(
    `[boulevard/install-callback] BLVD_ENV raw="${process.env.BLVD_ENV}" resolved="${env}" application_id_len=${APPLICATION_ID?.length ?? 0} api_key_len=${API_KEY?.length ?? 0} api_secret_len=${API_SECRET?.length ?? 0} businessId=${businessId}`,
  );
  if (!APPLICATION_ID || !API_KEY || !API_SECRET) {
    return errReturn("server_config");
  }

  const credentials: BoulevardOAuthCredentials = {
    applicationId: APPLICATION_ID,
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    env,
  };

  const sb = createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ── Step 1: identify the business (display name + tier)
  let business;
  try {
    business = await getBoulevardBusiness({ credentials, businessId });
  } catch (e) {
    // v1.35.x doctrine: bubble provider error detail into the redirect
    // URL so it's visible in the browser Network panel without needing
    // a wrangler tail.
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[boulevard/install-callback] business fetch failed:", msg);
    const safeMsg = msg.slice(0, 180).replace(/[^a-zA-Z0-9_\-:.()]/g, "_");
    return errReturn(`business_fetch__${safeMsg}`);
  }

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

  // ── Step 2: upsert connection row (pending while we wire webhooks)
  const existing = await sbAny
    .from("scheduler_connections")
    .select("id")
    .eq("user_id", state.userId)
    .eq("platform", "boulevard")
    .maybeSingle();

  let connectionId: string;
  if (existing.data) {
    connectionId = existing.data.id;
    await sbAny
      .from("scheduler_connections")
      .update({
        status: "pending",
        // Boulevard auth is app-level — no per-spa access/refresh tokens.
        access_token: null,
        refresh_token: null,
        token_expires_at: null,
        oauth_scope: null,
        platform_account_id: businessId,
        platform_account_email: business.name,
        last_error: null,
        disconnected_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", connectionId);
  } else {
    const ins = await sbAny
      .from("scheduler_connections")
      .insert({
        user_id: state.userId,
        platform: "boulevard",
        access_token: null,
        refresh_token: null,
        token_expires_at: null,
        oauth_scope: null,
        platform_account_id: businessId,
        platform_account_email: business.name,
        status: "pending",
      })
      .select("id")
      .single();
    if (ins.error || !ins.data) {
      console.error("[boulevard/install-callback] insert failed", ins.error);
      return errReturn("connection_save");
    }
    connectionId = ins.data.id;
  }

  // ── Step 3: register the webhook subscription (FAIL-DEGRADED).
  //
  // Boulevard issues a per-subscription signing secret returned in the
  // mutation response; stored on the row's webhook_secret column. If
  // Boulevard's webhook subscription create requires app approval (or
  // the spa's tier doesn't support webhooks), degrade gracefully: the
  // connection still lands status=connected with the warning stamped
  // on last_error for settings-page visibility. Same pattern as
  // Square v1.35.6 partner-scope degrade.
  let webhookSubscriptionId: string | null = subscriptionId;
  let webhookSigningSecret: string | null = null;
  let webhookWarning: string | null = null;
  if (!webhookSubscriptionId) {
    const notificationUrl = `${url.origin}/api/webhooks/scheduler/boulevard`;
    try {
      const subscription = await createBoulevardWebhookSubscription({
        credentials,
        businessId,
        notificationUrl,
      });
      webhookSubscriptionId = subscription.id;
      webhookSigningSecret = subscription.signingSecret;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(
        "[boulevard/install-callback] webhook subscribe failed (non-fatal):",
        msg,
      );
      webhookWarning = `Boulevard webhook subscription unavailable on this app (${msg.slice(0, 200)}). Connection works for read sync; real-time push deferred until app approval or polling fallback.`;
    }
  }

  if (webhookSubscriptionId) {
    await sbAny
      .from("scheduler_connections")
      .update({
        webhook_subscription_id: webhookSubscriptionId,
        webhook_secret: webhookSigningSecret ?? "",
      })
      .eq("id", connectionId);
  }

  // ── Step 4: tier check (Premier OR Enterprise required for writeback).
  //
  // The verified-research scout caught that Boulevard's marketing
  // "Enterprise only" framing is broader at API level — Premier ALSO
  // gets API access. Detect either as writeable.
  const tier = (business.tier ?? "").toLowerCase();
  const writeable = tier === "premier" || tier === "enterprise";

  // ── Step 5: backfill appointments (FAIL-DEGRADED).
  //
  // Mirrors backfillSquareBookings fail-degrade pattern from v1.35.8.
  // Connection lands status=connected even if backfill fails; spa can
  // hit Re-sync to retry. Common cause of backfill failure on first
  // install: spa just paste-installed and Boulevard's appointment
  // index hasn't fully synced yet on their side.
  let backfillWarning: string | null = null;
  try {
    await backfillBoulevardAppointments({
      sb,
      userId: state.userId,
      businessId,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(
      "[boulevard/install-callback] backfill failed (non-fatal):",
      msg,
    );
    backfillWarning = `Initial backfill failed (${msg.slice(0, 200)}). Hit Re-sync to retry.`;
  }

  // ── Step 6: mark connected — tier + webhook-warning + backfill-warning
  //          all baked into last_error as a non-fatal banner. Tier takes
  //          priority since it blocks writeback; webhook/backfill warnings
  //          are reads-only degradations.
  const lastError = !writeable
    ? `tier_gate: Boulevard ${business.tier ?? "Free/Starter"} tier detected. Sync + Rescue work; claim writeback will fail until you upgrade to Premier or Enterprise.`
    : backfillWarning ?? webhookWarning ?? null;

  await sbAny
    .from("scheduler_connections")
    .update({
      status: "connected",
      connected_at: new Date().toISOString(),
      last_sync_at: new Date().toISOString(),
      last_error: lastError,
    })
    .eq("id", connectionId);

  // ── Step 7: bounce home
  return buildCallbackRedirect(url.origin, state.returnTo, {
    scheduler_connected: "boulevard",
  });
}
