/**
 * Booker email-shape parser — ARCHITECTURE STUB pending real exemplars.
 *
 * Verified facts (per scout 2026-06-03):
 *   - Booker shares the Marketing Suite stack with Mindbody post-2018
 *     acquisition. help.booker.com 301-redirects to support.mindbodyonline.com.
 *   - Sender domain: tenant-configurable (same Marketing Suite model).
 *     CANNOT key on sender domain alone.
 *   - Body markers expected to include booker.com / booker-sourced
 *     unsubscribe-link host distinct from Mindbody's.
 *
 * Activation: follow-up minor ship after a Booker pilot tenant forwards
 * real exemplars. Until then this stub recognizes likely Booker-shape
 * and quarantines for review.
 */

import type { ParseInput, ParseResult } from "./index";
import { emailBodyText } from "./index";

const BOOKER_BODY_MARKERS = [
  /booker\.com/i,
  /\bbooker\b/i,
  /(?:secure|app)\.booker/i,
];

export function parseBookerEmail(input: ParseInput): ParseResult {
  const body = emailBodyText(input).toLowerCase();
  const hasMarker = BOOKER_BODY_MARKERS.some((re) => re.test(body));
  if (!hasMarker) {
    return {
      event: "unknown",
      appointments: [],
      confidence: 0,
      quarantineReason: "booker_body_marker_no_match",
    };
  }

  return {
    event: "unknown",
    appointments: [],
    confidence: 0.2,
    quarantineReason: "booker_parser_stub_pending_exemplars",
  };
}
