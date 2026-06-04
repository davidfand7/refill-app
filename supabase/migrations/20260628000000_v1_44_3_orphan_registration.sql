-- v1.44.3 — Register remaining orphan surfaces in the nav_features registry.
--
-- Closes the 2026-06-03 orphan-audit punch list. All 4 INSERT default_visible=false
-- so they stay invisible until admin flips them on per-tenant via
-- /app/admin/nav-features.
--
-- nav.sharing — half-built P4 sharing feature (spa-grant page exists at
--   /app/refill/sharing; rep-side reader getSpaAggregatesForRep[s] never wired
--   to UI). Registered so it's admin-controllable; STAYS off until rep-side
--   reader ships OR strategic call to rip.
-- nav.waitlist.invite — 691 LOC cold-opt-in composer at /app/refill/waitlist/invite
-- nav.waitlist.seed   — 425 LOC per-patient seeder at /app/refill/waitlist/seed
-- nav.waitlist.bulk   — 686 LOC bulk seeder at /app/refill/waitlist/bulk
--
-- Pattern: same as v1_44_2_nav_features.sql Campaigns seed. Future opt-in
-- features land here as additional INSERTs.

insert into public.nav_features (feature_key, label, description, persona, default_visible)
values
  (
    'nav.sharing',
    'Data sharing',
    'Grant per-rep access to your aggregate recovery metrics. (P4 sharing — half-built: spa-grant page is functional but rep-side reader UI never shipped. Keep OFF until rep-side ships or strategic call to remove.)',
    'spa',
    false
  ),
  (
    'nav.waitlist.invite',
    'Waitlist invite',
    'Cold-opt-in composer (v1.27.2). Compose a one-time invite to a patient who is not yet on your active waitlist.',
    'spa',
    false
  ),
  (
    'nav.waitlist.seed',
    'Waitlist seed (per patient)',
    'Admin/operator tool for seeding individual waitlist intents on behalf of a specific patient. Good for one-off setup.',
    'spa',
    false
  ),
  (
    'nav.waitlist.bulk',
    'Waitlist seed (bulk)',
    'Bulk waitlist seeder — apply waitlist intents across a large cohort at once. Use when migrating a spa onto Refill from a prior waitlist system.',
    'spa',
    false
  )
on conflict (feature_key) do nothing;

notify pgrst, 'reload schema';

-- Verify (run after apply):
-- select feature_key, persona, default_visible from public.nav_features order by feature_key;
-- Expected: 5 rows (nav.campaigns + nav.sharing + nav.waitlist.bulk + nav.waitlist.invite + nav.waitlist.seed)
