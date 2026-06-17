/**
 * Acuity OAuth callback — /api/integrations/acuity/oauth-callback (v381).
 *
 * Acuity redirects here after the spa owner authorizes the Refill app
 * in their Acuity account. We:
 *
 *   1. Exchange the auth code for an access_token
 *   2. Fetch /me to learn the Acuity account id + email
 *   3. Mint a per-spa webhook_secret + upsert the connection row
 *   4. Register the four lifecycle webhooks on the spa's Acuity account
 *   5. Backfill: pull last 30d historical + next 90d future appointments,
 *      upsert into appointments. Pre-migrate any existing
 *      'csv-acuity' rows to 'acuity' so the upsert dedupes correctly.
 *   6. Stamp connected_at + status='connected' on the connection row
 *   7. Redirect back to /app/refill/settings/scheduler with a success flag
 *
 * Failure modes redirect back to the settings page with an error code so
 * the UI can display "Connection failed — try again."
 *
 * Required server env:
 *   ACUITY_CLIENT_ID, ACUITY_CLIENT_SECRET — from the OAuth app we
 *     registered on Acuity's developer portal (one-time setup)
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — admin client for upserts
 */

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import {
  exchangeAcuityCodeForToken,
  getAcuityMe,
  ensureAcuityWebhooks,
} from "@/lib/schedulers/acuity";
import {
  decodeOAuthState,
  backfillAcuityAppointments,
} from "@/server/emma-scheduler.functions";

/**
 * v415.2 — URL-aware merge for callback redirects.
 *
 * BUG (latent until v415.2): the prior `${url.origin}${returnTo}?scheduler_connected=acuity`
 * append clobbered any existing query string on returnTo. e.g. returnTo
 * `/onboard?step=3` yielded `/onboard?step=3?scheduler_connected=acuity`
 * — two `?` chars, malformed. The Settings-page callsite happened to use
 * a path with no query (`/app/refill/settings/scheduler`) so the bug went
 * undetected until the /onboard wizard's Step 2 needed to carry `?step=3`
 * across the OAuth round-trip in v415.2.
 *
 * This helper parses returnTo as a URL, merges params correctly, and
 * re-serializes. Hash fragments on returnTo (rare) are preserved.
 */
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

export const Route = createFileRoute("/api/integrations/acuity/oauth-callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const code = url.searchParams.get("code");
        const stateRaw = url.searchParams.get("state");
        const oauthErr = url.searchParams.get("error");

        // v415.2: errReturn is a `let` so we can re-target it once the
        // OAuth state has been decoded (so a Step 2 wizard user gets
        // errors at /onboard?step=2&scheduler_error=..., not at the
        // Settings page they never visited). Default before-decode is
        // the Settings page since that's the closest sensible fallback
        // for an undecoded-state error.
        let errReturnPath = "/app/refill/settings/scheduler";
        const errReturn = (reason: string) =>
          buildCallbackRedirect(url.origin, errReturnPath, {
            scheduler_error: reason,
          });

        if (oauthErr) return errReturn(`acuity:${oauthErr}`);
        if (!code || !stateRaw) return errReturn("missing_params");

        const state = decodeOAuthState(stateRaw);
        if (!state || state.platform !== "acuity") {
          return errReturn("invalid_state");
        }
        // v415.2: state decoded successfully — re-target errors back to
        // wherever the user initiated from (e.g. /onboard?step=2).
        if (state.returnTo) {
          errReturnPath = state.returnTo;
        }

        const CLIENT_ID = process.env.ACUITY_CLIENT_ID;
        const CLIENT_SECRET = process.env.ACUITY_CLIENT_SECRET;
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!CLIENT_ID || !CLIENT_SECRET || !SUPABASE_URL || !SERVICE_KEY) {
          return errReturn("server_config");
        }

        const redirectUri = `${url.origin}/api/integrations/acuity/oauth-callback`;

        // ── Step 1: exchange code for token
        let tokenResp;
        try {
          tokenResp = await exchangeAcuityCodeForToken({
            code,
            credentials: {
              clientId: CLIENT_ID,
              clientSecret: CLIENT_SECRET,
              redirectUri,
            },
          });
        } catch (e) {
          console.error("[acuity/callback] token exchange failed", e);
          return errReturn("token_exchange");
        }

        // ── Step 2: identify the Acuity account
        let me;
        try {
          me = await getAcuityMe(tokenResp.accessToken);
        } catch (e) {
          console.error("[acuity/callback] /me failed", e);
          return errReturn("me_failed");
        }

        const sb = createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
          auth: { persistSession: false, autoRefreshToken: false },
        });

        // ── Step 3: upsert connection row (status=pending while we set up)
        const sbAny = sb as unknown as {
          from: (t: string) => {
            select: (cols: string) => {
              eq: (c: string, v: string) => {
                eq: (c: string, v: string) => {
                  maybeSingle: () => Promise<{ data: { id: string; webhook_secret: string } | null }>;
                };
              };
            };
            insert: (v: object) => {
              select: (cols: string) => {
                single: () => Promise<{ data: { id: string; webhook_secret: string } | null; error: { message: string } | null }>;
              };
            };
            update: (v: object) => {
              eq: (c: string, v: string) => Promise<{ error: { message: string } | null }>;
            };
            upsert: (v: object, opts?: object) => Promise<{ error: { message: string } | null }>;
          };
        };

        const existing = await sbAny
          .from("scheduler_connections")
          .select("id, webhook_secret")
          .eq("user_id", state.userId)
          .eq("platform", "acuity")
          .maybeSingle();

        let connectionId: string;
        let webhookSecret: string;

        if (existing.data) {
          connectionId = existing.data.id;
          webhookSecret = existing.data.webhook_secret;
          await sbAny
            .from("scheduler_connections")
            .update({
              status: "pending",
              access_token: tokenResp.accessToken,
              refresh_token: tokenResp.refreshToken,
              token_expires_at: tokenResp.expiresAt,
              oauth_scope: tokenResp.scope,
              platform_account_id: me.userId ? String(me.userId) : null,
              platform_account_email: me.email || null,
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
              platform: "acuity",
              access_token: tokenResp.accessToken,
              refresh_token: tokenResp.refreshToken,
              token_expires_at: tokenResp.expiresAt,
              oauth_scope: tokenResp.scope,
              platform_account_id: me.userId ? String(me.userId) : null,
              platform_account_email: me.email || null,
              status: "pending",
            })
            .select("id, webhook_secret")
            .single();
          if (ins.error || !ins.data) {
            console.error("[acuity/callback] insert failed", ins.error);
            return errReturn("connection_save");
          }
          connectionId = ins.data.id;
          webhookSecret = ins.data.webhook_secret;
        }

        // ── Step 4: register webhooks
        const webhookBaseUrl = `${url.origin}/api/webhooks/scheduler/acuity/${webhookSecret}`;
        try {
          await ensureAcuityWebhooks({
            accessToken: tokenResp.accessToken,
            webhookBaseUrl,
          });
        } catch (e) {
          console.error("[acuity/callback] webhook registration failed", e);
          await sbAny
            .from("scheduler_connections")
            .update({
              status: "error",
              last_error: `Webhook registration failed: ${e instanceof Error ? e.message : "unknown"}`,
            })
            .eq("id", connectionId);
          return errReturn("webhook_setup");
        }

        // ── Step 5: backfill
        try {
          await backfillAcuityAppointments({
            sb,
            userId: state.userId,
            accessToken: tokenResp.accessToken,
          });
        } catch (e) {
          console.error("[acuity/callback] backfill failed", e);
          await sbAny
            .from("scheduler_connections")
            .update({
              status: "error",
              last_error: `Backfill failed: ${e instanceof Error ? e.message : "unknown"}`,
            })
            .eq("id", connectionId);
          return errReturn("backfill");
        }

        // ── Step 6: mark connected
        await sbAny
          .from("scheduler_connections")
          .update({
            status: "connected",
            connected_at: new Date().toISOString(),
            last_sync_at: new Date().toISOString(),
          })
          .eq("id", connectionId);

        // ── Step 7: bounce home
        // v415.2: URL-aware merge preserves any existing query string on
        // returnTo (e.g. /onboard?step=3 keeps the step param instead of
        // being clobbered to /onboard?scheduler_connected=acuity).
        return buildCallbackRedirect(url.origin, state.returnTo, {
          scheduler_connected: "acuity",
        });
      },
    },
  },
});

// Backfill + acuityAppointmentToRow live in src/server/emma-scheduler.functions.ts
// since v381.6 so resyncSchedulerConnection can share them. Don't restore
// them here.
