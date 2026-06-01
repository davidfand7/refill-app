-- v1.28.2 — Decommission emma-invoice pg_cron job.
--
-- Phase 2 of the billing unification (Phase 1 shipped v1.26.23).
--
-- WHY: since v1.9 the UI writes to refill_pricing_plans + reads from
-- refill_invoices. The emma-invoice cron has been firing 0 9 1 * * UTC
-- against emma_pricing_plans (zero active rows post-v1.9) and writing
-- to emma_invoices (zero readers post-v1.7.2 + v1.26.23). Silently
-- churning over nothing. Decommission unblocks Phase 3 (file delete)
-- and Phase 4 (table archive).
--
-- GATE: SCHEDULER_SECRET rotation completed 2026-05-31 15:17 — done.
-- This is one of the 6 SCHEDULER_SECRET crons; removing it shrinks
-- the rotation surface area for next quarter.
--
-- ROLLBACK: re-paste supabase/migrations/20260523010000_emma_invoice_cron.sql
-- with the current rotated secret substituted.

select cron.unschedule('emma-invoice')
  where exists (select 1 from cron.job where jobname = 'emma-invoice');

-- Verification (paste into a SQL editor tab after Run):
-- select jobname, schedule, active from cron.job order by jobname;
-- expected: no 'emma-invoice' row. The 5 remaining SCHEDULER_SECRET
-- crons (emma-scheduled-sweep, emma-preshow-sweep, emma-reliability-sweep,
-- emma-reconcile, emma-recommendations) should still be active. The
-- refill-invoice ANON-key cron is unrelated and should also still show.

notify pgrst, 'reload schema';
