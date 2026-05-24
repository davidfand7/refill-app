-- Emma pre-show reminder sweep — fires /api/cron/emma-preshow-sweep every 15 min.
--
-- The sweep scans emma_appointments for upcoming appointments hitting
-- a cadence threshold (T-48h, T-24h, T-3h by default), composes the
-- reminder with the spa's tone + opt-in footer, dispatches via SMS or
-- email per the policy's preshow_channel setting. Compliance rails
-- (opt-out, quiet hours, velocity cap) run identically to campaign
-- sends.
--
-- v358 (2026-05-16) secret-rotation note: REPLACE the placeholder string
--   <<REPLACE_WITH_PROD_SCHEDULER_SECRET>>
-- with the SCHEDULER_SECRET value currently set in the Cloudflare Worker
-- env before pasting this SQL into Supabase Dashboard SQL Editor.
--
-- Cadence: every 15 min. The sweep is cheap when nothing is due (single
-- query returning zero rows). At 15-min granularity we hit cadence
-- thresholds within ±7.5 min of the target time, which is plenty for
-- the pre-show pattern.
--
-- Established 2026-05-17 (Promotions Engine v360).

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('emma-preshow-sweep') where exists (
  select 1 from cron.job where jobname = 'emma-preshow-sweep'
);

select cron.schedule(
  'emma-preshow-sweep',
  '*/15 * * * *',
  $$
    select net.http_post(
      url     := 'https://refill-app.davidfand303.workers.dev/api/cron/emma-preshow-sweep',
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
where jobname = 'emma-preshow-sweep';
