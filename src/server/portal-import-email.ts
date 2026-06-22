/**
 * Portal-import EMAIL lane — shared inbound helpers (Ship 3 + hardening).
 *
 * Server-only. Called by BOTH Resend inbound webhooks — `/api/resend/inbound`
 * (the general reply handler, where forwarded mail to the rewards-domain
 * address actually lands) AND `/api/resend/inbound-rewards` — so a forwarded
 * manufacturer-portal "Your Price" SCREENSHOT becomes a portal-import batch no
 * matter which endpoint Resend delivers it to. Same private drop-address +
 * same reward token = same tenant as the CSV rewards lane.
 *
 * Trust model: the token is the only secret (sender NOT trusted → a forward
 * from any staff inbox works). See project_vision_portal_import.
 */

import { admin } from "./admin-client";
import { getTenantIdForUser } from "@/server/auth-helpers";
import {
  REWARD_INGEST_DOMAIN,
  resolveRewardIngestToken,
} from "@/server/manufacturer-reward-ingest.functions";
import { ingestPortalImport, type ImageMedia } from "@/server/portal-import-core";

const RESEND_API = "https://api.resend.com";

type LooseAttachment = {
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

/** Map an attachment's name/MIME to a Claude-vision-supported image type, or
 *  null if it isn't a supported image (HEIC/PDF/etc. are skipped). */
export function imageMediaType(filename: string, contentType: string): ImageMedia | null {
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
  attachments: LooseAttachment[],
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
 *  signed download_url → base64. */
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
  let body: { data?: LooseAttachment[] } | null;
  try {
    body = (await listRes.json()) as { data?: LooseAttachment[] };
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
      // signed URL expired / fetch failed — skip.
    }
  }
  return out;
}

/** Extract the reward-domain token from a `to` list — bare local-part
 *  `<token>@rewards.smartspa.app` (mirrors inbound-rewards' extractToken). */
export function extractRewardToken(to: string[] | string | undefined): string | null {
  const list = Array.isArray(to) ? to : to ? [to] : [];
  const suffix = `@${REWARD_INGEST_DOMAIN.toLowerCase()}`;
  for (const raw of list) {
    const m = String(raw).match(/<([^>]+)>/);
    const addr = (m ? m[1] : String(raw)).trim().toLowerCase();
    if (addr.endsWith(suffix)) {
      const local = addr.slice(0, -suffix.length).trim();
      if (local) return local;
    }
  }
  return null;
}

/** Conservative manufacturer hint from the subject (vision auto-detects too —
 *  this only sharpens matching when the brand is named outright). */
export function manufacturerHintFromSubject(subject: string | null): string | null {
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

/**
 * The shared portal email-import attempt. Returns `{ handled: false }` when the
 * email isn't a portal screenshot (no rewards token, or no image) so the caller
 * falls through to its own routing. Returns `{ handled: true, body }` when it
 * staged a batch (or hit a clean stop like unknown token).
 */
export async function tryPortalEmailImport(args: {
  to: string[] | string | undefined;
  subject: string | null;
  metaAttachments: unknown;
  emailId: string | null;
}): Promise<{ handled: boolean; body?: Record<string, unknown> }> {
  const token = extractRewardToken(args.to);
  if (!token) return { handled: false };

  const meta: LooseAttachment[] = Array.isArray(args.metaAttachments)
    ? (args.metaAttachments as LooseAttachment[])
    : [];
  let images = extractInlineImageAttachments(meta);
  if (images.length === 0 && args.emailId) {
    const apiKey = process.env.RESEND_API_KEY;
    if (apiKey) images = await fetchImageAttachmentsViaApi(args.emailId, apiKey);
  }
  if (images.length === 0) return { handled: false }; // not an image email

  const sb = admin();
  const userId = await resolveRewardIngestToken(sb, token);
  if (!userId) {
    console.log("[portal-email] unknown_token", { tokenPrefix: token.slice(0, 6) });
    return { handled: true, body: { ignored: "unknown_token" } };
  }
  let tenantId: string;
  try {
    tenantId = await getTenantIdForUser(sb, userId, "no_tenant_for_portal_import");
  } catch {
    console.log("[portal-email] no_tenant", { tokenPrefix: token.slice(0, 6) });
    return { handled: true, body: { ignored: "no_tenant" } };
  }

  try {
    const r = await ingestPortalImport({
      sb,
      tenantId,
      source: "email",
      images: images.slice(0, 8),
      manufacturerHint: manufacturerHintFromSubject(args.subject),
      sourceMessageId: args.emailId, // idempotency across double-delivery
    });
    const matched = r.proposals.filter((p) => p.matchedProductId).length;
    console.log("[portal-email] import", {
      tokenPrefix: token.slice(0, 6),
      images: images.length,
      batchId: r.batchId,
      manufacturer: r.manufacturer,
      prices: r.proposals.length,
      matched,
    });
    return {
      handled: true,
      body: {
        lane: "portal_import",
        batchId: r.batchId,
        manufacturer: r.manufacturer,
        prices: r.proposals.length,
        matched,
      },
    };
  } catch (e) {
    console.log("[portal-email] import_failed", {
      tokenPrefix: token.slice(0, 6),
      reason: e instanceof Error ? e.message : "failed",
    });
    return {
      handled: true,
      body: { ignored: "portal_import_failed", reason: e instanceof Error ? e.message : "failed" },
    };
  }
}
