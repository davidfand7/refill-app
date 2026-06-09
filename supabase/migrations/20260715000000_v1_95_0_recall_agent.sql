-- v1.95.0 — Recall (Patient-Profitability OS · Phase 1 · Slice B).
--
-- Recall books a lapsed / expiring-reward patient and records the save as a
-- recovery event with recovery_agent='recall' + metric_key='recall_booking'
-- (the $5 win on the v1.93.0 fee-rules ledger).
--
-- The original constraint (20260520000000_emma_recovery_events.sql) allowed
-- only the three agents that existed then: rescue / post_recovery / preshow.
-- Inserting 'recall' throws 23514 until the constraint is widened. This drops
-- and re-adds it with the full current vocabulary.
--
-- metric_key needs NO migration: it's plain `text not null default 'slot_fill'`
-- with no check constraint (20260714000000_v1_93_0_billing_fee_rules.sql), so
-- 'recall_booking' inserts cleanly and is already priced @ $5 by the fee-rules.

alter table public.emma_recovery_events
  drop constraint if exists emma_recovery_events_recovery_agent_check;

alter table public.emma_recovery_events
  add constraint emma_recovery_events_recovery_agent_check
  check (recovery_agent in (
    'rescue',          -- v361 same-day slot fill
    'post_recovery',   -- post-show rebook
    'preshow',         -- counterfactual estimate
    'recall'           -- v1.95.0 lapsed / expiring-reward → booked
  ));

notify pgrst, 'reload schema';

-- Verify: nothing existing was blocked, and the agent mix is visible.
select recovery_agent, count(*)
from public.emma_recovery_events
group by recovery_agent
order by count(*) desc;
