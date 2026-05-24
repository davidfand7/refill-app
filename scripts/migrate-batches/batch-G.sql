-- ═══════════════════════════════════════════════════════════════════════
-- BATCH G (retry 3) — Rep platform + demo seeds
--   FIX BLOCK: identity infrastructure + update_updated_at_column fn
--   (the latter was added to 20260515999999 AFTER Batch C ran, so it
--   never got created in the live DB).
-- ═══════════════════════════════════════════════════════════════════════

-- ─── PRE-FIX: identity infrastructure + missing updated_at fn ─────
create or replace function public.update_updated_at_column()
returns trigger language plpgsql set search_path = public as $$
begin new.updated_at = now(); return new; end;
$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'app_role') then
    create type public.app_role as enum ('admin', 'member');
  end if;
end$$;

create table if not exists public.user_roles (
  id          uuid not null default gen_random_uuid() primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        public.app_role not null default 'member',
  created_at  timestamptz not null default now(),
  unique (user_id, role)
);

alter table public.user_roles enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='user_roles' and policyname='users_read_own_roles') then
    create policy users_read_own_roles on public.user_roles for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='user_roles' and policyname='service_role_user_roles') then
    create policy service_role_user_roles on public.user_roles for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
  end if;
end$$;

create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.user_roles where user_id = _user_id and role = _role)
$$;

-- ─── 1/9 rep_platform_foundation (payout_requests FK dropped) ─
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

-- ─── 2/9 rep_platform_phase_2d ────────────────
-- Refill Rep Platform — Phase 2D
--
-- Two additions on top of v395 foundation (20260606000000_rep_platform_foundation.sql):
--   1. RLS policy: a rep can read emma_recovery_events where they're the referrer.
--      Foundation migration added the referred_by_rep_id FK column but no SELECT
--      policy for self-read — without this, the realtime client subscription on
--      the live $$ widget returns zero rows even when events exist.
--   2. SQL function get_rep_network(rep_id, max_depth) — recursive CTE walking
--      downstream of a rep through rep_affiliations up to 3 levels. Used by the
--      network view server fn; also the right shape for the future commission
--      cron when it walks the tree to compute Tier-2 cascade.
--
-- Apply via Supabase dashboard SQL editor per project_migrations_via_dashboard.

-- ─── (1) RLS: rep reads emma_recovery_events where they're the referrer ───
--
-- emma_recovery_events already has a user_id-scoped RLS policy (the spa owner
-- reads their own events). The rep is a different actor entirely; they need
-- to see events attributed to them across multiple spas. Additive policy.

create policy emma_recovery_events_rep_read
  on public.emma_recovery_events
  for select
  using (referred_by_rep_id = auth.uid());

comment on policy emma_recovery_events_rep_read on public.emma_recovery_events is
  'Refill Rep Platform: a rep reads events attributed to them across all downstream spas.';

-- ─── (2) Recursive network walk fn ───────────────────────────────────────
--
-- Returns one row per descendant rep (excluding the input rep themselves)
-- with their absolute depth from the input rep. Capped by max_depth.
-- Used by:
--   - getMyNetwork() server fn (network-view UI)
--   - future commission cron (Tier-2 cascade lookup)
--
-- SECURITY DEFINER + a rep-id input means the caller (server fn with
-- verifyAuth) controls who can ask about whose network. The function does
-- NOT trust auth.uid() internally — the server fn passes the verified rep_id
-- as the argument. EXECUTE granted to authenticated; anonymous can't call.

create or replace function public.get_rep_network(
  root_rep_id uuid,
  max_depth   int default 3
)
returns table (
  rep_id        uuid,
  parent_rep_id uuid,
  depth         int,
  display_name  text,
  business_name text,
  status        text,
  joined_at     timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with recursive network as (
    -- anchor: direct children of root
    select
      a.rep_id,
      a.parent_rep_id,
      1 as depth
    from public.rep_affiliations a
    where a.parent_rep_id = root_rep_id
      and a.active = true

    union all

    -- recursive step: children of children, capped by max_depth
    select
      a.rep_id,
      a.parent_rep_id,
      n.depth + 1
    from public.rep_affiliations a
    join network n on a.parent_rep_id = n.rep_id
    where a.active = true
      and n.depth < max_depth
  )
  select
    n.rep_id,
    n.parent_rep_id,
    n.depth,
    r.display_name,
    r.business_name,
    r.status,
    r.joined_at
  from network n
  join public.rep_accounts r on r.rep_user_id = n.rep_id
  order by n.depth, r.display_name;
$$;

revoke all on function public.get_rep_network(uuid, int) from public;
grant execute on function public.get_rep_network(uuid, int) to authenticated, service_role;

comment on function public.get_rep_network(uuid, int) is
  'Returns descendants of root_rep_id from rep_affiliations up to max_depth (default 3).';

-- ─── (3) Realtime publication ────────────────────────────────────────────
-- The live $$ widget subscribes to emma_recovery_events INSERT/UPDATE via
-- Supabase realtime. ADD TABLE is not idempotent (raises if already a member),
-- so we check pg_publication_tables first. Safe to re-apply.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'emma_recovery_events'
  ) then
    execute 'alter publication supabase_realtime add table public.emma_recovery_events';
  end if;
end$$;

-- ─── (4) PostgREST reload ────────────────────────────────────────────────
notify pgrst, 'reload schema';

-- ─── (5) Verify ──────────────────────────────────────────────────────────
-- Sanity check that the policy, function, and publication membership all
-- registered. Should return one row per query.

select policyname
from   pg_policies
where  tablename = 'emma_recovery_events'
  and  policyname = 'emma_recovery_events_rep_read';

select proname
from   pg_proc
where  proname = 'get_rep_network';

select tablename
from   pg_publication_tables
where  pubname = 'supabase_realtime'
  and  schemaname = 'public'
  and  tablename = 'emma_recovery_events';

-- ─── 3/9 rep_platform_demo_seed (Kelly+Maria) ─
-- Refill Rep Platform — Phase 2G demo seed for the 5/29 Kelly Caffee meeting.
--
-- Creates a fully-populated "Kelly Caffee" demo persona so when Grasshopper
-- signs in as her (via magic link generated through getKellyDemoMagicLink),
-- screens 5/6/7 render with realistic data instead of empty-state.
--
-- Structure:
--   - 1 anchor rep (Kelly Caffee) — tier-1 to herself
--   - 5 direct sub-reps under Kelly (Tier-1 to Kelly's network)
--   - 2 sub-sub-reps (Tier-2 cascade — one under Maria, one under Tony)
--   - ~3 months of commission ledger history (Tier-1 direct + Tier-2 cascade)
--   - ~20 emma_recovery_events spanning the last 30 days, attributed
--     directly to Kelly's user_id — populates her LiveEarningsCard
--
-- ALL seeded rows are tagged so wipe_kelly_demo_data() can clean them up
-- before Kelly's real signup:
--   - rep_accounts: metadata->>'demo' = 'true'
--   - rep_commission_ledger: notes LIKE 'DEMO_KELLY%'
--   - emma_recovery_events: notes LIKE 'DEMO_KELLY%'
--   - auth.users: email LIKE '%@refill-demo.test'
--
-- Apply via Supabase dashboard SQL editor per feedback_migrations_via_dashboard.

-- ─── (0) Stable UUIDs ─────────────────────────────────────────────────────
-- Hardcoded for reproducibility — if you re-apply this migration after a
-- wipe_kelly_demo_data() run, the UUIDs match and the data lands cleanly.

-- Kelly Caffee (anchor) = c0ffee00-0000-0000-0000-000000000001
-- Maria Chen (T1 sub)  = c0ffee00-0000-0000-0000-000000000002
-- Tony Reyes (T1 sub)  = c0ffee00-0000-0000-0000-000000000003
-- Sarah Kim (T1 sub)   = c0ffee00-0000-0000-0000-000000000004
-- Jasmine Patel (T1)   = c0ffee00-0000-0000-0000-000000000005
-- Marcus Williams (T1) = c0ffee00-0000-0000-0000-000000000006
-- Daniela Vargas (T2)  = c0ffee00-0000-0000-0000-000000000007 (under Maria)
-- Brennan OHara (T2)   = c0ffee00-0000-0000-0000-000000000008 (under Tony)

-- ─── (1) auth.users + auth.identities ────────────────────────────────────
-- Direct INSERT into auth schema. Requires service_role (i.e. you must be
-- pasting this into the Supabase dashboard SQL editor or running it via
-- the service-role API). Email confirmed = true so magic link works
-- without a confirmation step. encrypted_password = empty string is fine
-- for magic-link-only users.

insert into auth.users (
  id, instance_id, aud, role,
  email, encrypted_password, email_confirmed_at,
  raw_user_meta_data, raw_app_meta_data,
  created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change
) values
  ('c0ffee00-0000-0000-0000-000000000001'::uuid,
   '00000000-0000-0000-0000-000000000000'::uuid,
   'authenticated', 'authenticated',
   'kelly@refill-demo.test', '', now(),
   jsonb_build_object('display_name','Kelly Caffee','demo',true),
   jsonb_build_object('provider','email','providers',jsonb_build_array('email')),
   now() - interval '120 days', now(), '', '', '', ''),
  ('c0ffee00-0000-0000-0000-000000000002'::uuid,
   '00000000-0000-0000-0000-000000000000'::uuid,
   'authenticated', 'authenticated',
   'maria@refill-demo.test', '', now(),
   jsonb_build_object('display_name','Maria Chen','demo',true),
   jsonb_build_object('provider','email','providers',jsonb_build_array('email')),
   now() - interval '85 days', now(), '', '', '', ''),
  ('c0ffee00-0000-0000-0000-000000000003'::uuid,
   '00000000-0000-0000-0000-000000000000'::uuid,
   'authenticated', 'authenticated',
   'tony@refill-demo.test', '', now(),
   jsonb_build_object('display_name','Tony Reyes','demo',true),
   jsonb_build_object('provider','email','providers',jsonb_build_array('email')),
   now() - interval '78 days', now(), '', '', '', ''),
  ('c0ffee00-0000-0000-0000-000000000004'::uuid,
   '00000000-0000-0000-0000-000000000000'::uuid,
   'authenticated', 'authenticated',
   'sarah@refill-demo.test', '', now(),
   jsonb_build_object('display_name','Sarah Kim','demo',true),
   jsonb_build_object('provider','email','providers',jsonb_build_array('email')),
   now() - interval '70 days', now(), '', '', '', ''),
  ('c0ffee00-0000-0000-0000-000000000005'::uuid,
   '00000000-0000-0000-0000-000000000000'::uuid,
   'authenticated', 'authenticated',
   'jasmine@refill-demo.test', '', now(),
   jsonb_build_object('display_name','Jasmine Patel','demo',true),
   jsonb_build_object('provider','email','providers',jsonb_build_array('email')),
   now() - interval '55 days', now(), '', '', '', ''),
  ('c0ffee00-0000-0000-0000-000000000006'::uuid,
   '00000000-0000-0000-0000-000000000000'::uuid,
   'authenticated', 'authenticated',
   'marcus@refill-demo.test', '', now(),
   jsonb_build_object('display_name','Marcus Williams','demo',true),
   jsonb_build_object('provider','email','providers',jsonb_build_array('email')),
   now() - interval '40 days', now(), '', '', '', ''),
  ('c0ffee00-0000-0000-0000-000000000007'::uuid,
   '00000000-0000-0000-0000-000000000000'::uuid,
   'authenticated', 'authenticated',
   'daniela@refill-demo.test', '', now(),
   jsonb_build_object('display_name','Daniela Vargas','demo',true),
   jsonb_build_object('provider','email','providers',jsonb_build_array('email')),
   now() - interval '45 days', now(), '', '', '', ''),
  ('c0ffee00-0000-0000-0000-000000000008'::uuid,
   '00000000-0000-0000-0000-000000000000'::uuid,
   'authenticated', 'authenticated',
   'brennan@refill-demo.test', '', now(),
   jsonb_build_object('display_name','Brennan OHara','demo',true),
   jsonb_build_object('provider','email','providers',jsonb_build_array('email')),
   now() - interval '38 days', now(), '', '', '', '')
on conflict (id) do nothing;

-- Identities for the email provider (Supabase requires one identity per
-- provider per user). provider_id = same UUID as user, identity_data
-- carries the email + sub claims.

insert into auth.identities (
  id, user_id, provider, provider_id, identity_data,
  last_sign_in_at, created_at, updated_at
)
select
  gen_random_uuid(),
  u.id,
  'email',
  u.id::text,
  jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
  null,
  u.created_at,
  now()
from auth.users u
where u.email like '%@refill-demo.test'
  and not exists (
    select 1 from auth.identities i where i.user_id = u.id and i.provider = 'email'
  );

-- ─── (2) rep_accounts ────────────────────────────────────────────────────

insert into public.rep_accounts (
  rep_user_id, display_name, business_name, status, origin_type,
  territory, joined_at, payout_method, metadata
) values
  ('c0ffee00-0000-0000-0000-000000000001'::uuid,
   'Kelly Caffee', 'Aesthetic Channel Network', 'active', 'indy_rep',
   jsonb_build_object('states', jsonb_build_array('CO','UT','NE','WY')),
   now() - interval '120 days', 'stripe',
   jsonb_build_object('demo', true, 'is_anchor', true, 'note', 'Kelly Caffee demo persona')),
  ('c0ffee00-0000-0000-0000-000000000002'::uuid,
   'Maria Chen', 'Boutique Aesthetic Advisors', 'active', 'indy_rep',
   jsonb_build_object('states', jsonb_build_array('CO')),
   now() - interval '85 days', 'stripe',
   jsonb_build_object('demo', true)),
  ('c0ffee00-0000-0000-0000-000000000003'::uuid,
   'Tony Reyes', 'Reyes Med Spa Consulting', 'active', 'indy_rep',
   jsonb_build_object('states', jsonb_build_array('UT','NV')),
   now() - interval '78 days', 'stripe',
   jsonb_build_object('demo', true)),
  ('c0ffee00-0000-0000-0000-000000000004'::uuid,
   'Sarah Kim', 'Kim Aesthetics Group', 'active', 'indy_rep',
   jsonb_build_object('states', jsonb_build_array('CO','WY')),
   now() - interval '70 days', 'stripe',
   jsonb_build_object('demo', true)),
  ('c0ffee00-0000-0000-0000-000000000005'::uuid,
   'Jasmine Patel', 'Patel Beauty Partners', 'active', 'indy_rep',
   jsonb_build_object('states', jsonb_build_array('NE')),
   now() - interval '55 days', 'stripe',
   jsonb_build_object('demo', true)),
  ('c0ffee00-0000-0000-0000-000000000006'::uuid,
   'Marcus Williams', 'Williams Med-Aesthetic', 'active', 'indy_rep',
   jsonb_build_object('states', jsonb_build_array('CO')),
   now() - interval '40 days', 'stripe',
   jsonb_build_object('demo', true)),
  ('c0ffee00-0000-0000-0000-000000000007'::uuid,
   'Daniela Vargas', 'Vargas Skin Studio', 'active', 'indy_rep',
   jsonb_build_object('states', jsonb_build_array('CO')),
   now() - interval '45 days', 'stripe',
   jsonb_build_object('demo', true)),
  ('c0ffee00-0000-0000-0000-000000000008'::uuid,
   'Brennan OHara', 'OHara Aesthetic Group', 'active', 'indy_rep',
   jsonb_build_object('states', jsonb_build_array('UT')),
   now() - interval '38 days', 'stripe',
   jsonb_build_object('demo', true))
on conflict (rep_user_id) do nothing;

-- ─── (3) rep_affiliations (the tree) ─────────────────────────────────────
-- Kelly → 5 direct Tier-1 sub-reps (Maria, Tony, Sarah, Jasmine, Marcus)
-- Maria → Daniela (Tier-2 cascade through Maria)
-- Tony  → Brennan (Tier-2 cascade through Tony)
-- commission_split: 0.03 (3%) on direct, 0.01 (1%) on cascade

insert into public.rep_affiliations (
  rep_id, parent_rep_id, tier_level, commission_split, active
) values
  -- Kelly's 5 direct Tier-1 sub-reps
  ('c0ffee00-0000-0000-0000-000000000002'::uuid, 'c0ffee00-0000-0000-0000-000000000001'::uuid, 1, 0.0300, true),
  ('c0ffee00-0000-0000-0000-000000000003'::uuid, 'c0ffee00-0000-0000-0000-000000000001'::uuid, 1, 0.0300, true),
  ('c0ffee00-0000-0000-0000-000000000004'::uuid, 'c0ffee00-0000-0000-0000-000000000001'::uuid, 1, 0.0300, true),
  ('c0ffee00-0000-0000-0000-000000000005'::uuid, 'c0ffee00-0000-0000-0000-000000000001'::uuid, 1, 0.0300, true),
  ('c0ffee00-0000-0000-0000-000000000006'::uuid, 'c0ffee00-0000-0000-0000-000000000001'::uuid, 1, 0.0300, true),
  -- Tier-2 cascade
  ('c0ffee00-0000-0000-0000-000000000007'::uuid, 'c0ffee00-0000-0000-0000-000000000002'::uuid, 1, 0.0300, true),
  ('c0ffee00-0000-0000-0000-000000000008'::uuid, 'c0ffee00-0000-0000-0000-000000000003'::uuid, 1, 0.0300, true)
on conflict (rep_id, parent_rep_id, tier_level) do nothing;

-- ─── (4) rep_commission_ledger — 3 periods of history ────────────────────
-- Kelly's ledger shows two flavors of rows:
--   Tier-1 direct (tier_level=1, commission_split=0.0300) — spas Kelly
--     personally introduced. 8 spas, $5K each, 3 months running.
--   Tier-2 cascade (tier_level=2, commission_split=0.0100) — spas Kelly's
--     sub-reps introduced. ~20 spas across the 5 sub-reps, 1% to Kelly.
--
-- Periods are first-of-month. Use date_trunc to align cleanly regardless
-- of when this migration is applied.

with periods as (
  select
    date_trunc('month', now() - interval '60 days')::date as p3,  -- 2 months ago (paid)
    date_trunc('month', now() - interval '30 days')::date as p2,  -- 1 month ago (paid)
    date_trunc('month', now())::date                      as p1   -- current month (pending)
)
-- Kelly Tier-1 direct: 8 spas × $5,000 recovered/mo × 3% = $1,200/mo Kelly
-- Spread across 3 months. Earlier months are 'paid', current is 'pending'.
insert into public.rep_commission_ledger (
  rep_id, source_invoice_id, source_tenant_id, period_month, tier_level,
  commission_split, source_revenue_usd, commission_usd, status, paid_at, notes
)
select
  'c0ffee00-0000-0000-0000-000000000001'::uuid,
  null, null,
  case when n.month_offset = 2 then p.p3
       when n.month_offset = 1 then p.p2
       else p.p1
  end,
  1, 0.0300,
  5000.00,
  150.00,
  case when n.month_offset >= 1 then 'paid' else 'pending' end,
  case when n.month_offset >= 1 then (p.p2 + interval '7 days')::timestamptz else null end,
  'DEMO_KELLY Tier-1 spa #' || lpad(n.spa_idx::text, 2, '0')
from periods p
cross join (
  -- 8 spas × 3 months = 24 rows
  select g.spa_idx, m.month_offset
  from generate_series(1, 8) g(spa_idx)
  cross join generate_series(0, 2) m(month_offset)
) n;

-- Kelly Tier-2 cascade: 20 spas (across 5 sub-reps) × $5K/mo × 1% = $1,000/mo Kelly
-- Slightly lower volume in older periods (network was still growing).

with periods as (
  select
    date_trunc('month', now() - interval '60 days')::date as p3,
    date_trunc('month', now() - interval '30 days')::date as p2,
    date_trunc('month', now())::date                      as p1
),
cascade_counts as (
  select 0 as month_offset, 6  as spas union all   -- current month
  select 1, 14 union all                            -- 1 mo ago
  select 2, 20                                      -- 2 mo ago (when full ramp hits)
)
insert into public.rep_commission_ledger (
  rep_id, source_invoice_id, source_tenant_id, period_month, tier_level,
  commission_split, source_revenue_usd, commission_usd, status, paid_at, notes
)
select
  'c0ffee00-0000-0000-0000-000000000001'::uuid,
  null, null,
  case when c.month_offset = 2 then p.p3
       when c.month_offset = 1 then p.p2
       else p.p1
  end,
  2, 0.0100,
  5000.00,
  50.00,
  case when c.month_offset >= 1 then 'paid' else 'pending' end,
  case when c.month_offset >= 1 then (p.p2 + interval '7 days')::timestamptz else null end,
  'DEMO_KELLY Tier-2 cascade'
from periods p
cross join cascade_counts c
cross join lateral generate_series(1, c.spas) g(idx);

-- ─── (5) emma_recovery_events — live $$ widget feed ──────────────────────
-- 20 events across the last 30 days, all attributed to Kelly (her direct
-- spas only — sub-rep cascade flows through the ledger, not the live widget).
-- Mix of recovery_agent types (rescue, post_recovery, preshow) and verification
-- states (~70% verified with attributed_revenue_usd, ~30% unverified/pending).
--
-- created_at is staggered: 4 in the last hour (for "Today" + freshness),
-- 4 in the last day, 6 in the last 7 days, 6 in the last 30 days.

insert into public.emma_recovery_events (
  user_id, recovery_agent, attribution_method,
  attributed_revenue_usd, verification_source, verified_at, verified_by,
  referred_by_rep_id, notes, created_at, updated_at
)
select
  'c0ffee00-0000-0000-0000-000000000001'::uuid,                          -- user_id (Kelly herself as spa-owner stand-in)
  agent.val,                                                              -- recovery_agent
  'direct',
  case when v.is_verified then v.amount else null end,                    -- attributed_revenue_usd
  case when v.is_verified then 'stripe' else null end,                    -- verification_source
  case when v.is_verified then v.created_at + interval '4 hours' else null end,  -- verified_at
  case when v.is_verified then 'DEMO_VERIFIER' else null end,
  'c0ffee00-0000-0000-0000-000000000001'::uuid,                          -- referred_by_rep_id = Kelly
  'DEMO_KELLY recovery event',
  v.created_at,
  v.created_at
from (
  values
    -- 4 in last hour (for fresh feel)
    (now() - interval '8 minutes',  true,  475.00),
    (now() - interval '23 minutes', true,  680.00),
    (now() - interval '41 minutes', true,  525.00),
    (now() - interval '54 minutes', false, 0),
    -- 4 in last day (today/yesterday)
    (now() - interval '4 hours',    true,  890.00),
    (now() - interval '7 hours',    true,  340.00),
    (now() - interval '11 hours',   false, 0),
    (now() - interval '19 hours',   true,  720.00),
    -- 6 in last 7 days
    (now() - interval '2 days',     true,  610.00),
    (now() - interval '3 days',     true,  425.00),
    (now() - interval '3 days 8 hours', true,  290.00),
    (now() - interval '4 days',     false, 0),
    (now() - interval '5 days',     true,  520.00),
    (now() - interval '6 days',     true,  775.00),
    -- 6 in last 30 days
    (now() - interval '9 days',     true,  390.00),
    (now() - interval '14 days',    true,  620.00),
    (now() - interval '18 days',    true,  450.00),
    (now() - interval '21 days',    false, 0),
    (now() - interval '25 days',    true,  580.00),
    (now() - interval '28 days',    true,  365.00)
) as v(created_at, is_verified, amount)
cross join lateral (
  -- Rotate through the 3 agent types deterministically based on created_at.
  select case extract(epoch from v.created_at)::bigint % 3
    when 0 then 'rescue'
    when 1 then 'post_recovery'
    else 'preshow'
  end as val
) agent;

-- ─── (6) wipe function — clean revert before Kelly's real signup ─────────

create or replace function public.wipe_kelly_demo_data()
returns table (deleted_table text, row_count bigint)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_events_deleted  bigint;
  v_ledger_deleted  bigint;
  v_affil_deleted   bigint;
  v_reps_deleted    bigint;
  v_idents_deleted  bigint;
  v_users_deleted   bigint;
begin
  with d as (
    delete from public.emma_recovery_events
    where notes like 'DEMO_KELLY%'
    returning 1
  )
  select count(*) into v_events_deleted from d;

  with d as (
    delete from public.rep_commission_ledger
    where notes like 'DEMO_KELLY%'
    returning 1
  )
  select count(*) into v_ledger_deleted from d;

  with d as (
    delete from public.rep_affiliations
    where rep_id in (
      select rep_user_id from public.rep_accounts where metadata->>'demo' = 'true'
    )
    or parent_rep_id in (
      select rep_user_id from public.rep_accounts where metadata->>'demo' = 'true'
    )
    returning 1
  )
  select count(*) into v_affil_deleted from d;

  with d as (
    delete from public.rep_accounts
    where metadata->>'demo' = 'true'
    returning 1
  )
  select count(*) into v_reps_deleted from d;

  with d as (
    delete from auth.identities
    where user_id in (select id from auth.users where email like '%@refill-demo.test')
    returning 1
  )
  select count(*) into v_idents_deleted from d;

  with d as (
    delete from auth.users
    where email like '%@refill-demo.test'
    returning 1
  )
  select count(*) into v_users_deleted from d;

  return query values
    ('emma_recovery_events',  v_events_deleted),
    ('rep_commission_ledger', v_ledger_deleted),
    ('rep_affiliations',      v_affil_deleted),
    ('rep_accounts',          v_reps_deleted),
    ('auth.identities',       v_idents_deleted),
    ('auth.users',            v_users_deleted);
end;
$fn$;

revoke all on function public.wipe_kelly_demo_data() from public;
grant execute on function public.wipe_kelly_demo_data() to service_role;

comment on function public.wipe_kelly_demo_data() is
  'One-shot revert of the Kelly Caffee demo seed (Phase 2G v399). Returns row counts deleted per table. Call from Supabase dashboard SQL editor with: select * from public.wipe_kelly_demo_data();';

-- ─── (7) PostgREST reload ────────────────────────────────────────────────
notify pgrst, 'reload schema';

-- ─── (8) Verify ──────────────────────────────────────────────────────────
-- These should each return non-zero counts after the migration runs cleanly.
-- If any return 0, that step didn't land — investigate before demoing.

select 'demo_users'              as label, count(*) from auth.users where email like '%@refill-demo.test';
select 'demo_reps'               as label, count(*) from public.rep_accounts where metadata->>'demo' = 'true';
select 'demo_affiliations'       as label, count(*) from public.rep_affiliations
  where rep_id in (select rep_user_id from public.rep_accounts where metadata->>'demo' = 'true');
select 'demo_ledger_rows'        as label, count(*) from public.rep_commission_ledger where notes like 'DEMO_KELLY%';
select 'demo_recovery_events'    as label, count(*) from public.emma_recovery_events where notes like 'DEMO_KELLY%';
select 'kelly_lifetime_revenue'  as label, sum(attributed_revenue_usd)::numeric(12,2) from public.emma_recovery_events where notes like 'DEMO_KELLY%';

-- ─── 4/9 voice_shift_pinch_18 ─────────────────
-- ─────────────────────────────────────────────────────────────────────────
-- v403 — Pinch #18 voice-shift: rep-as-messenger for ICP-2 email_a + email_b
-- ─────────────────────────────────────────────────────────────────────────
--
-- WHY
--   The 2026-05-22 Kelly Caffee dry-run surfaced a dissonance in the
--   outreach send path: when a REP (Kelly) sends an ICP-2 template, the
--   From: line correctly shows "Kelly Caffee" — but the BODY is voiced
--   first-person Karen ("I'm Karen, RN-owner..."). Recipient reads From=
--   Kelly, Body=Karen — confusing at best, dishonest at worst.
--
-- WHAT THIS MIGRATION DOES
--   Inserts new versioned rows for (icp=2, channel='email_a') and
--   (icp=2, channel='email_b') with voice-shifted bodies that:
--     - Open in the sender's voice ([from first name] here — ...)
--     - Recast Karen as the friend/credibility-source (third-person)
--     - End with the sender's first-name signature
--   Existing active rows are flagged is_active=false in the same txn so
--   the partial unique index (one active per slot) never has a window of
--   violation.
--
-- SCOPE
--   ICP-2 only (cold tier-2 independents — Kelly's volume case for 5/29).
--   ICP-1 (Karen's own warm network) and ICP-3 (Acuity warm-tech) are
--   intentionally NOT touched: ICP-1 is meant for Karen sending to her
--   own friends and reads correctly in first-person. ICP-3 voice-shift
--   is deferred until v403.x because that path is lower-volume and the
--   demo arc doesn't hit it.
--
-- PLACEHOLDER CONTRACT
--   New tokens [from] and [from first name] resolve via PlaceholderContext
--   in src/server/refill-outreach-send.ts (v403). Admin sends without a
--   rep principal default senderName='Karen Anderson' / senderFirstName=
--   'Karen' so legacy templates that DON'T use [from] are unaffected.
--
-- TO RUN
--   Paste into Supabase SQL editor on the production project.
--   Per [[feedback-migrations-via-dashboard]] — never `db push --linked`.
-- ─────────────────────────────────────────────────────────────────────────

begin;

-- ── ICP-2 email_a (Variant A — killshot subject lead) ────────────────────

update public.outreach_templates
   set is_active = false,
       updated_at = now()
 where icp = 2
   and channel = 'email_a'
   and is_active = true;

insert into public.outreach_templates
       (icp, channel, subject, body, version, is_active, notes)
values (2, 'email_a',
        'Free unless it recovers money for you',
        $body$<p>Hi [first name],</p>
<p>[from first name] here — a friend of mine, Karen Anderson, is an RN-owner of a med-spa in Minnesota. She got so burned out on Tuesday-night cancellation chasing that she built a tool to handle it. I think you'll want to see it.</p>
<p>It's called Refill (<a href="https://getrefill.app">getrefill.app</a>). It watches the booking system, drafts the recovery message the second a cancellation hits, the spa just hits send.</p>
<p>Pricing is structured the way Karen wanted it as an operator: free unless it recovers money for you, then 12% of what it recovers. No monthly, no contract.</p>
<p>If you want a 2-minute Loom of it running on Karen's spa, reply "Loom" and I'll send it over. If not, no worries — you won't hear from me again.</p>
<p>— [from first name]</p>$body$,
        (select coalesce(max(version), 0) + 1
           from public.outreach_templates
          where icp = 2 and channel = 'email_a'),
        true,
        'v403 Pinch #18 — rep-as-messenger voice (third-person Karen, [from first name] signature). Replaces first-person Karen voice that read dishonest when a non-Karen rep dispatched the send.');

-- ── ICP-2 email_b (Variant B — peer-credibility lead) ────────────────────

update public.outreach_templates
   set is_active = false,
       updated_at = now()
 where icp = 2
   and channel = 'email_b'
   and is_active = true;

insert into public.outreach_templates
       (icp, channel, subject, body, version, is_active, notes)
values (2, 'email_b',
        'An RN-owner I know built something for the cancellation problem',
        $body$<p>Hi [first name],</p>
<p>[from first name] here — wanted to put something in front of you that I think you'll want to see. A friend of mine, Karen Anderson, is an RN-owner of a med-spa in Minnesota (Rejuv). Last fall she got so burned out on Tuesday-evening cancellation chasing — the texts at 9 PM, the rebooking spreadsheet, the "did anyone want the slot?" group messages — that she built a tool for her own spa to handle it. It plugs into the booking system, drafts the recovery message to the right patient, the spa just hits send.</p>
<p>It's been running on Rejuv for [N] weeks. They've recovered $[exact figure] doing nothing different.</p>
<p>She's calling it Refill (<a href="https://getrefill.app">getrefill.app</a>), and she's opening it up to a small number of other independent spas. Pricing is structured the way Karen would want it as an operator: <strong>free unless it recovers money for you, then 12% of what it recovers. No monthly fee, no contract, no setup fee.</strong></p>
<p>If you want a 2-minute Loom of how it works on Karen's spa, reply "Loom." If you want to talk it through, reply "call." If you're not interested, ignore this and we're done — I won't bug you.</p>
<p>— [from first name]</p>$body$,
        (select coalesce(max(version), 0) + 1
           from public.outreach_templates
          where icp = 2 and channel = 'email_b'),
        true,
        'v403 Pinch #18 — rep-as-messenger voice. Subject re-anchored from "RN-owner to RN-owner" (only true for Karen) to "An RN-owner I know" (true for any rep introducing Karen).');

commit;

-- ── PostgREST schema reload (defensive — no schema change but harmless) ──

notify pgrst, 'reload schema';

-- ── Verify (paste-friendly) ──────────────────────────────────────────────
-- Run after the migration to confirm exactly one active version per slot
-- and the new bodies reference the [from first name] placeholder:
--
-- select icp, channel, version, is_active,
--        substring(body for 80) as body_preview
--   from public.outreach_templates
--  where icp = 2 and channel in ('email_a','email_b')
--  order by channel, version desc;
--
-- -- Body must contain [from first name] in the opener AND signature.
-- select icp, channel,
--        position('[from first name]' in body) as opener_position
--   from public.outreach_templates
--  where icp = 2 and channel in ('email_a','email_b') and is_active = true;

-- ─── 5/9 seed_restitch_spa_names ──────────────
-- ─────────────────────────────────────────────────────────────────────────
-- v405 — Pinch #4 seed re-stitch: ledger notes get realistic spa names
-- ─────────────────────────────────────────────────────────────────────────
--
-- WHY
--   The 2026-05-22 Kelly Caffee dry-run flagged Pinch #4: the rep's
--   commission ledger showed every Tier-1 row as "DEMO_KELLY Tier-1 spa
--   #01" through "#08" and every Tier-2 cascade row as the bare string
--   "DEMO_KELLY Tier-2 cascade". The rep mental model expects spa NAMES
--   tied to the network ("Anderson Aesthetics — Kelly direct" / "Coast
--   Aesthetics — via Maria Chen"), not anonymous indices. Sub-rep names
--   on the network page should reconcile with the ledger's spa
--   attributions. v405 rewrites the seeded notes so they do.
--
-- WHAT
--   Re-points the `notes` column on existing rep_commission_ledger demo
--   rows (rep_id = c0ffee00-...-001 = Kelly) to descriptive names:
--     - Tier 1: 8 fictional spa names paired with " (Kelly direct)"
--     - Tier 2: 20 fictional spa names paired with " (via <sub-rep>)"
--   "DEMO_KELLY · " prefix is preserved so the existing wipe function
--   (notes LIKE 'DEMO_KELLY%') still matches and cleans up cleanly.
--
--   The ledger UI in v405 strips the "DEMO_KELLY · " prefix at render
--   time (app.lizzie.ledger.tsx) so the rep sees "Anderson Aesthetics
--   (Kelly direct)" with no leakage of the demo tag — but the DB row
--   keeps the tag for wipe.
--
-- IDEMPOTENCY
--   Each UPDATE narrowly matches the prior literal ("DEMO_KELLY Tier-1
--   spa #NN" / "DEMO_KELLY Tier-2 cascade") so re-running the migration
--   after it's already been applied is a no-op (zero rows match).
--
-- TO RUN
--   Paste into Supabase SQL editor on production. Per
--   [[feedback-migrations-via-dashboard]] — never `db push --linked`.
-- ─────────────────────────────────────────────────────────────────────────

begin;

-- ── Tier 1: 8 Kelly-direct spas across 3 months (24 rows) ────────────────
-- Extract spa_idx (1..8) from the existing notes literal and map it to
-- the spa name pool. Original literal example: "DEMO_KELLY Tier-1 spa #03"

update public.rep_commission_ledger
   set notes = 'DEMO_KELLY · ' || spa.name || ' (Kelly direct)',
       updated_at = now()
  from (values
    (1, 'Anderson Aesthetics'),
    (2, 'Lakeside Med Spa'),
    (3, 'Riverbend Wellness'),
    (4, 'Cedar Bluff Skin'),
    (5, 'Northwoods Beauty'),
    (6, 'Olympia Aesthetics'),
    (7, 'Crestview Rejuv'),
    (8, 'Stonebrook Med')
  ) as spa(idx, name)
 where rep_id = 'c0ffee00-0000-0000-0000-000000000001'::uuid
   and tier_level = 1
   and notes like 'DEMO_KELLY Tier-1 spa #%'
   and spa.idx = (substring(notes from 'spa #(\d+)'))::int;

-- ── Tier 2: 20 cascade spas across 5 sub-reps, distributed by period ─────
-- The seed inserts 6/14/20 Tier-2 rows per period (current/-1mo/-2mo) all
-- with identical notes. We use row_number() partitioned by period_month
-- to assign a spa-pool index 0..19 deterministically. Modulo 20 keeps it
-- in range even if the per-period count exceeds 20 (it doesn't today).
--
-- The 20-spa pool: 4 spas per sub-rep × 5 sub-reps. Names anchor each spa
-- to a specific sub-rep so the rep's mental model "Maria's 4 spas, Tony's
-- 4 spas, ..." matches the network tree.

with tier2_rows as (
  select id,
         (row_number() over (partition by period_month order by id) - 1)::int as row_idx
    from public.rep_commission_ledger
   where rep_id = 'c0ffee00-0000-0000-0000-000000000001'::uuid
     and tier_level = 2
     and notes = 'DEMO_KELLY Tier-2 cascade'
),
spa_pool as (
  select * from (values
    (0,  'Coast Aesthetics',       'Maria Chen'),
    (1,  'Pacific Skin',           'Maria Chen'),
    (2,  'Tidewater Med Spa',      'Maria Chen'),
    (3,  'Marina Beauty',          'Maria Chen'),
    (4,  'Highland Aesthetics',    'Tony Reyes'),
    (5,  'Mesa Med Spa',           'Tony Reyes'),
    (6,  'Foothills Skin',         'Tony Reyes'),
    (7,  'Canyon Wellness',        'Tony Reyes'),
    (8,  'Birch Beauty',           'Sarah Kim'),
    (9,  'Glasshouse Aesthetics',  'Sarah Kim'),
    (10, 'Linden Med Spa',         'Sarah Kim'),
    (11, 'Maple Lane Skin',        'Sarah Kim'),
    (12, 'Vista Aesthetics',       'Jasmine Patel'),
    (13, 'Sunridge Beauty',        'Jasmine Patel'),
    (14, 'Goldenrod Med',          'Jasmine Patel'),
    (15, 'Sage Wellness',          'Jasmine Patel'),
    (16, 'Brickline Med Spa',      'Marcus Williams'),
    (17, 'Ironwood Aesthetics',    'Marcus Williams'),
    (18, 'Foundry Beauty',         'Marcus Williams'),
    (19, 'Studio M Skin',          'Marcus Williams')
  ) as p(idx, spa_name, sub_rep)
)
update public.rep_commission_ledger l
   set notes = 'DEMO_KELLY · ' || p.spa_name || ' (via ' || p.sub_rep || ')',
       updated_at = now()
  from tier2_rows t
  join spa_pool p on p.idx = (t.row_idx % 20)
 where l.id = t.id;

commit;

-- ── PostgREST reload (defensive; no schema change but harmless) ──────────
notify pgrst, 'reload schema';

-- ── Verify (paste-friendly) ──────────────────────────────────────────────
-- Tier-1 distinct names — should return 8 distinct rows:
--
-- select distinct notes
--   from public.rep_commission_ledger
--  where rep_id = 'c0ffee00-0000-0000-0000-000000000001'::uuid
--    and tier_level = 1
--  order by notes;
--
-- Tier-2 distinct names — should return 20 distinct rows (Coast..Studio M):
--
-- select distinct notes
--   from public.rep_commission_ledger
--  where rep_id = 'c0ffee00-0000-0000-0000-000000000001'::uuid
--    and tier_level = 2
--  order by notes;
--
-- Verify wipe fn still matches via prefix:
--
-- select count(*) from public.rep_commission_ledger
--  where notes like 'DEMO_KELLY%';

-- ─── 6/9 rep_referral_links ───────────────────
-- ─────────────────────────────────────────────────────────────────────────
-- v406 — Persisted referral links (short slug + history substrate)
-- ─────────────────────────────────────────────────────────────────────────
--
-- WHY
--   Two pinches from the 2026-05-22 Kelly Caffee dry-run, both blocked on
--   the same missing substrate:
--
--     Pinch #10: the outbound referral URL Kelly shares is a 200+ char
--       JWT-shaped string (getrefill.app/onboard?ref=eyJyZXAiOiJjMG&hellip;).
--       Looks broken in a text message; unmemorable; impossible to
--       say-aloud on a phone call. Want: getrefill.app/r/kelly-caffee.
--
--     Pinch #7: /app/lizzie/referral-links shows the most-recently-minted
--       link but no history. If the rep mints once, leaves the page, and
--       comes back, the page is empty &mdash; they can't tell what their
--       current link is or whether anyone has used it.
--
--   Both are fixed by the same move: persist every mint to a
--   rep_referral_links table with a short_slug column. The existing
--   HMAC-signed token (src/server/referral-tokens.ts) becomes the
--   INTERNAL artifact &mdash; resolved server-side by slug lookup &mdash; and the
--   SHARE artifact is the short slug URL.
--
-- DATA MODEL
--   - One persistent row per rep (idempotent mint; same rep_user_id gets
--     the same slug on every subsequent call). This matches the "lifetime
--     referral link" mental model already shipped in v395.
--   - short_slug is globally unique (partial unique index, lowercase, kebab).
--   - token is the HMAC-signed JWT-shaped string (still verifiable
--     stateless via validateReferralToken; the row just stores it for
--     resolution).
--   - use_count + last_used_at update every time /r/<slug> resolves; gives
--     the history view a "X people have joined via your link" metric.
--
-- RLS
--   Service-role only. All reads/writes go through admin-gated server fns
--   (mintMyReferralLink, listMyReferralLinks, resolveReferralSlug). The
--   /r/<slug> route is a public redirect endpoint &mdash; no auth required to
--   resolve, but the underlying lookup uses the service-role client.
--
-- KELLY DEMO SEED
--   One pre-populated row for Kelly (rep_user_id = c0ffee00-...-001) with
--   slug "kelly-caffee", a freshly-minted token, and use_count=5 (matches
--   her 5 seeded Tier-1 sub-reps from migration 20260608). This makes the
--   history view non-empty for the demo without requiring her to mint
--   anything first.
--
-- TO RUN
--   Paste into Supabase SQL editor. Per [[feedback-migrations-via-dashboard]].
-- ─────────────────────────────────────────────────────────────────────────

begin;

create table if not exists public.rep_referral_links (
  id            uuid        primary key default gen_random_uuid(),
  rep_user_id   uuid        not null references auth.users(id) on delete cascade,
  -- Lowercase kebab-case slug, e.g. 'kelly-caffee'. Enforced unique globally
  -- so /r/<slug> resolves to exactly one rep with no collision.
  short_slug    text        not null,
  -- HMAC-signed referral token (see src/server/referral-tokens.ts). The row
  -- stores it so /r/<slug> can resolve slug → token → /onboard?ref=<token>
  -- redirect without re-minting on every resolution.
  token         text        not null,
  -- Resolution audit: bumped on every /r/<slug> hit.
  use_count     integer     not null default 0,
  last_used_at  timestamptz,
  created_at    timestamptz not null default now()
);

-- Lookup hot path: /r/<slug> resolution.
create unique index if not exists rep_referral_links_short_slug_unique
  on public.rep_referral_links (short_slug);

-- Per-rep listing: history view sorted newest-first (rep_user_id, created_at desc).
create index if not exists rep_referral_links_rep_idx
  on public.rep_referral_links (rep_user_id, created_at desc);

comment on table public.rep_referral_links is
  'Persisted referral link record per rep. Idempotent mint (one row per rep_user_id in current implementation); /r/<short_slug> redirects to /onboard?ref=<token>.';

comment on column public.rep_referral_links.short_slug is
  'Lowercase kebab-case slug derived from rep display name. Globally unique.';

comment on column public.rep_referral_links.token is
  'HMAC-signed referral token (see src/server/referral-tokens.ts). Stored so /r/<slug> resolves without re-minting.';

-- ── RLS ─────────────────────────────────────────────────────────────────
-- Service-role only. The /r/<slug> redirect route uses the admin client to
-- look up the slug → token mapping; the rep-facing UI calls server fns
-- (mintMyReferralLink, listMyReferralLinks) that also use the admin client.

alter table public.rep_referral_links enable row level security;

do $$ begin
  create policy "service_role_rep_referral_links"
    on public.rep_referral_links for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

-- ── Kelly demo seed ─────────────────────────────────────────────────────
-- One row for Kelly with use_count=5 so the history view is non-empty for
-- the 5/29 demo without requiring her to mint anything first. The token
-- value here is a placeholder ('SEED_REPLACE_ON_FIRST_MINT'); the first
-- call to mintMyReferralLink for Kelly will overwrite it with a real
-- HMAC-signed token (server fn handles this). /r/kelly-caffee will resolve
-- correctly the moment the server fn fires (idempotency clause in the
-- updated mintMyReferralLink — see src/server/rep-platform.ts).

insert into public.rep_referral_links
       (rep_user_id, short_slug, token, use_count, created_at)
values ('c0ffee00-0000-0000-0000-000000000001'::uuid,
        'kelly-caffee',
        'SEED_REPLACE_ON_FIRST_MINT',
        5,
        now() - interval '21 days')
on conflict (short_slug) do nothing;

commit;

-- ── PostgREST schema reload ─────────────────────────────────────────────
notify pgrst, 'reload schema';

-- ── Verify (paste-friendly) ──────────────────────────────────────────────
-- Confirm the table + indexes landed and the Kelly seed row is present:
--
-- select column_name, data_type, is_nullable
--   from information_schema.columns
--  where table_schema='public' and table_name='rep_referral_links'
--  order by ordinal_position;
--
-- select indexname from pg_indexes
--  where schemaname='public' and tablename='rep_referral_links';
--
-- -- Kelly seed:
-- select short_slug, use_count, last_used_at, created_at
--   from public.rep_referral_links
--  where rep_user_id = 'c0ffee00-0000-0000-0000-000000000001'::uuid;

-- ─── 7/9 kelly_outreach_history_seed ──────────
-- ─────────────────────────────────────────────────────────────────────────
-- v405.3 — Kelly demo outreach history seed (Pinch #13)
-- ─────────────────────────────────────────────────────────────────────────
--
-- WHY
--   The new "Your recent sends" panel at the bottom of /app/lizzie/outreach
--   shows the rep's outreach_engagement_events filtered by sent_by=me.
--   Kelly's seed has no engagement events &mdash; the panel would render empty
--   in the 5/29 demo, undermining the methodology (the page should look
--   like a working channel, not a fresh install).
--
-- WHAT
--   8 seeded outreach send rows tied to Kelly (sent_by=c0ffee00-...-001):
--     - Mixed across ICP-2 email_a + email_b (the templates Kelly demos)
--     - All send_mode='dry_run' (matches OUTREACH_LIVE=false production)
--     - Staggered sent_at: 3 in last 24h (fresh feel), 2 in last week,
--       3 in last 30 days (older history)
--     - Conversion progression: 2 converted (signed up as sub-reps/spas),
--       3 opened, 1 replied, 2 sent-only — mirrors realistic funnel
--     - Recipient names mapped to the Tier-1 sub-reps Kelly already has
--       seeded (Maria/Tony/Sarah/Jasmine/Marcus) PLUS 3 fictional
--       prospects who haven't converted yet
--   All rows tagged 'DEMO_KELLY' in source_context so wipe can match.
--
-- WIPE FUNCTION
--   Updated to also drop outreach_engagement_events where source_context
--   like 'DEMO_KELLY%'. Previously the wipe function only matched
--   rep_commission_ledger + emma_recovery_events on notes; engagement
--   events use source_context as their tag column instead.
--
-- IDEMPOTENCY
--   Insert is gated by a SELECT-then-INSERT check on source_context. Re-
--   running the migration after first apply is a no-op (zero rows match
--   the WHERE NOT EXISTS clause).
--
-- TO RUN
--   Paste into Supabase SQL editor. Per [[feedback-migrations-via-dashboard]].
-- ─────────────────────────────────────────────────────────────────────────

begin;

-- ── Seed 8 engagement events for Kelly ───────────────────────────────────
-- Use a CTE pattern so the conversion-state columns can be set inline per
-- row. Each row's sent_at is computed from now() + an interval so the
-- demo always shows "today" / "3d ago" / "21d ago" no matter when the
-- migration is applied.

with seed_rows as (
  select * from (values
    -- (recipient_first_name, recipient_email, icp, channel, subject, ago,  state)
    -- "state" drives which engagement columns get populated:
    --   sent  | opened | replied | converted
    --   -----+--------+---------+----------
    ('Maria',    'maria@boutique-aesthetic-advisors.test',  2, 'email_b',
        'An RN-owner I know built something for the cancellation problem',
        interval '23 days', 'converted'),
    ('Tony',     'tony@reyes-medspa-consulting.test',       2, 'email_b',
        'An RN-owner I know built something for the cancellation problem',
        interval '17 days', 'converted'),
    ('Sarah',    'sarah@kim-aesthetics-group.test',         2, 'email_a',
        'Free unless it recovers money for you',
        interval '14 days', 'replied'),
    ('Jasmine',  'jasmine@patel-beauty-partners.test',      2, 'email_a',
        'Free unless it recovers money for you',
        interval '9 days',  'opened'),
    ('Marcus',   'marcus@williams-medaesthetic.test',       2, 'email_b',
        'An RN-owner I know built something for the cancellation problem',
        interval '5 days',  'opened'),
    ('Diane',    'diane@northstarderm.test',                2, 'email_a',
        'Free unless it recovers money for you',
        interval '20 hours','opened'),
    ('Chen',     'chen.lin@bluespringaesthetics.test',      2, 'email_b',
        'An RN-owner I know built something for the cancellation problem',
        interval '7 hours', 'sent'),
    ('Priya',    'priya@cedarvalleyrn.test',                2, 'email_a',
        'Free unless it recovers money for you',
        interval '42 minutes', 'sent')
  ) as r(first_name, email, icp, channel, subject, ago, state)
)
insert into public.outreach_engagement_events
       (recipient_email, recipient_first_name, icp, channel,
        send_mode, rendered_subject, rendered_body,
        sent_by, sent_at, opened_at, response_received_at, converted_at,
        source_context)
select s.email, s.first_name, s.icp, s.channel,
       'dry_run',
       s.subject,
       -- Body placeholder — the demo panel doesn't render this, but the
       -- column is NOT NULL. Real production sends carry the rendered HTML.
       '(demo seed — body omitted)',
       'c0ffee00-0000-0000-0000-000000000001'::uuid,
       now() - s.ago,
       case when s.state in ('opened','replied','converted') then now() - s.ago + interval '2 hours' end,
       case when s.state in ('replied','converted')          then now() - s.ago + interval '1 day' end,
       case when s.state = 'converted'                       then now() - s.ago + interval '3 days' end,
       'DEMO_KELLY rep:Kelly Caffee'
  from seed_rows s
 where not exists (
   select 1 from public.outreach_engagement_events
    where sent_by = 'c0ffee00-0000-0000-0000-000000000001'::uuid
      and source_context like 'DEMO_KELLY%'
 );

-- ── Update wipe function to also clean engagement events ────────────────
-- The existing wipe_kelly_demo_data() drops ledger + recovery events but
-- doesn't know about outreach_engagement_events. Extend it.

create or replace function public.wipe_kelly_demo_data()
returns table (deleted_table text, row_count bigint)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_events_deleted     bigint;
  v_ledger_deleted     bigint;
  v_outreach_deleted   bigint;
  v_referrals_deleted  bigint;
  v_affil_deleted      bigint;
  v_reps_deleted       bigint;
  v_idents_deleted     bigint;
  v_users_deleted      bigint;
begin
  with d as (
    delete from public.emma_recovery_events
    where notes like 'DEMO_KELLY%'
    returning 1
  )
  select count(*) into v_events_deleted from d;

  with d as (
    delete from public.rep_commission_ledger
    where notes like 'DEMO_KELLY%'
    returning 1
  )
  select count(*) into v_ledger_deleted from d;

  with d as (
    delete from public.outreach_engagement_events
    where source_context like 'DEMO_KELLY%'
    returning 1
  )
  select count(*) into v_outreach_deleted from d;

  with d as (
    delete from public.rep_referral_links
    where rep_user_id in (
      select rep_user_id from public.rep_accounts where metadata->>'demo' = 'true'
    )
    returning 1
  )
  select count(*) into v_referrals_deleted from d;

  with d as (
    delete from public.rep_affiliations
    where rep_id in (
      select rep_user_id from public.rep_accounts where metadata->>'demo' = 'true'
    )
    or parent_rep_id in (
      select rep_user_id from public.rep_accounts where metadata->>'demo' = 'true'
    )
    returning 1
  )
  select count(*) into v_affil_deleted from d;

  with d as (
    delete from public.rep_accounts
    where metadata->>'demo' = 'true'
    returning 1
  )
  select count(*) into v_reps_deleted from d;

  with d as (
    delete from auth.identities
    where user_id in (select id from auth.users where email like '%@refill-demo.test')
    returning 1
  )
  select count(*) into v_idents_deleted from d;

  with d as (
    delete from auth.users
    where email like '%@refill-demo.test'
    returning 1
  )
  select count(*) into v_users_deleted from d;

  return query values
    ('emma_recovery_events',        v_events_deleted),
    ('rep_commission_ledger',       v_ledger_deleted),
    ('outreach_engagement_events',  v_outreach_deleted),
    ('rep_referral_links',          v_referrals_deleted),
    ('rep_affiliations',            v_affil_deleted),
    ('rep_accounts',                v_reps_deleted),
    ('auth.identities',             v_idents_deleted),
    ('auth.users',                  v_users_deleted);
end;
$fn$;

commit;

notify pgrst, 'reload schema';

-- ── Verify (paste-friendly) ──────────────────────────────────────────────
-- Should return 8 rows after first apply, idempotent after that:
--
-- select count(*) from public.outreach_engagement_events
--  where sent_by = 'c0ffee00-0000-0000-0000-000000000001'::uuid
--    and source_context like 'DEMO_KELLY%';
--
-- Confirm wipe function recognizes the new tables:
--
-- select prosrc from pg_proc where proname = 'wipe_kelly_demo_data';

-- ─── 8/9 outreach_rep_audience ────────────────
-- ─────────────────────────────────────────────────────────────────────────
-- v408 — Outreach audience split + recruit templates substrate
-- ─────────────────────────────────────────────────────────────────────────
--
-- WHY
--   Today /app/lizzie/outreach is rep→spa outreach (Kelly emails med-spas
--   she wants to recruit as Refill tenants). The platform's COMPOUNDING
--   growth mechanic is rep→REP outreach (Kelly recruits OTHER REPS into
--   her downstream, then earns 1% cascade on every spa THEY introduce,
--   forever). v408 adds the substrate.
--
-- DESIGN
--   - outreach_templates gets an `audience` column ('spa' | 'rep'). The
--     send-pipeline filter switches by audience so the existing spa
--     library stays untouched while a parallel rep library accumulates.
--   - outreach_engagement_events gets a `purpose` column ('spa_outreach'
--     | 'rep_recruit') so the analytics, past-sends panel, and conversion
--     stamping can branch on intent. Existing rows default to 'spa_outreach'.
--   - outreach_engagement_events also gets `converted_rep_user_id` (sibling
--     of the existing `converted_tenant_id`): when a recruit recipient
--     signs up as a sub-rep we stamp the new rep_accounts.rep_user_id here.
--     For spa conversions, converted_tenant_id stays the conversion column.
--   - The existing partial unique index on (icp, channel) WHERE is_active
--     is rebuilt as (icp, channel, audience) WHERE is_active. This lets
--     spa and rep audiences share an (icp, channel) slot without colliding.
--
-- RECRUIT TEMPLATES SEEDED HERE
--   ICP-1 email_a (rep)            — warm peer, references [my month earnings]
--   ICP-1 email_no_numbers (rep)   — green-rep starter (no earnings refs)
--   ICP-1 loom_script (rep)        — talking-head script
--   ICP-2 email_a (rep)            — cold peer in adjacent vertical
--
-- PLACEHOLDER CONTRACT
--   New tokens [my commission rate] / [my month earnings] / [my downstream
--   count] resolve via PlaceholderContext in src/server/refill-outreach-send.ts
--   (v408). Values are pulled live from getMyLiveEarnings + getMyNetwork at
--   send time. Per [[feedback-math-must-be-exact]] — if a value is unknown
--   or zero, the literal placeholder stays in the body so it's visible the
--   number is missing rather than silently rendering "$0".
--
-- TO RUN
--   Paste into Supabase SQL editor on production. Per [[feedback-migrations-via-dashboard]].
-- ─────────────────────────────────────────────────────────────────────────

begin;

-- ── 1) audience column on outreach_templates ─────────────────────────────

alter table public.outreach_templates
  add column if not exists audience text not null default 'spa'
    check (audience in ('spa', 'rep'));

-- Rebuild the partial unique index to include audience so (icp, channel)
-- can be shared across spa + rep audiences without collision.
drop index if exists public.outreach_templates_active_unique;
create unique index outreach_templates_active_unique
  on public.outreach_templates (icp, channel, audience)
  where is_active;

comment on column public.outreach_templates.audience is
  'spa = rep-to-spa outreach (default; original library). rep = rep-to-rep recruit outreach (v408+). Send pipeline filters by audience to keep the two libraries semantically separate while sharing the substrate.';

-- ── 2) purpose + converted_rep_user_id on outreach_engagement_events ────

alter table public.outreach_engagement_events
  add column if not exists purpose text not null default 'spa_outreach'
    check (purpose in ('spa_outreach', 'rep_recruit'));

alter table public.outreach_engagement_events
  add column if not exists converted_rep_user_id uuid
    references public.rep_accounts(rep_user_id) on delete set null;

-- Per-(purpose, sent_at) sort hot path for the past-sends panel filtering.
create index if not exists outreach_eng_purpose_sent_idx
  on public.outreach_engagement_events (purpose, sent_at desc);

create index if not exists outreach_eng_converted_rep_idx
  on public.outreach_engagement_events (converted_rep_user_id)
  where converted_rep_user_id is not null;

comment on column public.outreach_engagement_events.purpose is
  'spa_outreach = rep emails a med-spa (existing flow). rep_recruit = rep emails another rep (v408+). Separates conversion semantics and lets the past-sends panel + analytics filter cleanly.';

comment on column public.outreach_engagement_events.converted_rep_user_id is
  'Set when this engagement event converted a recipient into a sub-rep under the sender. Sibling of converted_tenant_id (which stamps when the recipient converts into a tenant). Stamped by ensureMyRepAccount when it consumes the refill_recruit_event cookie.';

-- ── 3) Seed 4 recruit templates (audience='rep') ─────────────────────────
-- ICP semantics for the rep audience:
--   ICP-1 = warm peer (you've met them, you know their name)
--   ICP-2 = cold peer (adjacent vertical, never met)
--   ICP-3 = (reserved; not used in v408)

insert into public.outreach_templates
       (icp, channel, audience, subject, body, version, is_active, notes)
values
  (1, 'email_a', 'rep',
   'Made $[my month earnings] last month on a side rep gig — want in?',
   $body$<p>Hey [first name] — [from first name].</p>
<p>I&apos;ve been quietly building out a side rep book on a med-spa product called Refill the last few months. It&apos;s automated no-show recovery for med-spas — they pay nothing unless it recovers real revenue for them, then 12% of what it recovers. The product sells itself once the spa sees the recovery in their first week.</p>
<p>My take is [my commission rate] of every recovered dollar on spas I introduce. Lifetime. No decay. Last month I cleared $[my month earnings] doing roughly an hour a week. I have [my downstream count] reps in my downstream now and they each clip 1% cascade for me on what THEIR spas recover.</p>
<p>I&apos;m looking for 2-3 more reps in your network. You&apos;d come in directly under me at the same 3% direct rate. Want me to send you the 90-second walkthrough?</p>
<p>— [from first name]</p>$body$,
   1, true,
   'v408 ICP-1 warm peer recruit — voiced from rep, leans on [my month earnings] + [my downstream count] for credibility. Green reps with $0 earnings should use email_no_numbers instead.'),

  (1, 'email_no_numbers', 'rep',
   'Picking up a side rep gig — thought of you',
   $body$<p>Hey [first name] — [from first name].</p>
<p>Just picked up a side rep book on a med-spa product called Refill. Automated no-show recovery — the spa pays nothing unless it recovers real revenue, then 12% of what it recovers. Pricing structure means the spa says yes pretty easily.</p>
<p>Rep economics are unusually clean: [my commission rate] of every recovered dollar on spas I introduce, lifetime, no decay. Plus 1% cascade on every spa my downstream reps introduce. Math compounds fast if you have any med-spa relationships.</p>
<p>You came to mind because of your network. Want me to send you the 90-second walkthrough so you can see if it fits?</p>
<p>— [from first name]</p>$body$,
   1, true,
   'v408 ICP-1 warm peer recruit — green-rep version. No references to my earnings or downstream count. Use this until I have real numbers to share (per [[feedback-math-must-be-exact]] — better to ship without numbers than ship with $0).'),

  (1, 'loom_script', 'rep',
   null,
   $body$<p>(00:00) Hey [first name], [from first name] here. Quick 90 seconds.</p>
<p>(00:05) I&apos;ve been quietly building a side rep book on a product called Refill. It&apos;s automated no-show recovery for med-spas. The spa pays nothing unless it recovers real money for them, then 12% of what it recovered. No monthly, no contract, no setup fee.</p>
<p>(00:25) Why I&apos;m calling you specifically: I&apos;m looking for 2-3 reps to come in under me. You&apos;d be at the same 3% direct rate I&apos;m at — no haircut for coming through me. I take a 1% cascade on what your spas recover, which doesn&apos;t come out of your pocket; it comes out of the 8% Refill keeps.</p>
<p>(00:50) Rep math: 3% direct, lifetime, no decay. I&apos;m at $[my month earnings] last month with [my downstream count] reps in my downstream. The compounding is real.</p>
<p>(01:10) If you want to dig in, reply to the email I just sent and I&apos;ll send the rep onboarding link. Takes about three minutes to set up. Talk soon.</p>$body$,
   1, true,
   'v408 ICP-1 loom_script for rep audience. Voiced from sender, references same live placeholders as email_a.'),

  (2, 'email_a', 'rep',
   'A rep gig you could moonlight without quitting your day job',
   $body$<p>Hi [first name],</p>
<p>You don&apos;t know me — [from first name]. I rep a product called Refill (med-spa no-show recovery) on the side. Pinging you because the rep math is unusually clean and I think it&apos;d fit alongside what you already do.</p>
<p>Refill charges spas nothing unless it recovers revenue for them, then 12% of what it recovers. No monthly fee, no contract — which makes the pitch unusually easy. Spa says yes the moment they see their first recovery.</p>
<p>Rep take is [my commission rate] direct, lifetime, on every recovered dollar on spas you introduce. Plus 1% cascade on spas YOUR sub-reps introduce. No quota, no exclusivity, no W-2 — pure 1099 referral, paid through Stripe Connect.</p>
<p>Reply &quot;walkthrough&quot; if you want the 90-second Loom. Reply &quot;not for me&quot; and I won&apos;t bug you again.</p>
<p>— [from first name]</p>$body$,
   1, true,
   'v408 ICP-2 cold peer recruit — assumes no prior relationship. Leads with the structural pitch (free + 12% of recovered revenue), surfaces [my commission rate] but not [my month earnings] (cold pitch shouldn&apos;t lean on personal credibility).')
on conflict do nothing;

commit;

-- ── PostgREST schema reload ─────────────────────────────────────────────
notify pgrst, 'reload schema';

-- ── Verify (paste-friendly) ──────────────────────────────────────────────
-- Should return 4 rep-audience templates after first apply:
--
-- select icp, channel, audience, version,
--        coalesce(subject, '(no subject — loom)') as subject_preview
--   from public.outreach_templates
--  where audience = 'rep' and is_active = true
--  order by icp, channel;
--
-- Confirm engagement events backfilled with default purpose:
--
-- select purpose, count(*) from public.outreach_engagement_events
--  group by purpose;
--
-- Confirm new columns + index landed:
--
-- select column_name from information_schema.columns
--  where table_schema = 'public' and table_name = 'outreach_engagement_events'
--    and column_name in ('purpose', 'converted_rep_user_id');
--
-- select indexname from pg_indexes
--  where schemaname = 'public'
--    and indexname in ('outreach_templates_active_unique',
--                      'outreach_eng_purpose_sent_idx',
--                      'outreach_eng_converted_rep_idx');

-- ─── 9/9 kelly_recruit_seed ───────────────────
-- ─────────────────────────────────────────────────────────────────────────
-- v408 — Kelly recruit-outreach demo seed
-- ─────────────────────────────────────────────────────────────────────────
--
-- WHY
--   v408 ships /app/lizzie/recruit (rep-to-rep recruiting outreach). For
--   the 5/29 Kelly Caffee demo the page can&apos;t feel empty — Kelly needs
--   a working channel with past sends and a non-zero downstream count
--   the moment she lands. This seed mirrors the v405.3 spa-outreach
--   history seed pattern, applied to the rep_recruit purpose.
--
-- WHAT
--   - 2 new demo auth.users + rep_accounts for the converted peer reps
--     (Randi Lopez, Marcus Stein). Both come in as Tier-1 sub-reps
--     under Kelly so her downstream count goes from 7 to 9 and her
--     [my downstream count] placeholder renders a real value on first
--     paint.
--   - 8 outreach_engagement_events with purpose='rep_recruit', staggered
--     across 30 days, mirroring the realistic funnel from the spa seed
--     (2 converted, 1 replied, 3 opened, 2 sent-only).
--   - Both converted rows stamp converted_rep_user_id pointing at the
--     new rep accounts so the recruit-attribution chain is whole end-to-end.
--   - All rows tagged 'DEMO_KELLY_RECRUIT' in source_context — matches
--     the existing 'DEMO_KELLY%' wipe filter so no wipe function update
--     is needed.
--
-- IDEMPOTENCY
--   Insert guarded by NOT EXISTS on the same source_context tag. Re-runs
--   are no-ops after the first apply.
--
-- TO RUN
--   Paste into Supabase SQL editor AFTER 20260613000000_outreach_rep_audience.sql.
--   Per [[feedback-migrations-via-dashboard]]. Order matters — the recruit
--   templates seeded in the prior migration must exist before this seed's
--   engagement_events rows can reference them by (icp, channel, audience).
-- ─────────────────────────────────────────────────────────────────────────

begin;

-- ── (1) auth.users for the 2 converted recruit recipients ────────────────
-- UUIDs continue the c0ffee00-…-00N sequence (existing demo uses 001-008).

insert into auth.users (
  id, instance_id, aud, role,
  email, encrypted_password, email_confirmed_at,
  raw_user_meta_data, raw_app_meta_data,
  created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change
) values
  ('c0ffee00-0000-0000-0000-000000000009'::uuid,
   '00000000-0000-0000-0000-000000000000'::uuid,
   'authenticated', 'authenticated',
   'randi@refill-demo.test', '', now(),
   jsonb_build_object('display_name','Randi Lopez','demo',true),
   jsonb_build_object('provider','email','providers',jsonb_build_array('email')),
   now() - interval '20 days', now(), '', '', '', ''),
  ('c0ffee00-0000-0000-0000-00000000000a'::uuid,
   '00000000-0000-0000-0000-000000000000'::uuid,
   'authenticated', 'authenticated',
   'marcus.stein@refill-demo.test', '', now(),
   jsonb_build_object('display_name','Marcus Stein','demo',true),
   jsonb_build_object('provider','email','providers',jsonb_build_array('email')),
   now() - interval '14 days', now(), '', '', '', '')
on conflict (id) do nothing;

-- auth.identities for the new users (email provider).

insert into auth.identities (
  id, user_id, provider, provider_id, identity_data,
  last_sign_in_at, created_at, updated_at
)
select
  gen_random_uuid(),
  u.id,
  'email',
  u.id::text,
  jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
  null,
  u.created_at,
  now()
from auth.users u
where u.email in ('randi@refill-demo.test', 'marcus.stein@refill-demo.test')
  and not exists (
    select 1 from auth.identities i where i.user_id = u.id and i.provider = 'email'
  );

-- ── (2) rep_accounts for the 2 new sub-reps ─────────────────────────────

insert into public.rep_accounts (
  rep_user_id, display_name, business_name, status, origin_type,
  territory, joined_at, payout_method, metadata
) values
  ('c0ffee00-0000-0000-0000-000000000009'::uuid,
   'Randi Lopez', 'Lopez Aesthetic Reps', 'active', 'indy_rep',
   jsonb_build_object('states', jsonb_build_array('CO','NM')),
   now() - interval '20 days', 'stripe',
   jsonb_build_object('demo', true, 'recruited_by', 'Kelly Caffee')),
  ('c0ffee00-0000-0000-0000-00000000000a'::uuid,
   'Marcus Stein', 'Stein Med-Aesthetic Partners', 'active', 'indy_rep',
   jsonb_build_object('states', jsonb_build_array('CO','WY')),
   now() - interval '14 days', 'stripe',
   jsonb_build_object('demo', true, 'recruited_by', 'Kelly Caffee'))
on conflict (rep_user_id) do nothing;

-- ── (3) rep_affiliations: both as Tier-1 sub-reps under Kelly ───────────

insert into public.rep_affiliations (
  rep_id, parent_rep_id, tier_level, commission_split, active
) values
  ('c0ffee00-0000-0000-0000-000000000009'::uuid,
   'c0ffee00-0000-0000-0000-000000000001'::uuid, 1, 0.0300, true),
  ('c0ffee00-0000-0000-0000-00000000000a'::uuid,
   'c0ffee00-0000-0000-0000-000000000001'::uuid, 1, 0.0300, true)
on conflict (rep_id, parent_rep_id, tier_level) do nothing;

-- ── (4) Seed 8 rep_recruit engagement events for Kelly ──────────────────
-- Mirrors the v405.3 spa-outreach seed shape. ICP semantics differ slightly:
--   icp=1 = warm peer (Kelly knows them personally)
--   icp=2 = cold peer (adjacent vertical, no prior relationship)
--
-- Two converted rows stamp converted_rep_user_id pointing at the new
-- rep_accounts inserted above. The lookup-by-template ensures historical
-- template_id linkage even though we don&apos;t hardcode template UUIDs.

with template_lookup as (
  select id, icp, channel from public.outreach_templates
   where audience = 'rep' and is_active = true
),
seed_rows as (
  select * from (values
    -- (first_name, email, icp, channel, subject, ago, state, converted_rep)
    ('Randi',     'randi.lopez@axis-aesthetic-network.test', 1, 'email_a',
        'Made $[my month earnings] last month on a side rep gig — want in?',
        interval '23 days', 'converted',
        'c0ffee00-0000-0000-0000-000000000009'::uuid),
    ('Marcus',    'marcus@stein-medaesthetic.test',          2, 'email_a',
        'A rep gig you could moonlight without quitting your day job',
        interval '17 days', 'converted',
        'c0ffee00-0000-0000-0000-00000000000a'::uuid),
    ('Jordan',    'jordan@parkrep.test',                     1, 'email_a',
        'Made $[my month earnings] last month on a side rep gig — want in?',
        interval '14 days', 'replied',
        null::uuid),
    ('Aisha',     'aisha@webbpartners.test',                 1, 'email_no_numbers',
        'Picking up a side rep gig — thought of you',
        interval '9 days', 'opened',
        null::uuid),
    ('Devon',     'devon@mills-channel.test',                2, 'email_a',
        'A rep gig you could moonlight without quitting your day job',
        interval '5 days', 'opened',
        null::uuid),
    ('Tasha',     'tasha@reyesgroup-aesthetic.test',         1, 'email_a',
        'Made $[my month earnings] last month on a side rep gig — want in?',
        interval '20 hours', 'opened',
        null::uuid),
    ('Eddie',     'eddie@vu-medsales.test',                  1, 'loom_script',
        null,
        interval '7 hours', 'sent',
        null::uuid),
    ('Priscilla', 'priscilla@yangrep.test',                  2, 'email_a',
        'A rep gig you could moonlight without quitting your day job',
        interval '42 minutes', 'sent',
        null::uuid)
  ) as r(first_name, email, icp, channel, subject, ago, state, converted_rep_user_id)
)
insert into public.outreach_engagement_events
       (recipient_email, recipient_first_name, template_id, icp, channel,
        send_mode, rendered_subject, rendered_body,
        sent_by, sent_at, opened_at, response_received_at, converted_at,
        converted_rep_user_id, source_context, purpose)
select s.email, s.first_name,
       (select id from template_lookup t where t.icp = s.icp and t.channel = s.channel limit 1),
       s.icp, s.channel,
       'dry_run',
       s.subject,
       '(demo seed — body omitted)',
       'c0ffee00-0000-0000-0000-000000000001'::uuid,
       now() - s.ago,
       case when s.state in ('opened','replied','converted') then now() - s.ago + interval '2 hours' end,
       case when s.state in ('replied','converted')          then now() - s.ago + interval '1 day' end,
       case when s.state = 'converted'                       then now() - s.ago + interval '3 days' end,
       s.converted_rep_user_id,
       'DEMO_KELLY_RECRUIT rep:Kelly Caffee',
       'rep_recruit'
  from seed_rows s
 where not exists (
   select 1 from public.outreach_engagement_events
    where sent_by = 'c0ffee00-0000-0000-0000-000000000001'::uuid
      and source_context = 'DEMO_KELLY_RECRUIT rep:Kelly Caffee'
 );

commit;

notify pgrst, 'reload schema';

-- ── Verify (paste-friendly) ──────────────────────────────────────────────
-- Should return 8 recruit events for Kelly after first apply:
--
-- select count(*) from public.outreach_engagement_events
--  where sent_by = 'c0ffee00-0000-0000-0000-000000000001'::uuid
--    and purpose = 'rep_recruit';
--
-- Confirm both converted rows stamped converted_rep_user_id:
--
-- select recipient_first_name, converted_rep_user_id
--   from public.outreach_engagement_events
--  where source_context = 'DEMO_KELLY_RECRUIT rep:Kelly Caffee'
--    and converted_at is not null;
--
-- Confirm Kelly's downstream count is 7 (5 original + 2 new Tier-1):
--
-- select count(*) from public.rep_affiliations
--  where parent_rep_id = 'c0ffee00-0000-0000-0000-000000000001'::uuid
--    and active = true and tier_level = 1;

-- ═══════════════════════════════════════════════════════════════════════
-- BATCH G VERIFY
-- ═══════════════════════════════════════════════════════════════════════
select 'update_updated_at_column fn' as check_, count(*)::text as result from pg_proc where proname='update_updated_at_column' and pronamespace=(select oid from pg_namespace where nspname='public')
union all select 'app_role enum', count(*)::text from pg_type where typname='app_role'
union all select 'user_roles table', count(*)::text from information_schema.tables where table_schema='public' and table_name='user_roles'
union all select 'has_role fn', count(*)::text from pg_proc where proname='has_role' and pronamespace=(select oid from pg_namespace where nspname='public')
union all select 'new rep tables', count(*)::text from information_schema.tables where table_schema='public' and table_name in ('rep_accounts','rep_affiliations','rep_commission_ledger','rep_referral_links')
union all select 'kelly user exists', count(*)::text from auth.users where email='kelly@refill-demo.test'
union all select 'maria user exists', count(*)::text from auth.users where email='maria@refill-demo.test'
union all select 'total public tables', count(*)::text from information_schema.tables where table_schema='public';
