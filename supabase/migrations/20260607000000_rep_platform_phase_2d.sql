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
