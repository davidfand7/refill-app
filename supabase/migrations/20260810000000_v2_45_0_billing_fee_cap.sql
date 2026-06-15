-- v2.45.0 — Per-feature price CAP on billing fee-rules (operator pricing flexibility).
-- ─────────────────────────────────────────────────────────────────────────────
-- Idea 1 of the pricing/timing flexibility thread (project_flexible_pricing_and_timing).
-- Idea 2 (the reschedule grace WINDOW) shipped in v2.44.0; this is its pricing twin.
--
-- The ask (Grasshopper, 2026-06-14): let an operator bound the downside of a
-- metered feature — "$5 per win, but never more than $X per year for this one."
-- CTO guidance (locked): build the CAP primitive, NOT a monthly/annual/per-event
-- pricing matrix. A cap keeps the metered FAIRNESS (you only pay on value created)
-- while bounding the worst case — the opposite of a flat subscription that can
-- over-charge a spa for a barely-used feature (the manufacturer-style misalignment
-- we position against). So: cap, don't flat-subscribe.
--
-- Default is UNCHANGED. cap_usd NULL = no cap = the marketed "Free + $5/win" with
-- zero new decisions. This is pure progressive disclosure — a knob for the spa
-- that asks, never a fork in everyone's onboarding. Extends the locked pricing
-- model (project_pricing_model); it does NOT reopen the free-by-default rule.
--
-- ENFORCEMENT NOTE (why no new ledger table): an ANNUAL cap is the only piece
-- that spans periods — month M's charge for a metric must know what was already
-- billed for that metric earlier the same calendar year. We DERIVE that from the
-- per-metric `charge` already persisted in refill_invoices.fee_breakdown, so the
-- cap composes month-by-month and stays idempotent on a cron re-run. A MONTHLY
-- cap is the trivial within-period case: min(this month's charge, cap_usd).

-- Additive, nullable cap on the existing per-tenant per-metric rule.
--   cap_usd    NULL  → no cap (default; behavior byte-identical to pre-v2.45.0).
--              > 0   → this feature's charges stop accruing once the period total
--                      reaches this dollar amount.
--   cap_period 'annual'  → the cap resets each calendar year (the v1 surface).
--              'monthly' → the cap resets each calendar month (carried for the
--                          future; not surfaced in the v1 UI).
alter table public.billing_fee_rules
  add column if not exists cap_usd numeric(10,2);

alter table public.billing_fee_rules
  add column if not exists cap_period text;

-- Guard the period vocabulary. Idempotent: drop-if-exists then re-add so the full
-- file is always safe to re-apply.
do $$ begin
  alter table public.billing_fee_rules drop constraint if exists billing_fee_rules_cap_period_chk;
  alter table public.billing_fee_rules
    add constraint billing_fee_rules_cap_period_chk
    check (cap_period is null or cap_period in ('annual', 'monthly'));
exception when undefined_table then null;
end $$;

notify pgrst, 'reload schema';

-- Verify (run after applying):
-- select column_name, data_type, is_nullable from information_schema.columns
--   where table_name = 'billing_fee_rules' and column_name in ('cap_usd','cap_period');
-- select count(*) from public.billing_fee_rules where cap_usd is not null;  -- expect 0 right after migrate
