-- Emma monthly invoice generation — fires /api/cron/emma-invoice on the
-- 1st of each month at 09:00 UTC (v366).
--
-- For each spa with an active emma_pricing_plans row, aggregates verified
-- emma_recovery_events from the prior month, computes the share, generates
-- an emma_invoices row in draft status. v366.x flips draft → sent + pushes
-- to Stripe when the spa adds a payment method.
--
-- v358 secret-rotation note: REPLACE <<REPLACE_WITH_PROD_SCHEDULER_SECRET>>
-- with the current value before pasting.
--
-- Established 2026-05-17 (Promotions Engine v366 — engine complete).

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('emma-invoice') where exists (
  select 1 from cron.job where jobname = 'emma-invoice'
);

-- 1st of every month at 09:00 UTC. Late enough that the prior day's
-- reconciliation cron (04:30 UTC) has settled the last batch of
-- verified recovery events.
select cron.schedule(
  'emma-invoice',
  '0 9 1 * *',
  $$
    select net.http_post(
      url     := 'https://refill-app.davidfand303.workers.dev/api/cron/emma-invoice',
      headers := jsonb_build_object(
        'Content-Type',       'application/json',
        'X-Scheduler-Secret', '<<REPLACE_WITH_PROD_SCHEDULER_SECRET>>'
      ),
      body    := '{}'::jsonb
    );
  $$
);

select jobname, schedule, active
from cron.job
where jobname = 'emma-invoice';
