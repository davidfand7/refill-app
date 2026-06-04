/**
 * Boulevard email-shape parser — ARCHITECTURE STUB pending real exemplars.
 *
 * Verified facts (per scout 2026-06-03):
 *   - Sender: Boulevard-controlled domain (joinblvd.com expected); exact
 *     From not publicly verifiable until pilot exemplar.
 *   - HTML body, owner-customizable price-display field.
 *   - Documented owner-emails: new booking (online + in-business),
 *     client arrival, cancellation, service order completed.
 *   - Reschedule + no-show NOT documented as standalone owner-email
 *     triggers — fallback signal (API webhook) required for those even
 *     under Light Mode.
 *
 * Activation: a follow-up minor ship after a Boulevard pilot tenant
 * forwards real exemplars (per feedback-validate-against-real-exports).
 */

import type { ParseInput, ParseResult } from "./index";
import { emailBodyText } from "./index";

const BOULEVARD_BODY_MARKERS = [
  /joinblvd\.com/i,
  /\bboulevard\b/i,
  /dashboard\.joinblvd/i,
];

export function parseBoulevardEmail(input: ParseInput): ParseResult {
  const body = emailBodyText(input).toLowerCase();
  const hasMarker = BOULEVARD_BODY_MARKERS.some((re) => re.test(body));
  if (!hasMarker) {
    return {
      event: "unknown",
      appointments: [],
      confidence: 0,
      quarantineReason: "boulevard_body_marker_no_match",
    };
  }

  return {
    event: "unknown",
    appointments: [],
    confidence: 0.2,
    quarantineReason: "boulevard_parser_stub_pending_exemplars",
  };
}
