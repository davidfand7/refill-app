-- v1.26.10 — persistent log of reliability tier-sweep runs.
--
-- v1.26.9 shipped the "Recompute now" button + a transient toast
-- ("X patients · N tier transitions"). The freshness card on the
-- A-list rules page can only show `Last computed: <time>` because
-- the result of the sweep itself isn't persisted anywhere — once
-- the toast fades, the user has no surface for "what did the last
-- sweep actually do?"
--
-- Worse: the v1.26.9 freshness query sources `latestRecomputedAt`
-- from `max(recomputed_at)` across emma_reliability_status rows,
-- which is only updated for rows whose TIER changed (step 5 of the
-- bulk recompute). So a sweep with 0 transitions doesn't move the
-- timestamp at all, and the card stays stuck on the last sweep
-- that DID transition someone. Confusing for "did the cron run?"
--
-- Fix: log every sweep into a tiny runs table. One row per
-- recomputeReliabilityForUser call. Freshness card now reads
-- "Last computed: <time> · X patients · N tier transitions" from
-- the most recent run row, regardless of whether transitions
-- happened. Cron sweeps and manual button clicks both write here;
-- a `trigger` column distinguishes the two for future debugging.

create table if not exists public.emma_reliability_runs (
  id                      uuid        primary key default gen_random_uuid(),
  user_id                 uuid        not null references auth.users(id) on delete cascade,

  -- When the sweep finished (set by the application, not now()
  -- default — recomputeReliabilityForUser computes its own ISO
  -- timestamp at the same instant it stamps recomputed_at on
  -- changed rows, so the two stay aligned).
  completed_at            timestamptz not null,

  -- Result of the sweep.
  patients_recomputed     int         not null default 0,
  transitions             int         not null default 0,

  -- How the sweep was kicked off. Lets us tell apart "cron silent
  -- failure" from "user clicked Recompute now" in audit later.
  trigger                 text        not null
                          check (trigger in ('cron', 'manual')),

  created_at              timestamptz not null default now()
);

alter table public.emma_reliability_runs enable row level security;

do $$ begin
  create policy "users_own_emma_reliability_runs"
    on public.emma_reliability_runs for all
    using  (auth.uid() = user_id)
    with check (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "service_role_emma_reliability_runs"
    on public.emma_reliability_runs for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

-- The freshness query is `select ... order by completed_at desc
-- limit 1 where user_id = $1` — covered by this composite.
create index if not exists emma_reliability_runs_by_user_idx
  on public.emma_reliability_runs (user_id, completed_at desc);

comment on table public.emma_reliability_runs is
  'One row per bulk reliability-tier sweep. Powers the "Last computed: X · Y patients · Z transitions" surface on the A-list rules page. Written by recomputeReliabilityForUser (both cron + manual paths).';

-- Tell PostgREST about the new table.
notify pgrst, 'reload schema';

-- Verify after paste:
--   select count(*) from public.emma_reliability_runs;
-- Should return 0 — table exists, no runs logged yet. The next
-- manual "Recompute now" click or overnight cron will populate it.
