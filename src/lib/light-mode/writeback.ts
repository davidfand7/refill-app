/**
 * Lite Mode writeback deeplinks (v1.43.0).
 *
 * When a rescue claim lands on a Lite Mode connection (appointments
 * row with source like `lite-zenoti`), Refill can NOT call the vendor's
 * API to book the slot — that's the entire point of Lite Mode. Instead,
 * we send the spa owner an email with:
 *   1. A best-effort deeplink to the platform's relevant dashboard page
 *   2. A copy-paste payload with patient + slot details
 *
 * Owner taps deeplink → portal opens → owner manually books the
 * rescued-in patient. Refill's next Lite Mode email parse (the new
 * confirmation triggered by the manual book) closes the loop
 * automatically.
 *
 * Pure functions; no Supabase dependency. Server fn wraps these to
 * load owner email + patient details + send via Resend.
 */

import type { LightModePlatform } from "@/lib/email-parsers";

export interface DeeplinkArgs {
  platform: LightModePlatform;
  /** Spa's slug at the platform if known (Zenoti subdomain, Jane clinic_url, Mindbody siteId, etc.). NULL → use generic landing URL. */
  spaPlatformSlug: string | null;
  /** Original (cancelled / no-show) appointment ID at the platform — useful when the portal can navigate-by-id. */
  originalExternalId: string | null;
  /** When the slot is scheduled (ISO). */
  scheduledAt: string | null;
}

export interface DeeplinkResult {
  /** Best-effort URL to navigate the owner to the right page in their portal. */
  url: string;
  /** Whether this URL supports query-param prefill of patient details. v1 = false on all (we don't have verified prefill formats). Future polish ship. */
  supportsPrefill: boolean;
  /** Human-readable label for the CTA button in the email. */
  cta: string;
  /** What the owner should expect to do once the link opens. */
  instructions: string;
}

export interface CopyPayloadArgs {
  patientFirstName: string | null;
  patientLastName: string | null;
  patientPhone: string | null;
  patientEmail: string | null;
  serviceName: string | null;
  scheduledAt: string | null;
  notes: string | null;
}

/**
 * Build the URL + cta + instructions for the owner-facing email.
 *
 * Per third-party-UI verification rule: only confirmed paths. For
 * platforms where the per-spa subdomain or prefill URL pattern is not
 * publicly verifiable, we default to the platform's generic dashboard
 * landing page and rely on the copy payload below for fast manual entry.
 */
export function buildClaimDeeplink(args: DeeplinkArgs): DeeplinkResult {
  switch (args.platform) {
    case "mindbody": {
      // Mindbody's dashboard URL pattern is well-known from the sandbox:
      // clients.mindbodyonline.com/classic/ws?studioid=<siteId>.
      // Production owners land in the same shape with their real siteId.
      const siteIdQuery = args.spaPlatformSlug
        ? `?studioid=${encodeURIComponent(args.spaPlatformSlug)}`
        : "";
      return {
        url: `https://clients.mindbodyonline.com/classic/ws${siteIdQuery}`,
        supportsPrefill: false,
        cta: "Open Mindbody to book the slot",
        instructions:
          "Sign in to Mindbody, find the time slot below, and book the rescued patient. Refill will detect the new booking through your email forwarding and close the loop automatically.",
      };
    }

    case "booker": {
      // Booker (Mindbody-owned) — dashboard at app.booker.com is the
      // canonical owner-side entry point.
      return {
        url: "https://app.booker.com",
        supportsPrefill: false,
        cta: "Open Booker to book the slot",
        instructions:
          "Sign in to Booker, find the time slot below, and book the rescued patient. Refill will detect the new booking via email forwarding and close the loop.",
      };
    }

    case "boulevard": {
      // Boulevard dashboard root. Note: Custom App install lives at
      // dashboard.joinblvd.com/manage-business/apps but for owner
      // booking the calendar root is more direct.
      return {
        url: "https://dashboard.joinblvd.com",
        supportsPrefill: false,
        cta: "Open Boulevard to book the slot",
        instructions:
          "Sign in to Boulevard, navigate to your calendar, and book the rescued patient into the open slot. Refill will detect the new booking via email forwarding.",
      };
    }

    case "zenoti": {
      // Zenoti per-spa subdomain pattern not publicly confirmed. Fall
      // back to the generic web app login. Future polish: capture the
      // spa's subdomain at Lite Mode wizard time + use here.
      return {
        url: "https://login.zenoti.com",
        supportsPrefill: false,
        cta: "Open Zenoti to book the slot",
        instructions:
          "Sign in to Zenoti, navigate to your calendar, and book the rescued patient. Refill will detect the new booking via email forwarding and close the loop.",
      };
    }

    case "jane": {
      // Jane uses per-clinic subdomains: <clinic>.jane.app. We may not
      // know it at the Lite Mode level. Generic fallback is jane.app
      // sign-in.
      const url = args.spaPlatformSlug
        ? `https://${encodeURIComponent(args.spaPlatformSlug)}.jane.app/admin`
        : "https://jane.app/login";
      return {
        url,
        supportsPrefill: false,
        cta: "Open Jane to book the slot",
        instructions:
          "Sign in to Jane, navigate to your schedule, and book the rescued patient into the open slot. Refill will detect the new booking via email forwarding.",
      };
    }
  }
}

/**
 * Compose a plain-text copy-paste payload the owner can scan + paste
 * into the platform's New Booking form. Keeps each field on its own
 * line per feedback_copy_paste_actionables.
 */
export function buildCopyPayload(args: CopyPayloadArgs): string {
  const lines: string[] = [];
  if (args.patientFirstName || args.patientLastName) {
    lines.push(
      `First name: ${args.patientFirstName ?? ""}`,
      `Last name: ${args.patientLastName ?? ""}`,
    );
  }
  if (args.patientPhone) lines.push(`Phone: ${args.patientPhone}`);
  if (args.patientEmail) lines.push(`Email: ${args.patientEmail}`);
  if (args.serviceName) lines.push(`Service: ${args.serviceName}`);
  if (args.scheduledAt) {
    const d = new Date(args.scheduledAt);
    if (!Number.isNaN(d.getTime())) {
      lines.push(`Time: ${d.toLocaleString()}`);
    } else {
      lines.push(`Time: ${args.scheduledAt}`);
    }
  }
  if (args.notes) lines.push(`Notes: ${args.notes}`);
  return lines.join("\n");
}
