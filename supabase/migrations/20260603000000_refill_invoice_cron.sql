-- ─────────────────────────────────────────────────────────────────────────
-- v392 — Refill monthly invoice cron registration
-- ─────────────────────────────────────────────────────────────────────────
--
-- Registers a pg_cron job that fires on the 1st of each month at 09:00 UTC
-- to generate the prior month's invoices for every Refill tenant with an
-- active pricing plan. The job posts to the Supabase Edge Function
-- `refill-invoice`, which proxies to the app's /api/cron/refill-invoice
-- endpoint with the SCHEDULER_SECRET header.
--
-- ARCHITECTURE: two-hop (pg_cron → edge fn → app endpoint), not one-hop
--   pg_cron directly to app. Mirrors the refill-trial-drip pattern (v388)
--   rather than the emma-invoice pattern (v366) so the scheduler secret
--   never lives in pg_cron SQL — only the public anon key does. This makes
--   the scheduler secret rotatable via the Supabase Functions dashboard.
--
-- CADENCE: `0 9 1 * *` — 1st of every month at 09:00 UTC. Matches
--   emma-invoice (v366) so ops staff have a single mental model for "billing
--   runs." 09:00 UTC is comfortably off any spa's open hours in US time.
--
-- IDEMPOTENT: re-running the job on the same day (or any day in the same
--   month) is a no-op for tenants whose invoice already exists. The
--   (tenant_id, period_start) unique constraint on refill_invoices enforces
--   this at the DB level — generateMonthlyInvoicesForAll upserts with
--   onConflict matching the existing row.
--
-- FIRST FIRE: 2026-06-01 09:00 UTC. The first run will create draft
--   invoices for May 2026 recovery events on any tenants that added a paid
--   plan during May (currently zero — rejuv is on trial).
--
-- AUTH IN CRON: the SQL below uses the Supabase project anon key in the
--   Authorization Bearer header. The anon key is a JWT signed by the
--   project's JWT secret, valid for invoking edge functions that have
--   verify_jwt=true (the default). The anon key is PUBLIC — it ships in
--   client JS bundles — so embedding it in pg_cron SQL is fine.
--
-- BEFORE PASTING: replace <<REPLACE_WITH_PROD_ANON_KEY>> below with the
--   anon key from
--   https://supabase.com/dashboard/project/uzjzknuhwyfrrtfusdus/settings/api-keys
--   → "anon public" row → click to reveal → copy the eyJ... value.
-- ─────────────────────────────────────────────────────────────────────────

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Unschedule any prior version of this job before re-registering so this
-- migration is replay-safe.
select cron.unschedule('refill-invoice') where exists (
  select 1 from cron.job where jobname = 'refill-invoice'
);

-- Register: 1st of every month at 09:00 UTC. The edge function reads
-- SCHEDULER_SECRET from its env and forwards to the app's
-- /api/cron/refill-invoice endpoint with the real secret.
select cron.schedule(
  'refill-invoice',
  '0 9 1 * *',
  $$
    select net.http_post(
      url     := 'https://uzjzknuhwyfrrtfusdus.supabase.co/functions/v1/refill-invoice',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer <<REPLACE_WITH_PROD_ANON_KEY>>'
      ),
      body    := '{}'::jsonb
    );
  $$
);

-- ── PostgREST schema reload ──────────────────────────────────────────────

notify pgrst, 'reload schema';

-- ── Verify (paste-friendly) ──────────────────────────────────────────────
-- Run these in the SQL editor after the migration completes to confirm:
--
-- select jobname, schedule, active, jobid
--   from cron.job
--  where jobname = 'refill-invoice';
--
-- -- Inspect recent cron runs (will be empty until the 1st of next month
-- -- or until manually fired):
-- select runid, status, return_message, start_time, end_time
--   from cron.job_run_details
--  where jobid = (select jobid from cron.job where jobname = 'refill-invoice')
--  order by start_time desc
--  limit 10;
--
-- -- Manually fire the cron to verify end-to-end (bypasses the schedule;
-- -- runs the same net.http_post the cron would have):
-- select net.http_post(
--   url     := 'https://uzjzknuhwyfrrtfusdus.supabase.co/functions/v1/refill-invoice',
--   headers := jsonb_build_object(
--     'Content-Type',  'application/json',
--     'Authorization', 'Bearer <<REPLACE_WITH_PROD_ANON_KEY>>'
--   ),
--   body    := '{}'::jsonb
-- );
