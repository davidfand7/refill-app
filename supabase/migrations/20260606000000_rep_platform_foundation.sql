-- ============================================================================
-- Refill Rep Platform — Phase 2B foundation
-- ============================================================================
-- Architecture spec:  ~/Desktop/Refill-Rep-Platform-Architecture.html
-- Apply via:          Supabase dashboard SQL editor
--                     (per feedback_migrations_via_dashboard — never `db push`)
--
-- Adds three new tables:
--   1. rep_accounts          — rep identity (1:1 with auth.users)
--   2. rep_affiliations      — multi-tier parent/child cascade junction
--   3. rep_commission_ledger — what each rep is owed, when, paid status
--
-- Plus three FK additions for attribution:
--   - tenants.referred_by_rep_id              (set at signup from referral link)
--   - refill_invoices.referred_by_rep_id      (copied at invoice generation)
--   - emma_recovery_events.referred_by_rep_id (copied at event write)
--
-- Commission economics LOCKED (8/3/1 split inside 12% recovered revenue):
--   8% Refill platform · 3% Tier-1 direct · 1% Tier-2 upstream
--   Tier-depth cap = 3 (policy-enforced, schema CHECK enforces also)
--   Lifetime, not time-decayed.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. rep_accounts — rep identity, distinct from spa-as-tenant
-- ----------------------------------------------------------------------------
create table if not exists public.rep_accounts (
  rep_user_id        uuid primary key references auth.users(id) on delete cascade,
  display_name       text not null,
  business_name      text,
  status             text not null default 'active'
                       check (status in ('active', 'paused', 'terminated')),
  origin_type        text not null default 'indy_rep'
                       check (origin_type in ('indy_rep', 'corporate_rep', 'spa_owner', 'other')),
  territory          jsonb default '{}'::jsonb,
  joined_at          timestamptz not null default now(),
  payout_method      text default 'stripe',
  stripe_account_id  text,
  metadata           jsonb default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists rep_accounts_status_idx
  on public.rep_accounts (status) where status = 'active';

create index if not exists rep_accounts_origin_idx
  on public.rep_accounts (origin_type);

comment on table  public.rep_accounts is
  'Rep identity for the Refill Rep Platform. 1:1 with auth.users. Distinct from tenant (spa) semantics.';
comment on column public.rep_accounts.origin_type is
  'Differentiates indy reps (Kelly Caffee), corporate reps (Allergan/Evolus/Galderma), spa-owner Tier-1 originators.';
comment on column public.rep_accounts.territory is
  'JSON for flexibility; states[] is the canonical key today. Future: zip codes, regions.';


-- ----------------------------------------------------------------------------
-- 2. rep_affiliations — multi-tier parent/child cascade
-- ----------------------------------------------------------------------------
create table if not exists public.rep_affiliations (
  id                 uuid primary key default gen_random_uuid(),
  rep_id             uuid not null references public.rep_accounts(rep_user_id) on delete cascade,
  parent_rep_id      uuid references public.rep_accounts(rep_user_id) on delete set null,
  tier_level         smallint not null check (tier_level between 1 and 3),
  commission_split   numeric(5,4) not null,
  active             boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint rep_affiliations_unique_active
    unique (rep_id, parent_rep_id, tier_level)
);

create index if not exists rep_affiliations_rep_idx
  on public.rep_affiliations (rep_id) where active = true;

create index if not exists rep_affiliations_parent_idx
  on public.rep_affiliations (parent_rep_id) where active = true;

comment on table public.rep_affiliations is
  'Parent/child junction encoding the multi-tier affiliate cascade. Recursive CTE traverses the tree. Policy cap = 3 tiers; schema cap = 3 via CHECK.';
comment on column public.rep_affiliations.commission_split is
  'Per-row split %. Defaults: Tier 1 = 0.0300, Tier 2 = 0.0100. Refill keeps the remainder of 0.1200.';


-- ----------------------------------------------------------------------------
-- 3. rep_commission_ledger — what's owed, when, paid status
-- ----------------------------------------------------------------------------
create table if not exists public.rep_commission_ledger (
  id                    uuid primary key default gen_random_uuid(),
  rep_id                uuid not null references public.rep_accounts(rep_user_id) on delete cascade,
  source_invoice_id     uuid references public.refill_invoices(id) on delete set null,
  source_tenant_id      uuid references public.tenants(id) on delete set null,
  period_month          date not null,
  tier_level            smallint not null check (tier_level between 1 and 3),
  commission_split      numeric(5,4) not null,
  source_revenue_usd    numeric(12,2) not null,
  commission_usd        numeric(12,2) not null,
  status                text not null default 'pending'
                          check (status in ('pending', 'paid', 'voided')),
  -- Cleave fix 2026-05-24: dropped FK to public.payout_requests
  -- (Agentiport-only table, not ported). Kept as nullable uuid for
  -- analytics stitching, no referential integrity.
  stripe_payout_id      uuid,
  paid_at               timestamptz,
  notes                 text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint rep_commission_ledger_unique_entry
    unique (rep_id, period_month, source_invoice_id, tier_level)
);

create index if not exists rep_commission_ledger_rep_period_idx
  on public.rep_commission_ledger (rep_id, period_month desc);

create index if not exists rep_commission_ledger_status_idx
  on public.rep_commission_ledger (status) where status = 'pending';

create index if not exists rep_commission_ledger_tenant_idx
  on public.rep_commission_ledger (source_tenant_id);

comment on table public.rep_commission_ledger is
  'What each rep is owed, per period, per source-invoice, per tier. Idempotent on (rep_id, period_month, source_invoice_id, tier_level) so recompute is safe.';


-- ----------------------------------------------------------------------------
-- 4. FK additions to existing tables for attribution
-- ----------------------------------------------------------------------------

-- 4a. tenants.referred_by_rep_id  (set at tenant creation from referral link)
alter table public.tenants
  add column if not exists referred_by_rep_id uuid
  references public.rep_accounts(rep_user_id) on delete set null;

create index if not exists tenants_referred_by_idx
  on public.tenants (referred_by_rep_id)
  where referred_by_rep_id is not null;

comment on column public.tenants.referred_by_rep_id is
  'Rep who introduced this tenant. Set at tenant creation from signed referral link. Immutable once set.';

-- 4b. refill_invoices.referred_by_rep_id  (copied at invoice generation)
alter table public.refill_invoices
  add column if not exists referred_by_rep_id uuid
  references public.rep_accounts(rep_user_id) on delete set null;

create index if not exists refill_invoices_referred_by_idx
  on public.refill_invoices (referred_by_rep_id)
  where referred_by_rep_id is not null;

comment on column public.refill_invoices.referred_by_rep_id is
  'Rep credited for this tenant''s invoice. Copied from tenants.referred_by_rep_id at invoice generation.';

-- 4c. emma_recovery_events.referred_by_rep_id  (copied at event write)
alter table public.emma_recovery_events
  add column if not exists referred_by_rep_id uuid
  references public.rep_accounts(rep_user_id) on delete set null;

create index if not exists emma_recovery_events_referred_by_idx
  on public.emma_recovery_events (referred_by_rep_id)
  where referred_by_rep_id is not null;

comment on column public.emma_recovery_events.referred_by_rep_id is
  'Rep credited for this recovery event. Copied from tenants.referred_by_rep_id at event-write time. Per-event attribution needed for sub-rep cascade traceability.';


-- ----------------------------------------------------------------------------
-- 5. RLS — rep-owns-own-rows + admin-via-has_role + service_role bypass
-- ----------------------------------------------------------------------------
-- Pattern matches existing project convention: public.has_role(auth.uid(),'admin')
-- SECURITY DEFINER, defined in 20260417232733_*.sql. service_role bypasses RLS.
-- ----------------------------------------------------------------------------

alter table public.rep_accounts          enable row level security;
alter table public.rep_affiliations      enable row level security;
alter table public.rep_commission_ledger enable row level security;

-- rep_accounts
drop policy if exists rep_accounts_self_read   on public.rep_accounts;
drop policy if exists rep_accounts_admin_all   on public.rep_accounts;

create policy rep_accounts_self_read
  on public.rep_accounts for select
  using (auth.uid() = rep_user_id);

create policy rep_accounts_admin_all
  on public.rep_accounts for all
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

-- rep_affiliations: rep can read rows where they are either rep_id OR parent_rep_id
drop policy if exists rep_affiliations_chain_read on public.rep_affiliations;
drop policy if exists rep_affiliations_admin_all  on public.rep_affiliations;

create policy rep_affiliations_chain_read
  on public.rep_affiliations for select
  using (auth.uid() = rep_id or auth.uid() = parent_rep_id);

create policy rep_affiliations_admin_all
  on public.rep_affiliations for all
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

-- rep_commission_ledger
drop policy if exists rep_commission_ledger_self_read on public.rep_commission_ledger;
drop policy if exists rep_commission_ledger_admin_all on public.rep_commission_ledger;

create policy rep_commission_ledger_self_read
  on public.rep_commission_ledger for select
  using (auth.uid() = rep_id);

create policy rep_commission_ledger_admin_all
  on public.rep_commission_ledger for all
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));


-- ----------------------------------------------------------------------------
-- 6. updated_at triggers — reuse existing public.update_updated_at_column()
-- ----------------------------------------------------------------------------
drop trigger if exists rep_accounts_updated_at          on public.rep_accounts;
drop trigger if exists rep_affiliations_updated_at      on public.rep_affiliations;
drop trigger if exists rep_commission_ledger_updated_at on public.rep_commission_ledger;

create trigger rep_accounts_updated_at
  before update on public.rep_accounts
  for each row execute function public.update_updated_at_column();

create trigger rep_affiliations_updated_at
  before update on public.rep_affiliations
  for each row execute function public.update_updated_at_column();

create trigger rep_commission_ledger_updated_at
  before update on public.rep_commission_ledger
  for each row execute function public.update_updated_at_column();


-- ----------------------------------------------------------------------------
-- 7. PostgREST schema reload
-- ----------------------------------------------------------------------------
notify pgrst, 'reload schema';


-- ----------------------------------------------------------------------------
-- 8. Verification — run after applying to confirm shape
-- ----------------------------------------------------------------------------
-- Expect: 13/9/16 columns across the three new tables, plus 3 new
-- referred_by_rep_id columns on existing tables, plus 6 RLS policies.
--
-- select c.table_name, count(*) as columns
-- from information_schema.columns c
-- where c.table_schema = 'public'
--   and c.table_name in ('rep_accounts', 'rep_affiliations', 'rep_commission_ledger')
-- group by c.table_name
-- order by c.table_name;
--
-- select c.table_name, c.column_name
-- from information_schema.columns c
-- where c.table_schema = 'public'
--   and c.column_name = 'referred_by_rep_id'
-- order by c.table_name;
--
-- select tablename, policyname, cmd
-- from pg_policies
-- where schemaname = 'public'
--   and tablename in ('rep_accounts', 'rep_affiliations', 'rep_commission_ledger')
-- order by tablename, policyname;

-- ============================================================================
-- END Phase 2B
-- ============================================================================
