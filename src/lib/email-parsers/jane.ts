/**
 * Jane email-shape parser — ARCHITECTURE STUB pending real exemplars.
 *
 * Verified facts (per scout 2026-06-03):
 *   - Sender domain: Jane-controlled but exact From not publicly verifiable.
 *   - HTML body, templated.
 *   - Jane BATCHES multiple appointments per email on a ~3-minute window.
 *     Parser MUST handle N appointments per email (returns
 *     `appointments[]` of length > 1).
 *   - Per-event opt-in/out via Staff Profile settings.
 *
 * Until a Jane pilot tenant forwards real exemplars, this stub returns
 * `unknown` so inbound mail lands in emma_email_quarantine for review.
 * The shipping doctrine (project-platforms-pre-built-architecture)
 * means the dispatch + UI surface exists in v1.42.0; parser activation
 * is a follow-up minor ship after exemplars land.
 */

import type { ParseInput, ParseResult } from "./index";
import { emailBodyText } from "./index";

const JANE_BODY_MARKERS = [
  /jane\.app/i,
  /sent by jane/i,
  /powered by jane/i,
];

export function parseJaneEmail(input: ParseInput): ParseResult {
  const body = emailBodyText(input).toLowerCase();
  const hasMarker = JANE_BODY_MARKERS.some((re) => re.test(body));
  if (!hasMarker) {
    return {
      event: "unknown",
      appointments: [],
      confidence: 0,
      quarantineReason: "jane_body_marker_no_match",
    };
  }

  // Architecture-stub: classifier + batched-event splitter pending
  // pilot exemplars. Recognize as Jane-shaped but quarantine with a
  // distinct reason so the v1.42.x follow-up parser ship can target it.
  return {
    event: "unknown",
    appointments: [],
    confidence: 0.2,
    quarantineReason: "jane_parser_stub_pending_exemplars",
  };
}
