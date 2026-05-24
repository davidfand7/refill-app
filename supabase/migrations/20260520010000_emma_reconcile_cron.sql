-- Emma daily reconciliation — matches recovery events to QBO transactions (v363).
--
-- Hits /api/cron/emma-reconcile once a day at 04:30 UTC (after the
-- reliability sweep, before the morning).
--
-- For each spa, the endpoint scans unverified emma_recovery_events
-- (verified_at null) and tries to match them to patient_transactions
-- by patient_node_id + transaction_date in the 14-day window AFTER
-- the rescue claim. On match: stamp verified_at + 'qbo' +
-- attributed_revenue_usd from the transaction.amount_usd. Best-effort
-- — manual confirmation always works as a fallback for any missed
-- match or non-QBO spas.
--
-- v358 secret-rotation note: REPLACE <<REPLACE_WITH_PROD_SCHEDULER_SECRET>>
-- with the current SCHEDULER_SECRET value from the Cloudflare Worker env
-- before pasting.
--
-- Established 2026-05-17 (Promotions Engine v363).

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('emma-reconcile') where exists (
  select 1 from cron.job where jobname = 'emma-reconcile'
);

-- 04:30 UTC daily — well after reliability sweep (02:00) and
-- well before US-Eastern AM rush (~12:30 UTC for early-bird spas).
select cron.schedule(
  'emma-reconcile',
  '30 4 * * *',
  $$
    select net.http_post(
      url     := 'https://refill-app.davidfand303.workers.dev/api/cron/emma-reconcile',
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
where jobname = 'emma-reconcile';
