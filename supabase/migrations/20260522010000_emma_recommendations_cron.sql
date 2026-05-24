-- Emma weekly recommendations regen — refreshes setting recommendations
-- across every spa once a week (v365).
--
-- Hits /api/cron/emma-recommendations on Sunday at 06:00 UTC. The
-- foreground regen also fires on-demand when the spa visits
-- /app/emma/rescue, debounced per-spa so we don't recompute on every
-- page hit. The weekly cron is the safety net for spas that haven't
-- visited recently.
--
-- v358 secret-rotation note: REPLACE <<REPLACE_WITH_PROD_SCHEDULER_SECRET>>
-- with the current value before pasting.
--
-- Established 2026-05-17 (Promotions Engine v365).

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('emma-recommendations') where exists (
  select 1 from cron.job where jobname = 'emma-recommendations'
);

-- Sunday 06:00 UTC (weekly).
select cron.schedule(
  'emma-recommendations',
  '0 6 * * 0',
  $$
    select net.http_post(
      url     := 'https://refill-app.davidfand303.workers.dev/api/cron/emma-recommendations',
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
where jobname = 'emma-recommendations';
