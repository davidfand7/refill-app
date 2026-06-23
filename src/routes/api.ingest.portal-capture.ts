/**
 * Portal CAPTURE ingest — /api/ingest/portal-capture (Capture Lane P1).
 *
 * The browser-extension front door into the portal-import engine. While the
 * owner is logged into a manufacturer portal, the "Capture to SmartSpa"
 * extension screenshots the visible tab and POSTs it here with the spa's token
 * (the same reward-ingest token as the email/Agent lanes). We resolve the
 * tenant from the token — never a portal credential — and run the SHARED
 * ingest core, so the capture lands in the Verified-pricing inbox exactly like
 * an upload or an emailed screenshot. See project_capture_lane.
 *
 * Trust model: the token authorizes the SPA, not portal access. The capture is
 * the owner's own authenticated view. Token-auth (not cookie) → CORS '*' is
 * safe; OPTIONS preflight handled for the extension's cross-origin POST.
 *
 * NOTE (P1 thin slice): captures stage as source='upload'; a distinct
 * source='capture' tag (for lane analytics) is a fast-follow that needs a
 * one-line CHECK-constraint widen.
 */

import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { admin } from "@/server/admin-client";
import { getTenantIdForUser } from "@/server/auth-helpers";
import { resolveRewardIngestToken } from "@/server/manufacturer-reward-ingest.functions";
import { ingestPortalImport } from "@/server/portal-import-core";
import { manufacturerHintFromSubject } from "@/server/portal-import-email";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

function resp(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}

const captureInput = z.object({
  token: z.string().min(1),
  images: z
    .array(
      z.object({
        data: z.string().min(1).max(15_000_000), // base64, ~10MB raw cap
        mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
      }),
    )
    .min(1)
    .max(8),
  pageUrl: z.string().optional(),
  pageTitle: z.string().optional(),
  /** Client-generated id → idempotency on an accidental double-fire. */
  captureId: z.string().optional(),
});

export const Route = createFileRoute("/api/ingest/portal-capture")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),
      POST: async ({ request }) => {
        let body: z.infer<typeof captureInput>;
        try {
          body = captureInput.parse(JSON.parse(await request.text()));
        } catch {
          return resp(400, { ok: false, error: "bad_request" });
        }

        const sb = admin();
        // Forgiving: accept the bare token OR the full drop-address
        // (<token>@rewards.smartspa.app) — strip any @domain + whitespace.
        const rawToken = body.token.trim();
        const token = rawToken.includes("@") ? rawToken.split("@")[0].trim() : rawToken;
        const userId = await resolveRewardIngestToken(sb, token);
        if (!userId) return resp(401, { ok: false, error: "unknown_token" });

        let tenantId: string;
        try {
          tenantId = await getTenantIdForUser(sb, userId, "no_tenant_for_portal_capture");
        } catch {
          return resp(403, { ok: false, error: "no_tenant" });
        }

        // Hint from the page title/URL (e.g. an "aspire"/"allergan" host) —
        // vision auto-detects too; this only sharpens matching.
        const hint = manufacturerHintFromSubject(
          [body.pageTitle, body.pageUrl].filter(Boolean).join(" ") || null,
        );

        try {
          const r = await ingestPortalImport({
            sb,
            tenantId,
            source: "upload", // P1: capture rides the upload lane
            images: body.images,
            manufacturerHint: hint,
            sourceMessageId: body.captureId ?? null,
          });
          const matched = r.proposals.filter((p) => p.matchedProductId).length;
          console.log("[portal-capture] import", {
            tokenPrefix: body.token.slice(0, 6),
            images: body.images.length,
            batchId: r.batchId,
            manufacturer: r.manufacturer,
            prices: r.proposals.length,
            matched,
            deduped: r.deduped ?? false,
          });
          return resp(200, {
            ok: true,
            batchId: r.batchId,
            manufacturer: r.manufacturer,
            prices: r.proposals.length,
            matched,
            deduped: r.deduped ?? false,
          });
        } catch (e) {
          console.log("[portal-capture] import_failed", {
            tokenPrefix: body.token.slice(0, 6),
            reason: e instanceof Error ? e.message : "failed",
          });
          return resp(200, { ok: false, reason: e instanceof Error ? e.message : "failed" });
        }
      },
    },
  },
});
