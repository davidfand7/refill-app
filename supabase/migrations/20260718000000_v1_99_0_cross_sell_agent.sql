-- v1.99.0 — Cross-Sell · Slice B (Patient-Profitability OS · Phase 2).
--
-- A cross-sell win: a patient books a service/add-on that carried an active
-- manufacturer promo. We record it as a recovery event with
-- recovery_agent='cross_sell' + metric_key='cross_sell_addon' ($5 on the
-- v1.93.0 fee-rules ledger). The recovery_agent CHECK must accept the new
-- agent — same one-line widening as v1.95.0 (recall). metric_key is plain
-- text (no constraint); cross_sell_addon is already a priced fee-rule.

alter table public.emma_recovery_events
  drop constraint if exists emma_recovery_events_recovery_agent_check;

alter table public.emma_recovery_events
  add constraint emma_recovery_events_recovery_agent_check
  check (recovery_agent in (
    'rescue',          -- v361 same-day slot fill
    'post_recovery',   -- post-show rebook
    'preshow',         -- counterfactual estimate
    'recall',          -- v1.95.0 lapsed / expiring-reward → booked
    'cross_sell'       -- v1.99.0 promo-offered service/add-on booked
  ));

notify pgrst, 'reload schema';

-- Verify: nothing existing was blocked, and the agent mix is visible.
select recovery_agent, count(*)
from public.emma_recovery_events
group by recovery_agent
order by count(*) desc;
