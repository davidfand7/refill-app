-- v1.44.2 — Nav-features registry + per-tenant overrides.
--
-- Same architectural pattern as v1.34.3's agent_defaults + per-tenant
-- agent overrides, applied to nav visibility. Admin can flip global
-- defaults on/off + override per-tenant from /app/admin/nav-features.
--
-- Why: per project_customer_as_developer_access + feedback_stealth_first_doctrine,
-- we want to ship features and enable them per-tenant (starting with Rejuv
-- as Refill's first customer) without bloating every tenant's nav. The
-- v1.44.1 Discoverability Sweep made always-on features visible; this ship
-- makes opt-in features admin-controllable.
--
-- Tables:
--   public.nav_features         — global registry (feature_key PK)
--   public.tenant_nav_overrides — per-tenant overrides (tenant_id + feature_key PK)
--
-- RLS:
--   nav_features        — world-readable for authenticated (so RefillNav can resolve)
--   tenant_nav_overrides — readable by tenant members + admins; writes via service role only
--
-- Seed: nav.campaigns (Promotions Engine Phase 1) default_visible=false.
--   Admin flips it on for Rejuv via the admin UI as the proof-of-pattern.

create table if not exists public.nav_features (
  feature_key text primary key,
  label text not null,
  description text,
  persona text not null check (persona in ('spa', 'rep', 'admin')),
  default_visible boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.tenant_nav_overrides (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  feature_key text not null references public.nav_features(feature_key) on delete cascade,
  visible boolean not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  primary key (tenant_id, feature_key)
);

create index if not exists tenant_nav_overrides_tenant_id_idx
  on public.tenant_nav_overrides (tenant_id);

alter table public.nav_features enable row level security;
alter table public.tenant_nav_overrides enable row level security;

-- Registry: any authenticated user can read (RefillNav + RefillHome resolve
-- per-page-load; cheap; no PII).
drop policy if exists "nav_features readable by authenticated" on public.nav_features;
create policy "nav_features readable by authenticated"
  on public.nav_features
  for select
  to authenticated
  using (true);
-- Writes: no policy → service role only (admin server fns)

-- Overrides: readable by tenant members + admins.
drop policy if exists "tenant_nav_overrides readable by tenant or admin" on public.tenant_nav_overrides;
create policy "tenant_nav_overrides readable by tenant or admin"
  on public.tenant_nav_overrides
  for select
  to authenticated
  using (
    tenant_id in (
      select tenant_id from public.tenant_memberships where user_id = auth.uid()
    )
    or exists (
      select 1 from public.user_roles where user_id = auth.uid() and role = 'admin'
    )
  );
-- Writes: no policy → service role only

-- Seed: Campaigns marketing-blast composer (~1,500 LOC Promotions Engine
-- Phase 1, lived as orphan since v355-v360 per the 2026-06-03 audit).
-- default_visible=false so it stays hidden by default; admin flips it on
-- per-tenant as the first opt-in. Rejuv gets it first.
insert into public.nav_features (feature_key, label, description, persona, default_visible)
values (
  'nav.campaigns',
  'Campaigns',
  'Manual blast composer for marketing emails to patient cohorts. Complements the automated Agents (Preshow/Rescue/Attribution/Recognition). Use when you want to push a specific message to a specific cohort right now (e.g., "Botox promo this weekend, send to all my botox patients").',
  'spa',
  false
)
on conflict (feature_key) do nothing;

-- Notify PostgREST to pick up the new tables immediately (otherwise the
-- API returns "relation does not exist" for ~30s after dashboard apply).
notify pgrst, 'reload schema';

-- Verify (run after apply):
-- select feature_key, label, persona, default_visible from public.nav_features order by feature_key;
-- select count(*) from public.tenant_nav_overrides;
