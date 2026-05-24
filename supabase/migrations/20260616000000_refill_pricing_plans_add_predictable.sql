-- v411.1 — extend refill_pricing_plans.plan check constraint to allow 'predictable'.
--
-- v411 shipped the 3-card billing layout with Predictable as a teaser; v411.1
-- wires the third plan end-to-end. The original check constraint from
-- 20260601000000_refill_billing.sql (`plan in ('starter','pro')`) blocks
-- INSERTs with plan='predictable' — we relax it here.
--
-- Refill plan economics per [[project-pricing-killshot]]:
--   starter      — free + 12% of recovered revenue (the killshot default)
--   predictable  — $299/mo flat + 0% revenue share (NEW v411.1)
--   pro          — $99/mo + 8% of recovered (commitment + shared upside)
--
-- No data backfill needed — existing rows are all starter/pro and stay valid
-- under the expanded constraint.

alter table public.refill_pricing_plans
  drop constraint if exists refill_pricing_plans_plan_check;

alter table public.refill_pricing_plans
  add constraint refill_pricing_plans_plan_check
  check (plan in ('starter', 'predictable', 'pro'));

-- Ask PostgREST to reload its schema cache so the API picks up the relaxed
-- constraint immediately without waiting for the periodic refresh.
notify pgrst, 'reload schema';

-- Cleave fix 2026-05-24: removed leftover smoke-test line that called
-- enum_range(null::text) — broken (text isn't an enum) and not load-bearing
-- (the real verification is the constraint check below).
select conname, pg_get_constraintdef(oid)
from pg_constraint
where conname = 'refill_pricing_plans_plan_check';
