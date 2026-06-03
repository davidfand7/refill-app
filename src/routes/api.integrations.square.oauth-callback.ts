/**
 * Square OAuth callback — /api/integrations/square/oauth-callback (v1.35.0).
 *
 * Mirror of api.integrations.acuity.oauth-callback.ts. Diverges where
 * Square diverges from Acuity:
 *
 *   - Auth-code expiry is 5 minutes (we exchange immediately, no
 *     deferred work between receiving `code` and POSTing /token).
 *   - Tokens are 30 days + refresh_token (vs Acuity's effectively-
 *     permanent tokens). The token_expires_at column gets a real value.
 *   - Webhook subscription is a single POST to /v2/webhooks/subscriptions
 *     with a global notification URL (no per-spa secret in URL path).
 *     The subscription returns a signature_key that lives on the row
 *     in webhook_secret + a subscription_id that lives in the new
 *     webhook_subscription_id column.
 *   - Tier-gate probe: free-tier sellers can OAuth + receive read
 *     webhooks but CreateBooking 403s. We probe once on callback and
 *     surface the gate on the settings page; sync still runs.
 *
 * Required env: SQUARE_APP_ID + SQUARE_APP_SECRET (or sandbox pair) +
 * SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + (optional) SQUARE_ENV.
 */

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import {
  exchangeSquareCodeForToken,
  createSquareWebhookSubscription,
  getSquareMerchant,
  probeSquareBookingsTier,
  resolveSquareEnv,
  type SquareEnv,
} from "@/lib/schedulers/square";
import {
  decodeOAuthState,
  backfillSquareBookings,
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

export const Route = createFileRoute("/api/integrations/square/oauth-callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const code = url.searchParams.get("code");
        const stateRaw = url.searchParams.get("state");
        const oauthErr = url.searchParams.get("error");

        let errReturnPath = "/app/refill/settings/scheduler";
        const errReturn = (reason: string) =>
          buildCallbackRedirect(url.origin, errReturnPath, {
            scheduler_error: reason,
          });

        if (oauthErr) return errReturn(`square:${oauthErr}`);
        if (!code || !stateRaw) return errReturn("missing_params");

        const state = decodeOAuthState(stateRaw);
        if (!state || state.platform !== "square") {
          return errReturn("invalid_state");
        }
        if (state.returnTo) errReturnPath = state.returnTo;

        const env: SquareEnv = resolveSquareEnv();
        // v1.35.4: defensive whitespace strip on credentials. CF dashboard's
        // secret input field wraps long values visually and can leak embedded
        // newlines/tabs/spaces into the stored value. Square credentials are
        // alphanumeric + hyphens — no legitimate whitespace possible — so
        // stripping all whitespace is safe and defends against multi-line
        // copy/paste artifacts in addition to leading/trailing whitespace.
        const stripWs = (v: string | undefined) => v?.replace(/\s+/g, "");
        const CLIENT_ID = stripWs(
          env === "sandbox"
            ? process.env.SQUARE_SANDBOX_APP_ID
            : process.env.SQUARE_APP_ID,
        );
        const CLIENT_SECRET = stripWs(
          env === "sandbox"
            ? process.env.SQUARE_SANDBOX_APP_SECRET
            : process.env.SQUARE_APP_SECRET,
        );
        console.log(
          `[square/oauth-callback] SQUARE_ENV raw="${process.env.SQUARE_ENV}" resolved="${env}" client_id_len=${CLIENT_ID?.length ?? 0} client_secret_len=${CLIENT_SECRET?.length ?? 0}`,
        );
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!CLIENT_ID || !CLIENT_SECRET || !SUPABASE_URL || !SERVICE_KEY) {
          return errReturn("server_config");
        }

        const redirectUri = `${url.origin}/api/integrations/square/oauth-callback`;
        const notificationUrl = `${url.origin}/api/webhooks/scheduler/square`;

        // ── Step 1: exchange code (5-min TTL — do it now)
        let tokenResp;
        try {
          tokenResp = await exchangeSquareCodeForToken({
            code,
            credentials: {
              clientId: CLIENT_ID,
              clientSecret: CLIENT_SECRET,
              redirectUri,
              env,
            },
          });
        } catch (e) {
          // v1.35.4: bubble Square's actual error detail into the redirect
          // URL so it's visible in the browser Network panel without needing
          // a wrangler tail. Sanitize to URL-safe chars.
          const msg = e instanceof Error ? e.message : String(e);
          console.error("[square/callback] token exchange failed:", msg);
          const safeMsg = msg
            .slice(0, 180)
            .replace(/[^a-zA-Z0-9_\-:.()]/g, "_");
          return errReturn(`token_exchange__${safeMsg}`);
        }

        // ── Step 2: identify the merchant (business name + currency, mostly)
        let merchant;
        try {
          merchant = await getSquareMerchant(
            tokenResp.accessToken,
            env,
            tokenResp.merchantId,
          );
        } catch (e) {
          console.error("[square/callback] merchant fetch failed", e);
          return errReturn("merchant_fetch");
        }

        const sb = createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
          auth: { persistSession: false, autoRefreshToken: false },
        });

        // ── Step 3: upsert connection row (pending while we wire webhooks)
        const sbAny = sb as unknown as {
          from: (t: string) => {
            select: (cols: string) => {
              eq: (c: string, v: string) => {
                eq: (c: string, v: string) => {
                  maybeSingle: () => Promise<{
                    data: { id: string } | null;
                  }>;
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

        const existing = await sbAny
          .from("emma_scheduler_connections")
          .select("id")
          .eq("user_id", state.userId)
          .eq("platform", "square")
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
              platform_account_id: tokenResp.merchantId,
              platform_account_email: merchant.businessName,
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
              platform: "square",
              access_token: tokenResp.accessToken,
              refresh_token: tokenResp.refreshToken,
              token_expires_at: tokenResp.expiresAt,
              oauth_scope: tokenResp.scope.join(" "),
              platform_account_id: tokenResp.merchantId,
              platform_account_email: merchant.businessName,
              status: "pending",
            })
            .select("id")
            .single();
          if (ins.error || !ins.data) {
            console.error("[square/callback] insert failed", ins.error);
            return errReturn("connection_save");
          }
          connectionId = ins.data.id;
        }

        // ── Step 4: register the webhook subscription
        let subscription;
        try {
          subscription = await createSquareWebhookSubscription({
            accessToken: tokenResp.accessToken,
            env,
            notificationUrl,
            name: "Refill booking events",
          });
        } catch (e) {
          console.error("[square/callback] webhook subscribe failed", e);
          await sbAny
            .from("emma_scheduler_connections")
            .update({
              status: "error",
              last_error: `Webhook subscription failed: ${e instanceof Error ? e.message : "unknown"}`,
            })
            .eq("id", connectionId);
          return errReturn("webhook_setup");
        }

        // Persist subscription_id + signature_key on the connection row.
        // Square's HMAC verification needs both the signature_key (HMAC
        // key) and the registered notification URL (part of HMAC input),
        // so the receiver reads webhook_secret = signature_key on every
        // delivery.
        await sbAny
          .from("emma_scheduler_connections")
          .update({
            webhook_subscription_id: subscription.id,
            webhook_secret: subscription.signatureKey,
          })
          .eq("id", connectionId);

        // ── Step 5: tier probe (non-fatal — UI surfaces the gate)
        let tier: "writeable" | "read_only" | "unknown" = "unknown";
        try {
          tier = await probeSquareBookingsTier({
            accessToken: tokenResp.accessToken,
            env,
          });
        } catch {
          tier = "unknown";
        }

        // ── Step 6: backfill bookings
        try {
          await backfillSquareBookings({
            sb,
            userId: state.userId,
            accessToken: tokenResp.accessToken,
          });
        } catch (e) {
          console.error("[square/callback] backfill failed", e);
          await sbAny
            .from("emma_scheduler_connections")
            .update({
              status: "error",
              last_error: `Backfill failed: ${e instanceof Error ? e.message : "unknown"}`,
            })
            .eq("id", connectionId);
          return errReturn("backfill");
        }

        // ── Step 7: mark connected (tier baked into last_error as a
        //          non-fatal banner the settings page can render)
        await sbAny
          .from("emma_scheduler_connections")
          .update({
            status: "connected",
            connected_at: new Date().toISOString(),
            last_sync_at: new Date().toISOString(),
            last_error:
              tier === "read_only"
                ? "tier_gate: Square Appointments Free tier detected. Sync + Rescue work; claim writeback will fail until you upgrade to Appointments Plus or Premium."
                : null,
          })
          .eq("id", connectionId);

        // ── Step 8: bounce home
        return buildCallbackRedirect(url.origin, state.returnTo, {
          scheduler_connected: "square",
        });
      },
    },
  },
});
