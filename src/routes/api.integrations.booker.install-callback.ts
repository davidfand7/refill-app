/**
 * Booker install callback (v1.39.0).
 *
 * Server-to-server OAuth client_credentials flow + paste-Location-ID
 * tenant identification. POST receives location_id + state from the
 * wizard form; we mint an app-level access_token, validate the location
 * exists, register webhook, backfill.
 */

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import {
  BOOKER_WEBHOOK_EVENTS,
  createBookerWebhookSubscription,
  getBookerAccessToken,
  getBookerBusiness,
  resolveBookerEnv,
  type BookerCredentials,
  type BookerEnv,
} from "@/lib/schedulers/booker";
import {
  backfillBookerAppointments,
  decodeOAuthState,
} from "@/server/emma-scheduler.functions";

function buildCallbackRedirect(origin: string, returnTo: string, paramsToAdd: Record<string, string>): Response {
  const target = new URL(returnTo, origin);
  for (const [key, value] of Object.entries(paramsToAdd)) target.searchParams.set(key, value);
  return Response.redirect(target.toString(), 302);
}

function jsonResp(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export const Route = createFileRoute("/api/integrations/booker/install-callback")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const url = new URL(request.url);
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!SUPABASE_URL || !SERVICE_KEY) return jsonResp(500, { error: "Server not configured" });

        const ct = request.headers.get("content-type") ?? "";
        let locationId: string | null = null;
        let stateRaw: string | null = null;
        if (ct.includes("application/x-www-form-urlencoded")) {
          const form = new URLSearchParams(await request.text());
          locationId = form.get("location_id");
          stateRaw = form.get("state");
        } else if (ct.includes("application/json")) {
          try {
            const body = (await request.json()) as Record<string, unknown>;
            locationId = (body.location_id as string | undefined) ?? null;
            stateRaw = (body.state as string | undefined) ?? null;
          } catch { /* fall through */ }
        }

        let errReturnPath = "/app/refill/settings/scheduler";
        const errReturn = (reason: string) => buildCallbackRedirect(url.origin, errReturnPath, { scheduler_error: reason });
        if (!locationId || !stateRaw) return errReturn("missing_params");

        const state = decodeOAuthState(stateRaw);
        if (!state || state.platform !== "booker") return errReturn("invalid_state");
        if (state.returnTo) errReturnPath = state.returnTo;

        const env: BookerEnv = resolveBookerEnv();
        const stripWs = (v: string | undefined) => v?.replace(/\s+/g, "");
        const CLIENT_ID = stripWs(env === "sandbox" ? process.env.BOOKER_SANDBOX_CLIENT_ID : process.env.BOOKER_CLIENT_ID);
        const CLIENT_SECRET = stripWs(env === "sandbox" ? process.env.BOOKER_SANDBOX_CLIENT_SECRET : process.env.BOOKER_CLIENT_SECRET);
        const SUBSCRIPTION_KEY = stripWs(env === "sandbox" ? process.env.BOOKER_SANDBOX_SUBSCRIPTION_KEY : process.env.BOOKER_SUBSCRIPTION_KEY);
        console.log(
          `[booker/install-callback] BOOKER_ENV raw="${process.env.BOOKER_ENV}" resolved="${env}" client_id_len=${CLIENT_ID?.length ?? 0} client_secret_len=${CLIENT_SECRET?.length ?? 0} sub_key_len=${SUBSCRIPTION_KEY?.length ?? 0} locationId=${locationId}`,
        );
        if (!CLIENT_ID || !CLIENT_SECRET || !SUBSCRIPTION_KEY) return errReturn("server_config");

        const credentials: BookerCredentials = {
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
          subscriptionKey: SUBSCRIPTION_KEY,
          env,
        };

        // Mint access token + validate location
        let tok;
        let business;
        try {
          tok = await getBookerAccessToken({ credentials });
          business = await getBookerBusiness({ accessToken: tok.accessToken, credentials });
          if (business.id !== locationId) {
            // Booker's /location endpoint returned a different ID than the spa pasted —
            // could mean credentials are scoped to a different location.
            return errReturn(`location_mismatch__app_creds_scoped_to_${business.id}`);
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const safeMsg = msg.slice(0, 180).replace(/[^a-zA-Z0-9_\-:.()]/g, "_");
          return errReturn(`booker_validate__${safeMsg}`);
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
                single: () => Promise<{ data: { id: string } | null; error: { message: string } | null }>;
              };
            };
            update: (v: object) => { eq: (c: string, v: string) => Promise<{ error: { message: string } | null }> };
          };
        };

        const webhookSecret = crypto.randomUUID().replace(/-/g, "");

        const existing = await sbAny
          .from("emma_scheduler_connections")
          .select("id")
          .eq("user_id", state.userId)
          .eq("platform", "booker")
          .maybeSingle();

        let connectionId: string;
        const baseFields = {
          status: "pending" as const,
          access_token: null,
          refresh_token: null,
          token_expires_at: null,
          oauth_scope: null,
          platform_account_id: locationId,
          platform_account_email: business.name ?? business.email,
          webhook_secret: webhookSecret,
        };

        if (existing.data) {
          connectionId = existing.data.id;
          await sbAny.from("emma_scheduler_connections").update({
            ...baseFields,
            last_error: null,
            disconnected_at: null,
            updated_at: new Date().toISOString(),
          }).eq("id", connectionId);
        } else {
          const ins = await sbAny
            .from("emma_scheduler_connections")
            .insert({ user_id: state.userId, platform: "booker", ...baseFields })
            .select("id")
            .single();
          if (ins.error || !ins.data) {
            console.error("[booker/install-callback] insert failed", ins.error);
            return errReturn("connection_save");
          }
          connectionId = ins.data.id;
        }

        // Webhook subscription FAIL-DEGRADED
        const notificationUrl = `${url.origin}/api/webhooks/scheduler/booker/${webhookSecret}`;
        let webhookWarning: string | null = null;
        try {
          const sub = await createBookerWebhookSubscription({
            accessToken: tok.accessToken,
            credentials,
            webhookUrl: notificationUrl,
            events: BOOKER_WEBHOOK_EVENTS,
          });
          await sbAny.from("emma_scheduler_connections").update({
            webhook_subscription_id: sub.subscriptionId,
            platform_account_email: sub.signingSecret, // overload for HMAC key storage
          }).eq("id", connectionId);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.warn("[booker/install-callback] webhook subscribe failed (non-fatal):", msg);
          webhookWarning = `Booker webhook subscription failed (${msg.slice(0, 200)}). Connection works for read sync; real-time push deferred.`;
        }

        // Backfill FAIL-DEGRADED
        let backfillWarning: string | null = null;
        try {
          await backfillBookerAppointments({ sb, userId: state.userId, locationId });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.warn("[booker/install-callback] backfill failed (non-fatal):", msg);
          backfillWarning = `Initial backfill failed (${msg.slice(0, 200)}). Hit Re-sync to retry.`;
        }

        await sbAny.from("emma_scheduler_connections").update({
          status: "connected",
          connected_at: new Date().toISOString(),
          last_sync_at: new Date().toISOString(),
          last_error: backfillWarning ?? webhookWarning ?? null,
        }).eq("id", connectionId);

        return buildCallbackRedirect(url.origin, state.returnTo, { scheduler_connected: "booker" });
      },
    },
  },
});
