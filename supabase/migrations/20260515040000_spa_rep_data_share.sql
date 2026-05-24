-- Patient Architecture P4 — spa-rep aggregate consent.
--
-- The cross-tenant boundary between Emma(OS) and Lizzie(OS). Spas own all
-- patient data (RLS-enforced on knowledge_nodes + patient_transactions +
-- patient_contact_candidates), and reps NEVER see individual patient rows.
-- But spas may opt-in to share *aggregates* with specific reps they're
-- already working with — e.g. "Rejuv has 84 active Jeuveau patients" lets
-- the Evolus rep prioritize who to call without ever seeing a name.
--
-- Default is denied: a row missing from this table means no consent. Spas
-- grant per-rep; revocation is a flip of revoked_at, not a delete (so we
-- have an audit trail of "you used to share with me; you stopped on…").
--
-- Why a column-level RLS read policy for the rep:
--   The rep needs to discover "which spas have shared with me" without
--   being able to enumerate other reps' shares OR fish for spas who haven't
--   consented. The rep-read RLS row gate is (rep_user_id = auth.uid() AND
--   revoked_at IS NULL) — they see only their own currently-active grants.
--
-- Established 2026-05-15 (Patient Architecture P4).

create table if not exists public.spa_rep_data_share (
  id            uuid        primary key default gen_random_uuid(),
  spa_user_id   uuid        not null references auth.users(id) on delete cascade,
  rep_user_id   uuid        not null references auth.users(id) on delete cascade,
  -- 'aggregate' is the only level today. Future: 'cohort_lists' (named
  -- patient counts by cohort definition) or 'contact_pool' (consented
  -- patients' phone+email for rep-initiated outreach). Reserved as a
  -- string so adding levels doesn't churn schema.
  share_level   text        not null default 'aggregate',
  granted_at    timestamptz not null default now(),
  revoked_at    timestamptz,
  -- Optional spa-side note about WHY they're sharing — useful when reviewing
  -- the consent later ("granted during 2026-Q2 Evolus promo follow-up").
  spa_note      text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint spa_rep_data_share_unique unique (spa_user_id, rep_user_id),
  constraint spa_rep_data_share_level_check check (
    share_level in ('aggregate', 'cohort_lists', 'contact_pool')
  ),
  -- A row is either active (revoked_at NULL) or revoked (revoked_at set).
  -- Active grants must have a granted_at, revoked grants must have both.
  constraint spa_rep_data_share_timeline_check check (
    granted_at is not null
    and (revoked_at is null or revoked_at >= granted_at)
  )
);

alter table public.spa_rep_data_share enable row level security;

-- Spa side: full ownership of their own grants. The spa decides which reps
-- see what, when, and for how long.
do $$ begin
  create policy "spa_owns_data_share"
    on public.spa_rep_data_share for all
    using  (auth.uid() = spa_user_id)
    with check (auth.uid() = spa_user_id);
exception when duplicate_object then null;
end $$;

-- Rep side: read-only access to their own currently-active grants. Cannot
-- INSERT/UPDATE — only the spa can grant. Cannot read revoked grants
-- (defensive: avoids "the spa used to share but doesn't now" awkwardness).
do $$ begin
  create policy "rep_reads_active_shares"
    on public.spa_rep_data_share for select
    using  (auth.uid() = rep_user_id and revoked_at is null);
exception when duplicate_object then null;
end $$;

-- Service role: full access for the rep-side aggregate fn that has to
-- bypass RLS to compute counts against the spa's patient data.
do $$ begin
  create policy "service_role_data_share"
    on public.spa_rep_data_share for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

-- Lookup: rep's active grants, used when assembling the interest-signal
-- card's per-spa aggregate row.
create index if not exists spa_rep_data_share_by_rep_idx
  on public.spa_rep_data_share (rep_user_id)
  where revoked_at is null;

-- Lookup: spa's full grant history (for the sharing-management surface).
create index if not exists spa_rep_data_share_by_spa_idx
  on public.spa_rep_data_share (spa_user_id, granted_at desc);

-- Updated-at trigger so the spa-side UI can show "last touched X ago"
-- without server-side rewrites.
create or replace function public.touch_spa_rep_data_share()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end
$$;

drop trigger if exists trg_touch_spa_rep_data_share on public.spa_rep_data_share;
create trigger trg_touch_spa_rep_data_share
  before update on public.spa_rep_data_share
  for each row execute function public.touch_spa_rep_data_share();

comment on table public.spa_rep_data_share is
  'Spa-controlled consent for aggregate data sharing with specific reps. Default = absent = denied. Rep can read only their own currently-active grants (revoked_at IS NULL).';
