-- v386: Refill auth gate (Phase 1.4)
--
-- Binds csv_scanner_leads to auth.users so a Refill lead can become a
-- claimed account inside the onboarding wizard. Two new columns:
--
--   user_id            — set when the lead is first claimed via magic
--                        link or token-as-auth silent-sign-in. NULL until
--                        claim. ON DELETE SET NULL so an auth.users row
--                        purge doesn't destroy the scan history.
--
--   token_consumed_at  — set the first time followup_report_token is
--                        used to sign someone in. Subsequent hits on the
--                        same token go through the magic-link path
--                        instead. Permanent value once set; we never
--                        unset it.
--
-- The token itself stays valid as a /report viewer (read-only); it just
-- can't be used a second time as a silent-sign-in vector.
--
-- pgrst NOTIFY at the bottom forces PostgREST to reload its schema cache
-- so the new columns are exposed to the JS client immediately.

alter table public.csv_scanner_leads
  add column if not exists user_id uuid
    references auth.users(id) on delete set null,
  add column if not exists token_consumed_at timestamptz;

create index if not exists csv_scanner_leads_user_id_idx
  on public.csv_scanner_leads (user_id)
  where user_id is not null;

create index if not exists csv_scanner_leads_token_consumed_at_idx
  on public.csv_scanner_leads (token_consumed_at)
  where token_consumed_at is not null;

notify pgrst, 'reload schema';

-- Verify (paste-friendly): the columns are present and the indexes exist.
-- select column_name, data_type, is_nullable
--   from information_schema.columns
--  where table_schema = 'public'
--    and table_name = 'csv_scanner_leads'
--    and column_name in ('user_id', 'token_consumed_at');
