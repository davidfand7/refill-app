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
 *   4. Audits the inbound event in scheduler_webhook_events
 *   5. Fetches the full appointment from Acuity API (webhook body is thin)
 *   6. Upserts into appointments — which fires the existing
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
  decideWebhookSignatureAction,
  getAcuityAppointment,
  parseAcuityWebhookBody,
  probeAcuityWebhookSignature,
  type AcuityAppointment,
} from "@/lib/schedulers/acuity";
import {
  buildPatientIndex,
  matchPatientFromIndex,
} from "@/server/emma-appointments.functions";
import { buildAcuityProviderIndex } from "@/server/emma-scheduler.functions";

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
        const ACUITY_CLIENT_ID = process.env.ACUITY_CLIENT_ID ?? null;
        if (!SUPABASE_URL || !SERVICE_KEY || !ACUITY_CLIENT_SECRET) {
          return jsonResp(500, { error: "Server not configured" });
        }

        const sb = createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
          auth: { persistSession: false, autoRefreshToken: false },
        });
        const sbAny = sb as unknown as SbScheduleAny;

        // ── Look up the connection
        const { data: connection } = await sbAny
          .from("scheduler_connections")
          .select(
            "id, user_id, status, access_token, refresh_token, webhook_signature_verified_at",
          )
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

        // v2.47.0: signature verification is SELF-CALIBRATING.
        // Acuity's docs say dynamic (OAuth) webhooks are signed with the
        // *account API key* — which an OAuth integration doesn't hold — and
        // real deliveries don't validate against our OAuth client_secret
        // (production confirmed 772/772 fail). So we probe every credential we
        // DO possess against the live signature and record which scheme
        // matched, to learn Acuity's actual signing key from the audit trail.
        // Until a connection has produced ≥1 valid signature we stay ADVISORY
        // (the 48-char path secret is the gate); once proven, an invalid
        // signature on that connection is a forgery and is hard-rejected. This
        // can never silently drop a working feed.
        //
        // v2.49.0 — CONCLUSION (verified on real deliveries 2026-06-15): the
        // scheme stays NULL — NONE of the credentials we hold (access_token,
        // client_secret, refresh_token, client_id) match, confirming Acuity
        // signs with the account API key we can't obtain via OAuth. DECISION:
        // the path secret IS the gate (≈192-bit bearer, server-to-server over
        // TLS); this probe + latch are intentionally kept DORMANT — they
        // auto-arm only if a matching key is ever captured (e.g. an optional
        // onboarding API-key paste). This is a settled posture, not an open
        // investigation. See project_calendar_mirror_state.
        const probe = await probeAcuityWebhookSignature({
          rawBody,
          signatureHeader: signature,
          candidates: [
            { keyName: "access_token", key: connection.access_token },
            { keyName: "client_secret", key: ACUITY_CLIENT_SECRET },
            { keyName: "refresh_token", key: connection.refresh_token },
            { keyName: "client_id", key: ACUITY_CLIENT_ID },
          ],
        });
        const sigOk = probe.matched;
        const alreadyVerified = Boolean(connection.webhook_signature_verified_at);
        const sigDecision = decideWebhookSignatureAction({ sigOk, alreadyVerified });

        // First proof of this connection's signing key — latch it on so future
        // invalid signatures become rejectable forgeries.
        if (sigDecision.stampVerified) {
          await sbAny
            .from("scheduler_connections")
            .update({ webhook_signature_verified_at: new Date().toISOString() })
            .eq("id", connection.id);
          console.warn(
            `[acuity-webhook] signature scheme proven for connection ${connection.id}: ${probe.scheme}`,
          );
        }

        // Key is proven for this connection and this body's signature is bad →
        // forgery. Reject loudly (audit row + 401) WITHOUT advancing
        // last_sync_at, so a real key-rotation break surfaces via S3
        // appointment-freshness rather than passing silently.
        if (sigDecision.reject) {
          await sbAny.from("scheduler_webhook_events").insert({
            connection_id: connection.id,
            user_id: connection.user_id,
            platform: "acuity",
            event_type: "signature_rejected",
            raw_payload: {
              signature_header_present: Boolean(signature),
              rawBody: rawBody.slice(0, 500),
            },
            error:
              "HMAC signature invalid on a connection whose signing key was previously proven — rejected as forgery",
          });
          return jsonResp(401, { error: "invalid_signature" });
        }

        if (!sigOk) {
          console.warn(
            `[acuity-webhook] signature unverified on connection ${connection.id}; continuing in advisory mode (no scheme matched yet)`,
          );
        }

        // ── Parse the event
        const payload = parseAcuityWebhookBody(rawBody);
        if (!payload) {
          await sbAny.from("scheduler_webhook_events").insert({
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
          .from("scheduler_webhook_events")
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
              signature_scheme: probe.scheme,
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
          .from("appointments")
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

        // ── Upsert into appointments. Resolve provider_id continuously
        // from the Acuity calendarID → the mirrored provider's external_id, so
        // the appointment is linked to its native provider without waiting for
        // a manual staging-mirror re-run (v2.42.0). Best-effort: an unmapped
        // calendar just leaves provider_id null (provider_name still set).
        let providerId: string | null = null;
        try {
          const providerIndex = await buildAcuityProviderIndex(sb, connection.user_id);
          providerId = providerIndex.get(String(acuityApt.calendarID)) ?? null;
        } catch (e) {
          console.error("[acuity/webhook] provider resolve failed:", e instanceof Error ? e.message : e);
        }
        const row = acuityAppointmentToInsert(
          acuityApt,
          connection.user_id,
          resolvedPatientNodeId,
          providerId,
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

        // ── Stamp audit row with success + the appointment id we wrote
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

        // ── Trigger graph (mirrors updateAppointmentStatus exactly)
        // Only fire when this webhook actually CHANGED status — webhook
        // re-deliveries shouldn't re-trigger the engine.
        const priorStatus = prior?.status ?? null;
        const newStatus = upserted.status;
        const statusChanged = priorStatus !== newStatus;

        if (statusChanged) {
          // Audit the status transition (best-effort).
          await sb
            .from("appointment_status_events")
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

          // At-booking VIP early-access ask (Slice 1). The FIRST time an
          // appointment transitions into 'scheduled' (no prior row) and it's
          // future-dated, offer the patient first dibs on earlier openings.
          // All real gating (per-spa opt-in, ≥7-day lead, one-ask-per-patient,
          // phone present) lives in dispatchAtBookingAsk — kept here minimal.
          if (
            newStatus === "scheduled" &&
            priorStatus === null &&
            futureScheduled
          ) {
            try {
              const { dispatchAtBookingAsk } = await import(
                "@/server/emma-rescue.functions"
              );
              await dispatchAtBookingAsk({
                sb,
                userId: connection.user_id,
                appointmentId: upserted.id,
              });
            } catch (e) {
              console.error(
                "at-booking ask failed (webhook):",
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
            refresh_token: string | null;
            webhook_signature_verified_at: string | null;
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
    .from("scheduler_webhook_events")
    .update({ error })
    .eq("id", auditId);
}

function acuityAppointmentToInsert(
  apt: AcuityAppointment,
  userId: string,
  patientNodeId: string | null,
  providerId: string | null = null,
): Database["public"]["Tables"]["appointments"]["Insert"] {
  // v1.4.3: parse Acuity's timezone-aware datetime properly. See twin
  // helper in src/server/emma-scheduler.functions.ts for the war story.
  const scheduledAt = new Date(apt.datetime ?? "").toISOString();
  const status: Database["public"]["Tables"]["appointments"]["Insert"]["status"] = apt.canceled
    ? "cancelled"
    : apt.noShow
      ? "no_show"
      : "scheduled";
  const base: Database["public"]["Tables"]["appointments"]["Insert"] = {
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
  // v2.46.0: persist the patient's identity from the Acuity payload so the
  // calendar shows a name even before a knowledge_node match. Same upsert-
  // preserve idiom as patient_node_id (omit-when-absent → never wipe on re-delivery).
  const fullName = `${apt.firstName ?? ""} ${apt.lastName ?? ""}`.trim();
  if (fullName) base.booking_name = fullName;
  if (apt.email) base.booking_email = apt.email;
  if (apt.phone) base.booking_phone = apt.phone;
  // Only attach patient_node_id when we have a confident match — omitting
  // the key (vs. setting null) lets the upsert preserve any existing link
  // on the row when our match misses on a re-delivery.
  if (patientNodeId) {
    base.patient_node_id = patientNodeId;
  }
  if (providerId) {
    base.provider_id = providerId;
  }
  return base;
}
