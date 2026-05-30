/**
 * Demo-persona allowlist — the canonical three personas the
 * PersonaSwitcher surfaces.
 *
 * Grasshopper directive 2026-05-27: the unified admin's persona switcher
 * is a DEMO surface, not a user-management surface. Operator needs
 * exactly three personas to walk: Admin (themselves), Spa Owner (Karen
 * Demo), Rep (Kelly Demo). Listing all 14 users in the dropdown dilutes
 * the demo flow and adds nothing the /app/admin/users page can't do
 * better.
 *
 * Adding a fourth persona (e.g. Maria for cross-rep comparison) is a
 * deliberate product call, not just adding an email to a list. Keep
 * this set small.
 */

export const DEMO_PERSONA_EMAILS: ReadonlySet<string> = new Set([
  // v1.26.13 — Spa Owner pointed at the LIVE working tenant where the
  // rescue engine actively fires (testspaowner@test.com, renamed from
  // karen@rejuv-demo.test). The 2026-05-29 diagnostic showed 11 rescue
  // attempts + 10 offers + 9 future cancellations + email proxy active
  // there, vs zero engine activity on the formerly-canonical
  // karen.aslak@gmail.com which holds the QB-uploaded patient roster
  // but no rescue history. v1.24.5-era choice was correct for "where
  // do real patients live" but wrong for "where does the engine fire"
  // — v417 superseded that pointer and this allowlist follows. The
  // dormant gmail tenant is renamed to dormantspaowner@test.com but
  // not in this allowlist (no longer demo-visible).
  "testspaowner@test.com",
  // Rep — Kelly Caffee (seed user from rep_platform_demo_seed; fully
  // populated with 7 downstream, 64 ledger, 19 outreach, 20 recovery).
  "kelly@refill-demo.test",
]);
