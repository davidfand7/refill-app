/**
 * Rep-proposal Ghostwriter core — SERVER-ONLY (v2.148.0, Rep Deal-Maker slice 1).
 *
 * Composes the off-record-friendly negotiation ask FROM the spa owner TO their
 * manufacturer rep, in the OWNER'S careful, confidential, relationship-first
 * voice. The owner reviews / edits / SENDS it himself — SmartSpa is the
 * strategist + ghostwriter, never a party of record. The deal stays human and
 * off SmartSpa's books (we don't persist it; an off-record deal that lands just
 * surfaces later as a deeper per-tenant verified cost via the existing portal/
 * verified-ladder lane). See project_rep_dealmaker + project_karen_assistant
 * (same voice-composition pattern, aimed at the SUPPLY side).
 *
 * The @anthropic-ai/sdk import (node:crypto/fs) lives here so it never reaches
 * the browser bundle; rep-dealmaker.functions.ts reaches this via a *dynamic*
 * import inside its handler. Nothing here is client-safe.
 *
 * GUARDRAIL (the trust foundation — baked into the system prompt): the draft
 * ASKS what's possible on the owner's OWN leverage (timing + his own volume +
 * the relationship). It must NEVER assert or imply cross-spa terms ("other
 * practices get $350") — that would break the confidentiality the owner promises
 * every rep, which is the whole basis of the off-record layer.
 */

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

function getAnthropicClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("Deal-Maker isn't configured — ANTHROPIC_API_KEY missing.");
  }
  return new Anthropic({ apiKey });
}

export type RepProposalTone = "warm" | "direct" | "brief";
export type RepProposalChannel = "email" | "text";

export type RepProposalInput = {
  spaName: string;
  ownerName?: string | null;
  manufacturerLabel: string;
  repName?: string | null;
  /** Timing leverage from the leverage-window engine. */
  windowHeadline?: string | null;
  isYearEnd?: boolean;
  daysUntil?: number | null;
  quarterLabel?: string | null;
  /** Volume-commitment leverage (the what-if). */
  productName?: string | null;
  currentUnitPrice?: number | null;
  targetQty?: number | null;
  targetUnitPrice?: number | null;
  unitLabel?: string | null;
  /** Optional owner-entered/derived burn ("I usually buy ~N per quarter"). */
  typicalQtyPerQuarter?: number | null;
  /** Owner's OWN spend with this manufacturer (reliable; credible volume leverage). */
  quarterlySpendUsd?: number | null;
  annualSpendUsd?: number | null;
  /** Optional free-text relationship colour ("we've worked together 6 years"). */
  relationshipNote?: string | null;
  tone: RepProposalTone;
  channel: RepProposalChannel;
};

export type RepProposalOutput = { subject: string | null; body: string };

const outputSchema = z.object({
  subject: z.string().nullable(),
  body: z.string().min(1),
});

const SYSTEM = `You are a ghostwriter. You write a SHORT message FROM an independent medical-spa owner TO their manufacturer sales rep (the person who sells them Botox/filler/etc.). The owner will read it, tweak it, and send it himself from his own inbox/phone. You are NOT a party to the message — you write in the owner's first-person voice.

THE OWNER'S VOICE:
- A seasoned, successful practice owner (often 15–20+ years). Calm, confident, warm, never desperate.
- Relationship-first: the rep is a long-term partner, not an adversary. Collaborative tone — "let's both win."
- Confidential by reflex: the owner is known for discretion and PROMISES every rep that anything they work out stays between them. That discretion should come through.
- Concise and human — a real text/email between two people who know each other, not a procurement RFP.

THE PLAYBOOK (use only what the inputs support):
1. TIMING: gently surface that you know it's near quarter-end / year-end and you'd like to help them hit their number — and that this is a good moment for you to place a meaningful order.
2. VOLUME: ask, openly, what's possible if you commit to a larger order — "what would I need to order to unlock a better number / extra rebates / vouchers / a special this quarter?" Invite them to tell you the threshold.
3. RELATIONSHIP: lean on the years and trust; reaffirm discretion.

HARD RULES (never break — this protects the trust the whole relationship rests on):
- NEVER reference, assert, or imply what ANY other practice, spa, or customer pays or gets. No "I hear others get…", no comparisons, no benchmarks. Zero.
- NEVER state a specific competing price or quote as leverage. The owner's leverage is his OWN timing, his OWN volume commitment, and the relationship — nothing else.
- NEVER pressure, threaten to switch brands, or sound transactional/cold.
- It's an ASK and an INVITATION ("is there room…", "what's possible if I commit to…", "what would I need to order to…"), never a demand.
- Don't invent numbers. Only use the figures provided. If volume figures are absent, ask the rep to tell you the thresholds rather than naming any.
- Reaffirm that anything you work out stays strictly between the two of you.

FORMAT:
- channel "email": include a short, warm subject line and a 1–2 short-paragraph body. End with a friendly sign-off; if an owner name is provided, sign with it.
- channel "text": subject = null; body = 2–4 plain sentences, no greeting line needed beyond a quick "Hey [rep]".
- tone "warm": friendly and personal. tone "direct": still warm but gets to the ask faster. tone "brief": shortest version that still carries timing + the ask.

Return ONLY a JSON object: { "subject": string|null, "body": string }. No markdown, no commentary.`;

function fmtMoney(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  return `$${n.toFixed(2)}`;
}

function buildUserMessage(input: RepProposalInput): string {
  const unit = input.unitLabel?.trim() || "unit";
  const lines: string[] = [];
  lines.push(`Spa / practice name: ${input.spaName}`);
  if (input.ownerName) lines.push(`Owner's name (sign-off): ${input.ownerName}`);
  lines.push(`Manufacturer: ${input.manufacturerLabel}`);
  lines.push(`Rep name: ${input.repName?.trim() || "(unknown — use a generic friendly greeting)"}`);
  lines.push(`Channel: ${input.channel}`);
  lines.push(`Tone: ${input.tone}`);

  lines.push("");
  lines.push("TIMING LEVERAGE:");
  if (input.windowHeadline) lines.push(`- ${input.windowHeadline}`);
  if (input.quarterLabel) lines.push(`- Current quarter: ${input.quarterLabel}`);
  if (input.daysUntil != null) lines.push(`- Days until the quarter closes: ${input.daysUntil}`);
  if (input.isYearEnd) lines.push(`- This is also the manufacturer's fiscal YEAR-end (extra pressure on the rep).`);

  const hasVolume =
    input.productName || input.targetQty != null || input.currentUnitPrice != null;
  if (hasVolume) {
    lines.push("");
    lines.push("VOLUME LEVERAGE (the owner's own commitment — frame as an ask, never assert it as a known deal):");
    if (input.productName) lines.push(`- Product in focus: ${input.productName}`);
    const cur = fmtMoney(input.currentUnitPrice);
    if (cur) lines.push(`- Owner's current price: ${cur}/${unit}`);
    if (input.targetQty != null) lines.push(`- A volume break exists if the owner commits to ~${input.targetQty} ${unit}s.`);
    const tgt = fmtMoney(input.targetUnitPrice);
    if (tgt) lines.push(`- That published break would land around ${tgt}/${unit} — but the owner is asking what's possible BEYOND the published ladder, off the record.`);
  }

  if (input.typicalQtyPerQuarter != null) {
    lines.push("");
    lines.push(`OWNER'S TYPICAL PACE: about ${input.typicalQtyPerQuarter} ${unit}s per quarter (use to make the commitment feel real and credible).`);
  }

  const qSpend = fmtMoney(input.quarterlySpendUsd);
  const aSpend = fmtMoney(input.annualSpendUsd);
  if (qSpend || aSpend) {
    lines.push("");
    lines.push("OWNER'S OWN VOLUME WITH THIS MANUFACTURER (the owner's own real spend — credible leverage; reference it as 'my business with you', NEVER compare to anyone else):");
    if (qSpend) lines.push(`- About ${qSpend} per quarter.`);
    if (aSpend) lines.push(`- About ${aSpend} per year.`);
  }

  if (input.relationshipNote?.trim()) {
    lines.push("");
    lines.push(`RELATIONSHIP NOTE (weave in naturally): ${input.relationshipNote.trim()}`);
  }

  lines.push("");
  lines.push("Write the message now. Remember the HARD RULES — the owner's leverage is ONLY his timing, his own volume, and the relationship. Never reference anyone else's pricing.");
  return lines.join("\n");
}

/** Compose the rep-ask draft. Returns subject (email only) + editable body. */
export async function composeRepProposal(
  input: RepProposalInput,
): Promise<RepProposalOutput> {
  const client = getAnthropicClient();
  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: SYSTEM,
      messages: [{ role: "user", content: buildUserMessage(input) }],
    });
    const text = response.content
      .find((b): b is Anthropic.TextBlock => b.type === "text")
      ?.text?.trim();
    if (!text) throw new Error("The Deal-Maker came back empty — try again.");
    const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripped);
    } catch {
      // Fall back to treating the whole reply as the body (no subject).
      return { subject: null, body: stripped };
    }
    const safe = outputSchema.safeParse(parsed);
    if (!safe.success) {
      return { subject: null, body: stripped };
    }
    return {
      subject: input.channel === "text" ? null : safe.data.subject,
      body: safe.data.body,
    };
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) {
      throw new Error("The Deal-Maker is rate-limited right now — try again in 30s.");
    }
    if (e instanceof Anthropic.AuthenticationError) {
      throw new Error("Deal-Maker isn't configured (auth) — ping support.");
    }
    throw e instanceof Error ? e : new Error("Couldn't draft the message.");
  }
}
