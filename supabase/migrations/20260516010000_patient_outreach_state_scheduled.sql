-- Emma(OS) scheduled sends (v356).
--
-- Adds a scheduled_at column on patient_outreach_state plus a new
-- valid state 'scheduled'. The spa owner picks a future datetime in
-- the composer; every targeted row flips to state='scheduled' with
-- scheduled_at set. A pg_cron sweep on /api/cron/emma-sweep wakes
-- every minute, finds rows where state='scheduled' AND
-- scheduled_at <= now(), race-safe locks them via UPDATE...RETURNING
-- with the state guard, and dispatches each through the same
-- compliance + dispatch helper that the foreground Send button uses.
--
-- Why a per-row scheduled_at (not per-campaign): the cron sweep
-- already operates row-by-row for the existing 'targeted' rows the
-- foreground send loop ships, so per-row scheduling keeps the
-- dispatch shape uniform. It also lets a future ship support
-- per-row staggering (drip campaigns) without another migration.
--
-- Why 'scheduled' as a distinct state (not just scheduled_at on
-- targeted rows): the sweep query needs a cheap WHERE clause that
-- doesn't scan every targeted row in the database. A partial index
-- on state='scheduled' keeps the hot path small even at fleet scale.
--
-- Established 2026-05-16 (Promotions Engine v356).

-- 1. Widen the state check to include 'scheduled'.
alter table public.patient_outreach_state
  drop constraint if exists patient_outreach_state_state_check;

alter table public.patient_outreach_state
  add constraint patient_outreach_state_state_check check (
    state in ('targeted', 'scheduled', 'outreached', 'engaged', 'booked',
              'showed', 'no_show', 'closed_won', 'closed_lost', 'opted_out')
  );

-- 2. Add the column. Null = not scheduled (the default for foreground
-- targeted rows). Non-null on a 'scheduled' state means "fire after
-- this time on the next sweep tick".
alter table public.patient_outreach_state
  add column if not exists scheduled_at timestamptz;

-- 3. Partial index for the sweep query. Only indexes scheduled rows
-- (typically a tiny fraction of all state rows), and orders by
-- scheduled_at so the planner can stop scanning the moment it hits
-- the first future row.
create index if not exists patient_outreach_state_due_idx
  on public.patient_outreach_state (scheduled_at)
  where state = 'scheduled' and scheduled_at is not null;

comment on column public.patient_outreach_state.scheduled_at is
  'When state=scheduled, the wall-clock time the cron sweep should fire this row. Null otherwise. The compliance rails (quiet hours, velocity cap, opted_out) still run at dispatch time — a 2 AM scheduled send respects quiet hours.';
