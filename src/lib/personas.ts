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
  "karen",
  "kelly",
]);

/**
 * Derived: the set of emails the PersonaSwitcher allowlists in its
 * client-side filter. Computed from PERSONA_EMAILS + DEMO_PERSONA_KEYS
 * so a rename in PERSONA_EMAILS automatically propagates here.
 */
export const DEMO_PERSONA_EMAILS: ReadonlySet<string> = new Set(
  [...DEMO_PERSONA_KEYS].map((k) => PERSONA_EMAILS[k]),
);
