/**
 * Sample Order PDF renderer (v323).
 *
 * Takes the structured order artifact Liz emits and produces a single-page
 * PDF a Rep can attach to an email or hand to a practice owner. pdf-lib
 * (no headless browser) so this runs cleanly inside Cloudflare Workers.
 *
 * Design: light background, dark ink, two-column header (practice / rep),
 * line-items table, total row, closing-line callout, footer with a small
 * disclaimer. Matches David's "polished docs use light background" rule.
 */

import { PDFDocument, StandardFonts, rgb, type PDFPage, type PDFFont } from "pdf-lib";
import type { LizSampleOrder } from "@/server/liz-chat.functions";

export type RenderSampleOrderInput = {
  order: LizSampleOrder;
  /** Rep's display name — appears in the "Prepared by" block. */
  repName: string;
  /** Rep's email — small print, lets the practice reply if questions. */
  repEmail?: string;
  /** ISO date string for the "Issued" label. Defaults to now. */
  issuedAt?: string;
};

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN_X = 54;

const INK = rgb(0.114, 0.161, 0.225);
const INK_SOFT = rgb(0.408, 0.451, 0.522);
const ACCENT = rgb(0.114, 0.306, 0.847);
const RULE = rgb(0.886, 0.91, 0.941);
const BG_TINT = rgb(0.973, 0.976, 0.984);

function usd(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
}

function formatDate(iso?: string): string {
  const d = iso ? new Date(iso) : new Date();
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

/** Wrap a long line at `maxWidth` using the given font/size. */
function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const w of words) {
    const next = current ? `${current} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) <= maxWidth) {
      current = next;
    } else {
      if (current) lines.push(current);
      current = w;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function drawText(
  page: PDFPage,
  text: string,
  x: number,
  y: number,
  opts: { font: PDFFont; size: number; color?: ReturnType<typeof rgb> },
) {
  page.drawText(text, { x, y, font: opts.font, size: opts.size, color: opts.color ?? INK });
}

export async function renderSampleOrderPdf({
  order,
  repName,
  repEmail,
  issuedAt,
}: RenderSampleOrderInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Sample Order — ${order.account.title}`);
  doc.setAuthor(repName);
  doc.setCreator("Lizzie(OS) by Agentiport");

  const page = doc.addPage([PAGE_W, PAGE_H]);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let y = PAGE_H - 60;

  // ── Eyebrow + title ────────────────────────────────────────────────
  drawText(page, "SAMPLE ORDER", MARGIN_X, y, { font: bold, size: 9, color: ACCENT });
  y -= 14;
  drawText(page, order.account.title, MARGIN_X, y - 18, { font: bold, size: 22 });
  y -= 36;

  // Issued + manufacturer line
  const sub = `Issued ${formatDate(issuedAt)}${order.manufacturer ? ` · ${order.manufacturer[0].toUpperCase()}${order.manufacturer.slice(1)}` : ""}`;
  drawText(page, sub, MARGIN_X, y, { font: regular, size: 10, color: INK_SOFT });
  y -= 22;

  // Horizontal rule
  page.drawLine({ start: { x: MARGIN_X, y }, end: { x: PAGE_W - MARGIN_X, y }, thickness: 1, color: RULE });
  y -= 26;

  // ── Two-column block: "Verified position" / "Prepared by" ──────────
  const colW = (PAGE_W - MARGIN_X * 2 - 24) / 2;
  const leftX = MARGIN_X;
  const rightX = MARGIN_X + colW + 24;
  const blockTop = y;

  drawText(page, "VERIFIED POSITION", leftX, blockTop, { font: bold, size: 8, color: INK_SOFT });
  drawText(page, "PREPARED BY", rightX, blockTop, { font: bold, size: 8, color: INK_SOFT });

  let lY = blockTop - 16;
  drawText(page, `Tier: ${order.verified.tier}`, leftX, lY, { font: regular, size: 11 });
  lY -= 16;
  drawText(page, `YTD: ${usd(order.verified.ytd_usd)}`, leftX, lY, { font: regular, size: 11 });
  lY -= 16;
  drawText(page, `Next-tier threshold: ${usd(order.verified.threshold_to_advance_usd)}`, leftX, lY, { font: regular, size: 11 });
  lY -= 16;
  drawText(page, `Gap to close: ${usd(order.verified.gap_usd)}`, leftX, lY, { font: bold, size: 11, color: ACCENT });

  let rY = blockTop - 16;
  drawText(page, repName, rightX, rY, { font: regular, size: 11 });
  if (repEmail) {
    rY -= 16;
    drawText(page, repEmail, rightX, rY, { font: regular, size: 10, color: INK_SOFT });
  }

  y = lY - 30;

  // ── Line items header ──────────────────────────────────────────────
  drawText(page, "PROPOSED ORDER", MARGIN_X, y, { font: bold, size: 8, color: INK_SOFT });
  y -= 14;

  // Table header row (tinted background)
  page.drawRectangle({ x: MARGIN_X, y: y - 6, width: PAGE_W - MARGIN_X * 2, height: 22, color: BG_TINT });
  drawText(page, "Product", MARGIN_X + 10, y, { font: bold, size: 10 });
  const valueColRight = PAGE_W - MARGIN_X - 10;
  const valueColX = valueColRight - bold.widthOfTextAtSize("Amount", 10);
  drawText(page, "Amount", valueColX, y, { font: bold, size: 10 });
  y -= 24;

  // Line item rows
  const rowH = 22;
  for (const li of order.line_items) {
    const display = li.product_display || li.product_family;
    drawText(page, display, MARGIN_X + 10, y, { font: regular, size: 11 });
    const valueStr = usd(li.order_value_usd);
    const vX = valueColRight - regular.widthOfTextAtSize(valueStr, 11);
    drawText(page, valueStr, vX, y, { font: regular, size: 11 });
    page.drawLine({
      start: { x: MARGIN_X, y: y - 6 },
      end: { x: PAGE_W - MARGIN_X, y: y - 6 },
      thickness: 0.5,
      color: RULE,
    });
    y -= rowH;
  }

  // Total row
  y -= 4;
  page.drawRectangle({ x: MARGIN_X, y: y - 6, width: PAGE_W - MARGIN_X * 2, height: 26, color: BG_TINT });
  drawText(page, "Total", MARGIN_X + 10, y + 2, { font: bold, size: 12 });
  const totalStr = usd(order.total_usd);
  const tX = valueColRight - bold.widthOfTextAtSize(totalStr, 12);
  drawText(page, totalStr, tX, y + 2, { font: bold, size: 12, color: ACCENT });
  y -= 36;

  // ── Closing-line callout ───────────────────────────────────────────
  if (order.puts_them_at_tier) {
    const closingMsg = `This order brings ${order.account.title} to the ${order.puts_them_at_tier} tier.`;
    const lines = wrap(closingMsg, regular, 11, PAGE_W - MARGIN_X * 2 - 24);
    const calloutH = lines.length * 16 + 24;
    page.drawRectangle({
      x: MARGIN_X,
      y: y - calloutH,
      width: PAGE_W - MARGIN_X * 2,
      height: calloutH,
      borderColor: ACCENT,
      borderWidth: 0.5,
      color: rgb(0.945, 0.961, 0.996),
    });
    let cy = y - 18;
    for (const ln of lines) {
      drawText(page, ln, MARGIN_X + 14, cy, { font: regular, size: 11, color: INK });
      cy -= 16;
    }
    y -= calloutH + 14;
  }

  // ── Footer ─────────────────────────────────────────────────────────
  const footerY = 56;
  page.drawLine({
    start: { x: MARGIN_X, y: footerY + 18 },
    end: { x: PAGE_W - MARGIN_X, y: footerY + 18 },
    thickness: 0.5,
    color: RULE,
  });
  drawText(
    page,
    "Sample order prepared with Lizzie(OS). Prices reflect manufacturer list at time of issue; final invoicing is on the manufacturer.",
    MARGIN_X,
    footerY,
    { font: regular, size: 8, color: INK_SOFT },
  );
  drawText(page, "agentiport.com", PAGE_W - MARGIN_X - regular.widthOfTextAtSize("agentiport.com", 8), footerY - 12, {
    font: regular,
    size: 8,
    color: INK_SOFT,
  });

  return doc.save();
}
