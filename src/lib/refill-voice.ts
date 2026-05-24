/**
 * Refill voice — codified rules + reusable helpers (v413).
 *
 * The 8 voice principles + greeting helpers that keep every welcome
 * moment across the Refill spa-owner experience speaking with ONE
 * voice. Use the helpers when writing new welcome copy; reference
 * the principles in code reviews when copy lands.
 *
 * The rules are GROUNDED in voice patterns that already ship and
 * work — derived from the v413 scout audit of 14 highest-touch
 * welcome moments across /scan, /onboard, RefillHome, Settings
 * (Scheduler/Noshow/Sender), Recovery, Inbox, Billing, and the
 * patient-facing /book + /rescue/claim + /unsubscribe surfaces.
 * Not aspirational principles — observation-grounded.
 *
 * When in doubt:
 *   - greet(spaName) for any signed-in surface that knows the name
 *   - welcomeArc(spaName, outcome) for outcome-anchored arc headings
 *   - welcomeWithFallback(spaName?, outcome) when name may not be loaded
 *   - REFILL_VOICE_PRINCIPLES for the full ruleset
 *
 * DRIFT WARNING: if a Refill-shell surface introduces a welcome
 * moment that doesn't match these rules, that's a regression on
 * the Po CTO Goal 1 ("one product, one story"). Update the ruleset
 * OR fix the surface — don't let them drift silently. Brand-name
 * substitutions (Refill vs the stealth substrate name) ride on
 * brand.ts → brandFor(shell).name; never hardcode brand strings
 * in voice copy. See [[feedback-emma-never-user-facing]].
 */

export interface RefillVoicePrinciple {
  /** The rule, stated as a positive direction. */
  rule: string;
  /** A verbatim shipping example that proves the rule already works. */
  example: string;
  /** The anti-pattern to refuse. */
  avoid: string;
}

/**
 * The 8 codified Refill voice principles. Reference these when
 * adding or editing welcome copy; each is anchored to a real
 * shipping example, not aspiration.
 */
export const REFILL_VOICE_PRINCIPLES: readonly RefillVoicePrinciple[] = [
  {
    rule: "Lead with customer outcome, not product feature.",
    example:
      "/scan: \"See what cancellations + no-shows are really costing you.\"",
    avoid: "Headings that start with Manage / Configure / Set up [tool].",
  },
  {
    rule: "Use numbers to anchor trust, not to impress.",
    example:
      "/onboard Step 1: \"Refill estimates ~$3,180 of recoverable revenue per month.\"",
    avoid: "Vague magnitudes like \"thousands recovered\" or \"a lot of revenue.\"",
  },
  {
    rule: "Erase friction, don't name it.",
    example:
      "/onboard Step 2: \"One tap, OAuth handles the rest — no API keys, no webhook URLs, no port numbers.\"",
    avoid: "Making the user think about the absent thing or the work they'd avoid.",
  },
  {
    rule: "Match copy length to decision speed.",
    example:
      "/rescue/claim is short + urgent (10s patient decision); /scan explains math (60s+ cold-owner decision).",
    avoid: "Long ledes on hot patient surfaces; short ledes on cold-considered owner surfaces.",
  },
  {
    rule: "Use the product name as a verb, not a noun.",
    example: "\"Refill catches the cancellations\" / \"Refill estimates\" / \"Refill automates.\"",
    avoid: "Marketing verbs ahead of the brand: \"Try Refill,\" \"Unlock Refill,\" \"Use Refill.\"",
  },
  {
    rule: "Respect user judgment; offer defaults, not mandates.",
    example:
      "Settings/Noshow: \"Smart defaults work for most spas — tune anything that doesn't fit yours.\"",
    avoid: "Hand-holding microcopy, guilt-trip framing, forced sequences.",
  },
  {
    rule: "Every error message includes a next action.",
    example: "/unsubscribe: \"Changed your mind? Just close this page.\"",
    avoid: "Dead-end errors with no escape hatch.",
  },
  {
    rule: "Greet by name when we know the name.",
    example: "RefillHome: \"Hey Rejuv Skin Spa.\" / /book: \"Hi {first name}.\"",
    avoid: "Generic \"Welcome back\" when a real name is available.",
  },
] as const;

/**
 * Canonical name-anchored greeting. RefillHome hero is the
 * reference implementation; settings page headers, post-onboard
 * landings, and any signed-in surface that knows the spa name
 * should match.
 *
 * Always trailed by a period (declarative, calm — never an
 * exclamation point, which would over-emote).
 */
export function greet(spaName: string): string {
  return `Hey ${spaName.trim()}.`;
}

/**
 * Name-anchored greeting plus outcome continuation. The em-dash
 * bridges personal recognition to forward action in one sentence.
 *
 * Pass the outcome as a verb-phrase ("make your scan real",
 * "see what Refill recovered") — the helper prepends "let's" so
 * callers don't have to remember the cadence.
 *
 * Example:
 *   welcomeArc("Rejuv Skin Spa", "make your scan real")
 *     → "Hey Rejuv Skin Spa — let's make your scan real."
 */
export function welcomeArc(spaName: string, outcomeClause: string): string {
  const trimmed = spaName.trim();
  const clause = stripLeadingLets(outcomeClause);
  return `Hey ${trimmed} — let's ${clause}.`;
}

/**
 * Welcome with graceful fallback when the spa name isn't loaded
 * yet (first-render arcs where hydration is async).
 *
 * Example:
 *   welcomeWithFallback("Rejuv Skin Spa", "make your scan real")
 *     → "Hey Rejuv Skin Spa — let's make your scan real."
 *   welcomeWithFallback(null, "make your scan real")
 *     → "Welcome — let's make your scan real."
 */
export function welcomeWithFallback(
  spaName: string | null | undefined,
  outcomeClause: string,
): string {
  const clause = stripLeadingLets(outcomeClause);
  const trimmed = spaName?.trim();
  if (!trimmed) {
    return `Welcome — let's ${clause}.`;
  }
  return `Hey ${trimmed} — let's ${clause}.`;
}

function stripLeadingLets(clause: string): string {
  // Tolerate callers that already include "let's" (e.g. carried over
  // from existing copy) so we don't double it up.
  return clause.trim().replace(/^let'?s\s+/i, "");
}
