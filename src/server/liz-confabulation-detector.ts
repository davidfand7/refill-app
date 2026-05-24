/**
 * liz-confabulation-detector.ts (v333) — server-importable library port of
 * scripts/diag-liz-confabulation.ts, with one new check class.
 *
 * Detects three classes of issues in a Liz reply:
 *
 *   1. FABRICATED_THRESHOLD — a tier-threshold dollar figure that doesn't
 *      match the canonical ASPIRE ladder ($25K / $40K / $65K / $150K / $350K /
 *      $600K / $700K / $1.4M).
 *
 *   2. YTD_MISMATCH — a YTD claim for a named account that doesn't match
 *      the DB. Mirrors the v322 detector logic.
 *
 *   3. MISSING_VERIFIED_LINE (v333 new) — the reply cites tier-math
 *      dollar figures (gap, YTD, threshold, "to reach Executive", etc.)
 *      WITHOUT a `[VERIFIED] <account>: tier=…, ytd=…, threshold_to_advance=…,
 *      gap=…` line at the top. The v319 convention is that every tier-math
 *      reply opens with a structured data receipt; without it, the rep has
 *      no way to verify Liz's numbers against the source. Closes the loop
 *      the CLI detector previously left open.
 *
 * Used by sendLizMessage to enforce the [VERIFIED] convention at the
 * chat-handler retry layer (auto-retry once if findings detected).
 *
 * Pure function — no env reads at import time. The caller supplies the
 * Supabase admin client + the authenticated user's ID.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

export type ConfabFindingType =
  | "FABRICATED_THRESHOLD"
  | "YTD_MISMATCH"
  | "MISSING_VERIFIED_LINE";

export type ConfabFinding = {
  severity: "FLAG" | "WARN";
  type: ConfabFindingType;
  quote: string;
  reason: string;
};

// ── Canonical Galderma ASPIRE thresholds ──────────────────────────────────
// Mirror of scripts/seed-galderma-aspire-tiers.ts ASPIRE_LADDER. Update both
// when the program changes.
const VALID_GALDERMA_THRESHOLDS = new Set<number>([
  0, 25000, 65000, 150000, 350000, 600000,
  40000, 700000, 1400000,
]);
const VALID_GALDERMA_ADVANCE = new Set<number>([
  25000, 65000, 150000, 350000, 600000,
  40000, 150000, 350000, 700000, 1400000,
]);

function dollarStringToNumber(s: string): number | null {
  const cleaned = s.replace(/[$,\s]/g, "");
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

// ── Pattern matchers (mirror diag-liz-confabulation.ts) ───────────────────
const THRESHOLD_PATTERNS: RegExp[] = [
  /Tier Threshold:?\s*\*?\*?\$?([\d,]+(?:\.\d+)?)/gi,
  /\$([\d,]+(?:\.\d+)?)\s*(?:\(annualized|annual)/gi,
  /\$([\d,]+(?:\.\d+)?)\s+to\s+reach/gi,
  /(?:Threshold to advance|to advance to|advance threshold)[^$]*\$([\d,]+(?:\.\d+)?)/gi,
  /\$([\d,]+(?:\.\d+)?)\s+away from/gi,
];

const YTD_PATTERNS: RegExp[] = [
  /ytd\s*=\s*\$?([\d,]+(?:\.\d+)?)/gi,
  /(?:Current YTD Spend|YTD Spend|YTD)[\s:*$]{0,10}([\d,]+(?:\.\d+)?)/gi,
  /YTD\s+(?:spend|spend\s+is|is)[\s:*$]{0,10}([\d,]+(?:\.\d+)?)/gi,
  /year-to-date\s+spend[\s:*$]{0,20}([\d,]+(?:\.\d+)?)/gi,
];

// v333 new: structured [VERIFIED] line that opens any tier-math reply.
// The v319 contract: `[VERIFIED] <account>: tier=X, ytd=$Y, threshold_to_advance=$Z, gap=$G`
// Tolerant: case-insensitive, optional `$`/commas, allows whitespace around `=`.
const VERIFIED_LINE_RE =
  /\[VERIFIED\]\s+[^:]+:\s*tier\s*=\s*[^,]+,\s*ytd\s*=\s*\$?[\d,]+(?:\.\d+)?\s*,\s*threshold_to_advance\s*=\s*\$?[\d,]+(?:\.\d+)?\s*,\s*gap\s*=\s*\$?[\d,]+(?:\.\d+)?/i;

// Tier-math keywords that signal the reply IS doing tier-math reasoning
// (and therefore SHOULD have a [VERIFIED] line). Anchored so we don't fire
// on every casual mention of "gap" or "tier" — must co-occur with a dollar
// figure within the same response.
const TIER_MATH_KEYWORDS = [
  /\bgap\b/i,
  /\bto\s+(?:advance|reach)\b/i,
  /\bthreshold\b/i,
  /\bytd\b/i,
  /\byear[- ]to[- ]date\b/i,
  /\bexecutive\s+tier\b/i,
  /\bsignature\s+(?:director|suite)\b/i,
  /\bbrand\s+adoption\b/i,
  /\baspire\s+access\b/i,
];

// Dollar-figure detector — used only by the missing-VERIFIED check to
// decide "does this reply cite money next to tier-math keywords."
const DOLLAR_NEAR_TIER_RE = /\$\s?[\d,]+(?:\.\d+)?(?:\s|$|[.,;:!?])/;

type AccountInfo = {
  lookupKey: string;
  ytd: number | null;
  tier: string | null;
};

async function getAccountYtds(
  sb: SupabaseClient<Database>,
  userId: string,
): Promise<Map<string, AccountInfo>> {
  const { data: accounts } = await sb
    .from("knowledge_nodes")
    .select("title, lookup_key, attachments")
    .eq("user_id", userId)
    .eq("node_type", "account")
    .eq("source", "report-projection");
  const out = new Map<string, AccountInfo>();
  for (const a of accounts ?? []) {
    const att = (a.attachments ?? {}) as Record<string, unknown>;
    const ytd = typeof att.ytd_volume_usd === "number" ? att.ytd_volume_usd : null;
    const tiers = att.tiers as Array<{ tier: string }> | undefined;
    out.set(a.title.toLowerCase(), {
      lookupKey: (a.lookup_key as string) ?? "",
      ytd,
      tier: tiers?.[0]?.tier ?? null,
    });
  }
  return out;
}

/**
 * Detect confabulations + missing-[VERIFIED]-line issues in a Liz reply.
 *
 * Returns an array of findings; an empty array means the reply passes all
 * structural checks. Defensive: any DB error returns an empty array (we
 * don't want detector flakiness blocking the chat send — silently failing
 * open is the right default until we have observability around it).
 */
export async function detectConfabulations(
  text: string,
  userId: string,
  sb: SupabaseClient<Database>,
): Promise<ConfabFinding[]> {
  const findings: ConfabFinding[] = [];

  // ── 1. Threshold fabrication checks ─────────────────────────────────────
  for (const re of THRESHOLD_PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const amount = dollarStringToNumber(m[1]);
      if (amount == null) continue;
      const inLadder =
        VALID_GALDERMA_THRESHOLDS.has(amount) || VALID_GALDERMA_ADVANCE.has(amount);
      if (!inLadder) {
        findings.push({
          severity: "FLAG",
          type: "FABRICATED_THRESHOLD",
          quote: m[0],
          reason: `$${amount.toLocaleString()} is not in the canonical Galderma ASPIRE ladder. Valid thresholds: $25K, $40K, $65K, $150K, $350K, $600K, $700K, $1.4M.`,
        });
      }
    }
  }

  // ── 2. YTD mismatch checks ──────────────────────────────────────────────
  let accountsByTitle: Map<string, AccountInfo>;
  try {
    accountsByTitle = await getAccountYtds(sb, userId);
  } catch {
    accountsByTitle = new Map();
  }

  for (const re of YTD_PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const ytdClaim = dollarStringToNumber(m[1]);
      if (ytdClaim == null) continue;
      const matchPos = m.index ?? 0;
      const lookback = text.slice(Math.max(0, matchPos - 200), matchPos).toLowerCase();
      let matchedAccount: { title: string; ytd: number | null } | null = null;
      for (const [titleLower, info] of accountsByTitle) {
        if (titleLower.length < 4) continue;
        const firstWord = titleLower.split(/\s+/)[0];
        if (
          lookback.includes(titleLower) ||
          (firstWord.length >= 4 && lookback.includes(firstWord))
        ) {
          matchedAccount = { title: titleLower, ytd: info.ytd };
          break;
        }
      }
      if (!matchedAccount) continue;
      const realYtd = matchedAccount.ytd;
      if (realYtd != null && Math.abs(ytdClaim - realYtd) > 1) {
        findings.push({
          severity: "FLAG",
          type: "YTD_MISMATCH",
          quote: m[0],
          reason: `Claim of $${ytdClaim.toLocaleString()} for "${matchedAccount.title}" doesn't match DB. DB says $${realYtd.toLocaleString()}. (Possible context substitution from another account.)`,
        });
      }
    }
  }

  // ── 3. Missing [VERIFIED] line check (v333 new) ─────────────────────────
  // Heuristic: if the reply mentions tier-math keywords AND cites at least
  // one dollar amount, it's a tier-math reply and SHOULD open with a
  // [VERIFIED] line. Absence of that line is a structural protocol
  // violation, not a numerical confabulation, but it's the same category
  // of fix (retry the model with a "include the [VERIFIED] line" nudge).
  const hasVerifiedLine = VERIFIED_LINE_RE.test(text);
  const mentionsTierMath = TIER_MATH_KEYWORDS.some((re) => re.test(text));
  const citesDollarAmount = DOLLAR_NEAR_TIER_RE.test(text);
  if (!hasVerifiedLine && mentionsTierMath && citesDollarAmount) {
    findings.push({
      severity: "FLAG",
      type: "MISSING_VERIFIED_LINE",
      quote: "(no [VERIFIED] line at top of reply)",
      reason:
        "Reply cites tier-math dollar figures without opening with the [VERIFIED] data-receipt line. " +
        "Per the v319 convention, every reply that cites account numbers must begin with " +
        "`[VERIFIED] <account>: tier=X, ytd=$Y, threshold_to_advance=$Z, gap=$G`.",
    });
  }

  // ── Dedupe — overlapping regex matches can produce duplicates ───────────
  const seen = new Set<string>();
  return findings.filter((f) => {
    const amountMatch = f.quote.match(/\$?([\d,]+(?:\.\d+)?)/);
    const accountMatch = f.reason.match(/for "([^"]+)"/);
    const key = `${f.type}::${amountMatch?.[1] ?? f.quote}::${accountMatch?.[1] ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Build the corrective instruction sent back to the model on auto-retry.
 * Specific enough that the model knows exactly what's wrong, terse enough
 * that the model doesn't drown in feedback.
 */
export function buildRetryInstruction(findings: ConfabFinding[]): string {
  const counts = new Map<ConfabFindingType, number>();
  for (const f of findings) counts.set(f.type, (counts.get(f.type) ?? 0) + 1);

  const issues: string[] = [];
  const seenTypes = new Set<ConfabFindingType>();
  for (const f of findings.slice(0, 5)) {
    if (seenTypes.has(f.type)) continue;
    seenTypes.add(f.type);
    if (f.type === "MISSING_VERIFIED_LINE") {
      issues.push(
        "Your previous reply cited tier-math numbers without opening with the " +
          "`[VERIFIED] <account>: tier=X, ytd=$Y, threshold_to_advance=$Z, gap=$G` line. " +
          "Regenerate the reply, beginning with a valid [VERIFIED] line for the account you're discussing.",
      );
    } else if (f.type === "YTD_MISMATCH") {
      issues.push(
        `Your previous reply contained a YTD mismatch: ${f.reason}. ` +
          "Re-query the memory graph to find the correct YTD for that account, then regenerate.",
      );
    } else if (f.type === "FABRICATED_THRESHOLD") {
      issues.push(
        `Your previous reply contained a fabricated threshold: ${f.reason}. ` +
          "Use only the canonical ASPIRE ladder thresholds: $25K, $40K, $65K, $150K, $350K, $600K, $700K, $1.4M.",
      );
    }
  }

  return (
    "[SYSTEM AUTO-RETRY] Detector flagged the following issues with your previous reply:\n\n" +
    issues.map((i, n) => `${n + 1}. ${i}`).join("\n\n") +
    "\n\nRegenerate your reply correctly. The user's original question stands; this is a retry-with-feedback, not a new question."
  );
}
