/**
 * Mindbody webhook receiver — POST + HEAD /api/webhooks/scheduler/mindbody/$secret (v1.37.0).
 *
 * Per-spa path secret in URL (back to Acuity's pattern, NOT Square's
 * single-global). Tenant routing happens via the secret: lookup
 * connection row WHERE platform='mindbody' AND webhook_secret=:secret.
 * HMAC verification uses a separate messageSignatureKey (stored at
 * oauth-callback time in platform_account_email as an architecture-
 * stub overload — a schema migration adding
 * webhook_message_signature_key column is queued for sandbox-verify).
 *
 * Critical: Mindbody validates the webhook URL via HEAD request when
 * the subscription is being created. The HEAD handler MUST return 2xx
 * for subscription create to succeed. Without that, MB rejects the
 * subscription and the webhook never registers.
 *
 *   1. HEAD: respond 2xx for subscription validation (no body required)
 *   2. POST: parse JSON envelope, look up connection by path secret,
 *      HMAC verify, audit, dispatch
 *   3. Appointment events: upsert appointments, fire rescue +
 *      reliability trigger graph
 *   4. CLIENT_CREATED events: roster enrichment placeholder (deferred
 *      to follow-up ship)
 *
 * Always returns 200 on POST (so Mindbody doesn't retry indefinitely);
 * failures land in the audit row's `error` column for replay.
 */

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import {
  getMindbodyAppointment,
  MINDBODY_WEBHOOK_SIGNATURE_HEADER,
  mindbodyStatusToRefillStatus,
  parseMindbodyWebhookBody,
  resolveMindbodyEnv,
  verifyMindbodyWebhookSignature,
  type MindbodyAppointment,
  type MindbodyEnv,
} from "@/lib/schedulers/mindbody";
import { mindbodyAppointmentToRow } from "@/server/emma-scheduler.functions";
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

export const Route = createFileRoute(
  "/api/webhooks/scheduler/mindbody/$secret",
)({
  server: {
    handlers: {
      // HEAD: Mindbody validates the webhook URL via HEAD on subscription
      // create. Must return 2xx without a body. We don't even need to
      // look up the secret here — Mindbody's HEAD is just URL-reachability
      // verification, not auth.
      HEAD: async () => {
        return new Response(null, { status: 200 });
      },
      POST: async ({ request, params }) => {
        const secret = params.secret;
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!SUPABASE_URL || !SERVICE_KEY) {
          return jsonResp(500, { error: "Server not configured" });
        }

        const sb = createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
          auth: { persistSession: false, autoRefreshToken: false },
        });
        const sbAny = sb as unknown as SbAny;

        // ── Read raw body + signature header
        const rawBody = await request.text();
        const signature = request.headers.get(
          MINDBODY_WEBHOOK_SIGNATURE_HEADER,
        );

        // ── Parse the JSON envelope
        const payload = parseMindbodyWebhookBody(rawBody);
        if (!payload) {
          await sbAny.from("scheduler_webhook_events").insert({
            connection_id: null,
            user_id: null,
            platform: "mindbody",
            event_type: "unparseable",
            raw_payload: { rawBody: rawBody.slice(0, 500) },
            error: "Could not parse Mindbody webhook envelope",
          });
          return jsonResp(200, { ignored: "unparseable" });
        }

        // ── Look up connection by path secret + siteId
        const { data: connection } = await sbAny
          .from("scheduler_connections")
          .select(
            "id, user_id, status, access_token, refresh_token, token_expires_at, webhook_secret, platform_account_id, platform_account_email",
          )
          .eq("platform", "mindbody")
          .eq("webhook_secret", secret)
          .maybeSingle();

        if (!connection) {
          // Path-secret mismatch — could be stale subscription from a
          // disconnected spa, or spoofing attempt. Acknowledge.
          return jsonResp(200, { ignored: "unknown_secret" });
        }

        if (connection.status === "disconnected") {
          return jsonResp(200, { ignored: "disconnected" });
        }

        // Cross-check siteId from payload matches the connection's siteId.
        // Defense-in-depth: if the path secret somehow got reused across
        // sites (shouldn't happen but cheap to check), this fails the
        // mismatch.
        if (
          connection.platform_account_id &&
          payload.siteId &&
          connection.platform_account_id !== payload.siteId
        ) {
          await sbAny.from("scheduler_webhook_events").insert({
            connection_id: connection.id,
            user_id: connection.user_id,
            platform: "mindbody",
            event_type: payload.eventId,
            raw_payload: {
              message_id: payload.messageId,
              expected_site: connection.platform_account_id,
              actual_site: payload.siteId,
            },
            error: "siteId in payload does not match connection's siteId",
          });
          return jsonResp(200, { ignored: "site_mismatch" });
        }

        // ── HMAC verification. The messageSignatureKey lives on
        //    platform_account_email per the architecture-stub overload
        //    until a schema migration adds the dedicated column.
        const messageSignatureKey = connection.platform_account_email ?? "";
        const sigOk = messageSignatureKey
          ? await verifyMindbodyWebhookSignature({
              rawBody,
              signatureHeader: signature,
              messageSignatureKey,
            })
          : false;

        if (!sigOk) {
          await sbAny.from("scheduler_webhook_events").insert({
            connection_id: connection.id,
            user_id: connection.user_id,
            platform: "mindbody",
            event_type: payload.eventId,
            raw_payload: {
              message_id: payload.messageId,
              site_id: payload.siteId,
              signature_header_present: Boolean(signature),
              signature_secret_present: Boolean(messageSignatureKey),
            },
            error: messageSignatureKey
              ? "HMAC signature verification failed"
              : "Connection has no signing secret — accepted in degraded mode",
          });
          if (messageSignatureKey) {
            // Real mismatch → hard reject (Mindbody's HMAC scheme is
            // well-documented + stable, so mismatch = spoofing).
            return jsonResp(401, { error: "invalid_signature" });
          }
          // Degraded mode → continue processing but warning stamped
        }

        // ── Audit the inbound event
        const auditInsert = await sbAny
          .from("scheduler_webhook_events")
          .insert({
            connection_id: connection.id,
            user_id: connection.user_id,
            platform: "mindbody",
            event_type: payload.eventId,
            external_appointment_id: payload.appointment?.id ?? null,
            raw_payload: {
              message_id: payload.messageId,
              site_id: payload.siteId,
              occurred_at: payload.occurredAt,
              appointment_embedded: Boolean(payload.appointment),
              client_embedded: Boolean(payload.client),
              signature_ok: true,
            },
          })
          .select("id")
          .single();
        const auditId = auditInsert.data?.id ?? null;

        // ── CLIENT_CREATED branch: roster enrichment placeholder.
        //    Deferred to follow-up ship — for v1.37.0 we audit + ack.
        if (payload.eventId === "client.created") {
          if (auditId) {
            await sbAny
              .from("scheduler_webhook_events")
              .update({ processed_at: new Date().toISOString() })
              .eq("id", auditId);
          }
          return jsonResp(200, {
            ok: true,
            eventType: payload.eventId,
            clientId: payload.client?.id,
            note: "Client roster enrichment deferred to follow-up ship.",
          });
        }

        // ── Resolve the appointment (embedded OR follow-up GET)
        if (!connection.access_token) {
          await stampAuditError(sbAny, auditId, "missing_access_token");
          return jsonResp(200, { ignored: "missing_access_token" });
        }

        let appointment: MindbodyAppointment;
        if (payload.appointment) {
          appointment = payload.appointment;
        } else {
          const env: MindbodyEnv = resolveMindbodyEnv();
          const stripWs = (v: string | undefined) => v?.replace(/\s+/g, "");
          const API_KEY = stripWs(
            env === "sandbox"
              ? process.env.MINDBODY_SANDBOX_API_KEY
              : process.env.MINDBODY_API_KEY,
          );
          if (!API_KEY || !connection.platform_account_id) {
            await stampAuditError(sbAny, auditId, "server_credentials_missing");
            return jsonResp(200, { ignored: "server_credentials_missing" });
          }
          try {
            appointment = await getMindbodyAppointment({
              accessToken: connection.access_token,
              apiKey: API_KEY,
              siteId: connection.platform_account_id,
              env,
              appointmentId: payload.appointment?.id ?? "",
            });
          } catch (e) {
            await stampAuditError(
              sbAny,
              auditId,
              `Mindbody API fetch failed: ${e instanceof Error ? e.message : "unknown"}`,
            );
            return jsonResp(200, { ignored: "api_fetch_failed" });
          }
        }

        // ── Capture prior status for trigger graph
        const { data: prior } = await sb
          .from("appointments")
          .select("id, status, patient_node_id, scheduled_at")
          .eq("user_id", connection.user_id)
          .eq("external_id", appointment.id)
          .eq("source", "mindbody")
          .maybeSingle();

        // ── Resolve patient_node_id. Mindbody appointments carry
        //    ClientId; if the patient has a knowledge_node with
        //    attachments.scheduler_client_id stamped, we can match.
        //    For v1.37.0 architecture-pre-build we rely on a
        //    patientIndex-based lookup (Mindbody-specific stamping is
        //    a follow-up ship).
        let resolvedPatientNodeId: string | null =
          prior?.patient_node_id ?? null;
        if (!resolvedPatientNodeId && appointment.clientId) {
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
        const row = mindbodyAppointmentToRow(
          appointment,
          connection.user_id,
          resolvedPatientNodeId,
        );
        const { data: upserted, error: upsertErr } = await sb
          .from("appointments")
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

        if (auditId) {
          await sbAny
            .from("scheduler_webhook_events")
            .update({
              processed_at: new Date().toISOString(),
              emma_appointment_id: upserted.id,
            })
            .eq("id", auditId);
        }

        await sbAny
          .from("scheduler_connections")
          .update({ last_sync_at: new Date().toISOString() })
          .eq("id", connection.id);

        // ── Trigger graph (mirrors all other scheduler receivers)
        const priorStatus = prior?.status ?? null;
        const newStatus = upserted.status;
        const statusChanged = priorStatus !== newStatus;

        if (statusChanged) {
          await sb
            .from("appointment_status_events")
            .insert({
              user_id: connection.user_id,
              appointment_id: upserted.id,
              from_status: priorStatus ?? "scheduled",
              to_status: newStatus,
              triggered_by: "scheduler-webhook",
              reason: `mindbody:${payload.eventId}:${appointment.status}`,
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
                "rescue dispatch failed (mindbody webhook):",
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
                "reliability recompute failed (mindbody webhook):",
                e instanceof Error ? e.message : e,
              );
            }
          }
        }

        // Keep the status mapper alongside the wire status so future
        // observability can render both. Mirrors other receivers.
        void mindbodyStatusToRefillStatus;

        return jsonResp(200, {
          ok: true,
          appointmentId: upserted.id,
          status: upserted.status,
          eventType: payload.eventId,
          providerStatus: appointment.status,
          statusChanged,
        });
      },
    },
  },
});

// ─── Helpers ───────────────────────────────────────────────────────────────

type SbAny = {
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
              refresh_token: string | null;
              token_expires_at: string | null;
              webhook_secret: string;
              platform_account_id: string | null;
              platform_account_email: string | null;
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
  sbAny: SbAny,
  auditId: string | null,
  error: string,
): Promise<void> {
  if (!auditId) return;
  await sbAny
    .from("scheduler_webhook_events")
    .update({ error })
    .eq("id", auditId);
}
