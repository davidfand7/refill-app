-- v2.37.0 — Reschedule Reminders · Slice 3: the $5 reschedule_booking meter.
--
-- A reschedule win: a patient who cancelled or no-showed REBOOKS after a
-- Reschedule Reminders nudge. We record it as a recovery event with
-- recovery_agent='reschedule' + metric_key='reschedule_booking' ($5 flat on the
-- v1.93.0 fee-rules ledger; the fee-rule auto-seeds at $5 because the metric is
-- now in BILLABLE_METRICS). The recovery_agent CHECK must accept the new agent
-- — the same one-line widening as recall (v1.95.0) and cross_sell (v1.99.0).
-- metric_key is plain text (no constraint). Billing is unchanged: the win is
-- provisional until the reconcile cron matches a real transaction, so it only
-- bills verified, exactly like every other meter.

alter table public.emma_recovery_events
  drop constraint if exists emma_recovery_events_recovery_agent_check;

alter table public.emma_recovery_events
  add constraint emma_recovery_events_recovery_agent_check
  check (recovery_agent in (
    'rescue',          -- v361 same-day slot fill
    'post_recovery',   -- post-show rebook
    'preshow',         -- counterfactual estimate
    'recall',          -- v1.95.0 lapsed / expiring-reward → booked
    'cross_sell',      -- v1.99.0 promo-offered service/add-on booked
    'reschedule'       -- v2.37.0 cancelled/no-showed patient rebooks after a nudge
  ));

notify pgrst, 'reload schema';

-- Verify: nothing existing was blocked, and the agent mix is visible.
select recovery_agent, count(*)
from public.emma_recovery_events
group by recovery_agent
order by count(*) desc;
