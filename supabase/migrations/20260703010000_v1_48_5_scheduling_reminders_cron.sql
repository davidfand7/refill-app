-- ════════════════════════════════════════════════════════════════════════
-- v1.48.5 — Register the scheduling-reminders cron (pg_cron → Worker)
-- ════════════════════════════════════════════════════════════════════════
-- Same mechanism as emma-scheduled-sweep: pg_cron calls the Worker endpoint
-- every 5 minutes with the X-Scheduler-Secret header. Each tick releases
-- expired holds + sends due appointment reminders (dedupe is in the Worker).
--
-- BEFORE RUNNING: replace <<SCHEDULER_SECRET>> with the SAME secret already used
-- by the emma-scheduled-sweep job. To see it:
--     select jobname, command from cron.job where jobname = 'emma-scheduled-sweep';
-- (the secret is the X-Scheduler-Secret value inside that command). Use the
-- identical value here so the Worker's SCHEDULER_SECRET check passes.
-- ════════════════════════════════════════════════════════════════════════

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Idempotent: drop any prior registration before re-creating.
select cron.unschedule('scheduling-reminders')
where exists (select 1 from cron.job where jobname = 'scheduling-reminders');

select cron.schedule(
  'scheduling-reminders',
  '*/5 * * * *',
  $$
    select net.http_post(
      url     := 'https://refill-app.davidfand303.workers.dev/api/cron/scheduling-reminders',
      headers := jsonb_build_object(
        'Content-Type',       'application/json',
        'X-Scheduler-Secret', '<<SCHEDULER_SECRET>>'
      ),
      body    := '{}'::jsonb
    );
  $$
);

-- ── Verify (paste-friendly) ──────────────────────────────────────────────
-- select jobname, schedule, active from cron.job where jobname = 'scheduling-reminders';
-- After a few minutes, confirm runs:
-- select status, return_message, start_time
--   from cron.job_run_details
--  where jobid = (select jobid from cron.job where jobname = 'scheduling-reminders')
--  order by start_time desc limit 5;
