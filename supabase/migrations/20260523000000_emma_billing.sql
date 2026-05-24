-- Emma(OS) pricing plan + monthly invoicing (v366 — the killshot).
--
-- The capstone of the no-show recovery engine. Where the $$ actually
-- flows. Per the strategy doc: "free + % of recovered revenue" is the
-- pricing innovation that disintermediates the entire med-spa PMS
-- category. Incumbents charging $200-$500/mo flat with 12-month
-- contracts cannot match this without restructuring their entire
-- revenue model.
--
-- Two tables:
--   emma_pricing_plans  — per-spa plan selection (one active row per
--                          user_id; historical rows preserved for
--                          plan-change audit).
--   emma_invoices       — monthly billing records. Generated on the
--                          1st of each month for prior month's verified
--                          recovery events. v366 ships invoices in
--                          'draft' status; v366.x activates Stripe.
--
-- Three plans:
--   performance — free + 12% of recovered revenue (default, aligns
--                  incentives — the spa only pays when revenue arrives)
--   predictable — $299/mo flat, all features (for owners who hate
--                  revenue share on principle)
--   hybrid      — $99/mo + 8% of recovered (commitment + shared upside)
--
-- v366 ships the schema + UI + math + draft-invoice cron. v366.x adds
-- the Stripe customer + payment_method + actual collection flow when
-- a real spa explicitly opts in. Same pattern as v364 deposits —
-- ship the engine, defer activation.
--
-- Established 2026-05-17 (Promotions Engine v366 — engine complete).

-- ── emma_pricing_plans ──────────────────────────────────────────────────

create table if not exists public.emma_pricing_plans (
  id                       uuid        primary key default gen_random_uuid(),
  user_id                  uuid        not null references auth.users(id) on delete cascade,

  plan                     text        not null
                           check (plan in ('performance', 'predictable', 'hybrid')),

  -- The economic parameters. Snapshotted at plan-selection time so
  -- a future price change doesn't retroactively alter past invoices.
  revenue_share_pct        numeric(5,4)  not null default 0,  -- 0..1 (0.12 = 12%)
  monthly_flat_usd         numeric(10,2) not null default 0,

  -- Lifecycle.
  -- A spa has at most one row with plan_ended_at=null at a time
  -- (the active plan). Plan changes write a new row + close the prior.
  plan_started_at          timestamptz not null default now(),
  plan_ended_at            timestamptz,

  -- Stripe customer linkage. NULL until the spa adds a payment method
  -- (v366.x). For v1 we record the plan but no Stripe entities exist.
  stripe_customer_id       text,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

alter table public.emma_pricing_plans enable row level security;

do $$ begin
  create policy "users_own_emma_pricing_plans"
    on public.emma_pricing_plans for all
    using  (auth.uid() = user_id)
    with check (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "service_role_emma_pricing_plans"
    on public.emma_pricing_plans for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

-- Active-plan hot path: "what plan is this spa on right now?"
create index if not exists emma_pricing_plans_active_idx
  on public.emma_pricing_plans (user_id)
  where plan_ended_at is null;

create trigger emma_pricing_plans_set_updated_at
  before update on public.emma_pricing_plans
  for each row execute function public.set_updated_at();

-- ── emma_invoices ────────────────────────────────────────────────────────

create table if not exists public.emma_invoices (
  id                       uuid        primary key default gen_random_uuid(),
  user_id                  uuid        not null references auth.users(id) on delete cascade,

  -- The billing period. period_start is the 1st of the month at
  -- 00:00 UTC; period_end is the 1st of the next month (exclusive).
  period_start             timestamptz not null,
  period_end               timestamptz not null,

  -- Plan snapshot at invoice time (so future plan changes don't
  -- retroactively alter historical invoices).
  plan_at_invoice          text        not null,
  revenue_share_pct        numeric(5,4) not null,
  monthly_flat_usd         numeric(10,2) not null,

  -- The math. recovered_revenue_usd is the sum of verified
  -- recovery_events in the period; share_due_usd = recovered * pct;
  -- total_due_usd = share_due + monthly_flat.
  recovered_revenue_count  integer     not null default 0,
  recovered_revenue_usd    numeric(12,2) not null default 0,
  share_due_usd            numeric(12,2) not null default 0,
  total_due_usd            numeric(12,2) not null default 0,

  -- Lifecycle.
  status                   text        not null default 'draft'
                           check (status in (
                             'draft',         -- v366 default; not yet pushed to Stripe
                             'sent',          -- v366.x — pushed to Stripe
                             'paid',          -- v366.x — Stripe paid
                             'failed',        -- v366.x — payment failed
                             'void'           -- spa cancelled/disputed
                           )),

  -- Stripe invoice id when wired (v366.x). NULL on draft rows.
  stripe_invoice_id        text,

  -- Audit.
  generated_at             timestamptz not null default now(),
  sent_at                  timestamptz,
  paid_at                  timestamptz,
  voided_at                timestamptz,
  voided_by                text,
  notes                    text,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  -- One invoice per (spa, month).
  unique (user_id, period_start)
);

alter table public.emma_invoices enable row level security;

do $$ begin
  create policy "users_own_emma_invoices"
    on public.emma_invoices for all
    using  (auth.uid() = user_id)
    with check (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "service_role_emma_invoices"
    on public.emma_invoices for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

create index if not exists emma_invoices_by_user_idx
  on public.emma_invoices (user_id, period_start desc);

create index if not exists emma_invoices_by_status_idx
  on public.emma_invoices (user_id, status)
  where status in ('draft', 'sent', 'failed');

create trigger emma_invoices_set_updated_at
  before update on public.emma_invoices
  for each row execute function public.set_updated_at();

comment on table public.emma_pricing_plans is
  'Per-spa pricing plan selection. One active row (plan_ended_at=null) per user_id at a time; historical rows preserved on plan change. Plan economics snapshotted at selection so future price changes don''t alter past invoices.';

comment on table public.emma_invoices is
  'Monthly billing record per (spa, month). Generated on the 1st by the v366 cron from verified emma_recovery_events. v366 ships in draft status — v366.x activates Stripe push + collection.';
