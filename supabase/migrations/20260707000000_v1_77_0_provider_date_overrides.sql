-- v1.77.0 — Per-provider date-specific availability overrides.
-- ─────────────────────────────────────────────────────────────────────────────
-- Overrides the recurring weekly scheduling_hours for a SINGLE calendar date for
-- one provider: either CLOSED that day, or DIFFERENT open/close wall-clock times
-- (e.g. "Michelle works 10–2 only on Jul 3", or "closed Jul 4").
--   • the_date  = calendar date in the tenant's timezone (no time component)
--   • open_time / close_time = wall-clock times in the tenant tz (NULL when closed)
-- The slot engine consults these FIRST and falls back to weekly hours when no
-- override exists for a date. One-off blocks (scheduling_blocks) still handle
-- partial-day time-off; this table is for whole-day open/close changes.

create table if not exists public.scheduling_date_overrides (
  id          uuid        primary key default gen_random_uuid(),
  provider_id uuid        not null references public.scheduling_providers(id) on delete cascade,
  the_date    date        not null,
  is_closed   boolean     not null default false,
  open_time   time,
  close_time  time,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- One override row per provider per date.
  unique (provider_id, the_date),
  -- Closed day carries no times; an open day has both, open before close.
  check (
    (is_closed and open_time is null and close_time is null)
    or (not is_closed and open_time is not null and close_time is not null and open_time < close_time)
  )
);

create index if not exists scheduling_date_overrides_provider_idx
  on public.scheduling_date_overrides (provider_id, the_date);

alter table public.scheduling_date_overrides enable row level security;
do $$ begin
  create policy "service_role_scheduling_date_overrides"
    on public.scheduling_date_overrides for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

create trigger scheduling_date_overrides_set_updated_at
  before update on public.scheduling_date_overrides
  for each row execute function public.set_updated_at();

notify pgrst, 'reload schema';

-- Verify (run after applying):
-- select * from public.scheduling_date_overrides limit 5;
