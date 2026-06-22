/**
 * Resend Inbound — manufacturer-data email-drop receiver (v1.97.0; both
 * lanes since v2.3.1).
 *
 * Resend Inbound Routing delivers mail sent to <token>@rewards.smartspa.app
 * to this endpoint as JSON. The handler:
 *   1. Extracts the token from the `to` address local-part.
 *   2. Pulls attachment(s) from the payload, ROUTING BY TYPE:
 *      - CSV  → manufacturer-data lane (transaction vs. reward, auto-detected).
 *      - IMAGE → portal-price lane (Ship 3): a "Your Price" screenshot →
 *        Claude-vision portal-import batch the owner reviews in-app
 *        (Verified-pricing tab). Same token = same tenant; fires only when no
 *        CSV is present, so the CSV path is byte-for-byte unchanged.
 *   3. CSV: resolves token → tenant, routes by lane from the headers. Same
 *      cores as the manual uploads, so the spa never touches a dropdown.
 *   4. Always returns 200 (failures report a reason, never a retry storm).
 *
 * Trust model: the token is the only secret. We do NOT trust the From sender
 * (so a forwarded report from any staff inbox works). Token is unguessable +
 * revocable (reward_ingest_tokens).
 *
 * GO-LIVE (infra, one-time): add an MX record for rewards.smartspa.app and a
 * Resend Inbound route for that domain → this URL. Until then the endpoint is
 * testable by POSTing a sample payload directly.
 */

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import {
  REWARD_INGEST_DOMAIN,
  resolveRewardIngestToken,
} from "@/server/manufacturer-reward-ingest.functions";
import { ingestCsvByTokenRouted } from "@/server/manufacturer-ingest-router";
import { getTenantIdForUser } from "@/server/auth-helpers";
import { ingestPortalImport, type ImageMedia } from "@/server/portal-import-core";

function jsonResp(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Extract the local-part token from a `to` value that may be
 *  "Name <token@rewards.smartspa.app>" or a bare address. */
function extractToken(toRaw: string | string[] | undefined): string | null {
  const first = Array.isArray(toRaw) ? (toRaw[0] ?? "") : (toRaw ?? "");
  const m = first.match(/<([^>]+)>/);
  const addr = (m ? m[1] : first).trim().toLowerCase();
  const suffix = `@${REWARD_INGEST_DOMAIN.toLowerCase()}`;
  if (!addr.endsWith(suffix)) return null;
  const local = addr.slice(0, -suffix.length).trim();
  return local || null;
}

const RESEND_API = "https://api.resend.com";

type RawAttachment = {
  id?: string;
  filename?: string;
  name?: string;
  content?: string;
  contentBase64?: string;
  content_base64?: string;
  data?: string;
  content_type?: string;
  contentType?: string;
  download_url?: string;
};

function b64ToUtf8(b64: string): string {
  const clean = b64.replace(/\s/g, "");
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

/** Does an attachment's name/MIME look like a manufacturer CSV report? */
function looksLikeCsv(filename: string, contentType: string): boolean {
  const f = filename.toLowerCase();
  const ct = contentType.toLowerCase();
  if (f.endsWith(".csv")) return true;
  return (
    ct.includes("csv") ||
    ct.includes("excel") ||
    ct.includes("spreadsheet") ||
    ct === "text/plain"
  );
}

/**
 * Pull CSV attachments that are delivered INLINE (base64 in the payload).
 * This is the shape our smoke-test fixtures use and the shape some legacy /
 * forwarded variants carry. Resend's real `email.received` webhook does NOT
 * inline content (metadata only) — that path is handled by
 * fetchCsvAttachmentsViaApi below.
 */
function extractInlineCsvAttachments(
  attachments: RawAttachment[],
): Array<{ filename: string; text: string }> {
  const out: Array<{ filename: string; text: string }> = [];
  if (!Array.isArray(attachments)) return out;
  for (const a of attachments) {
    const filename = (a.filename ?? a.name ?? "report.csv").toString();
    const ct = (a.content_type ?? a.contentType ?? "").toString();
    const b64 = a.content ?? a.contentBase64 ?? a.content_base64 ?? a.data;
    if (!looksLikeCsv(filename, ct) || !b64) continue;
    try {
      out.push({ filename, text: b64ToUtf8(String(b64)) });
    } catch {
      // unreadable attachment — skip; reported in the result summary.
    }
  }
  return out;
}

/**
 * Resend's `email.received` webhook ships attachment METADATA only. To get the
 * bytes we list the received email's attachments (which returns a signed,
 * 1-hour `download_url` per attachment) and fetch the CSV ones directly.
 * Docs: GET /emails/receiving/{email_id}/attachments → { data: [{ download_url }] }.
 */
async function fetchCsvAttachmentsViaApi(
  emailId: string,
  apiKey: string,
): Promise<Array<{ filename: string; text: string }>> {
  const out: Array<{ filename: string; text: string }> = [];
  let listRes: Response;
  try {
    listRes = await fetch(
      `${RESEND_API}/emails/receiving/${emailId}/attachments`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
  } catch {
    return out;
  }
  if (!listRes.ok) return out;
  let body: { data?: RawAttachment[] } | null;
  try {
    body = (await listRes.json()) as { data?: RawAttachment[] };
  } catch {
    return out;
  }
  const list = Array.isArray(body?.data) ? body!.data! : [];
  for (const a of list) {
    const filename = (a.filename ?? "report.csv").toString();
    const ct = (a.content_type ?? a.contentType ?? "").toString();
    if (!looksLikeCsv(filename, ct) || !a.download_url) continue;
    try {
      const dl = await fetch(a.download_url);
      if (!dl.ok) continue;
      out.push({ filename, text: await dl.text() });
    } catch {
      // signed URL expired or fetch failed — skip; surfaced in summary.
    }
  }
  return out;
}

// ─── Portal-price IMAGE lane (Ship 3 of the vision-ingestion moat) ──────────
// Same inbound address + same reward token = same tenant. When the email
// carries an IMAGE (not a CSV), it's a manufacturer-portal "Your Price"
// screenshot → stage a portal-import batch the owner reviews in-app
// (Verified-pricing tab). See project_vision_portal_import.

/** Map an attachment's name/MIME to a Claude-vision-supported image type, or
 *  null if it isn't a supported image (HEIC/PDF/etc. are skipped). */
function imageMediaType(filename: string, contentType: string): ImageMedia | null {
  const f = filename.toLowerCase();
  const ct = contentType.toLowerCase();
  if (ct.includes("png") || f.endsWith(".png")) return "image/png";
  if (ct.includes("webp") || f.endsWith(".webp")) return "image/webp";
  if (ct.includes("gif") || f.endsWith(".gif")) return "image/gif";
  if (ct.includes("jpeg") || ct.includes("jpg") || f.endsWith(".jpg") || f.endsWith(".jpeg"))
    return "image/jpeg";
  return null;
}

/** Inline image attachments (fixtures / legacy forwarded variants). */
function extractInlineImageAttachments(
  attachments: RawAttachment[],
): Array<{ data: string; mediaType: ImageMedia }> {
  const out: Array<{ data: string; mediaType: ImageMedia }> = [];
  if (!Array.isArray(attachments)) return out;
  for (const a of attachments) {
    const filename = (a.filename ?? a.name ?? "screenshot.png").toString();
    const ct = (a.content_type ?? a.contentType ?? "").toString();
    const mediaType = imageMediaType(filename, ct);
    const b64 = a.content ?? a.contentBase64 ?? a.content_base64 ?? a.data;
    if (!mediaType || !b64) continue;
    const clean = String(b64)
      .replace(/^data:[^;]*;base64,/, "")
      .replace(/\s/g, "");
    if (clean) out.push({ data: clean, mediaType });
  }
  return out;
}

/** Real webhook: list the received email's attachments → fetch each image's
 *  signed download_url → base64. Mirrors fetchCsvAttachmentsViaApi but binary. */
async function fetchImageAttachmentsViaApi(
  emailId: string,
  apiKey: string,
): Promise<Array<{ data: string; mediaType: ImageMedia }>> {
  const out: Array<{ data: string; mediaType: ImageMedia }> = [];
  let listRes: Response;
  try {
    listRes = await fetch(`${RESEND_API}/emails/receiving/${emailId}/attachments`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch {
    return out;
  }
  if (!listRes.ok) return out;
  let body: { data?: RawAttachment[] } | null;
  try {
    body = (await listRes.json()) as { data?: RawAttachment[] };
  } catch {
    return out;
  }
  const list = Array.isArray(body?.data) ? body!.data! : [];
  for (const a of list) {
    const filename = (a.filename ?? "screenshot.png").toString();
    const ct = (a.content_type ?? a.contentType ?? "").toString();
    const mediaType = imageMediaType(filename, ct);
    if (!mediaType || !a.download_url) continue;
    try {
      const dl = await fetch(a.download_url);
      if (!dl.ok) continue;
      const buf = await dl.arrayBuffer();
      out.push({ data: Buffer.from(buf).toString("base64"), mediaType });
    } catch {
      // signed URL expired / fetch failed — skip; reported in summary.
    }
  }
  return out;
}

/** Conservative manufacturer hint from the subject line (vision auto-detects
 *  too — this only sharpens matching when the brand is named outright). */
function manufacturerHintFromSubject(subject: string | null): string | null {
  if (!subject) return null;
  const s = subject.toLowerCase();
  if (s.includes("allergan") || s.includes("abbvie") || s.includes("juvederm") || s.includes("botox"))
    return "abbvie";
  if (s.includes("galderma") || s.includes("aspire") || s.includes("restylane") || s.includes("sculptra") || s.includes("dysport"))
    return "galderma";
  if (s.includes("evolus") || s.includes("jeuveau") || s.includes("evolysse")) return "evolus";
  if (s.includes("revance") || s.includes("daxxify") || s.includes("rha")) return "revance";
  if (s.includes("merz") || s.includes("xeomin") || s.includes("radiesse") || s.includes("belotero"))
    return "merz";
  return null;
}

/** When the inbound email had no CSV, try the portal-image lane. Returns a
 *  Response if it handled an image batch (or hit a clean stop), else null so
 *  the caller falls through to the existing "no_csv_attachment" ignore. */
async function tryPortalImageImport(args: {
  metaAttachments: RawAttachment[];
  env: Record<string, unknown>;
  token: string;
  supabaseUrl: string;
  serviceKey: string;
}): Promise<Response | null> {
  const { metaAttachments, env, token, supabaseUrl, serviceKey } = args;

  let images = extractInlineImageAttachments(metaAttachments);
  if (images.length === 0) {
    const emailId =
      (env.email_id as string | undefined) ?? (env.id as string | undefined) ?? null;
    const apiKey = process.env.RESEND_API_KEY;
    if (emailId && apiKey) images = await fetchImageAttachmentsViaApi(emailId, apiKey);
  }
  if (images.length === 0) return null; // not an image email — let caller fall through

  const sb = createClient<Database>(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const userId = await resolveRewardIngestToken(sb, token);
  if (!userId) {
    console.log("[inbound-rewards] portal_unknown_token", { tokenPrefix: token.slice(0, 6) });
    return jsonResp(200, { ignored: "unknown_token" });
  }
  let tenantId: string;
  try {
    tenantId = await getTenantIdForUser(sb, userId, "no_tenant_for_portal_import");
  } catch {
    console.log("[inbound-rewards] portal_no_tenant", { tokenPrefix: token.slice(0, 6) });
    return jsonResp(200, { ignored: "no_tenant" });
  }

  const subject = typeof env.subject === "string" ? env.subject : null;
  try {
    const r = await ingestPortalImport({
      sb,
      tenantId,
      source: "email",
      images: images.slice(0, 8), // mirror the upload cap
      manufacturerHint: manufacturerHintFromSubject(subject),
    });
    const matched = r.proposals.filter((p) => p.matchedProductId).length;
    console.log("[inbound-rewards] portal_import", {
      tokenPrefix: token.slice(0, 6),
      images: images.length,
      batchId: r.batchId,
      manufacturer: r.manufacturer,
      prices: r.proposals.length,
      matched,
    });
    return jsonResp(200, {
      lane: "portal_import",
      batchId: r.batchId,
      manufacturer: r.manufacturer,
      prices: r.proposals.length,
      matched,
    });
  } catch (e) {
    console.log("[inbound-rewards] portal_import_failed", {
      tokenPrefix: token.slice(0, 6),
      reason: e instanceof Error ? e.message : "failed",
    });
    return jsonResp(200, {
      ignored: "portal_import_failed",
      reason: e instanceof Error ? e.message : "failed",
    });
  }
}

export const Route = createFileRoute("/api/resend/inbound-rewards")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!SUPABASE_URL || !SERVICE_KEY) {
          return jsonResp(500, { error: "Server not configured" });
        }

        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(await request.text()) as Record<string, unknown>;
        } catch {
          return jsonResp(200, { ignored: "non_json_body" });
        }

        // Resend's real `email.received` payload nests the envelope under
        // `data`; older/nested variants used `email`; test fixtures POST flat.
        const env =
          (payload.data as Record<string, unknown> | undefined) ??
          (payload.email as Record<string, unknown> | undefined) ??
          payload;
        const toForLog = Array.isArray(env.to)
          ? (env.to as string[])[0]
          : (env.to as string | undefined);
        const token = extractToken(env.to as string | string[] | undefined);
        if (!token) {
          console.log("[inbound-rewards] no_reward_token", {
            hasData: Boolean(payload.data),
            to: toForLog ?? null,
          });
          return jsonResp(200, { ignored: "no_reward_token" });
        }

        // Attachment content: inline base64 (fixtures/legacy) first; if none,
        // fall back to the Resend Attachments API using the received email id
        // (the real webhook carries metadata only).
        const metaAttachments =
          (env.attachments as RawAttachment[] | undefined) ??
          (payload.attachments as RawAttachment[] | undefined) ??
          [];
        let attachments = extractInlineCsvAttachments(metaAttachments);
        let source: "inline" | "api" | "none" = attachments.length
          ? "inline"
          : "none";
        if (attachments.length === 0) {
          const emailId =
            (env.email_id as string | undefined) ??
            (env.id as string | undefined) ??
            null;
          const apiKey = process.env.RESEND_API_KEY;
          if (emailId && apiKey) {
            attachments = await fetchCsvAttachmentsViaApi(emailId, apiKey);
            if (attachments.length) source = "api";
          }
        }
        if (attachments.length === 0) {
          // No CSV — maybe it's a manufacturer-portal price SCREENSHOT (the
          // vision portal-import lane). Same token → same tenant. Purely
          // additive: only fires when there's no CSV.
          const portalResult = await tryPortalImageImport({
            metaAttachments,
            env,
            token,
            supabaseUrl: SUPABASE_URL,
            serviceKey: SERVICE_KEY,
          });
          if (portalResult) return portalResult;

          console.log("[inbound-rewards] no_csv_attachment", {
            tokenPrefix: token.slice(0, 6),
            metaCount: Array.isArray(metaAttachments) ? metaAttachments.length : 0,
            hasEmailId: Boolean(env.email_id ?? env.id),
            hasApiKey: Boolean(process.env.RESEND_API_KEY),
          });
          return jsonResp(200, { ignored: "no_csv_attachment" });
        }

        const sb = createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
          auth: { persistSession: false, autoRefreshToken: false },
        });

        // Each CSV flows through the shared lane-router (same path as the
        // direct Portal-MCP endpoint /api/ingest/rewards) — it auto-detects
        // transaction vs. reward and runs the matching ingest core.
        const results: Array<Record<string, unknown>> = [];
        for (const att of attachments) {
          try {
            const r = await ingestCsvByTokenRouted(sb, token, att.text, att.filename);
            if (r.lane === "transaction") {
              results.push({
                file: att.filename,
                lane: "transaction",
                ok: r.ok,
                detected: r.detected,
                reason: r.reason,
                matchedPatients: r.receipt?.matchedPatients ?? null,
                cadenceRows: r.receipt?.cadenceRows ?? null,
                rowsInserted: r.receipt?.rowsInserted ?? null,
              });
            } else {
              results.push({
                file: att.filename,
                lane: "reward",
                ok: r.ok,
                detected: r.detected,
                reason: r.reason,
                matched: r.receipt?.matched ?? null,
                entries: r.receipt?.entriesUpserted ?? null,
              });
            }
          } catch (e) {
            results.push({
              file: att.filename,
              ok: false,
              reason: e instanceof Error ? e.message : "ingest_failed",
            });
          }
        }

        console.log("[inbound-rewards] processed", {
          tokenPrefix: token.slice(0, 6),
          source,
          count: results.length,
          results: results.map((r) => ({
            file: r.file,
            lane: r.lane,
            ok: r.ok,
            detected: r.detected,
            reason: r.reason,
          })),
        });

        return jsonResp(200, { processed: results.length, results });
      },
    },
  },
});
