-- Emma reliability sweep — daily recompute of every patient's tier (v362).
--
-- Hits /api/cron/emma-reliability-sweep once a day at 02:00 UTC.
-- The endpoint iterates every spa and recomputes reliability_status
-- for each patient with appointment history. Tier transitions emit
-- pattern_alerts.
--
-- Why daily not real-time: the foreground updateAppointmentStatus
-- trigger already fires recomputeForPatient on each status flip. The
-- cron is a safety net for missed signals + a place to catch the
-- "6mo window rolled past a no-show" passive transition (a patient
-- can age out of 'in_recovery' without any appointment activity).
--
-- v358 secret-rotation note: REPLACE <<REPLACE_WITH_PROD_SCHEDULER_SECRET>>
-- with the current SCHEDULER_SECRET value from the Cloudflare Worker env.
--
-- Established 2026-05-17 (Promotions Engine v362).

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('emma-reliability-sweep') where exists (
  select 1 from cron.job where jobname = 'emma-reliability-sweep'
);

-- 02:00 UTC daily — off-peak from the agent scheduler + emma preshow.
select cron.schedule(
  'emma-reliability-sweep',
  '0 2 * * *',
  $$
    select net.http_post(
      url     := 'https://refill-app.davidfand303.workers.dev/api/cron/emma-reliability-sweep',
      headers := jsonb_build_object(
        'Content-Type',       'application/json',
        'X-Scheduler-Secret', '<<9717152588c1f6697da3629b5af89e08ee0ff8fbb2c4bc6f>>'
      ),
      body    := '{}'::jsonb
    );
  $$
);

select jobname, schedule, active
from cron.job
where jobname = 'emma-reliability-sweep';
