-- v2.78.0 — Fix the migration-ledger collision introduced in v2.77.0.
--
-- The two emma_ migrations were mis-timestamped 20260618020000 / 20260618030000,
-- colliding EXACTLY with two existing v417 migrations
-- (v417_admin_refill_next, v417_persona_bridge_metadata). Because version is the
-- ledger PK, the v2.77.0 backfill's `on conflict do nothing` recorded the emma
-- rows and SILENTLY DROPPED the two v417 rows. The emma migration FILES have now
-- been renamed to 20260816020000 / 20260816030000 (correct forward sequence).
-- This migration reconciles the live ledger to match.
--
-- Idempotent + safe on any DB:
--   • On Rejuv (ledger ran buggy): deletes the mis-placed emma rows, records the
--     skipped v417 rows, and records the emma rows under their corrected versions.
--   • On a fresh DB (ledger backfill already corrected): the delete matches
--     nothing and every insert is a no-op.

create table if not exists public._schema_migrations (
  version     text primary key,
  name        text not null,
  applied_at  timestamptz not null default now(),
  backfilled  boolean not null default false
);

-- 1) Remove the two emma rows mis-recorded on the v417 timestamps.
delete from public._schema_migrations
where (version = '20260618020000' and name = 'v2_75_0_retire_emma_table_prefix')
   or (version = '20260618030000' and name = 'v2_76_0_emma_retire_phase2_functions_drop_views');

-- 2) Record the two v417 migrations the collision skipped.
insert into public._schema_migrations (version, name, backfilled) values
  ('20260618020000', 'v417_admin_refill_next', true),
  ('20260618030000', 'v417_persona_bridge_metadata', true)
on conflict (version) do nothing;

-- 3) Record the emma migrations under their corrected (renamed) versions.
insert into public._schema_migrations (version, name, backfilled) values
  ('20260816020000', 'v2_75_0_retire_emma_table_prefix', true),
  ('20260816030000', 'v2_76_0_emma_retire_phase2_functions_drop_views', true)
on conflict (version) do nothing;

-- Record THIS migration.
insert into public._schema_migrations (version, name) values
  ('20260817010000', 'v2_78_0_ledger_collision_fix')
on conflict (version) do nothing;
