/**
 * Vagaro webhook receiver (v1.38.0). Per-spa path secret. Shared-token
 * X-Vagaro-Signature verify (NOT HMAC). Degraded-mode fallback when
 * secret missing.
 */

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import {
  getVagaroAppointment,
  parseVagaroWebhookBody,
  VAGARO_WEBHOOK_SIGNATURE_HEADER,
  vagaroStatusToRefillStatus,
  verifyVagaroWebhookSignature,
  type VagaroAppointment,
} from "@/lib/schedulers/vagaro";
import { vagaroAppointmentToRow } from "@/server/emma-scheduler.functions";
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
  "/api/webhooks/scheduler/vagaro/$secret",
)({
  server: {
    handlers: {
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

        const rawBody = await request.text();
        const signature = request.headers.get(VAGARO_WEBHOOK_SIGNATURE_HEADER);

        const payload = parseVagaroWebhookBody(rawBody);
        if (!payload) {
          await sbAny.from("scheduler_webhook_events").insert({
            connection_id: null,
            user_id: null,
            platform: "vagaro",
            event_type: "unparseable",
            raw_payload: { rawBody: rawBody.slice(0, 500) },
            error: "Could not parse Vagaro webhook envelope",
          });
          return jsonResp(200, { ignored: "unparseable" });
        }

        const { data: connection } = await sbAny
          .from("scheduler_connections")
          .select(
            "id, user_id, status, access_token, platform_account_id, platform_account_email",
          )
          .eq("platform", "vagaro")
          .eq("webhook_secret", secret)
          .maybeSingle();

        if (!connection) {
          return jsonResp(200, { ignored: "unknown_secret" });
        }
        if (connection.status === "disconnected") {
          return jsonResp(200, { ignored: "disconnected" });
        }

        // Shared-token verify. The token lives in platform_account_email
        // per the same architecture-stub overload as Mindbody.
        const sharedToken = connection.platform_account_email ?? "";
        const sigOk = verifyVagaroWebhookSignature({
          signatureHeader: signature,
          sharedToken,
        });
        if (!sigOk) {
          await sbAny.from("scheduler_webhook_events").insert({
            connection_id: connection.id,
            user_id: connection.user_id,
            platform: "vagaro",
            event_type: payload.type,
            external_appointment_id: payload.appointment?.id ?? null,
            raw_payload: {
              event_id: payload.eventId,
              merchant_id: payload.merchantId,
              signature_header_present: Boolean(signature),
              signature_secret_present: Boolean(sharedToken),
            },
            error: sharedToken
              ? "Shared-token mismatch"
              : "Connection has no shared token — accepted in degraded mode",
          });
          if (sharedToken) {
            return jsonResp(401, { error: "invalid_signature" });
          }
          // Degraded mode continues processing
        }

        const auditInsert = await sbAny
          .from("scheduler_webhook_events")
          .insert({
            connection_id: connection.id,
            user_id: connection.user_id,
            platform: "vagaro",
            event_type: payload.type,
            external_appointment_id: payload.appointment?.id ?? null,
            raw_payload: {
              event_id: payload.eventId,
              merchant_id: payload.merchantId,
              occurred_at: payload.occurredAt,
              appointment_embedded: Boolean(payload.appointment),
              customer_embedded: Boolean(payload.customer),
              signature_ok: true,
            },
          })
          .select("id")
          .single();
        const auditId = auditInsert.data?.id ?? null;

        // Customer events: ack + defer roster enrichment
        if (payload.type.startsWith("customer.")) {
          if (auditId) {
            await sbAny
              .from("scheduler_webhook_events")
              .update({ processed_at: new Date().toISOString() })
              .eq("id", auditId);
          }
          return jsonResp(200, {
            ok: true,
            eventType: payload.type,
            customerId: payload.customer?.id,
            note: "Customer roster enrichment deferred to follow-up ship.",
          });
        }

        // Appointment events
        if (!connection.access_token) {
          await stampAuditError(sbAny, auditId, "missing_api_key");
          return jsonResp(200, { ignored: "missing_api_key" });
        }

        let appointment: VagaroAppointment;
        if (payload.appointment) {
          appointment = payload.appointment;
        } else if (payload.eventId) {
          try {
            appointment = await getVagaroAppointment({
              credentials: { apiKey: connection.access_token, merchantId: "" },
              appointmentId: payload.appointment?.id ?? "",
            });
          } catch (e) {
            await stampAuditError(
              sbAny,
              auditId,
              `Vagaro API fetch failed: ${e instanceof Error ? e.message : "unknown"}`,
            );
            return jsonResp(200, { ignored: "api_fetch_failed" });
          }
        } else {
          await stampAuditError(sbAny, auditId, "missing_appointment_id");
          return jsonResp(200, { ignored: "missing_appointment_id" });
        }

        const { data: prior } = await sb
          .from("appointments")
          .select("id, status, patient_node_id, scheduled_at")
          .eq("user_id", connection.user_id)
          .eq("external_id", appointment.id)
          .eq("source", "vagaro")
          .maybeSingle();

        let resolvedPatientNodeId: string | null = prior?.patient_node_id ?? null;
        if (!resolvedPatientNodeId && appointment.customerId) {
          const patientIndex = await buildPatientIndex(sb, connection.user_id);
          resolvedPatientNodeId = matchPatientFromIndex(
            { patientFirstName: null, patientLastName: null, patientPhone: null, patientEmail: null },
            patientIndex,
          );
        }

        const row = vagaroAppointmentToRow(
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
          await stampAuditError(sbAny, auditId, `Upsert failed: ${upsertErr?.message ?? "unknown"}`);
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
              reason: `vagaro:${payload.type}:${appointment.status}`,
            })
            .then(({ error }) => {
              if (error) console.error("audit insert failed:", error.message);
            });

          const futureScheduled = new Date(upserted.scheduled_at).getTime() > Date.now();
          if ((newStatus === "cancelled" || newStatus === "no_show") && futureScheduled) {
            try {
              const { dispatchRescueAttempt } = await import("@/server/emma-rescue.functions");
              await dispatchRescueAttempt({ sb, userId: connection.user_id, appointmentId: upserted.id });
            } catch (e) {
              console.error("rescue dispatch failed (vagaro webhook):", e instanceof Error ? e.message : e);
            }
          }
          if (upserted.patient_node_id && ["showed", "no_show", "cancelled"].includes(newStatus)) {
            try {
              const { recomputeReliabilityForPatient } = await import("@/server/emma-reliability.functions");
              await recomputeReliabilityForPatient({
                sb,
                userId: connection.user_id,
                patientNodeId: upserted.patient_node_id,
              });
            } catch (e) {
              console.error("reliability recompute failed (vagaro webhook):", e instanceof Error ? e.message : e);
            }
          }
        }

        void vagaroStatusToRefillStatus;

        return jsonResp(200, {
          ok: true,
          appointmentId: upserted.id,
          status: upserted.status,
          eventType: payload.type,
          providerStatus: appointment.status,
          statusChanged,
        });
      },
    },
  },
});

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
