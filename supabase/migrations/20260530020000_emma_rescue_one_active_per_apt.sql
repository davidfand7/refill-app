-- v381.4: race-safe lock on rescue dispatch per appointment.
--
-- v381 connected the Acuity webhook to dispatchRescueAttempt. First
-- live-fire test caught a race: Acuity fires BOTH appointment.canceled
-- AND appointment.changed for a single status flip, within the same
-- second. Both webhooks pass the in-code idempotency check (steps 3+
-- in dispatchRescueAttempt) at near-identical times because neither
-- has inserted yet — both then proceed to insert a fresh
-- emma_rescue_attempts row → two attempts, two offers, two proxy
-- emails, two iMessage drafts.
--
-- Fix: a partial unique index that constrains "at most one active
-- attempt per (user_id, freed_appointment_id)" at the database layer.
-- The losing concurrent insert will fail with SQLSTATE 23505 and the
-- caller code falls back to returning the winning row's identity.
-- Same race-safe pattern v361 uses for emma_rescue_offers claims.
--
-- Existing data is already deduplicated (see manual cleanup in chat
-- 2026-05-19 11:30 — one race-duplicate from this morning's test was
-- closed_unfilled before this migration runs). If the index creation
-- fails because some other duplicate landed between cleanup and
-- migration, the verify SELECT below will surface them so we can
-- close them and retry.

create unique index if not exists emma_rescue_attempts_one_active_per_apt
  on public.emma_rescue_attempts (user_id, freed_appointment_id)
  where status = 'active';

comment on index public.emma_rescue_attempts_one_active_per_apt is
  'v381.4: partial unique guarantees at most one active rescue attempt per (user, appointment). Race-safety against concurrent dispatchRescueAttempt callers (Acuity canceled+changed double-fire). Losing INSERT gets 23505; caller falls back to SELECT winner.';

notify pgrst, 'reload schema';

-- Verify: should return zero rows. If any rows return, those are
-- pre-existing duplicates that need cleanup before the index applies.
select user_id, freed_appointment_id, count(*) as active_count
from public.emma_rescue_attempts
where status = 'active'
group by user_id, freed_appointment_id
having count(*) > 1;
