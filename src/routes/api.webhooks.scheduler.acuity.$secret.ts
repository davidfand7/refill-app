/**
 * Acuity webhook receiver — POST /api/webhooks/scheduler/acuity/:secret (v381).
 *
 * Acuity sends one POST per appointment lifecycle event to this URL,
 * with the per-spa webhook_secret embedded in the path. The receiver:
 *
 *   1. Looks up the connection row by webhook_secret
 *   2. Verifies the X-Acuity-Signature HMAC against the raw body using
 *      the OAuth app's client_secret
 *   3. Parses the form-encoded body for action + appointmentId
 *   4. Audits the inbound event in emma_scheduler_webhook_events
 *   5. Fetches the full appointment from Acuity API (webhook body is thin)
 *   6. Upserts into emma_appointments — which fires the existing
 *      updateAppointmentStatus trigger graph → rescue dispatch → engine
 *
 * Always returns 200 (even on most errors) so Acuity doesn't retry forever
 * — failures are captured in the audit row's `error` column instead, so
 * we can replay missed events from the audit table during reconcile.
 *
 * Required env: ACUITY_CLIENT_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import {
  getAcuityAppointment,
  parseAcuityWebhookBody,
  verifyAcuityWebhookSignature,
  type AcuityAppointment,
} from "@/lib/schedulers/acuity";
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

export const Route = createFileRoute("/api/webhooks/scheduler/acuity/$secret")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const { secret } = params;
        if (!secret || secret.length < 16) {
          return jsonResp(400, { error: "Invalid path" });
        }

        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
        const ACUITY_CLIENT_SECRET = process.env.ACUITY_CLIENT_SECRET;
        if (!SUPABASE_URL || !SERVICE_KEY || !ACUITY_CLIENT_SECRET) {
          return jsonResp(500, { error: "Server not configured" });
        }

        const sb = createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
          auth: { persistSession: false, autoRefreshToken: false },
        });
        const sbAny = sb as unknown as SbScheduleAny;

        // ── Look up the connection
        const { data: connection } = await sbAny
          .from("emma_scheduler_connections")
          .select("id, user_id, status, access_token")
          .eq("webhook_secret", secret)
          .maybeSingle();

        if (!connection) {
          // Unknown secret. Could be a stale Acuity webhook from a
          // disconnected spa. Acknowledge so they stop retrying.
          return jsonResp(200, { ignored: "unknown_secret" });
        }

        if (connection.status === "disconnected") {
          return jsonResp(200, { ignored: "disconnected" });
        }

        // ── Read raw body + signature
        const rawBody = await request.text();
        const signature = request.headers.get("x-acuity-signature");

        // v381: signature verification is ADVISORY only.
        // Acuity's docs are ambiguous on whether OAuth-registered
        // ("dynamic") webhooks sign with the OAuth client_secret or
        // with a per-account API key. We attempt verification with the
        // client_secret; if it fails we still process the event but
        // audit the mismatch so we can investigate. The per-spa
        // webhook_secret in the URL path provides primary defense — a
        // caller without that 48-char hex secret can't reach this
        // handler. Once we observe a real Acuity webhook in production
        // and can compare its header to multiple candidate keys, we
        // tighten this to a hard reject.
        const sigOk = await verifyAcuityWebhookSignature({
          rawBody,
          signatureHeader: signature,
          clientSecret: ACUITY_CLIENT_SECRET,
        });

        if (!sigOk) {
          console.warn(
            `[acuity-webhook] signature mismatch on connection ${connection.id}; continuing in advisory mode`,
          );
        }

        // ── Parse the event
        const payload = parseAcuityWebhookBody(rawBody);
        if (!payload) {
          await sbAny.from("emma_scheduler_webhook_events").insert({
            connection_id: connection.id,
            user_id: connection.user_id,
            platform: "acuity",
            event_type: "unparseable",
            raw_payload: { rawBody: rawBody.slice(0, 500) },
            error: "Could not parse action + id from body",
          });
          return jsonResp(200, { ignored: "unparseable" });
        }

        // ── Audit the inbound event (best-effort, do not block downstream)
        const auditInsert = await sbAny
          .from("emma_scheduler_webhook_events")
          .insert({
            connection_id: connection.id,
            user_id: connection.user_id,
            platform: "acuity",
            event_type: payload.action,
            external_appointment_id: payload.appointmentId,
            raw_payload: {
              action: payload.action,
              id: payload.appointmentId,
              calendarID: payload.calendarId,
              appointmentTypeID: payload.appointmentTypeId,
              signature_ok: sigOk,
              signature_header_present: Boolean(signature),
            },
          })
          .select("id")
          .single();
        const auditId = auditInsert.data?.id ?? null;

        // ── Fetch the full appointment from Acuity
        if (!connection.access_token) {
          await stampAuditError(sbAny, auditId, "missing_access_token");
          return jsonResp(200, { ignored: "missing_access_token" });
        }

        let acuityApt: AcuityAppointment;
        try {
          acuityApt = await getAcuityAppointment(
            connection.access_token,
            payload.appointmentId,
          );
        } catch (e) {
          await stampAuditError(
            sbAny,
            auditId,
            `Acuity API fetch failed: ${e instanceof Error ? e.message : "unknown"}`,
          );
          return jsonResp(200, { ignored: "api_fetch_failed" });
        }

        // ── Capture the prior status (if any) BEFORE upserting so we
        //    can detect status transitions and fire the same trigger
        //    graph that updateAppointmentStatus fires on UI-driven flips.
        const { data: prior } = await sb
          .from("emma_appointments")
          .select("id, status, patient_node_id, scheduled_at")
          .eq("user_id", connection.user_id)
          .eq("external_id", String(acuityApt.id))
          .eq("source", "acuity")
          .maybeSingle();

        // ── Resolve patient_node_id from existing knowledge_nodes roster
        //    (v381.5). Acuity webhook payloads carry firstName/lastName/
        //    phone/email but the v381 ingest path was dropping them on
        //    the floor — every live-API row landed with patient_node_id
        //    null, so Emma's schedule view showed blank names. We build
        //    the per-spa index here and apply the same (phone → email →
        //    name) cascade used by the CSV ingest path. Conditional
        //    assignment below preserves any prior manual link if our
        //    match misses.
        const patientIndex = await buildPatientIndex(sb, connection.user_id);
        const resolvedPatientNodeId = matchPatientFromIndex(
          {
            patientFirstName: acuityApt.firstName || null,
            patientLastName: acuityApt.lastName || null,
            patientPhone: acuityApt.phone || null,
            patientEmail: acuityApt.email || null,
          },
          patientIndex,
        );

        // ── Upsert into emma_appointments
        const row = acuityAppointmentToInsert(
          acuityApt,
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

        // ── Stamp audit row with success + the appointment id we wrote
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

        // ── Trigger graph (mirrors updateAppointmentStatus exactly)
        // Only fire when this webhook actually CHANGED status — webhook
        // re-deliveries shouldn't re-trigger the engine.
        const priorStatus = prior?.status ?? null;
        const newStatus = upserted.status;
        const statusChanged = priorStatus !== newStatus;

        if (statusChanged) {
          // Audit the status transition (best-effort).
          await sb
            .from("emma_appointment_status_events")
            .insert({
              user_id: connection.user_id,
              appointment_id: upserted.id,
              from_status: priorStatus ?? "scheduled",
              to_status: newStatus,
              triggered_by: "scheduler-webhook",
              reason: `acuity:${payload.action}`,
            })
            .then(({ error }) => {
              if (error) console.error("audit insert failed:", error.message);
            });

          const futureScheduled =
            new Date(upserted.scheduled_at).getTime() > Date.now();

          // Same-day rescue dispatch.
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
                "rescue dispatch failed (webhook):",
                e instanceof Error ? e.message : e,
              );
            }
          }

          // Reliability recompute on the load-bearing transitions.
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
                "reliability recompute failed (webhook):",
                e instanceof Error ? e.message : e,
              );
            }
          }
        }

        return jsonResp(200, {
          ok: true,
          appointmentId: upserted.id,
          status: upserted.status,
          action: payload.action,
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
        maybeSingle: () => Promise<{
          data: {
            id: string;
            user_id: string;
            status: string;
            access_token: string | null;
          } | null;
          error: { message: string } | null;
        }>;
      };
    };
    insert: (v: object) => {
      select: (c: string) => {
        single: () => Promise<{ data: { id: string } | null; error: { message: string } | null }>;
      };
    } & Promise<{ error: { message: string } | null }>;
    update: (v: object) => {
      eq: (c: string, v: string) => Promise<{ error: { message: string } | null }>;
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

function acuityAppointmentToInsert(
  apt: AcuityAppointment,
  userId: string,
  patientNodeId: string | null,
): Database["public"]["Tables"]["emma_appointments"]["Insert"] {
  const scheduledAt = (apt.datetime ?? "").replace(/[+-]\d{4}$/, "Z");
  const status: Database["public"]["Tables"]["emma_appointments"]["Insert"]["status"] = apt.canceled
    ? "cancelled"
    : apt.noShow
      ? "no_show"
      : "scheduled";
  const base: Database["public"]["Tables"]["emma_appointments"]["Insert"] = {
    user_id: userId,
    external_id: String(apt.id),
    source: "acuity",
    scheduled_at: scheduledAt,
    duration_min: Number(apt.duration) || 0,
    treatment_type: apt.type || null,
    provider_name: apt.calendar || null,
    status,
    notes: apt.notes || null,
  };
  // Only attach patient_node_id when we have a confident match — omitting
  // the key (vs. setting null) lets the upsert preserve any existing link
  // on the row when our match misses on a re-delivery.
  if (patientNodeId) {
    base.patient_node_id = patientNodeId;
  }
  return base;
}
