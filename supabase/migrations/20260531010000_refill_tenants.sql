-- v387: Refill tenants infrastructure (Phase 1.5)
--
-- Two new tables that establish the multi-tenant boundary for Refill spas:
--
--   tenants            — one row per spa. Owns the URL slug, the trial
--                        window, and (later) the billing plan. Slug is
--                        unique across the platform — the constraint
--                        below is what makes `<slug>.getrefill.app`
--                        uniquely resolvable.
--
--   tenant_memberships — joins auth.users to tenants. For Phase 1.5 a
--                        user has exactly one membership (role='owner').
--                        Future shipped phases may add staff/admin roles
--                        per spa, hence the role column being open-ended
--                        rather than a boolean.
--
-- No RLS policies in this migration — all access flows through server
-- functions using the service-role key. Phase 4 (full multi-tenant data
-- propagation across spa-scoped tables) will add row-level enforcement
-- per table. For now keeping RLS-default-deny is the conservative posture.
--
-- The trial_ends_at default of created_at + 30 days encodes the
-- "free 30-day trial" copy from the wizard. plan defaults to 'trial'
-- so the billing engine (Phase 1.6) can stage transitions from
-- 'trial' → 'starter' / 'pro' without any pre-existing nulls to
-- defensively handle.

create table if not exists public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null,
  created_at timestamptz not null default now(),
  trial_starts_at timestamptz not null default now(),
  trial_ends_at timestamptz not null default (now() + interval '30 days'),
  payment_method_added_at timestamptz,
  plan text not null default 'trial'
);

-- Case-insensitive uniqueness via lower(slug). Reserved-slug rejection
-- already lives in src/lib/product-context.ts (isReservedSlug); the DB
-- constraint here guards the race-condition window between the wizard's
-- availability check and the claim insert.
create unique index if not exists tenants_slug_unique_idx
  on public.tenants (lower(slug));

create table if not exists public.tenant_memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'owner',
  created_at timestamptz not null default now(),
  unique (tenant_id, user_id)
);

-- "What tenants does this user belong to" — hot path on every authed
-- Refill request once tenant resolution is wired (Phase 4). Cheap to
-- maintain; carve it now while the table is empty.
create index if not exists tenant_memberships_user_id_idx
  on public.tenant_memberships (user_id);

notify pgrst, 'reload schema';

-- Verify (paste-friendly):
-- select table_name, column_name, data_type
--   from information_schema.columns
--  where table_schema = 'public'
--    and table_name in ('tenants', 'tenant_memberships')
--  order by table_name, ordinal_position;
