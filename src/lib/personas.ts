/**
 * Canonical persona roster — shared by the public /personas magic-link
 * mint flow AND the admin PersonaSwitcher dropdown.
 *
 * Single source of truth for "which test personas exist and what are
 * their emails." Renaming a persona email here automatically propagates
 * to both surfaces; there is no second list to keep in sync.
 *
 * History: pre-v1.26.17, this lived inline in
 * `src/server/v417-persona-mint.ts` and was duplicated by string-literal
 * email in `src/lib/demo-personas.ts`. v1.26.13's Karen tenant rename
 * had to manually edit both files. This file collapses the two.
 *
 * Client-safe: pure consts, no server-side imports (no service-role
 * client, no createServerFn). Importable from anywhere.
 *
 * Related: [[feedback-test-naming-convention]] (auth identity =
 * test{role}@test.com, display = warm human via spa-profile).
 */

export const PERSONA_EMAILS = {
  // v1.23.0 P3 — renamed from admin@refill-demo.test via
  // supabase/migrations/20260620000000_v123_admin_rename.sql (UUID
  // preserved so user_roles + admin_audit_log refs stay valid).
  admin: "admin@refill.platform",
  // Rep — Kelly Caffee, seeded from rep_platform_demo_seed (7 downstream,
  // 64 ledger, 19 outreach, 20 recovery).
  kelly: "kelly@refill-demo.test",
  // Rep #2 — Maria. Mint-only persona; not surfaced in the admin
  // PersonaSwitcher dropdown per Grasshopper's v1.24.4 three-personas
  // directive. Available via /personas magic-link for cross-rep demo.
  maria: "maria@refill-demo.test",
  // Spa Owner — Karen (testspaowner@test.com). v1.26.13 rename from
  // karen@rejuv-demo.test — the LIVE working tenant where the rescue
  // engine fires. Display name stays "Karen" via spa-profile
  // owner-display-name (v1.26.12).
  karen: "testspaowner@test.com",
} as const;

export type PersonaKey = keyof typeof PERSONA_EMAILS;

/**
 * Which personas appear in the admin PersonaSwitcher dropdown.
 *
 * Admin is excluded — the caller's own identity is rendered separately
 * as the "My roles" revert option.
 *
 * Maria is excluded per Grasshopper's v1.24.4 directive: the demo
 * surface needs THREE personas (Admin / Spa Owner / Rep), not four.
 * Maria stays mint-able via /personas for cross-rep comparison demos
 * that aren't part of the canonical walkthrough.
 *
 * Adding a fourth visible persona is a deliberate product call — edit
 * this set, not just PERSONA_EMAILS.
 */
export const DEMO_PERSONA_KEYS: ReadonlySet<PersonaKey> = new Set([
  // v2.175.0 (collapse-to-one-spa, Phase 1) — "karen" REMOVED. That key maps to
  // the DEMO-seed Rejuv (testspaowner@test.com, slug rejuv-demo, 1 patient),
  // which shares a display name with the REAL Rejuv (karen.rejuv@gmail.com,
  // ecf8bcee, 1,140 patients, via ADMIN_VIEWABLE_REAL_EMAILS). Two identically-
  // named "Rejuv Skin Spa" rows in the switcher = the footgun that's burned us
  // repeatedly (v1.34.1.1, and again tonight). Dropping the demo seed leaves
  // exactly ONE Rejuv in the dropdown — the real one. Kelly (rep demo) stays for
  // now; the rep platform is a separate axis from the one-spa collapse.
  "kelly",
]);

/**
 * v1.34.1.1: real-but-admin-viewable emails. These appear in the admin
 * PersonaSwitcher dropdown but are deliberately NOT in PERSONA_EMAILS,
 * so the public /personas magic-link mint flow (which iterates
 * PERSONA_EMAILS via v417-persona-mint.ts) cannot expose them.
 *
 * Use case: admin needs to view-as a real production user (Karen's
 * actual tenant where 1,140 real patients live) without making that
 * account mint-able by anonymous /personas visitors.
 *
 * Established 2026-06-02 after the v1.28.0 rename (dormantspaowner@test.com
 * → karen.rejuv@gmail.com) made Karen's real tenant invisible in the
 * PersonaSwitcher dropdown. The allowlist below was checking against the
 * now-defunct testspaowner@test.com via PERSONA_EMAILS.karen, which
 * matches the demo seed tenant, not Karen's real one.
 */
export const ADMIN_VIEWABLE_REAL_EMAILS: ReadonlySet<string> = new Set([
  "karen.rejuv@gmail.com",
]);

/**
 * Derived: the set of emails the PersonaSwitcher allowlists in its
 * client-side filter. Computed from PERSONA_EMAILS + DEMO_PERSONA_KEYS
 * + ADMIN_VIEWABLE_REAL_EMAILS so a rename in PERSONA_EMAILS automatically
 * propagates here AND admin can view-as real prod accounts without
 * exposing them to public mint.
 */
export const DEMO_PERSONA_EMAILS: ReadonlySet<string> = new Set([
  ...[...DEMO_PERSONA_KEYS].map((k) => PERSONA_EMAILS[k]),
  ...ADMIN_VIEWABLE_REAL_EMAILS,
]);
