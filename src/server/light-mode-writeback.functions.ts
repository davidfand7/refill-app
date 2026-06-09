/**
 * Lite Mode writeback dispatcher (v1.43.0).
 *
 * When `claimRescueSlot` resolves a winning offer that traces back to a
 * Lite Mode connection (`emma_appointments.source` matches /^lite-/),
 * the connector substrate can NOT call the vendor API to book the slot.
 * That's the entire point of Lite Mode — we don't have API access.
 *
 * This module composes + sends the owner an email with:
 *   - Subject naming the patient + slot time
 *   - Deeplink CTA to the relevant vendor portal
 *   - Plain-text copy-paste payload (patient + slot details)
 *
 * Owner taps deeplink → portal opens → owner manually books the
 * rescued-in patient. The next Lite Mode email parse (the vendor's
 * own confirmation email triggered by the manual book) closes the
 * loop automatically.
 *
 * Per project_imessage_mcp_killer_arch: the owner channel is email
 * (not iMessage MCP) because iMessage MCP is the patient-side primitive.
 * Owner-self notification is fine via straight email — the friction is
 * already minimal (one tap).
 */

import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import {
  buildClaimDeeplink,
  buildCopyPayload,
} from "@/lib/light-mode/writeback";
import type { LightModePlatform } from "@/lib/email-parsers";

const LIGHT_MODE_PLATFORMS = new Set<LightModePlatform>([
  "zenoti",
  "jane",
  "boulevard",
  "mindbody",
  "booker",
]);

function looksLikeLightModeSource(
  source: string | null | undefined,
): { is: true; platform: LightModePlatform } | { is: false } {
  if (!source || !source.startsWith("lite-")) return { is: false };
  const p = source.slice("lite-".length) as LightModePlatform;
  if (!LIGHT_MODE_PLATFORMS.has(p)) return { is: false };
  return { is: true, platform: p };
}

export interface LightModeWritebackArgs {
  userId: string;
  appointmentId: string;
  patientNodeId: string;
  source: string;
  originalExternalId: string | null;
  scheduledAt: string | null;
}

export interface LightModeWritebackResult {
  ok: boolean;
  reason?: string;
  notes: string;
}

/**
 * Compose + dispatch the owner-facing email. Returns a status string
 * that gets stamped on emma_rescue_attempts.notes (caller pattern in
 * claimRescueSlot — fail-open, never break the claim).
 */
export async function dispatchLightModeWriteback(
  args: LightModeWritebackArgs,
): Promise<LightModeWritebackResult> {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return {
      ok: false,
      reason: "no_supabase",
      notes: "writeback_failed: server not configured",
    };
  }
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      reason: "no_resend",
      notes: "writeback_failed: RESEND_API_KEY not configured",
    };
  }

  const detected = looksLikeLightModeSource(args.source);
  if (!detected.is) {
    return {
      ok: false,
      reason: "not_light_mode",
      notes: `writeback_skipped: source=${args.source}`,
    };
  }
  const platform = detected.platform;

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
    };
  };

  // ── Load owner email
  let ownerEmail: string | null = null;
  try {
    // Service-role can query auth.users via admin API. Simpler: look
    // up via tenants/tenant_memberships if a primary contact email is
    // there; fall back to auth.users.email.
    const { data: membership } = await sbAny
      .from("tenant_memberships")
      .select("tenant_id")
      .eq("user_id", args.userId)
      .maybeSingle();
    const tenantId = membership?.tenant_id as string | null | undefined;
    if (tenantId) {
      const { data: tenant } = await sbAny
        .from("tenants")
        .select("primary_contact_email")
        .eq("id", tenantId)
        .maybeSingle();
      ownerEmail =
        (tenant?.primary_contact_email as string | null | undefined) ?? null;
    }
    if (!ownerEmail) {
      // Fall back to auth.users via admin auth API
      const { data: u } = await sb.auth.admin.getUserById(args.userId);
      ownerEmail = u?.user?.email ?? null;
    }
  } catch {
    // soft-fail; we'll catch null below
  }

  if (!ownerEmail) {
    return {
      ok: false,
      reason: "no_owner_email",
      notes: `writeback_failed: no owner email on user ${args.userId}`,
    };
  }

  // ── Load patient details from knowledge_nodes
  const { data: patient } = await sbAny
    .from("knowledge_nodes")
    .select("attributes")
    .eq("id", args.patientNodeId)
    .maybeSingle();
  const attrs = (patient?.attributes ?? {}) as Record<string, unknown>;
  const patientFirstName =
    typeof attrs.first_name === "string" ? attrs.first_name : null;
  const patientLastName =
    typeof attrs.last_name === "string" ? attrs.last_name : null;
  const patientPhone =
    typeof attrs.phone === "string" ? attrs.phone : null;
  const patientEmail =
    typeof attrs.email === "string" ? attrs.email : null;

  // ── Load original appointment service/notes (for the copy payload)
  const { data: apt } = await sbAny
    .from("emma_appointments")
    .select("treatment_type, provider_name, scheduled_at")
    .eq("id", args.appointmentId)
    .maybeSingle();
  const serviceName =
    typeof apt?.treatment_type === "string" ? apt.treatment_type : null;
  const providerName =
    typeof apt?.provider_name === "string" ? apt.provider_name : null;
  const scheduledAt =
    typeof apt?.scheduled_at === "string"
      ? apt.scheduled_at
      : args.scheduledAt;

  // ── Try to resolve a per-spa platform slug (Mindbody siteId, etc.)
  // from emma_scheduler_connections if a regular API connection also
  // exists for this user+platform (some spas might have BOTH Light
  // Mode AND an API connection for the same vendor).
  let spaPlatformSlug: string | null = null;
  try {
    const { data: conn } = await sbAny
      .from("emma_scheduler_connections")
      .select("platform_account_id")
      .eq("user_id", args.userId)
      .maybeSingle();
    spaPlatformSlug =
      (conn?.platform_account_id as string | null | undefined) ?? null;
  } catch {
    // not fatal
  }

  // ── Build deeplink + payload
  const deeplink = buildClaimDeeplink({
    platform,
    spaPlatformSlug,
    originalExternalId: args.originalExternalId,
    scheduledAt,
  });
  const copyPayload = buildCopyPayload({
    patientFirstName,
    patientLastName,
    patientPhone,
    patientEmail,
    serviceName,
    scheduledAt,
    notes: providerName ? `Original provider: ${providerName}` : null,
  });

  // ── Compose email
  const patientDisplay =
    [patientFirstName, patientLastName].filter(Boolean).join(" ") ||
    "a waitlist patient";
  const slotDisplay = scheduledAt
    ? new Date(scheduledAt).toLocaleString()
    : "the open slot";
  const platformLabel = ((): string => {
    switch (platform) {
      case "mindbody":
        return "Mindbody";
      case "booker":
        return "Booker";
      case "boulevard":
        return "Boulevard";
      case "zenoti":
        return "Zenoti";
      case "jane":
        return "Jane";
    }
  })();

  const subject = `\u{1F389} Rescue claimed — book ${patientDisplay} into ${slotDisplay}`;
  const text = [
    `A waitlist patient just claimed your open slot.`,
    ``,
    `Patient: ${patientDisplay}${patientPhone ? ` (${patientPhone})` : ""}`,
    serviceName ? `Service: ${serviceName}` : null,
    `When: ${slotDisplay}`,
    ``,
    deeplink.instructions,
    ``,
    `\u{1F517} ${deeplink.cta}:`,
    deeplink.url,
    ``,
    `\u{1F4CB} Quick-copy details for the new booking:`,
    ``,
    copyPayload,
    ``,
    `—`,
    `Refill (Lite Mode — ${platformLabel})`,
    `You're all set once ${platformLabel} shows the booking. Refill will detect the new appointment via your email forwarding and close the loop automatically.`,
  ]
    .filter((l): l is string => l !== null)
    .join("\n");

  const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 560px; margin: 0 auto; color: #1a1a1a; line-height: 1.55;">
  <p style="font-size: 17px; font-weight: 600; margin: 0 0 16px;">
    A waitlist patient just claimed your open slot.
  </p>
  <table style="border-collapse: collapse; margin: 0 0 18px; font-size: 14px;">
    <tr><td style="padding: 4px 12px 4px 0; color: #6c6a62;">Patient</td><td style="padding: 4px 0;"><strong>${escapeHtml(patientDisplay)}</strong>${patientPhone ? ` &middot; ${escapeHtml(patientPhone)}` : ""}</td></tr>
    ${serviceName ? `<tr><td style="padding: 4px 12px 4px 0; color: #6c6a62;">Service</td><td style="padding: 4px 0;">${escapeHtml(serviceName)}</td></tr>` : ""}
    <tr><td style="padding: 4px 12px 4px 0; color: #6c6a62;">When</td><td style="padding: 4px 0;">${escapeHtml(slotDisplay)}</td></tr>
  </table>
  <p style="font-size: 14px; color: #3a3a36; margin: 0 0 18px;">
    ${escapeHtml(deeplink.instructions)}
  </p>
  <p style="margin: 0 0 22px;">
    <a href="${escapeHtml(deeplink.url)}" style="display: inline-block; background: #1f6f3c; color: white; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-weight: 600; font-size: 14px;">
      ${escapeHtml(deeplink.cta)}
    </a>
  </p>
  <div style="background: #f6f4ec; border-left: 3px solid #2e5e8f; padding: 12px 16px; font-family: 'SF Mono', Menlo, Consolas, monospace; font-size: 13px; white-space: pre-wrap; margin: 0 0 18px;">${escapeHtml(copyPayload)}</div>
  <p style="font-size: 12px; color: #6c6a62; margin: 20px 0 0; border-top: 1px solid #d6d3c7; padding-top: 12px;">
    Refill — Lite Mode (${escapeHtml(platformLabel)}). You're all set once ${escapeHtml(platformLabel)} shows the booking. Refill will detect the new appointment via your email forwarding and close the loop automatically.
  </p>
</div>
  `.trim();

  // ── Send via Resend
  const KAREN_FROM =
    process.env.REFILL_DRIP_FROM ?? "Karen Anderson <karen@getrefill.app>";
  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: KAREN_FROM,
        to: [ownerEmail],
        subject,
        text,
        html,
        tags: [
          { name: "type", value: "light-mode-writeback" },
          { name: "platform", value: platform },
        ],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!resp.ok) {
      const body = (await resp.text().catch(() => "")).slice(0, 200);
      return {
        ok: false,
        reason: "resend_failed",
        notes: `writeback_failed: Resend ${resp.status} ${body}`,
      };
    }
    return {
      ok: true,
      notes: `writeback_dispatched: light-mode email to owner via ${platformLabel}`,
    };
  } catch (e) {
    return {
      ok: false,
      reason: "fetch_error",
      notes: `writeback_failed: ${e instanceof Error ? e.message : "unknown"}`,
    };
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
