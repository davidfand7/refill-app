/**
 * Zoho CRM server functions — direct OAuth flow (v1.46.0).
 *
 * Three rep-facing surfaces:
 *
 *   initiateZohoOAuth
 *     Builds the Zoho authorize URL with a CSRF-signed state blob carrying
 *     userId + returnTo. UI calls this, then sets window.location.href to
 *     the returned redirectUrl.
 *
 *   getMyZohoConnection
 *     Reads zoho_connections for the current user. Returns identity hints
 *     (email/org), last sync timestamp, status. No tokens leak to the
 *     client.
 *
 *   syncMyZohoContacts
 *     Pulls a recent batch of contacts via Zoho REST. Auto-refreshes the
 *     access token if it's within 60s of expiry. Updates last_sync_at.
 *     Returns the contact list for UI preview — does NOT persist contacts
 *     locally yet (next ship after Kelly's walk-through).
 *
 *   disconnectZoho
 *     Marks the connection row revoked + clears tokens. Doesn't tell Zoho
 *     (the rep retains the consent). They can re-connect via the same
 *     button to re-issue tokens.
 */

import { createClient } from "@supabase/supabase-js";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { requireRepOrAdmin } from "@/server/auth-helpers";
import {
  buildZohoAuthorizeUrl,
  fetchZohoContacts,
  refreshAccessToken,
  type ZohoContact,
} from "@/lib/integrations/zoho";

type SbClient = ReturnType<typeof createClient<Database>>;

function admin(): SbClient {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ─── State (CSRF) ────────────────────────────────────────────────────────

export type ZohoOAuthState = {
  userId: string;
  returnTo: string;
  nonce: string;
};

export function encodeZohoState(state: ZohoOAuthState): string {
  return Buffer.from(JSON.stringify(state), "utf-8").toString("base64url");
}

export function decodeZohoState(raw: string): ZohoOAuthState | null {
  try {
    const json = Buffer.from(raw, "base64url").toString("utf-8");
    const obj = JSON.parse(json);
    if (!obj.userId || typeof obj.userId !== "string") return null;
    if (!obj.returnTo || typeof obj.returnTo !== "string") return null;
    if (!obj.nonce || typeof obj.nonce !== "string") return null;
    return obj as ZohoOAuthState;
  } catch {
    return null;
  }
}

const ZOHO_RETURN_TO_ALLOWLIST = ["/app/rep/integrations", "/app/admin"] as const;

export function isAllowedZohoReturnTo(returnTo: string): boolean {
  if (!returnTo.startsWith("/")) return false;
  if (returnTo.startsWith("//")) return false;
  return ZOHO_RETURN_TO_ALLOWLIST.some(
    (prefix) =>
      returnTo === prefix ||
      returnTo.startsWith(prefix + "?") ||
      returnTo.startsWith(prefix + "/") ||
      returnTo.startsWith(prefix + "#"),
  );
}

// ─── initiateZohoOAuth ───────────────────────────────────────────────────

const initiateInput = z.object({
  accessToken: z.string().min(1),
  origin: z.string().min(1),
  returnTo: z.string().default("/app/rep/integrations"),
});

export const initiateZohoOAuth = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => initiateInput.parse(raw))
  .handler(async ({ data }): Promise<{ redirectUrl: string }> => {
    const sb = admin();
    const principal = await requireRepOrAdmin(sb, data.accessToken);

    if (!isAllowedZohoReturnTo(data.returnTo)) {
      throw new Error(
        `returnTo "${data.returnTo}" is not in the Zoho OAuth allowlist`,
      );
    }

    const CLIENT_ID = process.env.ZOHO_CLIENT_ID;
    if (!CLIENT_ID) {
      throw new Error(
        "Zoho OAuth is not configured on the server. ZOHO_CLIENT_ID is missing.",
      );
    }

    const redirectUri = `${data.origin}/api/integrations/zoho/oauth-callback`;
    const nonce =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const state = encodeZohoState({
      userId: principal.userId,
      returnTo: data.returnTo,
      nonce,
    });

    const redirectUrl = buildZohoAuthorizeUrl({
      clientId: CLIENT_ID,
      redirectUri,
      state,
    });

    return { redirectUrl };
  });

// ─── getMyZohoConnection ─────────────────────────────────────────────────

export type ZohoConnection = {
  status: "connected" | "expired" | "revoked" | "error";
  zohoUserEmail: string | null;
  zohoOrgName: string | null;
  apiDomain: string;
  scopes: string;
  connectedAt: string;
  lastSyncAt: string | null;
  lastSyncedContactCount: number | null;
  lastError: string | null;
};

const authInput = z.object({
  accessToken: z.string().min(1),
});

export const getMyZohoConnection = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => authInput.parse(raw))
  .handler(async ({ data }): Promise<{ connection: ZohoConnection | null }> => {
    const sb = admin();
    const principal = await requireRepOrAdmin(sb, data.accessToken);

    const { data: row, error } = await sb
      .from("zoho_connections")
      .select(
        "status, zoho_user_email, zoho_org_name, api_domain, scopes, connected_at, last_sync_at, last_synced_contact_count, last_error",
      )
      .eq("user_id", principal.userId)
      .maybeSingle();

    if (error) {
      // Schema not migrated yet — treat as not connected so the UI shows
      // the Connect button instead of crashing.
      if (/relation .* does not exist/i.test(error.message)) {
        return { connection: null };
      }
      throw new Error(`Couldn't load Zoho connection: ${error.message}`);
    }
    if (!row) return { connection: null };

    return {
      connection: {
        status: row.status as ZohoConnection["status"],
        zohoUserEmail: row.zoho_user_email,
        zohoOrgName: row.zoho_org_name,
        apiDomain: row.api_domain,
        scopes: row.scopes,
        connectedAt: row.connected_at,
        lastSyncAt: row.last_sync_at,
        lastSyncedContactCount: row.last_synced_contact_count,
        lastError: row.last_error,
      },
    };
  });

// ─── syncMyZohoContacts ──────────────────────────────────────────────────

const syncInput = authInput.extend({
  limit: z.number().int().min(1).max(50).optional(),
});

export const syncMyZohoContacts = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => syncInput.parse(raw))
  .handler(
    async ({
      data,
    }): Promise<{
      contacts: ZohoContact[];
      moreRecords: boolean;
      lastSyncAt: string;
      message: string;
    }> => {
      const sb = admin();
      const principal = await requireRepOrAdmin(sb, data.accessToken);

      const { data: row, error } = await sb
        .from("zoho_connections")
        .select(
          "id, access_token, refresh_token, access_token_expires_at, accounts_server, api_domain, status",
        )
        .eq("user_id", principal.userId)
        .maybeSingle();
      if (error || !row) {
        throw new Error("Not connected to Zoho. Connect first, then sync.");
      }
      if (row.status === "revoked") {
        throw new Error("Zoho connection is revoked. Reconnect to sync.");
      }

      let accessToken = row.access_token as string;
      const expiresAt = new Date(row.access_token_expires_at as string).getTime();
      const now = Date.now();

      // Refresh if token expires in the next 60s.
      if (expiresAt - now < 60_000) {
        const CLIENT_ID = process.env.ZOHO_CLIENT_ID;
        const CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
        if (!CLIENT_ID || !CLIENT_SECRET) {
          throw new Error("ZOHO_CLIENT_ID or ZOHO_CLIENT_SECRET is missing.");
        }
        const refreshed = await refreshAccessToken({
          refreshToken: row.refresh_token as string,
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
          accountsServer: row.accounts_server as string,
        });
        accessToken = refreshed.accessToken;
        const newExpiresAt = new Date(
          Date.now() + refreshed.expiresInSeconds * 1000,
        ).toISOString();
        await sb
          .from("zoho_connections")
          .update({
            access_token: accessToken,
            access_token_expires_at: newExpiresAt,
            updated_at: new Date().toISOString(),
          })
          .eq("id", row.id);
      }

      const limit = data.limit ?? 25;
      let result;
      try {
        result = await fetchZohoContacts({
          accessToken,
          apiDomain: row.api_domain as string,
          perPage: limit,
          page: 1,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Stamp error onto the row so the UI shows what went wrong.
        await sb
          .from("zoho_connections")
          .update({
            last_error: msg.slice(0, 500),
            status: msg.includes("401") || msg.includes("INVALID_TOKEN") ? "expired" : "error",
            updated_at: new Date().toISOString(),
          })
          .eq("id", row.id);
        throw new Error(`Zoho contact sync failed: ${msg}`);
      }

      const lastSyncAt = new Date().toISOString();
      await sb
        .from("zoho_connections")
        .update({
          last_sync_at: lastSyncAt,
          last_synced_contact_count: result.contacts.length,
          last_error: null,
          status: "connected",
          updated_at: lastSyncAt,
        })
        .eq("id", row.id);

      return {
        contacts: result.contacts,
        moreRecords: result.moreRecords,
        lastSyncAt,
        message:
          result.contacts.length === 0
            ? "Connected, but no contacts returned. (Zoho account may be empty.)"
            : `Pulled ${result.contacts.length} contact${result.contacts.length === 1 ? "" : "s"} from Zoho.`,
      };
    },
  );

// ─── disconnectZoho ──────────────────────────────────────────────────────

export const disconnectZoho = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => authInput.parse(raw))
  .handler(async ({ data }): Promise<{ disconnected: boolean }> => {
    const sb = admin();
    const principal = await requireRepOrAdmin(sb, data.accessToken);

    const { error } = await sb
      .from("zoho_connections")
      .update({
        status: "revoked",
        access_token: "",
        refresh_token: "",
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", principal.userId);

    if (error) {
      throw new Error(`Couldn't disconnect Zoho: ${error.message}`);
    }
    return { disconnected: true };
  });
