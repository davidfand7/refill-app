/**
 * Zoho OAuth callback — /api/integrations/zoho/oauth-callback (v1.46.0).
 *
 * Zoho redirects here after the rep authorizes Refill in their Zoho account.
 * We:
 *
 *   1. Read code + state + accounts-server from the callback query string.
 *   2. Decode the state blob → look up which user initiated.
 *   3. Exchange the code for access_token + refresh_token (on the region
 *      determined by accounts-server).
 *   4. Fetch /users?type=CurrentUser and /org for display hints.
 *   5. Upsert zoho_connections (one row per user).
 *   6. Redirect back to state.returnTo with ?zoho_connected=1.
 *
 * Failure modes redirect back with ?zoho_error=<reason> so the UI can
 * surface a "Connection failed — try again" message.
 *
 * Required env: ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY.
 */

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import {
  deriveApiDomain,
  exchangeCodeForTokens,
  fetchZohoCurrentUser,
  fetchZohoOrgName,
  normalizeAccountsServer,
  ZOHO_SCOPES,
} from "@/lib/integrations/zoho";
import { decodeZohoState, isAllowedZohoReturnTo } from "@/server/zoho.functions";

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
  "/api/integrations/zoho/oauth-callback",
)({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const code = url.searchParams.get("code");
        const stateRaw = url.searchParams.get("state");
        const accountsServerRaw = url.searchParams.get("accounts-server");
        const oauthErr = url.searchParams.get("error");

        // Default fallback if state can't be decoded.
        let errReturnPath = "/app/rep/integrations";
        const errReturn = (reason: string) =>
          buildCallbackRedirect(url.origin, errReturnPath, {
            zoho_error: reason,
          });

        if (oauthErr) return errReturn(`zoho:${oauthErr}`);
        if (!code || !stateRaw) return errReturn("missing_params");

        const state = decodeZohoState(stateRaw);
        if (!state) return errReturn("invalid_state");
        if (isAllowedZohoReturnTo(state.returnTo)) {
          errReturnPath = state.returnTo;
        }

        const CLIENT_ID = process.env.ZOHO_CLIENT_ID;
        const CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!CLIENT_ID || !CLIENT_SECRET || !SUPABASE_URL || !SERVICE_KEY) {
          console.error("[zoho/oauth-callback] missing server config");
          return errReturn("server_config");
        }

        const accountsServer = normalizeAccountsServer(accountsServerRaw);
        const apiDomain = deriveApiDomain(accountsServer);
        const redirectUri = `${url.origin}/api/integrations/zoho/oauth-callback`;

        // ── Step 1: exchange code for tokens
        let tokens;
        try {
          tokens = await exchangeCodeForTokens({
            code,
            clientId: CLIENT_ID,
            clientSecret: CLIENT_SECRET,
            redirectUri,
            accountsServer,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error("[zoho/oauth-callback] token exchange failed:", msg);
          const safe = msg.slice(0, 180).replace(/[^a-zA-Z0-9_\-:.()]/g, "_");
          return errReturn(`token_exchange__${safe}`);
        }

        if (!tokens.access_token || !tokens.refresh_token) {
          // No refresh_token usually means the consent prompt was bypassed
          // (Zoho only issues refresh tokens on first consent OR with
          // prompt=consent). We requested prompt=consent so this is rare.
          return errReturn("missing_refresh_token");
        }

        // ── Step 2: identify the connected Zoho user + org (display only)
        let userInfo;
        let orgInfo: { name: string | null; id: string | null } = {
          name: null,
          id: null,
        };
        try {
          userInfo = await fetchZohoCurrentUser({
            accessToken: tokens.access_token,
            apiDomain,
          });
          orgInfo = await fetchZohoOrgName({
            accessToken: tokens.access_token,
            apiDomain,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.warn(
            "[zoho/oauth-callback] identity fetch failed (non-fatal):",
            msg,
          );
          userInfo = { email: null, fullName: null, orgName: null, orgId: null };
        }

        // ── Step 3: upsert the connection row
        const sb = createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
          auth: { persistSession: false, autoRefreshToken: false },
        });

        const expiresInSec = tokens.expires_in ?? 3600;
        const expiresAt = new Date(Date.now() + expiresInSec * 1000).toISOString();
        const nowIso = new Date().toISOString();

        const sbAny = sb as unknown as {
          from: (t: string) => {
            select: (cols: string) => {
              eq: (c: string, v: string) => {
                maybeSingle: () => Promise<{ data: { id: string } | null }>;
              };
            };
            insert: (v: object) => Promise<{ error: { message: string } | null }>;
            update: (v: object) => {
              eq: (c: string, v: string) => Promise<{
                error: { message: string } | null;
              }>;
            };
          };
        };

        const existing = await sbAny
          .from("zoho_connections")
          .select("id")
          .eq("user_id", state.userId)
          .maybeSingle();

        if (existing.data) {
          const upd = await sbAny
            .from("zoho_connections")
            .update({
              access_token: tokens.access_token,
              refresh_token: tokens.refresh_token,
              access_token_expires_at: expiresAt,
              scopes: tokens.scope ?? ZOHO_SCOPES,
              accounts_server: accountsServer,
              api_domain: apiDomain,
              zoho_user_email: userInfo.email,
              zoho_org_name: orgInfo.name ?? userInfo.orgName,
              zoho_org_id: orgInfo.id,
              status: "connected",
              last_error: null,
              connected_at: nowIso,
              updated_at: nowIso,
            })
            .eq("id", existing.data.id);
          if (upd.error) {
            console.error("[zoho/oauth-callback] update failed", upd.error);
            return errReturn("connection_save");
          }
        } else {
          const ins = await sbAny.from("zoho_connections").insert({
            user_id: state.userId,
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            access_token_expires_at: expiresAt,
            scopes: tokens.scope ?? ZOHO_SCOPES,
            accounts_server: accountsServer,
            api_domain: apiDomain,
            zoho_user_email: userInfo.email,
            zoho_org_name: orgInfo.name ?? userInfo.orgName,
            zoho_org_id: orgInfo.id,
            status: "connected",
          });
          if (ins.error) {
            console.error("[zoho/oauth-callback] insert failed", ins.error);
            return errReturn("connection_save");
          }
        }

        // ── Step 4: bounce home
        return buildCallbackRedirect(url.origin, state.returnTo, {
          zoho_connected: "1",
        });
      },
    },
  },
});
