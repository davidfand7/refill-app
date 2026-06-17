/**
 * Zenoti install callback (v1.41.0). Server-side API key + per-center
 * tenant routing. POST receives center_id + state from wizard.
 */

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import {
  ZENOTI_WEBHOOK_EVENTS,
  createZenotiWebhookSubscription,
  getZenotiCenter,
  resolveZenotiEnv,
  type ZenotiCredentials,
  type ZenotiEnv,
} from "@/lib/schedulers/zenoti";
import {
  backfillZenotiAppointments,
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

export const Route = createFileRoute("/api/integrations/zenoti/install-callback")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const url = new URL(request.url);
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!SUPABASE_URL || !SERVICE_KEY) return jsonResp(500, { error: "Server not configured" });

        let centerId: string | null = null;
        let stateRaw: string | null = null;
        const ct = request.headers.get("content-type") ?? "";
        if (ct.includes("application/x-www-form-urlencoded")) {
          const form = new URLSearchParams(await request.text());
          centerId = form.get("center_id");
          stateRaw = form.get("state");
        }

        let errReturnPath = "/app/refill/calendar/connections";
        const errReturn = (reason: string) => buildCallbackRedirect(url.origin, errReturnPath, { scheduler_error: reason });
        if (!centerId || !stateRaw) return errReturn("missing_params");

        const state = decodeOAuthState(stateRaw);
        if (!state || state.platform !== "zenoti") return errReturn("invalid_state");
        if (state.returnTo) errReturnPath = state.returnTo;

        const env: ZenotiEnv = resolveZenotiEnv();
        const stripWs = (v: string | undefined) => v?.replace(/\s+/g, "");
        const API_KEY = stripWs(env === "sandbox" ? process.env.ZENOTI_SANDBOX_API_KEY : process.env.ZENOTI_API_KEY);
        console.log(
          `[zenoti/install-callback] ZENOTI_ENV raw="${process.env.ZENOTI_ENV}" resolved="${env}" api_key_len=${API_KEY?.length ?? 0} centerId=${centerId}`,
        );
        if (!API_KEY) return errReturn("server_config");

        const credentials: ZenotiCredentials = { apiKey: API_KEY, centerId, env };

        let center;
        try {
          center = await getZenotiCenter({ credentials });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const safeMsg = msg.slice(0, 180).replace(/[^a-zA-Z0-9_\-:.()]/g, "_");
          return errReturn(`zenoti_validate__${safeMsg}`);
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
        const existing = await sbAny.from("scheduler_connections").select("id").eq("user_id", state.userId).eq("platform", "zenoti").maybeSingle();

        let connectionId: string;
        const baseFields = {
          status: "pending" as const,
          access_token: null,
          refresh_token: null,
          token_expires_at: null,
          oauth_scope: null,
          platform_account_id: centerId,
          platform_account_email: center.name ?? center.email,
          webhook_secret: webhookSecret,
        };

        if (existing.data) {
          connectionId = existing.data.id;
          await sbAny.from("scheduler_connections").update({
            ...baseFields,
            last_error: null,
            disconnected_at: null,
            updated_at: new Date().toISOString(),
          }).eq("id", connectionId);
        } else {
          const ins = await sbAny.from("scheduler_connections")
            .insert({ user_id: state.userId, platform: "zenoti", ...baseFields })
            .select("id").single();
          if (ins.error || !ins.data) return errReturn("connection_save");
          connectionId = ins.data.id;
        }

        const notificationUrl = `${url.origin}/api/webhooks/scheduler/zenoti/${webhookSecret}`;
        let webhookWarning: string | null = null;
        try {
          const sub = await createZenotiWebhookSubscription({
            credentials,
            webhookUrl: notificationUrl,
            events: ZENOTI_WEBHOOK_EVENTS,
          });
          await sbAny.from("scheduler_connections").update({
            webhook_subscription_id: sub.subscriptionId,
            platform_account_email: sub.secret,
          }).eq("id", connectionId);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          webhookWarning = `Zenoti webhook subscription failed (${msg.slice(0, 200)}). Sync works; real-time push deferred.`;
        }

        let backfillWarning: string | null = null;
        try {
          await backfillZenotiAppointments({ sb, userId: state.userId, centerId });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          backfillWarning = `Initial backfill failed (${msg.slice(0, 200)}). Hit Re-sync to retry.`;
        }

        await sbAny.from("scheduler_connections").update({
          status: "connected",
          connected_at: new Date().toISOString(),
          last_sync_at: new Date().toISOString(),
          last_error: backfillWarning ?? webhookWarning ?? null,
        }).eq("id", connectionId);

        return buildCallbackRedirect(url.origin, state.returnTo, { scheduler_connected: "zenoti" });
      },
    },
  },
});
