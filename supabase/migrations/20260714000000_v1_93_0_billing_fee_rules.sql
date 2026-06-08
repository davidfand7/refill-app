-- v1.93.0 — Billing fee-rules config + ledger (Patient-Profitability OS · P0).
-- ─────────────────────────────────────────────────────────────────────────────
-- Swaps Refill from tiered revenue-share plans (starter/pro/predictable) to a
-- single configurable formula:
--
--     Invoice = monthly_base + Σ over metrics ( per-metric fee × wins )
--
-- Default config = base $0 + every metric flat $5 = the marketed "Free + $5
-- per win." An admin panel tunes each metric ($X flat OR X% of attributed
-- revenue, on/off). A future hybrid is just base > 0 — no re-architecture.
-- Tiered plans are retired as the rate-source; refill_pricing_plans stays only
-- so historical invoices keep their plan snapshot.

-- 1. Per-tenant monthly base (the $0 knob; > 0 = hybrid later).
create table if not exists public.billing_config (
  tenant_id        uuid        primary key references public.tenants(id) on delete cascade,
  monthly_base_usd numeric(10,2) not null default 0,
  updated_at       timestamptz not null default now()
);

alter table public.billing_config enable row level security;
do $$ begin
  create policy "service_role_billing_config"
    on public.billing_config for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

-- 2. Per-tenant, per-metric fee rule. Seeded lazily by the server (defaults =
--    flat $5, enabled) so we don't fan out tenants × metrics here.
--    metric_key ∈ slot_fill | recall_booking | cross_sell_addon | lead_conversion.
--    mode 'flat'    → amount is dollars per win.
--    mode 'percent' → amount is a fraction (0.12 = 12%) of attributed revenue.
create table if not exists public.billing_fee_rules (
  id          uuid        primary key default gen_random_uuid(),
  tenant_id   uuid        not null references public.tenants(id) on delete cascade,
  metric_key  text        not null,
  mode        text        not null default 'flat' check (mode in ('flat', 'percent')),
  amount      numeric(10,4) not null default 5,
  enabled     boolean     not null default true,
  updated_at  timestamptz not null default now(),
  unique (tenant_id, metric_key)
);

create index if not exists billing_fee_rules_tenant_idx
  on public.billing_fee_rules (tenant_id);

alter table public.billing_fee_rules enable row level security;
do $$ begin
  create policy "service_role_billing_fee_rules"
    on public.billing_fee_rules for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

-- 3. Tag each billable event with the metric it bills under. Today every
--    recovery event (rescue / post_recovery / preshow) is a slot_fill win;
--    recall_booking / cross_sell_addon / lead_conversion light up as those
--    Solutions ship. Backfill existing rows to slot_fill.
alter table public.emma_recovery_events
  add column if not exists metric_key text not null default 'slot_fill';

update public.emma_recovery_events
  set metric_key = 'slot_fill'
  where metric_key is null or metric_key = '';

create index if not exists emma_recovery_events_metric_idx
  on public.emma_recovery_events (user_id, metric_key, verified_at);

-- 4. Invoice gets the new per-metric breakdown. Legacy revenue_share_pct /
--    monthly_flat_usd become nullable (new invoices use fee_breakdown +
--    monthly_base_usd; historical invoices keep their old snapshot columns).
alter table public.refill_invoices
  add column if not exists monthly_base_usd numeric(10,2) not null default 0;
alter table public.refill_invoices
  add column if not exists fee_breakdown jsonb not null default '[]'::jsonb;
alter table public.refill_invoices
  alter column revenue_share_pct drop not null;
alter table public.refill_invoices
  alter column monthly_flat_usd drop not null;

notify pgrst, 'reload schema';

-- Verify (run after applying):
-- select count(*) from public.billing_config;
-- select count(*) from public.billing_fee_rules;
-- select metric_key, count(*) from public.emma_recovery_events group by 1;
-- select column_name, is_nullable from information_schema.columns
--   where table_name = 'refill_invoices' and column_name in
--   ('revenue_share_pct','monthly_flat_usd','monthly_base_usd','fee_breakdown');
