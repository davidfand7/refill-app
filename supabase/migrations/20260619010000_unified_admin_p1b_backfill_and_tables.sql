-- v1.22.1 (P1 of unified admin platform sequence) — backfill user_roles
-- from sibling sources + create feature_flags + admin_audit_log tables.
--
-- Per plan in ~/.claude/plans/frolicking-stargazing-church.md.
--
-- PRECONDITION: 20260619000000_unified_admin_p1a_app_role_expansion.sql
-- must have run first (in its own commit) so the new enum values
-- ('spa_owner', 'rep', 'sub_rep', 'developer') are visible.
--
-- WHAT THIS DOES:
--   (1) Backfills user_roles from tenant_memberships → spa_owner
--   (2) Backfills user_roles from rep_accounts (active) → rep
--   (3) Backfills user_roles from user_preferences (primary_role='developer') → developer
--   (4) Creates public.feature_flags table (Layer E)
--   (5) Creates public.admin_audit_log table
--   (6) Logs this migration's own backfill action to admin_audit_log
--
-- ZERO USER-VISIBLE CHANGE: no consumers read from the new role rows in
-- P1. P2 will cut consumers over to a getEffectiveRoles helper. P1 just
-- lays the substrate.
--
-- IDEMPOTENT: all inserts use ON CONFLICT DO NOTHING; tables use IF NOT
-- EXISTS. Safe to re-run.

-- ─── (1) Backfill spa_owner from tenant_memberships ──────────────────────
-- Every existing tenant_memberships row implies the user is a spa owner.
-- tenant_memberships.role is open text (default 'owner') with no CHECK,
-- so we treat every membership as spa_owner status. Over-grants are
-- revocable from the future P4 admin UI; net new tenants will get their
-- spa_owner role row written via the same flow tenant_memberships uses.
insert into public.user_roles (user_id, role)
  select distinct user_id, 'spa_owner'::public.app_role
  from public.tenant_memberships
  on conflict (user_id, role) do nothing;

-- ─── (2) Backfill rep from rep_accounts where status='active' ────────────
-- Paused or terminated reps intentionally NOT granted the rep role.
insert into public.user_roles (user_id, role)
  select rep_user_id, 'rep'::public.app_role
  from public.rep_accounts
  where status = 'active'
  on conflict (user_id, role) do nothing;

-- ─── (3) Backfill developer from user_preferences ────────────────────────
-- The 'developer' value in user_preferences.primary_role becomes a real
-- user_roles entry. (admin@refill-demo.test currently has primary_role=
-- 'developer' per v417_admin_testing_identity migration.)
insert into public.user_roles (user_id, role)
  select user_id, 'developer'::public.app_role
  from public.user_preferences
  where primary_role = 'developer'
  on conflict (user_id, role) do nothing;

-- ─── (4) Feature flags table (Layer E from discovery doc) ────────────────
-- Single read API will be isFeatureEnabled(flagKey, { tenantId?, userId?, repId? })
-- in P5; scope walk order user > tenant > rep > global, first hit wins.
-- D8 lock: spa-owner Advanced UI and admin feature-flag UI manipulate the
-- SAME rows. Spa-owner writes scope=tenant; admin writes scope=global or
-- any scope.
create table if not exists public.feature_flags (
  id          uuid primary key default gen_random_uuid(),
  flag_key    text not null,
  scope       text not null check (scope in ('global','tenant','user','rep')),
  scope_id    uuid,
  enabled     boolean not null default false,
  metadata    jsonb default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id) on delete set null,
  unique (flag_key, scope, scope_id)
);

create index if not exists feature_flags_flag_key_idx on public.feature_flags(flag_key);
create index if not exists feature_flags_scope_idx on public.feature_flags(scope, scope_id);

alter table public.feature_flags enable row level security;

drop policy if exists feature_flags_admin_all on public.feature_flags;
create policy feature_flags_admin_all on public.feature_flags
  for all
  using (public.has_role(auth.uid(), 'admin'::public.app_role))
  with check (public.has_role(auth.uid(), 'admin'::public.app_role));

drop policy if exists feature_flags_service_role on public.feature_flags;
create policy feature_flags_service_role on public.feature_flags
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- ─── (5) Admin audit log table ───────────────────────────────────────────
-- Records every privileged admin action: role grants/revokes (P4),
-- feature flag toggles (P5), persona-switch start/stop (if/when compliance
-- requires; P3 doesn't write here by default).
create table if not exists public.admin_audit_log (
  id              uuid primary key default gen_random_uuid(),
  actor_user_id   uuid references auth.users(id) on delete set null,
  acted_at        timestamptz not null default now(),
  action          text not null,
  target_user_id  uuid references auth.users(id) on delete set null,
  target_tenant_id uuid,
  payload         jsonb default '{}'::jsonb
);

create index if not exists admin_audit_log_acted_at_idx on public.admin_audit_log(acted_at desc);
create index if not exists admin_audit_log_actor_idx on public.admin_audit_log(actor_user_id);
create index if not exists admin_audit_log_target_user_idx on public.admin_audit_log(target_user_id);

alter table public.admin_audit_log enable row level security;

drop policy if exists admin_audit_log_admin_read on public.admin_audit_log;
create policy admin_audit_log_admin_read on public.admin_audit_log
  for select
  using (public.has_role(auth.uid(), 'admin'::public.app_role));

drop policy if exists admin_audit_log_service_role on public.admin_audit_log;
create policy admin_audit_log_service_role on public.admin_audit_log
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- ─── (6) Log this migration's own backfill for traceability ──────────────
insert into public.admin_audit_log (actor_user_id, action, payload)
  select id,
         'p1.role.backfill',
         jsonb_build_object(
           'migration','20260619010000_unified_admin_p1b_backfill_and_tables',
           'note','Initial backfill of expanded app_role values from tenant_memberships, rep_accounts, user_preferences.'
         )
  from auth.users
  where email = 'admin@refill-demo.test'
  limit 1;

notify pgrst, 'reload schema';

-- Verify (paste after running):
--
-- (a) Backfill rollup:
--   select role::text, count(*)
--   from public.user_roles
--   group by role::text
--   order by role::text;
-- Expected: admin (>=2), spa_owner (>=1 — Karen), rep (>=1 — Kelly+Maria),
--           developer (>=1 — admin@refill-demo.test), member (whatever existed).
--
-- (b) Karen + davidfand303 + admin@refill-demo.test role rollup:
--   select u.email, array_agg(ur.role::text order by ur.role::text) as roles
--   from auth.users u
--   left join public.user_roles ur on ur.user_id = u.id
--   where u.email in ('davidfand303@gmail.com', 'admin@refill-demo.test')
--      or u.email like 'karen%'
--   group by u.email
--   order by u.email;
--
-- (c) Tables exist and are RLS-enabled:
--   select relname, relrowsecurity
--   from pg_class
--   where relname in ('feature_flags','admin_audit_log');
-- Expected: both rows, relrowsecurity = true.
--
-- (d) P1 self-log entry:
--   select action, payload->>'migration'
--   from public.admin_audit_log
--   where action = 'p1.role.backfill';
-- Expected: one row, payload value matches this file's name.
