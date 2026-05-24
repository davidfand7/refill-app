-- Cleave fix 2026-05-24 — port two trigger helper functions.
--
-- Both functions do the same thing (auto-bump updated_at on row updates)
-- but were defined under different names in different Agentiport
-- bootstrap migrations:
--   - set_updated_at()         — 20260421100000_v4_all_features
--   - update_updated_at_column() — 20260417232733_*-* (earliest bootstrap)
--
-- Neither of those bootstrap migrations are ported to refill-app. This
-- file defines both names so every Refill migration that references
-- either function resolves cleanly.
--
-- References:
--   - set_updated_at         — 12 refs across emma_*, batch C+D
--   - update_updated_at_column — 1 ref in rep_platform_foundation (batch G)
--
-- Slotted at 20260515999999 to land BEFORE the first Refill migration
-- that references either (20260516000000_emma_sender_domains).

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create or replace function public.update_updated_at_column()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ─── Identity & roles infrastructure ──────────────────────────────────────
-- The app_role enum + user_roles table + has_role() function are foundational
-- identity primitives defined in the 20260417232733 Agentiport bootstrap
-- migration. Refill consumers:
--   - rep_platform_foundation (batch G) — has_role() in RLS policies
--   - v417_admin_personas (batch H) — INSERT INTO user_roles
--   - v417_admin_testing_identity (batch H) — INSERT INTO user_roles

create type public.app_role as enum ('admin', 'member');

create table if not exists public.user_roles (
  id          uuid not null default gen_random_uuid() primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        public.app_role not null default 'member',
  created_at  timestamptz not null default now(),
  unique (user_id, role)
);

alter table public.user_roles enable row level security;

create policy "users_read_own_roles" on public.user_roles
  for select using (auth.uid() = user_id);

create policy "service_role_user_roles" on public.user_roles
  for all using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_roles
    where user_id = _user_id and role = _role
  )
$$;
