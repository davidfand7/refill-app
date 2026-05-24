-- ─────────────────────────────────────────────────────────────────────────
-- v410 — Add is_demo column to public.tenants
-- ─────────────────────────────────────────────────────────────────────────
--
-- WHY
--   v410 ships the Refill standalone-product spa-owner shell. The
--   RefillShellChrome surfaces a DemoBanner when the tenant is a seeded
--   demo persona — mirror of the rep_accounts.metadata->>'demo' pattern
--   that drives the Kelly demo banner. First-class boolean column is
--   cleaner than metadata-json tag (matches the v406 substrate decision
--   to use is_active boolean on outreach_templates rather than tag-based).
--
-- WHAT
--   Adds is_demo boolean column to tenants with default false. Partial
--   index where is_demo=true lets admin queries cheaply list demo tenants.
--
-- TO RUN
--   Paste into Supabase SQL editor BEFORE the Karen demo seed migration
--   (which depends on this column existing). Per [[feedback-migrations-via-dashboard]].
-- ─────────────────────────────────────────────────────────────────────────

begin;

alter table public.tenants
  add column if not exists is_demo boolean not null default false;

create index if not exists tenants_is_demo_idx
  on public.tenants (is_demo) where is_demo = true;

comment on column public.tenants.is_demo is
  'True when this tenant is a seeded demo persona (e.g. Karen demo for the 5/29 walkthrough). Drives the DemoBanner in RefillShellChrome and the wipe_*_demo_data() filters. Defaults false for real production tenants.';

commit;

notify pgrst, 'reload schema';

-- ── Verify (paste-friendly) ──────────────────────────────────────────────
-- select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--  where table_schema='public' and table_name='tenants' and column_name='is_demo';
--
-- select count(*) from public.tenants where is_demo = true;  -- 0 before Karen seed runs
