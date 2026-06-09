-- v2.3.20 — Close the double-billing race on emma_recovery_events.
--
-- BUG: recordRecoveryEvent() (emma-attribution.functions.ts) guards against
-- duplicate win rows with an application-level SELECT-then-INSERT. Two
-- concurrent calls for the SAME appointment (e.g. a retried claimRescueSlot,
-- a double-tapped client, or a Worker that committed then timed out and the
-- client retried) can BOTH pass the SELECT (see no existing row) and BOTH
-- INSERT — producing two recovery events for one appointment. Each verifies
-- on reconciliation and each bills $5. This is the shared idempotency point
-- for ALL billable meters (slot_fill, recall_booking, cross_sell_addon), so
-- the race exposes every meter.
--
-- The existing app logic already treats appointment_id as the unique key (the
-- guard SELECTs on appointment_id alone, ignoring metric_key — first win per
-- appointment wins). This migration makes that intent race-safe at the DB
-- level with a UNIQUE partial index, so a losing concurrent INSERT fails with
-- 23505 instead of creating a duplicate. The code change (same ship) catches
-- 23505 and returns the existing row, preserving idempotent behavior.
--
-- DEPLOY ORDER: apply this migration FIRST, then deploy the code (the code's
-- ON-CONFLICT handling needs this unique index to exist).

-- ── Step 0 · pre-check: how many appointments ALREADY have duplicate events? ──
-- If this returns any rows, real double-records exist (some may already have
-- been invoiced — worth a billing review). Step 1 keeps the earliest per
-- appointment and removes the rest so the unique index can be created.
select appointment_id, count(*) as dupes
from public.emma_recovery_events
where appointment_id is not null
group by appointment_id
having count(*) > 1
order by dupes desc;

-- ── Step 1 · dedupe: keep the earliest row per appointment_id, drop the rest ──
-- Aligns stored data with the always-intended "one event per appointment".
delete from public.emma_recovery_events e
using public.emma_recovery_events keep
where e.appointment_id is not null
  and e.appointment_id = keep.appointment_id
  and (
    keep.created_at < e.created_at
    or (keep.created_at = e.created_at and keep.id < e.id)
  );

-- ── Step 2 · enforce one event per appointment at the DB level ──
create unique index if not exists emma_recovery_events_appointment_uniq
  on public.emma_recovery_events (appointment_id)
  where appointment_id is not null;

notify pgrst, 'reload schema';

-- ── Step 3 · verify: zero remaining dupes, index present ──
select count(*) as remaining_dupe_groups from (
  select appointment_id
  from public.emma_recovery_events
  where appointment_id is not null
  group by appointment_id
  having count(*) > 1
) d;

select indexname from pg_indexes
where tablename = 'emma_recovery_events'
  and indexname = 'emma_recovery_events_appointment_uniq';
