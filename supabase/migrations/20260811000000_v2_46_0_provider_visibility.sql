-- v2.46.0 — Owner-controlled provider visibility on the calendar (Acuity import fix).
-- ─────────────────────────────────────────────────────────────────────────────
-- The mirror creates a scheduling_providers row for EVERY Acuity calendar, with
-- no way to tell a real provider (a person) from Acuity's business/shared
-- calendar — Acuity gives no flag. So a spa's calendar grid shows spurious
-- "provider" columns (e.g. the business-name calendar next to the real staff).
--
-- CTO call (Option 1): don't guess silently. Mirror everything, but let the OWNER
-- show/hide each provider column, with a smart default that auto-hides an EMPTY
-- business-name-matching mirrored calendar (never one that carries appointments —
-- hiding a column hides its appts, so we never make real bookings vanish by
-- default). A distinct override flag, NOT is_active: the mirror re-sets is_active
-- on every run, so reusing it would wipe the owner's choice on the next sync.
-- hidden_at survives re-mirror. Purely a DISPLAY concern, kept separate from the
-- "bookable after cutover" model (user_id / is_active).
--
--   hidden_at NULL      → shown as a column (default; behavior unchanged).
--             timestamptz→ hidden from the calendar grid (owner choice or the
--                          empty-business-calendar smart default).
alter table public.scheduling_providers
  add column if not exists hidden_at timestamptz;

notify pgrst, 'reload schema';

-- Verify (run after applying):
-- select column_name, data_type, is_nullable from information_schema.columns
--   where table_name = 'scheduling_providers' and column_name = 'hidden_at';
-- select count(*) from public.scheduling_providers where hidden_at is not null;  -- expect 0 right after migrate
