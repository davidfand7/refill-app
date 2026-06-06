-- ════════════════════════════════════════════════════════════════════════════
-- v1.52.0 — Provider × Service map with inherit-by-default overrides (P2 spine)
-- ════════════════════════════════════════════════════════════════════════════
--
-- THE MODEL: per-provider duration / price is a DELTA, not a MODE.
--
--   • The `services` catalog stays the single source of truth. It already has
--     duration_min, buffer_min, service_price numeric(10,2), and cogs_per_service.
--   • This table records WHICH providers offer WHICH services (the map) AND, on
--     the same row, three NULLABLE override columns. NULL ⇒ inherit the service
--     value; a set value ⇒ this provider's override.
--   • Resolution everywhere is a single coalesce:
--       effective_duration = provider_service.duration_min ?? service.duration_min
--       effective_buffer   = provider_service.buffer_min   ?? service.buffer_min
--       effective_price    = provider_service.price        ?? service.service_price
--   • COGS is NOT overridable — cost is a property of the product, not the
--     provider. Margin = effective_price − service.cogs_per_service.
--
-- WHY: med spas genuinely price by provider (senior injector vs RN) and faster
-- providers run shorter appointments. Acuity can't model this; we can — and a
-- single-provider spa never sees an override field (the columns sit NULL).
--
-- This is additive and reversible: dropping the table loses only the map +
-- overrides; the catalog and all existing bookings are untouched.
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists public.scheduling_provider_services (
  id           uuid          primary key default gen_random_uuid(),
  provider_id  uuid          not null references public.scheduling_providers(id) on delete cascade,
  service_id   uuid          not null references public.services(id)             on delete cascade,
  -- Overrides. NULL = inherit the service's value (the common case).
  duration_min integer       check (duration_min is null or duration_min > 0),
  buffer_min   integer       check (buffer_min   is null or buffer_min  >= 0),
  price        numeric(10,2) check (price        is null or price       >= 0),
  created_at   timestamptz   not null default now(),
  updated_at   timestamptz   not null default now(),
  -- One row per provider per service (the map is a set).
  unique (provider_id, service_id)
);

-- provider → services they offer (loading a provider's catalog).
-- The unique (provider_id, service_id) index already serves provider_id-prefix
-- lookups; add the reverse direction for "which providers do THIS service"
-- (the "first available" union).
create index if not exists scheduling_provider_services_service_idx
  on public.scheduling_provider_services (service_id);

alter table public.scheduling_provider_services enable row level security;
do $$ begin
  create policy "service_role_scheduling_provider_services"
    on public.scheduling_provider_services for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

create trigger scheduling_provider_services_set_updated_at
  before update on public.scheduling_provider_services
  for each row execute function public.set_updated_at();

notify pgrst, 'reload schema';

-- ── Verify (run after applying) ──────────────────────────────────────────────
-- 1) Table + columns exist with the right nullability (overrides must be NULLABLE):
-- select column_name, data_type, is_nullable
--   from information_schema.columns
--  where table_schema = 'public' and table_name = 'scheduling_provider_services'
--  order by ordinal_position;
--   → duration_min / buffer_min / price must show is_nullable = 'YES'.
--
-- 2) The map uniqueness + the service index are present:
-- select indexname from pg_indexes
--  where schemaname = 'public' and tablename = 'scheduling_provider_services';
--
-- 3) RLS is on and the service_role policy exists:
-- select relrowsecurity from pg_class where oid = 'public.scheduling_provider_services'::regclass;
-- select polname from pg_policy where polrelid = 'public.scheduling_provider_services'::regclass;
