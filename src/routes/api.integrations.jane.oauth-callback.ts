/**
 * Jane OAuth callback (v1.40.0). PKCE flow — code_verifier is embedded
 * in the state token for round-trip recovery (no separate DB storage).
 *
 * Per-clinic base URL extracted from id_token claims becomes the
 * connection's platform_account_id (overload: clinic_url is the tenant
 * routing key, not a UUID).
 *
 * NO webhook registration (Jane is polling-only). A polling cron route
 * (separate file) handles ongoing sync.
 */

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import {
  exchangeJaneCodeForToken,
  resolveJaneEnv,
  type JaneEnv,
  type JaneOAuthCredentials,
} from "@/lib/schedulers/jane";
import { backfillJaneAppointments } from "@/server/emma-scheduler.functions";

type JaneOAuthState = {
  userId: string;
  platform: string;
  returnTo: string;
  nonce: string;
  codeVerifier: string;
};

function decodeJaneState(raw: string): JaneOAuthState | null {
  try {
    const json = Buffer.from(raw, "base64url").toString("utf-8");
    const obj = JSON.parse(json) as JaneOAuthState;
    if (!obj.userId || obj.platform !== "jane" || !obj.codeVerifier) return null;
    return obj;
  } catch {
    return null;
  }
}

function buildCallbackRedirect(origin: string, returnTo: string, paramsToAdd: Record<string, string>): Response {
  const target = new URL(returnTo, origin);
  for (const [key, value] of Object.entries(paramsToAdd)) target.searchParams.set(key, value);
  return Response.redirect(target.toString(), 302);
}

export const Route = createFileRoute("/api/integrations/jane/oauth-callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const code = url.searchParams.get("code");
        const stateRaw = url.searchParams.get("state");
        const oauthErr = url.searchParams.get("error");

        let errReturnPath = "/app/refill/settings/scheduler";
        const errReturn = (reason: string) =>
          buildCallbackRedirect(url.origin, errReturnPath, { scheduler_error: reason });

        if (oauthErr) return errReturn(`jane:${oauthErr}`);
        if (!code || !stateRaw) return errReturn("missing_params");

        const state = decodeJaneState(stateRaw);
        if (!state) return errReturn("invalid_state");
        if (state.returnTo) errReturnPath = state.returnTo;

        const env: JaneEnv = resolveJaneEnv();
        const stripWs = (v: string | undefined) => v?.replace(/\s+/g, "");
        const CLIENT_ID = stripWs(env === "sandbox" ? process.env.JANE_SANDBOX_CLIENT_ID : process.env.JANE_CLIENT_ID);
        const CLIENT_SECRET = stripWs(env === "sandbox" ? process.env.JANE_SANDBOX_CLIENT_SECRET : process.env.JANE_CLIENT_SECRET);
        const IAM_BASE_URL = stripWs(env === "sandbox" ? process.env.JANE_SANDBOX_IAM_BASE_URL : process.env.JANE_IAM_BASE_URL);
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

        console.log(
          `[jane/oauth-callback] JANE_ENV raw="${process.env.JANE_ENV}" resolved="${env}" client_id_len=${CLIENT_ID?.length ?? 0} client_secret_len=${CLIENT_SECRET?.length ?? 0} iam_url_len=${IAM_BASE_URL?.length ?? 0}`,
        );

        if (!CLIENT_ID || !CLIENT_SECRET || !IAM_BASE_URL || !SUPABASE_URL || !SERVICE_KEY) {
          return errReturn("server_config");
        }

        const redirectUri = `${url.origin}/api/integrations/jane/oauth-callback`;
        const credentials: JaneOAuthCredentials = {
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
          iamBaseUrl: IAM_BASE_URL,
          redirectUri,
          env,
        };

        let tokenResp;
        try {
          tokenResp = await exchangeJaneCodeForToken({
            code,
            codeVerifier: state.codeVerifier,
            credentials,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error("[jane/oauth-callback] token exchange failed:", msg);
          const safeMsg = msg.slice(0, 180).replace(/[^a-zA-Z0-9_\-:.()]/g, "_");
          return errReturn(`token_exchange__${safeMsg}`);
        }

        if (!tokenResp.clinicUrl) {
          return errReturn("no_clinic_url__id_token_missing_clinic_url_claim");
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

        const existing = await sbAny
          .from("scheduler_connections")
          .select("id")
          .eq("user_id", state.userId)
          .eq("platform", "jane")
          .maybeSingle();

        let connectionId: string;
        const baseFields = {
          access_token: tokenResp.accessToken,
          refresh_token: tokenResp.refreshToken,
          token_expires_at: tokenResp.expiresAt,
          oauth_scope: tokenResp.scope.join(" "),
          // Overload: platform_account_id holds clinic_url, the tenant-routing
          // key for Jane's per-clinic base URL pattern.
          platform_account_id: tokenResp.clinicUrl,
          platform_account_email: tokenResp.clinicId,
          status: "pending" as const,
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
          const ins = await sbAny
            .from("scheduler_connections")
            .insert({ user_id: state.userId, platform: "jane", ...baseFields })
            .select("id")
            .single();
          if (ins.error || !ins.data) {
            console.error("[jane/oauth-callback] insert failed", ins.error);
            return errReturn("connection_save");
          }
          connectionId = ins.data.id;
        }

        // NO webhook registration — Jane is polling-only.

        let backfillWarning: string | null = null;
        try {
          await backfillJaneAppointments({
            sb,
            userId: state.userId,
            connectionId,
            accessToken: tokenResp.accessToken,
            clinicUrl: tokenResp.clinicUrl,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.warn("[jane/oauth-callback] backfill failed (non-fatal):", msg);
          backfillWarning = `Initial backfill failed (${msg.slice(0, 200)}). Hit Re-sync to retry.`;
        }

        await sbAny.from("scheduler_connections").update({
          status: "connected",
          connected_at: new Date().toISOString(),
          last_sync_at: new Date().toISOString(),
          last_error: backfillWarning,
        }).eq("id", connectionId);

        return buildCallbackRedirect(url.origin, state.returnTo, { scheduler_connected: "jane" });
      },
    },
  },
});
