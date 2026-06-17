/**
 * Jane polling cron (v1.40.0).
 *
 * Jane is the FIRST scheduler that does NOT support webhooks. This route
 * is invoked by a Cloudflare cron trigger (configured in wrangler.jsonc
 * when REFILL_JANE_ENABLED=1) every N minutes per Jane connection.
 *
 * For each active Jane connection:
 *   1. Pull recent appointments via listJaneAppointments (last 24h
 *      forward 14 days — narrow window for polling efficiency)
 *   2. Compare against appointments rows for status transitions
 *   3. Dispatch trigger graph (rescue + reliability) on cancel/no-show
 *
 * Architecture-stub: cron trigger config in wrangler.jsonc is added
 * when REFILL_JANE_ENABLED flips. This route is callable both via cron
 * AND manually (for testing) via GET.
 */

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import {
  listJaneAppointments,
  janeStatusToRefillStatus,
  type JaneAppointment,
} from "@/lib/schedulers/jane";
import {
  janeAppointmentToRow,
  withFreshJaneToken,
} from "@/server/emma-scheduler.functions";

function jsonResp(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const POLL_DAYS_BACK = 1;
const POLL_DAYS_FORWARD = 14;

export const Route = createFileRoute("/api/cron/jane-poll")({
  server: {
    handlers: {
      GET: async () => {
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!SUPABASE_URL || !SERVICE_KEY) {
          return jsonResp(500, { error: "Server not configured" });
        }
        const sb = createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
          auth: { persistSession: false, autoRefreshToken: false },
        });

        // Pull all active Jane connections
        const { data: connections } = await (sb as unknown as {
          from: (t: string) => {
            select: (cols: string) => {
              eq: (c: string, v: string) => {
                eq: (c: string, v: string) => Promise<{
                  data: Array<{
                    id: string;
                    user_id: string;
                    access_token: string | null;
                    refresh_token: string | null;
                    token_expires_at: string | null;
                    platform_account_id: string | null;
                  }> | null;
                }>;
              };
            };
          };
        })
          .from("scheduler_connections")
          .select("id, user_id, access_token, refresh_token, token_expires_at, platform_account_id")
          .eq("platform", "jane")
          .eq("status", "connected");

        if (!connections || connections.length === 0) {
          return jsonResp(200, { ok: true, polled: 0, note: "no active Jane connections" });
        }

        const now = new Date();
        const startDate = new Date(now.getTime() - POLL_DAYS_BACK * 86400000).toISOString().slice(0, 10);
        const endDate = new Date(now.getTime() + POLL_DAYS_FORWARD * 86400000).toISOString().slice(0, 10);

        let totalPolled = 0;
        let totalChanged = 0;
        for (const conn of connections) {
          if (!conn.access_token || !conn.platform_account_id) continue;
          try {
            const appointments: JaneAppointment[] = [];
            let cursor: string | null = null;
            for (let i = 0; i < 20; i++) {
              const { appointments: page, nextCursor } = await withFreshJaneToken({
                sb,
                connectionId: conn.id,
                accessToken: conn.access_token,
                refreshToken: conn.refresh_token,
                expiresAt: conn.token_expires_at,
                fn: (accessToken) =>
                  listJaneAppointments({
                    accessToken,
                    clinicUrl: conn.platform_account_id!,
                    startDate,
                    endDate,
                    pageSize: 200,
                    cursor: cursor ?? undefined,
                  }),
              });
              appointments.push(...page);
              if (!nextCursor) break;
              cursor = nextCursor;
            }

            for (const apt of appointments) {
              totalPolled++;
              const { data: prior } = await sb
                .from("appointments")
                .select("id, status, patient_node_id, scheduled_at")
                .eq("user_id", conn.user_id)
                .eq("external_id", apt.id)
                .eq("source", "jane")
                .maybeSingle();

              const row = janeAppointmentToRow(apt, conn.user_id, prior?.patient_node_id ?? null);
              const { data: upserted } = await sb
                .from("appointments")
                .upsert(row, { onConflict: "user_id,external_id,source" })
                .select("id, status, patient_node_id, scheduled_at")
                .single();

              if (!upserted) continue;
              const priorStatus = prior?.status ?? null;
              const newStatus = upserted.status;
              if (priorStatus === newStatus) continue;

              totalChanged++;

              await sb.from("appointment_status_events").insert({
                user_id: conn.user_id,
                appointment_id: upserted.id,
                from_status: priorStatus ?? "scheduled",
                to_status: newStatus,
                triggered_by: "scheduler-poll",
                reason: `jane:poll:${apt.status}`,
              });

              const futureScheduled = new Date(upserted.scheduled_at).getTime() > Date.now();
              if ((newStatus === "cancelled" || newStatus === "no_show") && futureScheduled) {
                try {
                  const { dispatchRescueAttempt } = await import("@/server/emma-rescue.functions");
                  await dispatchRescueAttempt({ sb, userId: conn.user_id, appointmentId: upserted.id });
                } catch (e) {
                  console.error("rescue dispatch failed (jane poll):", e instanceof Error ? e.message : e);
                }
              }
            }

            await (sb as unknown as { from: (t: string) => { update: (v: object) => { eq: (c: string, v: string) => Promise<unknown> } } })
              .from("scheduler_connections")
              .update({ last_sync_at: new Date().toISOString() })
              .eq("id", conn.id);
          } catch (e) {
            console.error(`[jane/poll] connection ${conn.id} failed:`, e instanceof Error ? e.message : e);
          }
        }

        // suppress unused-warnings for the mapper used downstream
        void janeStatusToRefillStatus;

        return jsonResp(200, {
          ok: true,
          connectionsPolled: connections.length,
          totalAppointments: totalPolled,
          totalChanged,
        });
      },
    },
  },
});
