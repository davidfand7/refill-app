-- ════════════════════════════════════════════════════════════════════════
-- v2.22.0 — Register the Recall Digest cron (pg_cron → Worker)
-- ════════════════════════════════════════════════════════════════════════
-- Same mechanism as emma-recommendations: pg_cron POSTs the Worker endpoint
-- with the X-Scheduler-Secret header. The Worker walks every spa with
-- recall_digest_enabled = true, computes its recall view, and emails the owner
-- a weekly heads-up ("$X on the table across N patients due"). Empty books send
-- nothing; a 6-day dedup guard in the Worker makes re-runs safe.
--
-- Cadence: Monday 14:00 UTC (≈ Monday morning US) — a fresh-week nudge.
--
-- BEFORE RUNNING: replace <<SCHEDULER_SECRET>> with the SAME secret the other
-- cron jobs use. To see it:
--     select jobname, command from cron.job where jobname = 'emma-recommendations';
-- (the secret is the X-Scheduler-Secret value inside that command). Use the
-- identical value here so the Worker's SCHEDULER_SECRET check passes.
-- ════════════════════════════════════════════════════════════════════════

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Idempotent: drop any prior registration before re-creating.
select cron.unschedule('recall-digest')
where exists (select 1 from cron.job where jobname = 'recall-digest');

select cron.schedule(
  'recall-digest',
  '0 14 * * 1',
  $$
    select net.http_post(
      url     := 'https://refill-app.davidfand303.workers.dev/api/cron/recall-digest',
      headers := jsonb_build_object(
        'Content-Type',       'application/json',
        'X-Scheduler-Secret', '<<SCHEDULER_SECRET>>'
      ),
      body    := '{}'::jsonb
    );
  $$
);

-- ── Verify (paste-friendly) ──────────────────────────────────────────────
select jobname, schedule, active from cron.job where jobname = 'recall-digest';
-- After a run, confirm:
-- select status, return_message, start_time
--   from cron.job_run_details
--  where jobid = (select jobid from cron.job where jobname = 'recall-digest')
--  order by start_time desc limit 5;
