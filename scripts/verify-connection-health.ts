/**
 * verify-connection-health.ts — runnable spec for the pure verdict logic,
 * focused on the v2.8.0 "expected but never arrived" escalation.
 *
 * Run: bun run scripts/verify-connection-health.ts
 *
 * The thing being proven: a portal the spa EXPECTS but that has never imported
 * does NOT sit at a benign "setup" forever — its silence ages against the tier
 * thresholds (poll: stale >36h, broken >72h) so a first pull that never landed
 * surfaces as a flagged card. And without an expectation anchor, an empty feed
 * stays a benign "setup" (we don't cry wolf on a feed nobody declared).
 */

import { computeVerdict, TIER_DEFAULTS } from "../src/lib/connection-health";

const H = 3_600_000;
const now = 1_900_000_000_000; // fixed clock; pure fn, no Date.now()

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    failures++;
    console.error(`✗ ${label}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
  } else {
    console.log(`✓ ${label}`);
  }
}

// ── Expected, never arrived: ages setup → stale → broken (poll tier) ──
// poll thresholds: stale >36h, broken >72h.
check(
  "expected 1h ago, no import → setup (still standing up)",
  computeVerdict({ tier: "poll", connected: true, lastEventAtMs: null, expectedSinceMs: now - 1 * H, nowMs: now }).verdict,
  "setup",
);
check(
  "expected 40h ago, no import → stale (first pull overdue)",
  computeVerdict({ tier: "poll", connected: true, lastEventAtMs: null, expectedSinceMs: now - 40 * H, nowMs: now }).verdict,
  "stale",
);
check(
  "expected 80h ago, no import → broken (first pull never landed)",
  computeVerdict({ tier: "poll", connected: true, lastEventAtMs: null, expectedSinceMs: now - 80 * H, nowMs: now }).verdict,
  "broken",
);

// ── No expectation anchor: an empty feed stays benign (don't cry wolf) ──
check(
  "connected, no data, NO expected anchor, even 'long ago' clock → setup",
  computeVerdict({ tier: "poll", connected: true, lastEventAtMs: null, nowMs: now }).verdict,
  "setup",
);

// ── Not connected at all, but expected (e.g. revoked calendar) → broken now ──
check(
  "expected scheduler, NOT connected → broken (gap now, no grace)",
  computeVerdict({ tier: "realtime", connected: false, lastEventAtMs: null, expectedSinceMs: now - 1 * H, nowMs: now }).verdict,
  "broken",
);
check(
  "NOT connected, NOT expected → unconfigured (don't invent connections)",
  computeVerdict({ tier: "realtime", connected: false, lastEventAtMs: null, nowMs: now }).verdict,
  "unconfigured",
);

// ── A real error still wins over the expected-silence path ──
check(
  "expected + errored → broken (hard failure wins)",
  computeVerdict({ tier: "poll", connected: true, errored: true, lastEventAtMs: null, expectedSinceMs: now - 1 * H, nowMs: now }).verdict,
  "broken",
);

// ── snapshot tier never escalates to broken on silence (brokenAfterH null) ──
check(
  "expected snapshot, ancient, no import → stale not broken (snapshots never hard-fail on age)",
  computeVerdict({ tier: "snapshot", connected: true, lastEventAtMs: null, expectedSinceMs: now - 365 * 24 * H, nowMs: now }).verdict,
  "stale",
);

// ── Once data HAS arrived, expectedSinceMs is ignored; freshness is real age ──
check(
  "imported 1h ago (expected long ago) → healthy (real event wins)",
  computeVerdict({ tier: "poll", connected: true, lastEventAtMs: now - 1 * H, expectedSinceMs: now - 999 * H, nowMs: now }).verdict,
  "healthy",
);

// ── Sanity: thresholds are what the spec assumes ──
check("poll staleAfterH", TIER_DEFAULTS.poll.staleAfterH, 36);
check("poll brokenAfterH", TIER_DEFAULTS.poll.brokenAfterH, 72);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll connection-health verdict checks passed.");
