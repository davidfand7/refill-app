/**
 * Mindbody email-shape parser — ARCHITECTURE STUB pending real exemplars.
 *
 * Verified facts (per scout 2026-06-03):
 *   - Sender domain: TENANT-CONFIGURABLE per Marketing Suite "From
 *     Address" customization. CANNOT key on sender domain alone.
 *   - Parser MUST use body markers (Marketing Suite footer / unsubscribe
 *     link host / macro fingerprints) for routing.
 *   - HTML body, owner-editable templates per event.
 *   - Granular per-event config; per-staff CC routing.
 *
 * Activation: a follow-up minor ship after a Mindbody pilot tenant
 * forwards real exemplars showing the actual footer + unsubscribe-link
 * host pattern. Until then this stub recognizes likely Mindbody-shape
 * and quarantines for review.
 */

import type { ParseInput, ParseResult } from "./index";
import { emailBodyText } from "./index";

const MINDBODY_BODY_MARKERS = [
  /mindbodyonline\.com/i,
  /\bmindbody\b/i,
  /clients\.mindbodyonline/i,
];

export function parseMindbodyEmail(input: ParseInput): ParseResult {
  const body = emailBodyText(input).toLowerCase();
  const hasMarker = MINDBODY_BODY_MARKERS.some((re) => re.test(body));
  if (!hasMarker) {
    return {
      event: "unknown",
      appointments: [],
      confidence: 0,
      quarantineReason: "mindbody_body_marker_no_match",
    };
  }

  return {
    event: "unknown",
    appointments: [],
    confidence: 0.2,
    quarantineReason: "mindbody_parser_stub_pending_exemplars",
  };
}
