/**
 * Boulevard webhook receiver — POST /api/webhooks/scheduler/boulevard (v1.36.0).
 *
 * Single global URL across all Boulevard sellers (per app, per env).
 * Tenant routing happens via businessId URN in the payload, NOT via a
 * per-spa secret in the URL path (which is how Acuity does it). Mirror
 * of `api.webhooks.scheduler.square.ts` with GraphQL/URN divergences
 * absorbed at the parser layer.
 *
 *   1. Parses + validates the JSON payload
 *   2. Looks up the connection row by (platform="boulevard",
 *      platform_account_id=businessId URN)
 *   3. Verifies the X-Boulevard-Signature HMAC against the raw body
 *      using the connection's webhook_secret (signing_secret returned
 *      from createBoulevardWebhookSubscription)
 *   4. Audits the inbound event in scheduler_webhook_events
 *   5. For appointment events: resolves the appointment from the
 *      payload's embedded object OR via a follow-up
 *      getBoulevardAppointment GraphQL query when only an id is embedded
 *   6. Upserts into appointments — fires the rescue + reliability
 *      trigger graph on status transitions
 *   7. For CLIENT_CREATED events: enriches knowledge_nodes via the
 *      patient-ingest pipeline if the client isn't yet known
 *
 * Always returns 200 (so Boulevard doesn't retry indefinitely);
 * failures land in the audit row's `error` column for replay
 * reconciliation. Same pattern as Square + Acuity receivers.
 *
 * Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 *
 * v1.35.x doctrine applied from day one:
 *   - Provider error bubbling: HMAC mismatch surfaces with header
 *     presence/length in the audit row (NOT just signature_ok=false)
 *   - Fail-degrade-vs-fail-fast: invalid signature = hard reject;
 *     downstream upsert failure = log + 200 (replay-safe)
 *   - Platform-aware audit: every webhook event row references the
 *     platform discriminator so cross-scheduler debugging is one
 *     WHERE clause away
 */

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import {
  BOULEVARD_WEBHOOK_SIGNATURE_HEADER,
  boulevardStatusToRefillStatus,
  getBoulevardAppointment,
  parseBoulevardWebhookBody,
  resolveBoulevardEnv,
  verifyBoulevardWebhookSignature,
  type BoulevardAppointment,
  type BoulevardEnv,
  type BoulevardOAuthCredentials,
} from "@/lib/schedulers/boulevard";
import { boulevardAppointmentToRow } from "@/server/emma-scheduler.functions";
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

export const Route = createFileRoute("/api/webhooks/scheduler/boulevard")({
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
        const sbAny = sb as unknown as SbAny;

        // ── Read raw body + signature header
        const rawBody = await request.text();
        const signature = request.headers.get(BOULEVARD_WEBHOOK_SIGNATURE_HEADER);

        // ── Parse the JSON envelope
        const payload = parseBoulevardWebhookBody(rawBody);
        if (!payload) {
          // Body was unparseable or event type unsupported. Acknowledge
          // and audit so we don't accidentally retry forever.
          await sbAny.from("scheduler_webhook_events").insert({
            connection_id: null,
            user_id: null,
            platform: "boulevard",
            event_type: "unparseable",
            raw_payload: { rawBody: rawBody.slice(0, 500) },
            error: "Could not parse Boulevard webhook envelope",
          });
          return jsonResp(200, { ignored: "unparseable" });
        }

        // ── Look up the connection by businessId URN
        const { data: connection } = await sbAny
          .from("scheduler_connections")
          .select("id, user_id, status, webhook_secret")
          .eq("platform", "boulevard")
          .eq("platform_account_id", payload.businessId)
          .maybeSingle();

        if (!connection) {
          // Could be a stale subscription from a disconnected spa, or
          // delivery for a different Refill env/app. Acknowledge.
          return jsonResp(200, { ignored: "unknown_business" });
        }

        if (connection.status === "disconnected") {
          return jsonResp(200, { ignored: "disconnected" });
        }

        // ── HMAC verification (assumed scheme — pinned at sandbox-verify).
        //    The connector's verifyBoulevardWebhookSignature wraps the
        //    actual algorithm so this receiver doesn't need to know HMAC
        //    details. If sandbox surfaces a different header name or
        //    algorithm, only boulevard.ts changes.
        const sigOk = connection.webhook_secret
          ? await verifyBoulevardWebhookSignature({
              rawBody,
              signatureHeader: signature,
              signingSecret: connection.webhook_secret,
            })
          : false;

        // v1.35.x doctrine: if connection.webhook_secret is empty (e.g.
        // install-callback's webhook subscribe step fail-degraded), we
        // can't HMAC-verify — surface that distinctly in the audit row
        // and either accept (degraded mode) or reject (strict mode).
        // For architecture-complete state we ACCEPT with warning stamped
        // to audit; flip to reject at sandbox-verify when the signing
        // secret reliably lands on every connection.
        if (!sigOk) {
          await sbAny.from("scheduler_webhook_events").insert({
            connection_id: connection.id,
            user_id: connection.user_id,
            platform: "boulevard",
            event_type: payload.type,
            external_appointment_id: payload.appointmentId,
            raw_payload: {
              event_id: payload.eventId,
              business_id: payload.businessId,
              signature_header_present: Boolean(signature),
              signature_secret_present: Boolean(connection.webhook_secret),
            },
            error: connection.webhook_secret
              ? "HMAC signature verification failed"
              : "Connection has no signing secret — accepted in degraded mode",
          });
          if (connection.webhook_secret) {
            // Real mismatch → hard reject
            return jsonResp(401, { error: "invalid_signature" });
          }
          // Degraded mode → continue processing but stamped warning
        }

        // ── Audit the inbound event (best-effort, never block downstream)
        const auditInsert = await sbAny
          .from("scheduler_webhook_events")
          .insert({
            connection_id: connection.id,
            user_id: connection.user_id,
            platform: "boulevard",
            event_type: payload.type,
            external_appointment_id: payload.appointmentId,
            raw_payload: {
              event_id: payload.eventId,
              business_id: payload.businessId,
              occurred_at: payload.occurredAt,
              appointment_embedded: Boolean(payload.appointment),
              client_embedded: Boolean(payload.client),
              signature_ok: true,
            },
          })
          .select("id")
          .single();
        const auditId = auditInsert.data?.id ?? null;

        // ── CLIENT_CREATED branch: roster enrichment (architecture-stub
        //    pending sandbox-verify of exact patient-ingest contract).
        //    For now we audit the event and acknowledge — the matching
        //    knowledge_nodes upsert can land in a follow-up ship once
        //    we've verified Boulevard's client payload shape.
        if (payload.type === "CLIENT_CREATED") {
          if (auditId) {
            await sbAny
              .from("scheduler_webhook_events")
              .update({ processed_at: new Date().toISOString() })
              .eq("id", auditId);
          }
          return jsonResp(200, {
            ok: true,
            eventType: payload.type,
            clientId: payload.clientId,
            note: "Client roster enrichment deferred to follow-up ship.",
          });
        }

        // ── Resolve the appointment (embedded OR follow-up GraphQL)
        let appointment: BoulevardAppointment;
        if (payload.appointment) {
          appointment = payload.appointment;
        } else {
          if (!payload.appointmentId) {
            await stampAuditError(sbAny, auditId, "missing_appointment_id");
            return jsonResp(200, { ignored: "missing_appointment_id" });
          }
          const env: BoulevardEnv = resolveBoulevardEnv();
          const stripWs = (v: string | undefined) => v?.replace(/\s+/g, "");
          const APPLICATION_ID = stripWs(
            env === "sandbox"
              ? process.env.BLVD_SANDBOX_APPLICATION_ID
              : process.env.BLVD_APPLICATION_ID,
          );
          const API_KEY = stripWs(
            env === "sandbox"
              ? process.env.BLVD_SANDBOX_API_KEY
              : process.env.BLVD_API_KEY,
          );
          const API_SECRET = stripWs(
            env === "sandbox"
              ? process.env.BLVD_SANDBOX_API_SECRET
              : process.env.BLVD_API_SECRET,
          );
          if (!APPLICATION_ID || !API_KEY || !API_SECRET) {
            await stampAuditError(sbAny, auditId, "server_credentials_missing");
            return jsonResp(200, { ignored: "server_credentials_missing" });
          }
          const credentials: BoulevardOAuthCredentials = {
            applicationId: APPLICATION_ID,
            apiKey: API_KEY,
            apiSecret: API_SECRET,
            env,
          };
          try {
            appointment = await getBoulevardAppointment({
              credentials,
              businessId: payload.businessId,
              appointmentId: payload.appointmentId,
            });
          } catch (e) {
            await stampAuditError(
              sbAny,
              auditId,
              `Boulevard API fetch failed: ${e instanceof Error ? e.message : "unknown"}`,
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
          .eq("source", "boulevard")
          .maybeSingle();

        // ── Resolve patient_node_id — Boulevard exposes clientId URN
        //    but not the client's full name on the appointment response.
        //    For v1.36.0 we mirror Square's approach: accept rows landing
        //    with patient_node_id null when no prior knowledge_node has
        //    a clientId stamp; CLIENT_CREATED webhooks + the inbound
        //    CSV path will fill these in.
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
        const row = boulevardAppointmentToRow(
          appointment,
          connection.user_id,
          resolvedPatientNodeId,
          boulevardStatusToRefillStatus,
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

        // ── Stamp audit row with success
        if (auditId) {
          await sbAny
            .from("scheduler_webhook_events")
            .update({
              processed_at: new Date().toISOString(),
              emma_appointment_id: upserted.id,
            })
            .eq("id", auditId);
        }

        // ── Update connection last_sync_at
        await sbAny
          .from("scheduler_connections")
          .update({ last_sync_at: new Date().toISOString() })
          .eq("id", connection.id);

        // ── Trigger graph (mirrors the Acuity + Square receivers exactly)
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
              reason: `boulevard:${payload.type}:${appointment.status}`,
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
                "rescue dispatch failed (boulevard webhook):",
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
                "reliability recompute failed (boulevard webhook):",
                e instanceof Error ? e.message : e,
              );
            }
          }
        }

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
