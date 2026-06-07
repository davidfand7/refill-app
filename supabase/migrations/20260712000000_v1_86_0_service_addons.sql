-- v1.86.0 — Service add-ons (P1 schema).
-- ─────────────────────────────────────────────────────────────────────────────
-- An add-on is a normal service flagged is_addon, attached to the base services
-- it's offered with (service_addons). At booking, chosen add-ons EXTEND the
-- visit: appointment duration = base + Σ(add-on durations), price = base +
-- add-ons, one provider, one visit. appointment_addons snapshots the selection
-- so historical bookings stay accurate if the add-on later changes.

-- 1. Flag a service as offerable as an add-on (can also be standalone-bookable,
--    or add-on-only when online_bookable = false).
alter table public.services
  add column if not exists is_addon boolean not null default false;

-- 2. Eligibility: which add-ons a base service offers, in display order.
create table if not exists public.service_addons (
  id               uuid        primary key default gen_random_uuid(),
  tenant_id        uuid        not null references public.tenants(id) on delete cascade,
  service_id       uuid        not null references public.services(id) on delete cascade,
  addon_service_id uuid        not null references public.services(id) on delete cascade,
  sort_order       integer     not null default 0,
  created_at       timestamptz not null default now(),
  unique (service_id, addon_service_id),
  -- A service can't be an add-on of itself.
  check (service_id <> addon_service_id)
);

create index if not exists service_addons_base_idx
  on public.service_addons (tenant_id, service_id, sort_order);

alter table public.service_addons enable row level security;
do $$ begin
  create policy "service_role_service_addons"
    on public.service_addons for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

-- 3. Snapshot of add-ons chosen on a booking (price/min frozen at booking time).
create table if not exists public.appointment_addons (
  id               uuid        primary key default gen_random_uuid(),
  appointment_id   uuid        not null references public.emma_appointments(id) on delete cascade,
  addon_service_id uuid        references public.services(id) on delete set null,
  name             text        not null,
  price            numeric     not null default 0,
  duration_min     integer     not null default 0,
  created_at       timestamptz not null default now()
);

create index if not exists appointment_addons_appt_idx
  on public.appointment_addons (appointment_id);

alter table public.appointment_addons enable row level security;
do $$ begin
  create policy "service_role_appointment_addons"
    on public.appointment_addons for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

notify pgrst, 'reload schema';

-- Verify (run after applying):
-- select count(*) from public.service_addons;
-- select count(*) from public.appointment_addons;
-- select name, is_addon from public.services where is_addon limit 10;
