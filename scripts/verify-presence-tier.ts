/**
 * verify-presence-tier.ts — runnable spec for the v2.58.0 'presence' tier
 * (the local delivery agent heartbeat verdict).
 *
 * Run: bun run scripts/verify-presence-tier.ts
 *
 * The thing being proven: unlike every other tier, a heartbeat fires on a fixed
 * cadence regardless of workload, so silence is trustworthy — age MUST escalate
 * Live → Quiet → Silent (healthy >0.5h stale, >4h broken). And a never-seen
 * agent stays a benign "setup" (no expectation anchor needed; provisioning is
 * the declaration, and the row's existence is what gates the card upstream).
 */

import { computeVerdict, TIER_DEFAULTS } from "../src/lib/connection-health";

const H = 3_600_000;
const MIN = 60_000;
const now = 1_900_000_000_000; // fixed clock; pure fn, no Date.now()

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    failures++;
    console.error(
      `✗ ${label}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`,
    );
  } else {
    console.log(`✓ ${label}`);
  }
}

// Thresholds are what the doctrine claims: tight, and DO hard-break.
check("presence thresholds = 0.5h stale / 4h broken", TIER_DEFAULTS.presence, {
  staleAfterH: 0.5,
  brokenAfterH: 4,
});

const presence = (lastEventAtMs: number | null) =>
  computeVerdict({ tier: "presence", connected: true, lastEventAtMs, nowMs: now })
    .verdict;

// ── Live: a fresh check-in (just now / 5 min / 25 min) ──
check("just checked in → healthy (Live)", presence(now), "healthy");
check("5 min ago → healthy (Live)", presence(now - 5 * MIN), "healthy");
check("25 min ago → healthy (Live)", presence(now - 25 * MIN), "healthy");

// ── Quiet: 30 min–4h (Mac may be asleep) ──
check("45 min ago → stale (Quiet)", presence(now - 45 * MIN), "stale");
check("2 h ago → stale (Quiet)", presence(now - 2 * H), "stale");
check("3.9 h ago → stale (Quiet)", presence(now - 3.9 * H), "stale");

// ── Silent: >4h (relay offline; this is the ONLY tier where age → broken) ──
check("5 h ago → broken (Silent)", presence(now - 5 * H), "broken");
check("overnight 14 h → broken (Silent)", presence(now - 14 * H), "broken");

// ── Never seen: provisioned but no ping yet → benign setup ──
check("never checked in → setup", presence(null), "setup");

// ── Contrast: the delivery tier NEVER hard-breaks, even at 30 days silent,
// where presence is long since broken — proving presence is genuinely distinct,
// not just delivery with new numbers. (delivery stale >72h, broken=never.)
const silence30d = now - 30 * 24 * H;
check(
  "delivery tier, 30 days silence → stale (never broken)",
  computeVerdict({ tier: "delivery", connected: true, lastEventAtMs: silence30d, nowMs: now }).verdict,
  "stale",
);
check(
  "presence tier, same 30 days silence → broken",
  presence(silence30d),
  "broken",
);

if (failures > 0) {
  console.error(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nAll presence-tier checks passed.");
