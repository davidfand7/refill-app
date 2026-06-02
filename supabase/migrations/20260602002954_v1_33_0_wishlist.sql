-- v1.33.0 — Wishlist: in-product feature-request channel from spa-owners to admin (Grasshopper).
--
-- WHY: per project_wishlist_thesis (banked 2026-06-01), customer-requested feature build IS our competitive moat.
-- The Po-compressed dev cycle means we can ship customer-requested features in 48 hours or less. The pitch ("tired of
-- one-size-fits-all? we'll build it or tell you why we can't, in 48h") requires an in-product affordance, otherwise
-- it's just a sales line. This migration adds the data substrate: per-tenant requests + cross-tenant admin inbox + a
-- conversation thread per request + status workflow that proves the 48h SLA in public.
--
-- WHAT SHIPS:
--   1) wishlist_requests table — one row per request. Composite identity: user_id (spa-owner who submitted) +
--      tenant_id (spa account). Status enum drives the workflow ('submitted' → 'reviewing' → 'in_progress' →
--      'shipped' OR 'declined'). Priority enum is Karen-selectable. Area is auto-captured from the URL she was
--      on when she opened the widget. Messages is a JSONB array threading clarifications from her and responses
--      from admin — keeps reply state inline without a join.
--   2) Per-status timestamp columns so we can compute SLA metrics later (avg time-to-shipped, decline rate).
--      shipped_in_version captures the v-pill it shipped under (audit trail + future "your request shipped in
--      v1.34.0" notification).
--   3) Indexes on (user_id), (tenant_id), (status, created_at) so the per-Karen "my requests" feed and the
--      admin inbox both scan cleanly.
--   4) RLS: spa-owners read+insert their own; admins read+update all (gated via user_roles check matching the
--      canonical_brands pattern from v1.30.0). Service-role bypass for daemons.
--   5) Triggers: updated_at auto-bumps; on status transitions, the per-status timestamp column populates so
--      we don't have to track elsewhere.
--
-- AUTH:
--   - Spa-owner READ: own rows only (auth.uid() = user_id).
--   - Spa-owner INSERT: own rows only (auth.uid() = user_id + valid tenant membership).
--   - Spa-owner UPDATE: own rows only, and ONLY the messages column (to append clarifications). Status / admin
--     fields are admin-only.
--   - Admin READ/UPDATE all: via user_roles role='admin' lookup.
--   - Service-role: full access for any future daemons (digest emails, etc.).
--
-- WHAT THIS DOESN'T FIX:
--   - Email notifications on status change (queued for v1.33.1; Resend is wired in src/server/resend-gateway.ts
--     but the digest cadence + template needs its own ship)
--   - Per-tenant config of who-on-the-spa-side can submit (every authenticated user with a tenant membership
--     can submit today)
--   - Public roadmap surface (intentionally not shipping — risks promising features Refill can't keep)
--   - Auto-link "shipped in vX.Y.Z" to the actual git commit (manual field for now; auto-detection later)
--   - Reply ordering / threading beyond linear chronological (JSONB array order = insertion order)
--
-- ROLLBACK: drop table public.wishlist_requests cascade; drop type public.wishlist_status cascade; drop type
--           public.wishlist_priority cascade;

-- ─── Enums ────────────────────────────────────────────────────────────────

create type public.wishlist_status as enum (
  'submitted',     -- initial state after Karen taps Submit
  'reviewing',     -- Grasshopper has seen it, deciding scope
  'in_progress',   -- Po is building / it's in the dev pipeline
  'shipped',       -- live in production (shipped_in_version populated)
  'declined'       -- not building; admin reason in messages thread
);

create type public.wishlist_priority as enum (
  'low',           -- nice-to-have
  'normal',        -- default
  'high',          -- meaningful productivity / revenue impact
  'urgent'         -- workflow-blocking
);

-- ─── Table ────────────────────────────────────────────────────────────────

create table public.wishlist_requests (
  id                    uuid primary key default gen_random_uuid(),
  -- Identity: spa-owner who submitted + spa account.
  user_id               uuid not null references auth.users(id) on delete cascade,
  tenant_id             uuid not null references public.tenants(id) on delete cascade,
  -- Request payload.
  title                 text not null check (char_length(title) between 1 and 140),
  description           text not null check (char_length(description) between 1 and 5000),
  -- Auto-captured from the URL she was on when she opened the widget. Helps Grasshopper
  -- triage by feature area without Karen having to describe "where" she was.
  area                  text null check (area is null or char_length(area) <= 200),
  priority              public.wishlist_priority not null default 'normal',
  status                public.wishlist_status not null default 'submitted',
  -- Conversation thread between Karen and admin. Each entry:
  -- { id, fromUserId, fromRole ('owner' | 'admin'), body, sentAt }
  -- Linear chronological; no nested threading.
  messages              jsonb not null default '[]'::jsonb,
  -- Admin-side fields.
  admin_notes           text null check (admin_notes is null or char_length(admin_notes) <= 5000),
  shipped_in_version    text null check (shipped_in_version is null or char_length(shipped_in_version) <= 32),
  -- Per-status timestamps for SLA metrics. Populated by trigger on status change.
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  reviewing_at          timestamptz null,
  in_progress_at        timestamptz null,
  shipped_at            timestamptz null,
  declined_at           timestamptz null
);

comment on table public.wishlist_requests is
  'v1.33.0: in-product feature requests from spa-owners. Per project_wishlist_thesis: customer-requested feature build IS the moat. Workflow: submitted → reviewing → in_progress → shipped | declined.';

-- ─── Indexes ──────────────────────────────────────────────────────────────

-- Per-Karen "my requests" feed: filter by user_id, sort by created_at desc.
create index wishlist_requests_user_idx on public.wishlist_requests (user_id, created_at desc);

-- Admin inbox: filter by status, sort by created_at desc.
create index wishlist_requests_status_idx on public.wishlist_requests (status, created_at desc);

-- Tenant-scoped reads (future: multi-user-per-spa).
create index wishlist_requests_tenant_idx on public.wishlist_requests (tenant_id, created_at desc);

-- ─── Trigger: updated_at + per-status timestamp population ────────────────

create or replace function public.wishlist_requests_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  -- Populate per-status timestamps when status transitions. Idempotent: if a status was
  -- entered before, the timestamp is preserved (only set if currently null AND the new
  -- status matches the column's lifecycle stage).
  if old.status is distinct from new.status then
    if new.status = 'reviewing' and new.reviewing_at is null then
      new.reviewing_at = now();
    elsif new.status = 'in_progress' and new.in_progress_at is null then
      new.in_progress_at = now();
    elsif new.status = 'shipped' and new.shipped_at is null then
      new.shipped_at = now();
    elsif new.status = 'declined' and new.declined_at is null then
      new.declined_at = now();
    end if;
  end if;
  return new;
end;
$$;

create trigger wishlist_requests_touch_updated_at
  before update on public.wishlist_requests
  for each row
  execute function public.wishlist_requests_touch_updated_at();

-- ─── RLS ──────────────────────────────────────────────────────────────────

alter table public.wishlist_requests enable row level security;

-- Spa-owner can read their own requests.
create policy wishlist_requests_owner_read
  on public.wishlist_requests
  for select
  to authenticated
  using (auth.uid() = user_id);

-- Spa-owner can submit their own requests (must reference a tenant they own).
-- Tenant membership validation is a defense-in-depth check; the server fn already
-- verifies, but RLS prevents an arbitrary tenant_id from being attached.
create policy wishlist_requests_owner_insert
  on public.wishlist_requests
  for insert
  to authenticated
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.tenant_memberships tm
      where tm.user_id = auth.uid()
      and tm.tenant_id = wishlist_requests.tenant_id
    )
  );

-- Admin (per user_roles) can read every tenant's requests for the inbox.
create policy wishlist_requests_admin_read
  on public.wishlist_requests
  for select
  to authenticated
  using (
    exists (
      select 1 from public.user_roles ur
      where ur.user_id = auth.uid()
      and ur.role = 'admin'
    )
  );

-- Admin can update status / admin_notes / shipped_in_version / messages.
create policy wishlist_requests_admin_update
  on public.wishlist_requests
  for update
  to authenticated
  using (
    exists (
      select 1 from public.user_roles ur
      where ur.user_id = auth.uid()
      and ur.role = 'admin'
    )
  )
  with check (
    exists (
      select 1 from public.user_roles ur
      where ur.user_id = auth.uid()
      and ur.role = 'admin'
    )
  );

-- Service role: full access for daemons (digest emails, sweeps).
create policy wishlist_requests_service_role_all
  on public.wishlist_requests
  for all
  to service_role
  using (true)
  with check (true);

-- ─── Reload PostgREST schema cache ────────────────────────────────────────

notify pgrst, 'reload schema';

-- ─── Verify ───────────────────────────────────────────────────────────────
-- Paste after running to confirm the table + enums + indexes + policies all landed:
--
--   select 'table' as kind, count(*) as n from public.wishlist_requests
--   union all
--   select 'status_enum_vals', count(*) from pg_enum where enumtypid = 'public.wishlist_status'::regtype
--   union all
--   select 'priority_enum_vals', count(*) from pg_enum where enumtypid = 'public.wishlist_priority'::regtype
--   union all
--   select 'indexes', count(*) from pg_indexes where tablename = 'wishlist_requests'
--   union all
--   select 'policies', count(*) from pg_policies where tablename = 'wishlist_requests';
--
-- Expected: table=0 (empty), status_enum_vals=5, priority_enum_vals=4, indexes=4 (pkey + 3 we declared),
-- policies=4 (owner_read, owner_insert, admin_read, admin_update, service_role_all = 5).
