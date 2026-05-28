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
  // Spa Owner — REAL Karen Aslakson (Rejuv production tenant). Holds the
  // QuickBooks-uploaded patient roster (1,140 patients). Earlier
  // v1.24.4-era allowlist pointed at karen@rejuv-demo.test which has
  // recovery seed but no patient roster — pointing at real Karen gives
  // the actual demo data we already loaded.
  "karen.aslak@gmail.com",
  // Rep — Kelly Caffee (seed user from rep_platform_demo_seed; fully
  // populated with 7 downstream, 64 ledger, 19 outreach, 20 recovery).
  "kelly@refill-demo.test",
]);
