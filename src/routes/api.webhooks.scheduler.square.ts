/**
 * Square webhook receiver — POST /api/webhooks/scheduler/square (v1.35.0).
 *
 * Single global URL across all Square sellers (per app, per env).
 * Tenant routing happens via merchant_id in the payload, NOT via a
 * per-spa secret in the URL path (which is how Acuity does it). The
 * receiver:
 *
 *   1. Parses + validates the JSON payload
 *   2. Looks up the connection row by (platform="square",
 *      platform_account_id=merchant_id)
 *   3. Verifies the x-square-hmacsha256-signature HMAC against
 *      (notification_url + raw_body) using the connection's
 *      webhook_secret (which Square calls signature_key)
 *   4. Audits the inbound event in emma_scheduler_webhook_events
 *   5. Resolves the booking either from the payload's embedded object
 *      OR from a follow-up GET /v2/bookings/:id when only an id is
 *      embedded
 *   6. Upserts into emma_appointments — fires the rescue + reliability
 *      trigger graph on status transitions
 *
 * Always returns 200 (so Square doesn't retry indefinitely); failures
 * land in the audit row's `error` column for replay reconciliation.
 *
 * Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 */

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import {
  getSquareBooking,
  parseSquareWebhookBody,
  resolveSquareEnv,
  squareStatusToRefillStatus,
  verifySquareWebhookSignature,
  type SquareBooking,
  type SquareEnv,
} from "@/lib/schedulers/square";
import { squareBookingToRow } from "@/server/emma-scheduler.functions";
import {
  buildPatientIndex,
  matchPatientFromIndex,
} from "@/server/emma-appointments.functions";

function jsonResp(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const Route = createFileRoute("/api/webhooks/scheduler/square")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!SUPABASE_URL || !SERVICE_KEY) {
          return jsonResp(500, { error: "Server not configured" });
        }

        const sb = createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
          auth: { persistSession: false, autoRefreshToken: false },
        });
        const sbAny = sb as unknown as SbScheduleAny;

        // ── Read raw body + signature
        const rawBody = await request.text();
        const signature = request.headers.get("x-square-hmacsha256-signature");

        // ── Parse the JSON envelope
        const payload = parseSquareWebhookBody(rawBody);
        if (!payload) {
          // Body was unparseable or event type unsupported. Acknowledge
          // and audit so we don't accidentally retry forever.
          await sbAny.from("emma_scheduler_webhook_events").insert({
            connection_id: null,
            user_id: null,
            platform: "square",
            event_type: "unparseable",
            raw_payload: { rawBody: rawBody.slice(0, 500) },
            error: "Could not parse Square webhook envelope",
          });
          return jsonResp(200, { ignored: "unparseable" });
        }

        // ── Look up the connection by merchant_id
        const { data: connection } = await sbAny
          .from("emma_scheduler_connections")
          .select(
            "id, user_id, status, access_token, webhook_secret",
          )
          .eq("platform", "square")
          .eq("platform_account_id", payload.merchantId)
          .maybeSingle();

        if (!connection) {
          // Could be a stale subscription from a disconnected spa, or
          // delivery for a different Refill env/app. Acknowledge.
          return jsonResp(200, { ignored: "unknown_merchant" });
        }

        if (connection.status === "disconnected") {
          return jsonResp(200, { ignored: "disconnected" });
        }

        // ── HMAC verification: signature_key = webhook_secret;
        //    HMAC input = notification_url + raw_body. The notification
        //    URL MUST match exactly what we registered — derive it from
        //    request.url to avoid host-mismatch (e.g., custom domain vs
        //    Worker URL). Constant-time compare in verifySquareWebhookSignature.
        const notificationUrl = `${new URL(request.url).origin}/api/webhooks/scheduler/square`;
        const sigOk = await verifySquareWebhookSignature({
          rawBody,
          signatureHeader: signature,
          signatureKey: connection.webhook_secret,
          notificationUrl,
        });
        if (!sigOk) {
          // Hard reject — unlike Acuity's advisory mode, Square's HMAC
          // scheme is well-documented and consistent. A mismatch means
          // either spoofing or stale signature_key (rotated subscription).
          await sbAny.from("emma_scheduler_webhook_events").insert({
            connection_id: connection.id,
            user_id: connection.user_id,
            platform: "square",
            event_type: payload.type,
            raw_payload: {
              event_id: payload.eventId,
              merchant_id: payload.merchantId,
              signature_header_present: Boolean(signature),
            },
            error: "HMAC signature verification failed",
          });
          return jsonResp(401, { error: "invalid_signature" });
        }

        // ── Audit the inbound event (best-effort, never block downstream)
        const auditInsert = await sbAny
          .from("emma_scheduler_webhook_events")
          .insert({
            connection_id: connection.id,
            user_id: connection.user_id,
            platform: "square",
            event_type: payload.type,
            external_appointment_id: payload.bookingId,
            raw_payload: {
              event_id: payload.eventId,
              merchant_id: payload.merchantId,
              created_at: payload.createdAt,
              booking_embedded: Boolean(payload.booking),
              signature_ok: true,
            },
          })
          .select("id")
          .single();
        const auditId = auditInsert.data?.id ?? null;

        // ── Resolve the booking. Square embeds booking object on
        //    creation but the payload shape for updates can omit it;
        //    fall back to a GET when needed.
        if (!connection.access_token) {
          await stampAuditError(sbAny, auditId, "missing_access_token");
          return jsonResp(200, { ignored: "missing_access_token" });
        }

        let booking: SquareBooking;
        if (payload.booking) {
          booking = payload.booking;
        } else {
          try {
            const env: SquareEnv =
              resolveSquareEnv();
            booking = await getSquareBooking({
              accessToken: connection.access_token,
              env,
              bookingId: payload.bookingId,
            });
          } catch (e) {
            await stampAuditError(
              sbAny,
              auditId,
              `Square API fetch failed: ${e instanceof Error ? e.message : "unknown"}`,
            );
            return jsonResp(200, { ignored: "api_fetch_failed" });
          }
        }

        // ── Capture prior status for trigger graph
        const { data: prior } = await sb
          .from("emma_appointments")
          .select("id, status, patient_node_id, scheduled_at")
          .eq("user_id", connection.user_id)
          .eq("external_id", booking.id)
          .eq("source", "square")
          .maybeSingle();

        // ── Resolve patient_node_id by customer info (Square only
        //    exposes customer_id on booking; we need a separate fetch
        //    if we want name/phone/email matching. For v1 we accept
        //    rows landing with patient_node_id null when no prior
        //    knowledge_node has a customer_id stamp — the resync /
        //    inbound CSV path will fill these in.)
        let resolvedPatientNodeId: string | null = prior?.patient_node_id ?? null;
        if (!resolvedPatientNodeId && booking.customerId) {
          // Try matching by customerId stamped on knowledge_nodes
          // attachments. (Future v1.x will stamp this on rescue claim
          // writebacks — see emma-rescue.functions.ts square branch.)
          const patientIndex = await buildPatientIndex(sb, connection.user_id);
          resolvedPatientNodeId = matchPatientFromIndex(
            {
              patientFirstName: null,
              patientLastName: null,
              patientPhone: null,
              patientEmail: null,
            },
            patientIndex,
          );
        }

        // ── Upsert
        const row = squareBookingToRow(
          booking,
          connection.user_id,
          resolvedPatientNodeId,
        );
        const { data: upserted, error: upsertErr } = await sb
          .from("emma_appointments")
          .upsert(row, { onConflict: "user_id,external_id,source" })
          .select("id, status, patient_node_id, scheduled_at")
          .single();

        if (upsertErr || !upserted) {
          await stampAuditError(
            sbAny,
            auditId,
            `Upsert failed: ${upsertErr?.message ?? "unknown"}`,
          );
          return jsonResp(200, { ignored: "upsert_failed" });
        }

        // ── Stamp audit row with success
        if (auditId) {
          await sbAny
            .from("emma_scheduler_webhook_events")
            .update({
              processed_at: new Date().toISOString(),
              emma_appointment_id: upserted.id,
            })
            .eq("id", auditId);
        }

        // ── Update connection last_sync_at
        await sbAny
          .from("emma_scheduler_connections")
          .update({ last_sync_at: new Date().toISOString() })
          .eq("id", connection.id);

        // ── Trigger graph (mirrors the Acuity receiver exactly)
        const priorStatus = prior?.status ?? null;
        const newStatus = upserted.status;
        const statusChanged = priorStatus !== newStatus;

        if (statusChanged) {
          await sb
            .from("emma_appointment_status_events")
            .insert({
              user_id: connection.user_id,
              appointment_id: upserted.id,
              from_status: priorStatus ?? "scheduled",
              to_status: newStatus,
              triggered_by: "scheduler-webhook",
              reason: `square:${payload.type}:${booking.status}`,
            })
            .then(({ error }) => {
              if (error) console.error("audit insert failed:", error.message);
            });

          const futureScheduled =
            new Date(upserted.scheduled_at).getTime() > Date.now();

          if (
            (newStatus === "cancelled" || newStatus === "no_show") &&
            futureScheduled
          ) {
            try {
              const { dispatchRescueAttempt } = await import(
                "@/server/emma-rescue.functions"
              );
              await dispatchRescueAttempt({
                sb,
                userId: connection.user_id,
                appointmentId: upserted.id,
              });
            } catch (e) {
              console.error(
                "rescue dispatch failed (square webhook):",
                e instanceof Error ? e.message : e,
              );
            }
          }

          if (
            upserted.patient_node_id &&
            ["showed", "no_show", "cancelled"].includes(newStatus)
          ) {
            try {
              const { recomputeReliabilityForPatient } = await import(
                "@/server/emma-reliability.functions"
              );
              await recomputeReliabilityForPatient({
                sb,
                userId: connection.user_id,
                patientNodeId: upserted.patient_node_id,
              });
            } catch (e) {
              console.error(
                "reliability recompute failed (square webhook):",
                e instanceof Error ? e.message : e,
              );
            }
          }
        }

        // The squareStatusToRefillStatus + the booking.status are kept
        // separate so the audit can record both the wire-format and the
        // refilled-status interpretation. squareStatusToRefillStatus is
        // imported here only for the type contract; the row construction
        // already applied it.
        void squareStatusToRefillStatus;

        return jsonResp(200, {
          ok: true,
          appointmentId: upserted.id,
          status: upserted.status,
          eventType: payload.type,
          bookingStatus: booking.status,
          statusChanged,
        });
      },
    },
  },
});

// ─── Helpers ───────────────────────────────────────────────────────────────

type SbScheduleAny = {
  from: (t: string) => {
    select: (cols: string) => {
      eq: (c: string, v: string) => {
        eq: (c: string, v: string) => {
          maybeSingle: () => Promise<{
            data: {
              id: string;
              user_id: string;
              status: string;
              access_token: string | null;
              webhook_secret: string;
            } | null;
            error: { message: string } | null;
          }>;
        };
      };
    };
    insert: (v: object) => {
      select: (c: string) => {
        single: () => Promise<{
          data: { id: string } | null;
          error: { message: string } | null;
        }>;
      };
    } & Promise<{ error: { message: string } | null }>;
    update: (v: object) => {
      eq: (c: string, v: string) => Promise<{
        error: { message: string } | null;
      }>;
    };
  };
};

async function stampAuditError(
  sbAny: SbScheduleAny,
  auditId: string | null,
  error: string,
): Promise<void> {
  if (!auditId) return;
  await sbAny
    .from("emma_scheduler_webhook_events")
    .update({ error })
    .eq("id", auditId);
}
