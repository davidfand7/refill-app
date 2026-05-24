/**
 * Sample-order "Send to practice" server fn (v323).
 *
 * Rep clicks the Send button next to a Liz reply that carries a structured
 * sample-order artifact. The chat UI pre-fills to/subject/body, the rep edits
 * if they want, hits Send — this server fn:
 *
 *   1. Verifies auth, loads the target agent turn, confirms it belongs to
 *      this rep's Liz session, and that `metadata.sample_order` exists.
 *   2. Renders a single-page PDF of the order via `renderSampleOrderPdf`.
 *   3. Sends via Resend (reuses the same REST pattern as `digestEmail.ts`)
 *      with the PDF attached.
 *   4. Logs the send to `agent_chat_turns.metadata.sends[]` so the UI can
 *      show "Sent to X on Y date" and so a rep can't accidentally double-send.
 *
 * Why no SMS: parked for a later phase. B2B reps send orders in email
 * anyway, and we don't want to re-enter carrier-filtering / TFV purgatory
 * for a use case Liz Kunze hasn't validated.
 */

import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { verifyAuth, accessTokenInput } from "@/server/auth-helpers";
import type { Database, Json } from "@/integrations/supabase/types";
import {
  renderSampleOrderPdf,
  type RenderSampleOrderInput,
} from "@/server/sample-order-pdf";
import type { LizSampleOrder } from "@/server/liz-chat.functions";

// Note: avoid parens / special chars in the display name — RFC 5322's
// comment syntax can trip simple parsers. "Lizzie" plain reads cleanly.
const FROM_EMAIL = "Lizzie <orders@notify.openagentic.site>";

// Apex hostname for the public Order NOW landing page. Practice-facing URL,
// brand-neutral on purpose — a stranger to the platform shouldn't have to
// puzzle out what "lizzie.agentiport.com" means. All subdomains route the
// same Worker, so /order/<token> resolves wherever we point.
const PUBLIC_SITE_ORIGIN = "https://agentiport.com";

const sendInput = accessTokenInput.extend({
  turnId: z.string().uuid(),
  to: z.string().email("Practice email looks invalid — double-check the address."),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(5000),
  /** Optional override — defaults to the verified user's display name / email. */
  repName: z.string().min(1).max(120).optional(),
});

export type SendSampleOrderResult = {
  ok: true;
  emailId: string | null;
  sentAt: string;
  to: string;
  /** Public landing-page URL the practice opens from the email (v325). */
  orderUrl: string;
  /** Intent token — UI joins this to confirmation state. */
  intentToken: string;
};

export type SampleOrderSendLogEntry = {
  to: string;
  subject: string;
  sent_at: string;
  email_id: string | null;
  /** v325: present on sends made on or after Order NOW shipped. */
  intent_token?: string;
};

function admin() {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw new Error("Server is missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  }
  return createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Convert a Uint8Array to a base64 string in a Workers-compatible way. */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  // btoa is available in Workers + modern Node.
  return btoa(bin);
}

export const sendSampleOrderEmail = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => sendInput.parse(input))
  .handler(async ({ data }): Promise<SendSampleOrderResult> => {
    const RESEND_KEY = process.env.RESEND_API_KEY;
    if (!RESEND_KEY) {
      throw new Error("Email isn't configured on the server (missing RESEND_API_KEY).");
    }

    const userId = await verifyAuth(data.accessToken);
    const sb = admin();

    // Load the turn + verify ownership via the joined session row.
    const { data: row, error: rowErr } = await sb
      .from("agent_chat_turns")
      .select("id, role, body, metadata, session_id, agent_chat_sessions!inner(user_id, persona)")
      .eq("id", data.turnId)
      .maybeSingle();

    if (rowErr || !row) {
      throw new Error("Couldn't find that reply to send.");
    }
    const sess = row.agent_chat_sessions as unknown as { user_id: string; persona: string };
    if (sess.user_id !== userId) throw new Error("That reply doesn't belong to you.");
    if (sess.persona !== "liz") throw new Error("This action is only for Liz replies.");
    if (row.role !== "agent") throw new Error("Only Liz replies carry a sample order.");

    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    const order = meta.sample_order as LizSampleOrder | undefined;
    if (!order || typeof order !== "object") {
      throw new Error(
        "This reply doesn't have a sample order attached — ask Liz to build one first.",
      );
    }

    // Resolve rep display name. Prefer client-passed `repName`, fall back to
    // user metadata / email. The PDF "Prepared by" block uses this verbatim.
    const repName = (data.repName ?? "").trim() || await resolveRepName(sb, userId);
    const repEmail = await resolveRepEmail(sb, userId);

    // Render the PDF.
    const pdfBytes = await renderSampleOrderPdf({
      order,
      repName,
      repEmail: repEmail ?? undefined,
    } satisfies RenderSampleOrderInput);

    // v325: create the Order NOW intent row BEFORE sending. The public URL
    // we put in the email points at this token. Keep the snapshot frozen
    // here — prompt drift on Liz's side never changes what the practice
    // sees. If the insert fails, the send never goes out (better to bounce
    // the rep with a clear error than email a link that 404s).
    const intentToken = generatePublicToken();
    const orderUrl = `${PUBLIC_SITE_ORIGIN}/order/${intentToken}`;
    const { error: intentErr } = await sb.from("sample_order_intents").insert({
      token: intentToken,
      rep_user_id: userId,
      turn_id: data.turnId,
      practice_email: data.to,
      order_snapshot: order as unknown as Json,
      rep_name: repName,
      rep_email: repEmail ?? null,
    });
    if (intentErr) {
      throw new Error(`Couldn't prep the order link — ${intentErr.message}`);
    }

    // Compose the email — both a plain-text body (for clients that prefer
    // it / for older clients) and an HTML body with a styled "Confirm &
    // forward" CTA. The plain text body still ends with the bare URL so
    // it's never gated behind HTML rendering.
    const textBody = `${data.body.trimEnd()}\n\nReview and confirm this order:\n${orderUrl}\n`;
    const htmlBody = renderEmailHtml({
      body: data.body,
      orderUrl,
      total: order.total_usd,
      practiceTitle: order.account.title,
      repName,
    });

    // Send via Resend.
    const filename = `sample-order-${slugify(order.account.title)}.pdf`;
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [data.to],
        reply_to: repEmail ?? undefined,
        subject: data.subject,
        text: textBody,
        html: htmlBody,
        attachments: [
          {
            filename,
            content: bytesToBase64(pdfBytes),
          },
        ],
        tags: [
          { name: "type", value: "sample-order" },
          { name: "turn_id", value: data.turnId },
          { name: "intent_token", value: intentToken },
        ],
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const msg = await res.text().catch(() => "");
      throw new Error(`Resend rejected the send (${res.status}). ${msg.slice(0, 200)}`);
    }
    const sendResp = (await res.json().catch(() => ({}))) as { id?: string };
    const emailId = sendResp.id ?? null;
    const sentAt = new Date().toISOString();

    // Append to metadata.sends — so the UI can show "Sent to X on Y" and we
    // can detect duplicate sends. Read-modify-write because the metadata
    // jsonb is opaque to the DB.
    const sends = Array.isArray(meta.sends) ? (meta.sends as SampleOrderSendLogEntry[]) : [];
    sends.push({
      to: data.to,
      subject: data.subject,
      sent_at: sentAt,
      email_id: emailId,
      intent_token: intentToken,
    });
    const nextMeta: Record<string, unknown> = { ...meta, sends };

    const { error: upErr } = await sb
      .from("agent_chat_turns")
      .update({ metadata: nextMeta as Json })
      .eq("id", data.turnId);
    if (upErr) {
      // Send already succeeded; log but don't throw — UI can survive missing log.
      console.warn("[sample-order-email] couldn't persist send log:", upErr.message);
    }

    return { ok: true, emailId, sentAt, to: data.to, orderUrl, intentToken };
  });

// ── Helpers ────────────────────────────────────────────────────────────────

async function resolveRepName(
  sb: ReturnType<typeof admin>,
  userId: string,
): Promise<string> {
  // Pull from auth admin API (service-role). raw_user_meta_data is the
  // standard Supabase shape; fall back to email-as-name if no profile name.
  try {
    const { data: u } = await sb.auth.admin.getUserById(userId);
    const meta = (u?.user?.user_metadata ?? {}) as Record<string, unknown>;
    const candidate =
      typeof meta.full_name === "string" ? meta.full_name
      : typeof meta.name === "string" ? meta.name
      : typeof meta.display_name === "string" ? meta.display_name
      : null;
    if (candidate && candidate.trim()) return candidate.trim();
    if (u?.user?.email) return u.user.email;
  } catch {
    /* fall through */
  }
  return "Your medical-aesthetics rep";
}

async function resolveRepEmail(
  sb: ReturnType<typeof admin>,
  userId: string,
): Promise<string | null> {
  try {
    const { data: u } = await sb.auth.admin.getUserById(userId);
    return u?.user?.email ?? null;
  } catch {
    return null;
  }
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "order";
}

/**
 * v325: generate the public token used as the Order NOW URL slug. 32 random
 * bytes → base64url. Workers exposes `crypto.getRandomValues` globally so we
 * don't need to import node:crypto (which doesn't load cleanly in Workers).
 */
function generatePublicToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  // base64url — strip padding + swap +/ → -_
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/**
 * v325: HTML email body with a styled "Confirm & forward to Galderma" CTA.
 * Inlined CSS only — Gmail / Outlook strip <style> blocks. Kept tight: any
 * change here also wants a screenshot test by Grasshopper before shipping.
 */
function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderEmailHtml(input: {
  body: string;
  orderUrl: string;
  total: number;
  practiceTitle: string;
  repName: string;
}): string {
  const { body, orderUrl, total, practiceTitle, repName } = input;
  // Body is plain text the rep wrote — preserve line breaks but escape HTML.
  const bodyHtml = escapeHtml(body)
    .split("\n\n")
    .map((para) => `<p style="margin:0 0 14px 0;">${para.replaceAll("\n", "<br>")}</p>`)
    .join("");
  const totalStr = total.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sample order for ${escapeHtml(practiceTitle)}</title>
</head>
<body style="margin:0;padding:0;background:#f6f7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1d293d;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f6f7fb;">
  <tr><td align="center" style="padding:24px 16px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;border:1px solid #e2e7f0;overflow:hidden;">
      <tr><td style="padding:28px 32px 6px 32px;">
        <div style="font-size:11px;letter-spacing:1.2px;text-transform:uppercase;color:#6b7280;font-weight:600;">Sample order</div>
        <div style="font-size:22px;font-weight:600;color:#0f172a;margin-top:4px;">${escapeHtml(practiceTitle)}</div>
        <div style="font-size:13px;color:#52607a;margin-top:2px;">Prepared by ${escapeHtml(repName)} · Total ${escapeHtml(totalStr)}</div>
      </td></tr>
      <tr><td style="padding:18px 32px 6px 32px;font-size:15px;line-height:1.55;color:#1d293d;">
        ${bodyHtml}
      </td></tr>
      <tr><td align="center" style="padding:18px 32px 6px 32px;">
        <a href="${escapeHtml(orderUrl)}" style="display:inline-block;background:#1d4ed8;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:13px 22px;border-radius:8px;letter-spacing:0.1px;">Review &amp; confirm order →</a>
      </td></tr>
      <tr><td align="center" style="padding:0 32px 24px 32px;">
        <div style="font-size:12px;color:#52607a;">Or open: <a href="${escapeHtml(orderUrl)}" style="color:#1d4ed8;text-decoration:underline;">${escapeHtml(orderUrl)}</a></div>
      </td></tr>
      <tr><td style="padding:14px 32px 22px 32px;border-top:1px solid #eef0f6;">
        <div style="font-size:11px;color:#6b7280;line-height:1.5;">PDF attached. The link above also lets the practice owner confirm and forward to Galderma in one click — they don't need to download anything.</div>
      </td></tr>
    </table>
    <div style="font-size:11px;color:#9aa3b2;margin-top:12px;">Sent via Lizzie(OS) · agentiport.com</div>
  </td></tr>
</table>
</body>
</html>`;
}
