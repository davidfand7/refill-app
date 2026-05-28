-- v1.22.1 (P1 of unified admin platform sequence) — expand app_role enum.
--
-- Per plan in ~/.claude/plans/frolicking-stargazing-church.md (D3 lock):
-- expand the existing app_role enum from ('admin','member') to also include
-- ('spa_owner','rep','sub_rep','developer') so user_roles becomes the
-- single source of truth for "what kind of user is this." This eliminates
-- the sibling-concept fragmentation that caused the v1.20.4 blank-page
-- outage (primaryRole === "admin" was an unreachable gate because admin
-- is not a valid value in user_preferences.primary_role).
--
-- WHY THIS IS ITS OWN MIGRATION FILE: Postgres prohibits using a newly-added
-- enum value in the same transaction as the ALTER TYPE that creates it
-- (visibility constraint). The Supabase dashboard SQL editor wraps multi-
-- statement pastes in an implicit transaction. Splitting enum expansion
-- (this file) from the backfill INSERTs (20260619010000_unified_admin_p1b
-- _backfill_and_tables.sql) lets each commit cleanly. Paste this file
-- first; wait for it to succeed; then paste the _p1b file.
--
-- IDEMPOTENT: every ADD VALUE uses IF NOT EXISTS — safe to re-run.

alter type public.app_role add value if not exists 'spa_owner';
alter type public.app_role add value if not exists 'rep';
alter type public.app_role add value if not exists 'sub_rep';
alter type public.app_role add value if not exists 'developer';

notify pgrst, 'reload schema';

-- Verify (paste after running):
--   select enumlabel
--   from pg_enum
--   where enumtypid = (select oid from pg_type where typname = 'app_role')
--   order by enumlabel;
-- Expected: admin, developer, member, rep, spa_owner, sub_rep
