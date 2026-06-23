-- v2.159.0 — Allocation → booking attribution (Part B fast-follow).
--
-- The Recognition Allocation engine deploys rebate units to specific patients
-- (knowledge_nodes 'allocation_suggestion', status confirmed/dispatched/sent).
-- Until now that was SEND-ONLY — no booking attribution, so the "Incentives at
-- work" scoreboard showed allocation as "conversion tracking soon" with no $.
--
-- This widens the recovery_agent CHECK to accept 'allocation' so a patient who
-- received an allocation and then BOOKS a paid visit settles as a recovery
-- event (recovery_agent='allocation' + metric_key='allocation_booking'). Same
-- shape as recall (v1.95.0) / cross_sell (v1.99.0) / reschedule (v2.37.0):
-- provisional on create, $ only once the reconcile cron matches a real
-- transaction. metric_key is plain text (no constraint) so it needs no change.
--
-- NOT added to BILLABLE_METRICS — allocation deploys the SPA's own rebate units,
-- so the booking is attributed/scored for the scoreboard but does NOT auto-bill
-- a $5 fee. (Billability is a separate pricing decision; flip later by adding
-- the metric to BILLABLE_METRICS if desired.)
--
-- Table + constraint are bare-named post-emma-retirement (v2.75.0). We drop both
-- the bare and the legacy emma_ constraint name defensively so this applies
-- cleanly regardless of which is live.

alter table public.recovery_events
  drop constraint if exists recovery_events_recovery_agent_check;
alter table public.recovery_events
  drop constraint if exists emma_recovery_events_recovery_agent_check;

alter table public.recovery_events
  add constraint recovery_events_recovery_agent_check
  check (recovery_agent in (
    'rescue',          -- v361 same-day slot fill
    'post_recovery',   -- post-show rebook
    'preshow',         -- counterfactual estimate
    'recall',          -- v1.95.0 lapsed / expiring-reward -> booked
    'cross_sell',      -- v1.99.0 promo-offered service/add-on booked
    'reschedule',      -- v2.37.0 cancelled/no-showed patient rebooks after a nudge
    'allocation'       -- v2.159.0 patient who received a deployed rebate allocation books
  ));

notify pgrst, 'reload schema';

-- Verify: nothing existing was blocked, and the agent mix is visible.
select recovery_agent, count(*)
from public.recovery_events
group by recovery_agent
order by count(*) desc;
