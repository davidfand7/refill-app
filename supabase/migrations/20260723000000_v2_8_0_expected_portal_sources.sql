-- v2.8.0 — Expected portal sources (the first real "gate"; Connection Health).
--
-- THE GAP this closes (feedback_connection_health_doctrine + the trusted-
-- onboarding deep-dive, project_trusted_onboarding): Connection Health derives
-- every reward-portal row from reward_signal_imports — i.e. from data that has
-- ALREADY arrived. So a portal a spa set up but that has NEVER successfully
-- imported (login wrong from day one, agent never ran) writes NO row, and
-- therefore never appears on the health page AT ALL. "Absence is the signal"
-- only works if there was ever a presence. The scariest version of the silent
-- failure the whole surface exists to catch — a scared owner who set up Allē,
-- got the login wrong, and sees *nothing* — is itself invisible.
--
-- The fix is a source-of-truth for what the spa EXPECTS to flow. With it, the
-- read model can union (expected) against (actually imported): an expected-but-
-- never-imported portal renders honestly as "Setting up", and — because we now
-- know WHEN it was expected to start — its silence ages into "Needs attention"
-- once the first pull is overdue. The first import never landing becomes a
-- visible, fixable card instead of a void.
--
-- This is also the first concrete instance of the trusted-onboarding "gate"
-- primitive: declaring an expected portal = demonstrate → she verifies on the
-- health page → she fixes the login → it unlocks (data flows). One row per
-- (tenant, manufacturer); toggling enabled is the latch.

create table if not exists public.expected_portal_sources (
  id              uuid        primary key default gen_random_uuid(),
  user_id         uuid        not null references auth.users(id) on delete cascade,
  -- canonical manufacturer key, lowercase: 'allergan' | 'galderma' | 'evolus'
  -- (matches the keys used by reward_signal_imports + PORTAL_DISPLAY).
  manufacturer    text        not null,
  -- optional display override; null = derive from PORTAL_DISPLAY.
  label           text,
  -- when the spa declared they expect this portal to flow. The anchor the
  -- freshness check ages a never-arrived first import against.
  expected_since  timestamptz not null default now(),
  -- toggle off to stop expecting (and stop flagging) without losing history.
  enabled         boolean     not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- One expectation row per (tenant, manufacturer); re-declaring just re-enables.
create unique index if not exists expected_portal_sources_user_mfr
  on public.expected_portal_sources (user_id, manufacturer);

-- Fast per-tenant read for the health dashboard.
create index if not exists expected_portal_sources_user_idx
  on public.expected_portal_sources (user_id)
  where enabled;

alter table public.expected_portal_sources enable row level security;

do $$ begin
  create policy "service_role_expected_portal_sources"
    on public.expected_portal_sources for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "users_read_own_expected_portal_sources"
    on public.expected_portal_sources for select
    using (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

notify pgrst, 'reload schema';

-- Verify: table is empty + ready.
select count(*) as expected_portal_count from public.expected_portal_sources;
