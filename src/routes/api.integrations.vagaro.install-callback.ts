/**
 * Vagaro install callback (v1.38.0).
 *
 * POST /api/integrations/vagaro/install-callback receives the spa's
 * pasted API key from the install wizard, validates it via
 * getVagaroBusiness, then upserts the connection row + registers
 * webhooks + backfills. Mirrors the Boulevard install-callback shape
 * but for paste-API-key auth instead of post-OAuth flow.
 */

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import {
  createVagaroWebhookSubscription,
  getVagaroBusiness,
  VAGARO_WEBHOOK_EVENTS,
} from "@/lib/schedulers/vagaro";
import {
  backfillVagaroAppointments,
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
  "/api/integrations/vagaro/install-callback",
)({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const url = new URL(request.url);
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!SUPABASE_URL || !SERVICE_KEY) {
          return jsonResp(500, { error: "Server not configured" });
        }

        // Parse the API key + state from the form-encoded POST.
        const ct = request.headers.get("content-type") ?? "";
        let apiKey: string | null = null;
        let stateRaw: string | null = null;
        if (ct.includes("application/x-www-form-urlencoded")) {
          const text = await request.text();
          const form = new URLSearchParams(text);
          apiKey = form.get("api_key");
          stateRaw = form.get("state");
        } else if (ct.includes("application/json")) {
          try {
            const body = (await request.json()) as Record<string, unknown>;
            apiKey = (body.api_key as string | undefined) ?? null;
            stateRaw = (body.state as string | undefined) ?? null;
          } catch {
            // Fall through.
          }
        }

        let errReturnPath = "/app/refill/calendar/connections";
        const errReturn = (reason: string) =>
          buildCallbackRedirect(url.origin, errReturnPath, {
            scheduler_error: reason,
          });

        if (!apiKey || !stateRaw) {
          return errReturn("missing_params");
        }

        const state = decodeOAuthState(stateRaw);
        if (!state || state.platform !== "vagaro") {
          return errReturn("invalid_state");
        }
        if (state.returnTo) errReturnPath = state.returnTo;

        // v1.35.x doctrine: defensive whitespace strip on credential at read.
        const cleanedApiKey = apiKey.replace(/\s+/g, "");
        console.log(
          `[vagaro/install-callback] api_key_len=${cleanedApiKey.length}`,
        );

        // ── Step 1: validate API key by fetching business
        let business;
        try {
          business = await getVagaroBusiness({
            credentials: { apiKey: cleanedApiKey, merchantId: "" },
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error(
            "[vagaro/install-callback] business fetch failed:",
            msg,
          );
          const safeMsg = msg
            .slice(0, 180)
            .replace(/[^a-zA-Z0-9_\-:.()]/g, "_");
          return errReturn(`vagaro_validate__${safeMsg}`);
        }

        const sb = createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
          auth: { persistSession: false, autoRefreshToken: false },
        });

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

        // ── Step 2: upsert connection row
        const webhookSecret = crypto.randomUUID().replace(/-/g, "");

        const existing = await sbAny
          .from("emma_scheduler_connections")
          .select("id")
          .eq("user_id", state.userId)
          .eq("platform", "vagaro")
          .maybeSingle();

        let connectionId: string;
        if (existing.data) {
          connectionId = existing.data.id;
          await sbAny
            .from("emma_scheduler_connections")
            .update({
              status: "pending",
              access_token: cleanedApiKey,
              refresh_token: null,
              token_expires_at: null,
              oauth_scope: null,
              platform_account_id: business.id,
              platform_account_email: business.email ?? business.name,
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
              platform: "vagaro",
              access_token: cleanedApiKey,
              refresh_token: null,
              token_expires_at: null,
              oauth_scope: null,
              platform_account_id: business.id,
              platform_account_email: business.email ?? business.name,
              webhook_secret: webhookSecret,
              status: "pending",
            })
            .select("id")
            .single();
          if (ins.error || !ins.data) {
            console.error("[vagaro/install-callback] insert failed", ins.error);
            return errReturn("connection_save");
          }
          connectionId = ins.data.id;
        }

        // ── Step 3: webhook subscription (FAIL-DEGRADED)
        const notificationUrl = `${url.origin}/api/webhooks/scheduler/vagaro/${webhookSecret}`;
        let webhookWarning: string | null = null;
        try {
          const sub = await createVagaroWebhookSubscription({
            credentials: { apiKey: cleanedApiKey, merchantId: business.id },
            webhookUrl: notificationUrl,
            events: VAGARO_WEBHOOK_EVENTS,
          });
          // Store the shared token in platform_account_email (architecture-stub
          // overload same as Mindbody — clean migration adding
          // webhook_message_signature_key column queued).
          await sbAny
            .from("emma_scheduler_connections")
            .update({
              webhook_subscription_id: sub.subscriptionId,
              platform_account_email: sub.sharedToken,
            })
            .eq("id", connectionId);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.warn(
            "[vagaro/install-callback] webhook subscribe failed (non-fatal):",
            msg,
          );
          webhookWarning = `Vagaro webhook subscription failed (${msg.slice(0, 200)}). Connection works for read sync; real-time push deferred.`;
        }

        // ── Step 4: backfill (FAIL-DEGRADED)
        let backfillWarning: string | null = null;
        try {
          await backfillVagaroAppointments({
            sb,
            userId: state.userId,
            apiKey: cleanedApiKey,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.warn(
            "[vagaro/install-callback] backfill failed (non-fatal):",
            msg,
          );
          backfillWarning = `Initial backfill failed (${msg.slice(0, 200)}). Hit Re-sync to retry.`;
        }

        await sbAny
          .from("emma_scheduler_connections")
          .update({
            status: "connected",
            connected_at: new Date().toISOString(),
            last_sync_at: new Date().toISOString(),
            last_error: backfillWarning ?? webhookWarning ?? null,
          })
          .eq("id", connectionId);

        return buildCallbackRedirect(url.origin, state.returnTo, {
          scheduler_connected: "vagaro",
        });
      },
    },
  },
});
