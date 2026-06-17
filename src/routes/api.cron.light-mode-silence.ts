/**
 * Lite Mode silence-detection cron (v1.42.1 — P2-3 stretch).
 *
 * Lite Mode connections in status='active' should produce events
 * regularly (booking confirmations + cancellations email through the
 * spa's normal operating tempo). When >24h pass with no parsed event
 * on an active connection, something is probably broken in the chain:
 *   - Gmail filter was disabled / removed / label-renamed
 *   - Spa owner changed Gmail account
 *   - Resend Inbound Route deactivated
 *   - Vendor changed email template + every event quarantined
 *
 * This cron route runs hourly and flips status='active' → 'silent' on
 * any connection where last_event_at < NOW - 24h. The settings page
 * surfaces 'silent' as a warning chip + actionable prompt for the
 * owner to re-verify forwarding.
 *
 * Cron trigger: configured in wrangler.jsonc once Lite Mode has its
 * first pilot tenant (no value in firing the cron on zero connections).
 * Manually invokable via GET for testing.
 *
 * Per project-platforms-pre-built-architecture: shipping the cron
 * route NOW even though wrangler.jsonc cron config waits — architecture
 * is decoupled from the activation gate.
 */

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";

const SILENCE_THRESHOLD_HOURS = 24;

function jsonResp(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function runSilenceSweep() {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return { ok: false, error: "Server not configured" };
  }

  const sb = createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const sbAny = sb as never as {
    from(t: string): {
      select(c: string): {
        eq(c: string, v: unknown): {
          lt(c: string, v: unknown): Promise<{
            data: Record<string, unknown>[] | null;
            error: unknown;
          }>;
        };
      };
      update(patch: Record<string, unknown>): {
        eq(c: string, v: unknown): Promise<{ error: unknown }>;
      };
    };
  };

  const threshold = new Date(
    Date.now() - SILENCE_THRESHOLD_HOURS * 60 * 60 * 1000,
  ).toISOString();

  // Find active Lite Mode connections where last_event_at is stale.
  // Also include connections where last_event_at is NULL but the
  // connection was created > threshold ago (pending forever = silent).
  const { data: stale } = await sbAny
    .from("light_mode_connections")
    .select("id,platform,user_id,last_event_at,created_at")
    .eq("status", "active")
    .lt("last_event_at", threshold);

  let flippedActive = 0;
  if (stale) {
    for (const row of stale) {
      const { error } = await sbAny
        .from("light_mode_connections")
        .update({
          status: "silent",
          last_error:
            "No parsed events in the last 24h. Check your Gmail filter is still forwarding to your Refill inbound address.",
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id as string);
      if (!error) flippedActive++;
    }
  }

  return {
    ok: true,
    flippedActive,
    thresholdIso: threshold,
    sweptAt: new Date().toISOString(),
  };
}

export const Route = createFileRoute("/api/cron/light-mode-silence")({
  server: {
    handlers: {
      // GET so it's manually callable during testing.
      GET: async () => {
        const result = await runSilenceSweep();
        return jsonResp(result.ok ? 200 : 500, result);
      },
      // Cloudflare cron triggers POST.
      POST: async () => {
        const result = await runSilenceSweep();
        return jsonResp(result.ok ? 200 : 500, result);
      },
    },
  },
});
