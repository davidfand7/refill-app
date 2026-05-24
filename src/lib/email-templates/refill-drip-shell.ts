/**
 * refill-drip-shell.ts — shared HTML template for every Refill trial drip
 * (v389). Single source of truth for the Refill drip email aesthetic so
 * Day-3, Day-7, Day-14, Day-21, Day-28, and any future incentive sends
 * (v390+) all look like they came from the same shop.
 *
 * Locked aesthetic: paper background (#fbfaf7), emerald accent (#056048),
 * Georgia serif headline, R-mark in the header strip, footer wordmark
 * link. Plain-text fallback generated from the same input so screen
 * readers + text-only clients get a parallel rendering.
 *
 * Inputs intentionally minimal: subject + headline + bodyParagraphs +
 * optional CTA. No per-message style overrides; if a future drip needs
 * a visual treatment the shell doesn't support, extend the shell rather
 * than peel back to inline HTML — keeping every drip identical in chrome
 * is the deliberate brand move.
 */

export interface DripEmailContent {
  /** Email subject line. */
  subject: string;
  /** Optional preheader (inbox preview snippet — invisible after the open). */
  preheader?: string;
  /** Big headline at the top of the card. Plain text; no HTML. */
  headline: string;
  /**
   * Body paragraphs in order. Each entry renders as a `<p>` in HTML and
   * a paragraph in text. Use the inline "%CTA%" placeholder in any
   * paragraph to inject an inline-styled button at that position; the
   * paragraph wrapping the placeholder will become a `<div>` so the
   * button can sit center-aligned without HTML-in-paragraph oddness.
   */
  bodyParagraphs: string[];
  /** Optional inline CTA button. Renders where %CTA% appears in body. */
  cta?: { label: string; href: string };
  /** Sign-off line at the bottom of the card. Defaults to "— Karen". */
  signoff?: string;
}

export interface DripEmailRendered {
  subject: string;
  text: string;
  html: string;
}

const BRAND_TAGLINE = "refill your schedule, recover your revenue";

export function wrapDripEmail(content: DripEmailContent): DripEmailRendered {
  const signoff = content.signoff ?? "— Karen";
  const safeSubject = escapeHtml(content.subject);
  const safeHeadline = escapeHtml(content.headline);
  const safePreheader = escapeHtml(content.preheader ?? "");

  // ── Plain text ─────────────────────────────────────────────────────────
  // %CTA% in the body becomes "<label>: <href>" in plain text so the
  // copy still reads naturally to text-only recipients.
  const textBody = content.bodyParagraphs
    .map((p) =>
      content.cta
        ? p.replace(/%CTA%/g, `${content.cta.label}: ${content.cta.href}`)
        : p.replace(/%CTA%/g, ""),
    )
    .filter((p) => p.trim().length > 0)
    .join("\n\n");

  const text = [
    textBody,
    "",
    signoff,
    "Refill / " + BRAND_TAGLINE,
    "https://getrefill.app",
  ].join("\n");

  // ── HTML ──────────────────────────────────────────────────────────────
  const ctaHtml = content.cta
    ? `<div style="margin:20px 0;text-align:center;"><a href="${escapeAttr(content.cta.href)}" style="display:inline-block;background:#056048;color:#fbfaf7;text-decoration:none;font-size:14px;font-weight:600;padding:11px 22px;border-radius:6px;">${escapeHtml(content.cta.label)}</a></div>`
    : "";

  const htmlBody = content.bodyParagraphs
    .map((p) => {
      const safe = escapeHtml(p);
      if (safe.includes("%CTA%")) {
        return safe
          .split("%CTA%")
          .map((chunk) =>
            chunk.trim()
              ? `<p style="margin:0 0 14px 0;color:#1c2024;font-size:15px;line-height:1.6;">${replaceInlineMarkdown(chunk)}</p>`
              : "",
          )
          .join(ctaHtml);
      }
      return `<p style="margin:0 0 14px 0;color:#1c2024;font-size:15px;line-height:1.6;">${replaceInlineMarkdown(safe)}</p>`;
    })
    .join("");

  const preheaderHtml = safePreheader
    ? `<div style="display:none;font-size:0;line-height:0;max-height:0;max-width:0;opacity:0;overflow:hidden;">${safePreheader}</div>`
    : "";

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${safeSubject}</title></head>
<body style="margin:0;padding:0;background:#fbfaf7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1c2024;">
  ${preheaderHtml}
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#fbfaf7;">
    <tr><td align="center" style="padding:32px 20px;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:560px;">
        <tr><td style="padding:0 0 24px 0;">
          <table role="presentation" cellpadding="0" cellspacing="0">
            <tr>
              <td style="background:#056048;width:36px;height:36px;border-radius:8px;text-align:center;vertical-align:middle;color:#fbfaf7;font-family:Georgia,'Times New Roman',serif;font-size:20px;font-weight:600;line-height:36px;">R</td>
              <td style="padding-left:12px;vertical-align:middle;">
                <div style="color:#056048;font-family:Georgia,'Times New Roman',serif;font-size:15px;font-weight:600;letter-spacing:-0.01em;">Refill</div>
                <div style="color:#8a9098;font-size:11px;">/ ${BRAND_TAGLINE}</div>
              </td>
            </tr>
          </table>
        </td></tr>
        <tr><td style="background:#ffffff;border:1px solid #e6e2d6;border-radius:12px;padding:32px 32px 28px 32px;">
          <h1 style="margin:0 0 16px 0;color:#1c2024;font-family:Georgia,'Times New Roman',serif;font-size:24px;line-height:1.25;font-weight:600;letter-spacing:-0.01em;">${safeHeadline}</h1>
          ${htmlBody}
          <p style="margin:24px 0 0 0;color:#5a6068;font-size:14px;line-height:1.55;">${escapeHtml(signoff)}</p>
        </td></tr>
        <tr><td style="padding:20px 4px 0 4px;color:#8a9098;font-size:12px;line-height:1.55;">
          <a href="https://getrefill.app" style="color:#056048;text-decoration:none;">getrefill.app</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return { subject: content.subject, text, html };
}

// ─── helpers ─────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

/**
 * Tiny inline-markdown pass so message authors can drop **bold** runs
 * into a paragraph without having to write raw HTML. Operates on already-
 * HTML-escaped strings (so we&apos;re looking for &amp;quot;**...**&amp;quot;-style runs that
 * survived escaping). Strictly double-asterisk; no italics or links.
 */
function replaceInlineMarkdown(s: string): string {
  return s.replace(
    /\*\*([^*]+)\*\*/g,
    '<strong style="color:#1c2024;">$1</strong>',
  );
}
