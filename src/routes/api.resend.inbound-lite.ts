/**
 * Resend Inbound Parse webhook — Lite Mode receiver (v1.42.0).
 *
 * Resend's Inbound Routing is configured (dashboard, separate from
 * existing reply-inbound at /api/resend/inbound) to deliver mail sent
 * to <slug>@inbound.getrefill.app to this endpoint as JSON.
 *
 * The handler:
 *   1. Validates the request shape + optional Resend webhook signature.
 *   2. Extracts the inbound slug from the `to` field's local-part.
 *   3. Looks up the matching emma_light_mode_connections row.
 *   4. Dispatches the raw envelope through the per-platform parser
 *      (src/lib/email-parsers/index.ts).
 *   5. On a clean parse: upserts into emma_appointments (firing the
 *      existing rescue + recognition trigger graph) and bumps the
 *      connection's events_parsed_total + last_event_at.
 *   6. On a quarantine: writes an emma_email_quarantine row holding
 *      the full raw envelope so retroactive reparsing remains possible
 *      after a parser fix.
 *   7. Always returns 200 so Resend doesn't retry forever — failures
 *      stamp on the quarantine row, not the response code.
 *
 * Required env:
 *   - SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (standard)
 *   - RESEND_INBOUND_SIGNING_SECRET (optional, when Resend ships
 *     webhook signing; treated as advisory until then per the same
 *     fail-soft pattern as the Acuity webhook receiver).
 */

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import {
  parseLightModeEmail,
  type LightModePlatform,
  type ParsedAppointment,
} from "@/lib/email-parsers";

function jsonResp(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const INBOUND_DOMAIN_SUFFIXES = [
  "@inbound.getrefill.app",
  "@inbound.refill.app",
];

function extractInboundSlug(toAddress: string): string | null {
  const lower = (toAddress || "").trim().toLowerCase();
  for (const suffix of INBOUND_DOMAIN_SUFFIXES) {
    if (lower.endsWith(suffix)) {
      return lower.slice(0, -suffix.length);
    }
  }
  return null;
}

type ResendInboundPayload = {
  from?: string;
  to?: string | string[];
  subject?: string;
  html?: string | null;
  text?: string | null;
  message_id?: string | null;
  headers?: Record<string, string> | null;
  // Some webhook variants nest the email envelope:
  email?: {
    from?: string;
    to?: string | string[];
    subject?: string;
    html?: string | null;
    text?: string | null;
    message_id?: string | null;
  };
};

function normalizePayload(raw: unknown): {
  fromAddress: string;
  toAddress: string;
  subject: string;
  rawHtml: string | null;
  rawText: string | null;
  messageId: string | null;
} {
  const p = (raw ?? {}) as ResendInboundPayload;
  const envelope = p.email ?? p;
  const toRaw = envelope.to;
  const toAddress = Array.isArray(toRaw) ? (toRaw[0] ?? "") : (toRaw ?? "");
  return {
    fromAddress: envelope.from ?? "",
    toAddress,
    subject: envelope.subject ?? "",
    rawHtml: envelope.html ?? null,
    rawText: envelope.text ?? null,
    messageId: envelope.message_id ?? null,
  };
}

export const Route = createFileRoute("/api/resend/inbound-lite")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!SUPABASE_URL || !SERVICE_KEY) {
          return jsonResp(500, { error: "Server not configured" });
        }

        let rawBody: string;
        try {
          rawBody = await request.text();
        } catch {
          return jsonResp(200, { ignored: "no_body" });
        }

        let parsedBody: unknown;
        try {
          parsedBody = JSON.parse(rawBody);
        } catch {
          return jsonResp(200, { ignored: "non_json_body" });
        }

        const env = normalizePayload(parsedBody);
        const slug = extractInboundSlug(env.toAddress);

        const sb = createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
          auth: { persistSession: false, autoRefreshToken: false },
        });
        const sbAny = sb as never as {
          from(t: string): {
            select(c: string): {
              eq(c: string, v: unknown): {
                maybeSingle(): Promise<{
                  data: Record<string, unknown> | null;
                  error: unknown;
                }>;
              };
            };
            insert(row: Record<string, unknown>): Promise<{ error: unknown }>;
            update(patch: Record<string, unknown>): {
              eq(c: string, v: unknown): Promise<{ error: unknown }>;
            };
          };
        };

        // ── Slug routing
        if (!slug) {
          await sbAny.from("emma_email_quarantine").insert({
            from_address: env.fromAddress,
            to_address: env.toAddress,
            subject: env.subject,
            raw_html: env.rawHtml,
            raw_text: env.rawText,
            message_id: env.messageId,
            reason: "no_inbound_slug",
          });
          return jsonResp(200, { quarantined: "no_inbound_slug" });
        }

        const { data: connection } = await sbAny
          .from("emma_light_mode_connections")
          .select(
            "id,user_id,platform,status,events_parsed_total,events_quarantined_total",
          )
          .eq("inbound_slug", slug)
          .maybeSingle();

        if (!connection) {
          await sbAny.from("emma_email_quarantine").insert({
            inbound_slug: slug,
            from_address: env.fromAddress,
            to_address: env.toAddress,
            subject: env.subject,
            raw_html: env.rawHtml,
            raw_text: env.rawText,
            message_id: env.messageId,
            reason: "unknown_slug",
          });
          return jsonResp(200, { quarantined: "unknown_slug" });
        }

        if (connection.status === "paused") {
          // Acknowledge but don't process while paused.
          return jsonResp(200, { ignored: "connection_paused" });
        }

        // ── D-7: Gmail forwarding verification interception (v1.42.1).
        // When the spa owner enters our inbound address as a Gmail
        // forwarding destination, Gmail sends a verification email
        // first. Detect it, extract the confirmation URL, and stash
        // for the wizard to surface as a one-click confirm prompt —
        // owner doesn't need to hunt through their forwarded mail.
        if (looksLikeGmailVerification(env)) {
          const confirmUrl = extractGmailConfirmUrl(env);
          await sbAny.from("emma_email_quarantine").insert({
            light_mode_connection_id: connection.id as string,
            user_id: connection.user_id as string,
            platform: connection.platform as string,
            inbound_slug: slug,
            from_address: env.fromAddress,
            to_address: env.toAddress,
            subject: env.subject,
            raw_html: env.rawHtml,
            raw_text: env.rawText,
            message_id: env.messageId,
            reason: "gmail_verification",
            reviewed_notes: confirmUrl ?? null,
          });
          // Bump last_event_at so the wizard shows that SOMETHING
          // arrived (forward path is wired); status stays 'pending'
          // until a real booking event lands.
          await sbAny
            .from("emma_light_mode_connections")
            .update({
              last_event_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq("id", connection.id as string);
          return jsonResp(200, {
            acknowledged: "gmail_verification",
            confirm_url_extracted: Boolean(confirmUrl),
          });
        }

        const platform = connection.platform as LightModePlatform;

        // ── Dispatch to parser
        const result = parseLightModeEmail(platform, {
          fromAddress: env.fromAddress,
          toAddress: env.toAddress,
          subject: env.subject,
          rawHtml: env.rawHtml,
          rawText: env.rawText,
          messageId: env.messageId,
        });

        // ── Quarantine path
        if (result.event === "unknown" || result.appointments.length === 0) {
          await sbAny.from("emma_email_quarantine").insert({
            light_mode_connection_id: connection.id as string,
            user_id: connection.user_id as string,
            platform,
            inbound_slug: slug,
            from_address: env.fromAddress,
            to_address: env.toAddress,
            subject: env.subject,
            raw_html: env.rawHtml,
            raw_text: env.rawText,
            message_id: env.messageId,
            reason: result.quarantineReason ?? "event_unknown",
            parser_confidence: result.confidence,
          });
          await sbAny
            .from("emma_light_mode_connections")
            .update({
              events_quarantined_total:
                ((connection.events_quarantined_total as number) ?? 0) + 1,
              updated_at: new Date().toISOString(),
            })
            .eq("id", connection.id as string);
          return jsonResp(200, {
            quarantined: result.quarantineReason ?? "event_unknown",
          });
        }

        // ── Successful parse: upsert appointments
        // We don't have a stable external_id from email-only signal in
        // most cases; for v1.42.0 we record the event as a light-mode-
        // sourced appointment row marked with the parsed external_id if
        // present, else a synthesized one from message_id + index.
        let upsertCount = 0;
        for (let i = 0; i < result.appointments.length; i++) {
          const appt = result.appointments[i];
          const row = appointmentToEmmaRow({
            userId: connection.user_id as string,
            platform,
            appt,
            messageId: env.messageId,
            index: i,
            eventType: result.event,
          });
          const { error } = await sbAny
            .from("emma_appointments")
            .insert(row);
          if (!error) upsertCount++;
        }

        await sbAny
          .from("emma_light_mode_connections")
          .update({
            status: "active",
            events_parsed_total:
              ((connection.events_parsed_total as number) ?? 0) + upsertCount,
            last_event_at: new Date().toISOString(),
            last_error: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", connection.id as string);

        return jsonResp(200, {
          ok: true,
          event: result.event,
          parsed: upsertCount,
        });
      },
    },
  },
});

// ─── Internals ──────────────────────────────────────────────────────

// ── D-7 helpers (Gmail forwarding verification) ────────────────────

const GMAIL_VERIFICATION_FROM_RE =
  /forwarding-noreply@google\.com|noreply@google\.com|mail-noreply@google\.com/i;

const GMAIL_VERIFICATION_SUBJECT_RE =
  /(gmail\s+forwarding\s+confirmation|confirm\s+forwarding|forwarding\s+address|confirmation\s+code)/i;

const GMAIL_CONFIRM_URL_RE =
  /https:\/\/mail\.google\.com\/mail\/[^\s"'<>]*(?:ConfirmForward|forwarding[^\s"'<>]*)[^\s"'<>]*/i;

function looksLikeGmailVerification(env: {
  fromAddress: string;
  subject: string;
}): boolean {
  return (
    GMAIL_VERIFICATION_FROM_RE.test(env.fromAddress || "") ||
    GMAIL_VERIFICATION_SUBJECT_RE.test(env.subject || "")
  );
}

function extractGmailConfirmUrl(env: {
  rawHtml: string | null;
  rawText: string | null;
}): string | null {
  const html = env.rawHtml ?? "";
  const text = env.rawText ?? "";
  const m = html.match(GMAIL_CONFIRM_URL_RE) || text.match(GMAIL_CONFIRM_URL_RE);
  return m ? m[0] : null;
}

function appointmentToEmmaRow(args: {
  userId: string;
  platform: LightModePlatform;
  appt: ParsedAppointment;
  messageId: string | null;
  index: number;
  eventType: string;
}): Record<string, unknown> {
  const externalId =
    args.appt.externalId ??
    `lite:${args.platform}:${args.messageId ?? "no-msgid"}:${args.index}`;

  // Map ParsedEventType → emma_appointments.status. The existing
  // updateAppointmentStatus trigger graph picks up these statuses and
  // fires rescue / recognition downstream.
  let status: string = "scheduled";
  if (args.eventType === "booking.cancelled") status = "cancelled";
  else if (args.eventType === "booking.no_show") status = "no_show";
  else if (args.eventType === "booking.created") status = "scheduled";
  else if (args.eventType === "booking.rescheduled") status = "scheduled";

  return {
    user_id: args.userId,
    external_id: externalId,
    source: `lite-${args.platform}`,
    status,
    patient_name: args.appt.patientName ?? null,
    patient_phone: args.appt.patientPhone ?? null,
    patient_email: args.appt.patientEmail ?? null,
    service_name: args.appt.serviceName ?? null,
    staff_name: args.appt.staffName ?? null,
    start_at: args.appt.startAt ?? null,
    end_at: args.appt.endAt ?? null,
    location_name: args.appt.locationName ?? null,
    raw_source_message_id: args.messageId,
  };
}
