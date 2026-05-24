-- Stage 1 of vertical breakout (Option C subdomain shell — see
-- project_vertical_breakout_locked memory). primary_role is a per-user pref
-- that drives shell + sidebar selection: 'spa-owner' → just /app/karen,
-- 'rep' → /app/liz + /app/liz/accounts, 'developer' or NULL → full platform.
--
-- Stamped automatically: 'spa-owner' on first successful claim via
-- /claim-your-business, 'rep' on first message sent through /app/liz.
-- Stamps only fire when the row is missing or primary_role is NULL — an
-- existing role is never silently overwritten by an auto-hook (a rep who
-- later claims their own spa keeps 'rep' until they manually opt to switch).
--
-- One-row-per-user (PK on user_id) — no history, no audit. Roles are
-- expected to be sticky. If history matters later, a separate
-- user_role_changes table captures it without changing this table's shape.
--
-- 'developer' is the explicit-platform value (admins, dogfooders who want
-- the full sidebar back after a stamp). NULL row (or no row at all) is
-- also "full platform" — meaning Stage 1 ships with zero backfill required.
-- Existing users see today's UX unchanged; Karen Aslakson + Liz get stamped
-- automatically on their first claim/liz-chat going forward.

create table if not exists public.user_preferences (
  user_id      uuid        primary key references auth.users(id) on delete cascade,
  primary_role text        check (primary_role in ('spa-owner','rep','developer')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.user_preferences enable row level security;

-- Owner can read their own row. (Sidebar render needs it client-side.)
do $$ begin
  create policy "user_preferences_self_read"
    on public.user_preferences for select
    using (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

-- Owner can update their own row — e.g., a future Settings UI lets a user
-- flip themselves between roles. Insert is service-role only: auto-stamping
-- happens inside server fns where we already hold a verified userId, so
-- there's no path that needs anon-INSERT.
do $$ begin
  create policy "user_preferences_self_update"
    on public.user_preferences for update
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "user_preferences_service_role"
    on public.user_preferences for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;
