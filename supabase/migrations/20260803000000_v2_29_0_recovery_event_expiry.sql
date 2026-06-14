-- v2.29.0 — Recovery-event expiry: close the provisional→verified timeout gap.
--
-- A recovery event starts provisional (verified_at NULL). The reconcile cron
-- tries to match it to a patient_transactions row inside a per-tenant window
-- (windowHours, default 72h). Before this migration, an event that NEVER
-- matched stayed provisional FOREVER:
--   1. it was re-scanned on every reconcile pass (wasted work), and
--   2. a transaction ingested months later (CSV re-upload, delayed sync) whose
--      transaction_date happened to fall in the original window could silently
--      reconcile and BILL the spa for a months-old recovery = a stale-charge
--      fairness risk.
--
-- Fix: stamp expired_at on a provisional once its match window has fully
-- elapsed (window + grace, floored at ~30d) AND it has no matched transaction.
-- The reconcile scan then skips expired rows, so they never late-match/bill.
-- Billing already requires verified_at NOT NULL, so an expired-unverified row
-- never bills regardless. Manual confirm still works on an expired row and
-- clears the expiry (owner override).
--
-- ⚠️ Only TRULY-DEAD provisionals expire: verified_at IS NULL AND
-- matched_transaction_id IS NULL. A "queued for review" event
-- (matched_transaction_id NOT NULL, verified_at NULL = legit pending owner OK)
-- is NEVER expired — that would drop a real pending charge.

alter table public.emma_recovery_events
  add column if not exists expired_at timestamptz,
  add column if not exists expiry_reason text;

comment on column public.emma_recovery_events.expired_at is
  'Stamped by the reconcile cron when a provisional event goes unmatched past its (window + grace) horizon. Excluded from the reconcile scan so it never late-matches or bills. Manual confirm clears it (owner override).';

-- Partial index keeps the reconcile scan (verified_at IS NULL AND expired_at
-- IS NULL, per user) fast as expired rows accumulate.
create index if not exists idx_emma_recovery_events_live_unverified
  on public.emma_recovery_events (user_id)
  where verified_at is null and expired_at is null;
