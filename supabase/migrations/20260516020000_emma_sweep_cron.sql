-- Emma scheduled-sends sweep — fires /api/cron/emma-sweep every minute.
--
-- The sweep scans patient_outreach_state for state='scheduled' AND
-- scheduled_at <= now(), race-safe locks each due row, and dispatches
-- through the same dispatchOutreach helper the foreground Send button
-- uses. Compliance rails (quiet hours, velocity cap, opted_out, banned)
-- run identically on scheduled sends.
--
-- STEP 1 (one-time, must already be done for the agent scheduler):
--   SCHEDULER_SECRET must be set in the Cloudflare Worker environment.
--   Same value pg_cron uses below — reusing the agent-scheduler secret
--   keeps secret management to one entry.
--
-- STEP 2: Before pasting, REPLACE <<REPLACE_WITH_PROD_SCHEDULER_SECRET>>
-- with the current SCHEDULER_SECRET value from the Cloudflare Worker
-- env. Then paste this file into Supabase Dashboard → SQL Editor and
-- run. pg_cron persists jobs across restarts — one paste per rotation.
--
-- Cadence: every minute. Each tick caps at 200 rows so a 1,000-patient
-- blast scheduled for the same minute completes within ~5 ticks.
-- Lift the cap in /api/cron/emma-sweep once dispatch latency is
-- benchmarked under real load.
--
-- Established 2026-05-16 (Promotions Engine v356).

-- Enable required extensions (no-ops if already enabled — both come
-- from the agent-scheduler migration).
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Remove any prior version of this job (idempotent re-run).
select cron.unschedule('emma-scheduled-sweep') where exists (
  select 1 from cron.job where jobname = 'emma-scheduled-sweep'
);

-- Schedule the sweep every minute. Adjust to '*/5 * * * *' if the
-- per-minute load proves wasteful — the cost is one HTTP call per
-- tick that returns immediately when nothing is due.
select cron.schedule(
  'emma-scheduled-sweep',
  '* * * * *',
  $$
    select net.http_post(
      url     := 'https://refill-app.davidfand303.workers.dev/api/cron/emma-sweep',
      headers := jsonb_build_object(
        'Content-Type',       'application/json',
        'X-Scheduler-Secret', '<<REPLACE_WITH_PROD_SCHEDULER_SECRET>>'
      ),
      body    := '{}'::jsonb
    );
  $$
);

-- Confirm the job is registered.
select jobname, schedule, active
from cron.job
where jobname = 'emma-scheduled-sweep';
