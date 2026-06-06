-- ════════════════════════════════════════════════════════════════════════
-- v1.48.0 — Smart Scheduling MVP: the spine
-- ════════════════════════════════════════════════════════════════════════
-- Native scheduler. 6 new tables + 2 table extensions + btree_gist EXCLUDE
-- constraints that make double-booking physically impossible at the DB layer.
--
-- ARCHITECTURE NOTES (read before changing anything):
--   • MVP renders ONE operator / ONE calendar, but the SCHEMA is architected
--     multi-provider + multi-room from day one. provider_id / resource_id are
--     first-class FKs; the EXCLUDE constraints are keyed PER-PROVIDER and
--     PER-ROOM (not per-tenant) so the no-double-book guarantee is already
--     multi-provider-correct the day a second provider is seeded. Going
--     multi-provider later = seed more rows, render more columns. No rewrite.
--   • HARD STOP at single-location: there is NO location_id and never will be.
--     tenant = location, 1:1, permanently.
--   • SCOPE SPLIT (discovered at build): emma_appointments is USER-scoped
--     (user_id -> auth.users), while services / scheduling_* are TENANT-scoped
--     (tenant_id -> tenants). scheduling_providers.user_id bridges the two: the
--     MVP's one provider maps to the owner's auth user, so a native booking can
--     stamp emma_appointments.user_id (NOT NULL) from the provider row.
--   • RLS posture matches the rest of Refill: service-role-only, no user
--     policies yet (Phase 4 will unify). All access is mediated by server fns
--     that gate on auth + tenant_memberships.
--   • updated_at is maintained by the global public.set_updated_at() trigger fn
--     (defined in 20260515999999_set_updated_at_function.sql).
-- ════════════════════════════════════════════════════════════════════════

begin;

-- btree_gist lets a GiST index mix equality (=) on a scalar (provider_id) with
-- range overlap (&&) on a tstzrange in a single EXCLUDE constraint. First use
-- of this extension in the codebase.
create extension if not exists btree_gist;

-- Immutable helper for the generated `during` range. Postgres's immutability
-- check for generated columns is conservative and rejects an inline
-- tstzrange(scheduled_at, scheduled_at + make_interval(...)) expression with
-- 42P17 ("generation expression is not immutable"). Wrapping it in an
-- IMMUTABLE-declared SQL function is the standard, correct fix: the body is
-- GENUINELY deterministic — a minutes-only interval added to a timestamptz is a
-- fixed absolute span, independent of session TimeZone / DateStyle — so the
-- IMMUTABLE declaration is honest and carries zero index-corruption risk.
create or replace function public.scheduling_appt_during(
  _start timestamptz,
  _duration_min integer
)
returns tstzrange
language sql
immutable
as $$
  select tstzrange(_start, _start + make_interval(mins => _duration_min));
$$;

-- ── 1. scheduling_providers ──────────────────────────────────────────────
-- A bookable person. MVP auto-creates exactly ONE ("the owner") and maps it to
-- the owner's auth user via user_id (the bridge described above). Multi-provider
-- later = insert more rows.
create table if not exists public.scheduling_providers (
  id          uuid        primary key default gen_random_uuid(),
  tenant_id   uuid        not null references public.tenants(id) on delete cascade,
  -- Which auth user this provider acts as. NULL allowed for future providers
  -- who are not platform users (e.g. a contractor injector with no login).
  user_id     uuid        references auth.users(id) on delete set null,
  name        text        not null,
  is_active   boolean     not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists scheduling_providers_tenant_idx
  on public.scheduling_providers (tenant_id)
  where is_active;

alter table public.scheduling_providers enable row level security;
do $$ begin
  create policy "service_role_scheduling_providers"
    on public.scheduling_providers for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

create trigger scheduling_providers_set_updated_at
  before update on public.scheduling_providers
  for each row execute function public.set_updated_at();

-- ── 2. scheduling_resources ──────────────────────────────────────────────
-- A bookable thing: room / chair / device. MVP auto-creates ONE; appointments
-- optionally consume one (resource_id nullable on emma_appointments).
create table if not exists public.scheduling_resources (
  id          uuid        primary key default gen_random_uuid(),
  tenant_id   uuid        not null references public.tenants(id) on delete cascade,
  name        text        not null,
  type        text        not null default 'room'
              check (type in ('room','chair','device')),
  is_active   boolean     not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists scheduling_resources_tenant_idx
  on public.scheduling_resources (tenant_id)
  where is_active;

alter table public.scheduling_resources enable row level security;
do $$ begin
  create policy "service_role_scheduling_resources"
    on public.scheduling_resources for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

create trigger scheduling_resources_set_updated_at
  before update on public.scheduling_resources
  for each row execute function public.set_updated_at();

-- ── 3. scheduling_settings ───────────────────────────────────────────────
-- One row per tenant. Timezone is the anchor for all wall-clock -> UTC math in
-- the slot engine. slot_granularity_min = the grid the booker sees (15 min).
create table if not exists public.scheduling_settings (
  id                       uuid        primary key default gen_random_uuid(),
  tenant_id                uuid        not null references public.tenants(id) on delete cascade,
  -- IANA tz name, e.g. 'America/Los_Angeles'. Combined with scheduling_hours
  -- wall-clock times + a calendar date to produce UTC slot boundaries.
  timezone                 text        not null default 'America/Los_Angeles',
  slot_granularity_min     integer     not null default 15  check (slot_granularity_min > 0),
  -- Patients can't book closer than this many minutes from now…
  min_advance_notice_min   integer     not null default 120 check (min_advance_notice_min >= 0),
  -- …nor further out than this many days.
  max_advance_days         integer     not null default 60  check (max_advance_days > 0),
  online_booking_enabled   boolean     not null default false,
  -- Hold window before an unconfirmed booking is swept back to available.
  hold_minutes             integer     not null default 5   check (hold_minutes > 0),
  -- Reminder lead times (hours before appointment).
  reminder_lead_hours      integer     not null default 24  check (reminder_lead_hours >= 0),
  sameday_reminder_enabled boolean     not null default true,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (tenant_id)
);

alter table public.scheduling_settings enable row level security;
do $$ begin
  create policy "service_role_scheduling_settings"
    on public.scheduling_settings for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

create trigger scheduling_settings_set_updated_at
  before update on public.scheduling_settings
  for each row execute function public.set_updated_at();

-- ── 4. scheduling_hours ──────────────────────────────────────────────────
-- Weekly availability KEYED TO provider_id (not tenant) so each provider owns
-- their own hours. MVP = the one provider's hours. open_time/close_time are
-- WALL-CLOCK times in the tenant's timezone; day_of_week uses Postgres DOW
-- convention (0 = Sunday … 6 = Saturday).
create table if not exists public.scheduling_hours (
  id          uuid        primary key default gen_random_uuid(),
  provider_id uuid        not null references public.scheduling_providers(id) on delete cascade,
  day_of_week integer     not null check (day_of_week between 0 and 6),
  open_time   time        not null,
  close_time  time        not null,
  is_closed   boolean     not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- One hours row per provider per weekday.
  unique (provider_id, day_of_week),
  -- A non-closed day must have open before close.
  check (is_closed or open_time < close_time)
);

create index if not exists scheduling_hours_provider_idx
  on public.scheduling_hours (provider_id, day_of_week);

alter table public.scheduling_hours enable row level security;
do $$ begin
  create policy "service_role_scheduling_hours"
    on public.scheduling_hours for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

create trigger scheduling_hours_set_updated_at
  before update on public.scheduling_hours
  for each row execute function public.set_updated_at();

-- ── 5. scheduling_blocks ─────────────────────────────────────────────────
-- One-off unavailability: vacation, holiday, lunch, a meeting. provider_id NULL
-- = whole-practice block (every provider). `during` is an explicit UTC range
-- (not generated — block times are arbitrary). The slot engine SUBTRACTS these
-- from open intervals; they are not appointments, so they do NOT participate in
-- the EXCLUDE constraints.
create table if not exists public.scheduling_blocks (
  id          uuid        primary key default gen_random_uuid(),
  tenant_id   uuid        not null references public.tenants(id) on delete cascade,
  provider_id uuid        references public.scheduling_providers(id) on delete cascade,
  during      tstzrange   not null,
  reason      text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (not isempty(during) and lower(during) is not null and upper(during) is not null)
);

create index if not exists scheduling_blocks_tenant_idx
  on public.scheduling_blocks (tenant_id);
-- GiST index for fast "blocks overlapping this day" range queries in the engine.
create index if not exists scheduling_blocks_during_gist
  on public.scheduling_blocks using gist (during);

alter table public.scheduling_blocks enable row level security;
do $$ begin
  create policy "service_role_scheduling_blocks"
    on public.scheduling_blocks for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

create trigger scheduling_blocks_set_updated_at
  before update on public.scheduling_blocks
  for each row execute function public.set_updated_at();

-- ── 6. scheduling_billable_events ────────────────────────────────────────
-- The $5/$5 ledger. The single source of truth the monthly refill_invoices
-- rollup reads. One row per billable booking. unique(appointment_id, type)
-- prevents the same appointment being billed twice for the same reason.
create table if not exists public.scheduling_billable_events (
  id             uuid        primary key default gen_random_uuid(),
  tenant_id      uuid        not null references public.tenants(id) on delete cascade,
  appointment_id uuid        not null references public.emma_appointments(id) on delete cascade,
  -- slot_fill      = consumed a rescue offer token ($5)
  -- campaign_booking = carried a targeted-promo token ($5)
  type           text        not null
                 check (type in ('slot_fill','campaign_booking')),
  amount_cents   integer     not null default 500 check (amount_cents >= 0),
  occurred_at    timestamptz not null default now(),
  -- Stamped when the monthly invoice rollup has counted this row.
  invoiced_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (appointment_id, type)
);

create index if not exists scheduling_billable_events_tenant_idx
  on public.scheduling_billable_events (tenant_id, occurred_at);
-- Hot path for the monthly rollup: un-invoiced events.
create index if not exists scheduling_billable_events_uninvoiced_idx
  on public.scheduling_billable_events (tenant_id, occurred_at)
  where invoiced_at is null;

alter table public.scheduling_billable_events enable row level security;
do $$ begin
  create policy "service_role_scheduling_billable_events"
    on public.scheduling_billable_events for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

create trigger scheduling_billable_events_set_updated_at
  before update on public.scheduling_billable_events
  for each row execute function public.set_updated_at();

-- ── 7. EXTEND services ───────────────────────────────────────────────────
-- Reuse the existing tenant-scoped catalog. duration_min drives the slot span;
-- buffer_min is turnover/cleanup time the slot ENGINE applies (it is NOT part of
-- the DB `during` range — see emma_appointments note below). online_bookable
-- gates whether a service appears on the public self-book page.
alter table public.services
  add column if not exists duration_min    integer not null default 30
    check (duration_min > 0),
  add column if not exists buffer_min      integer not null default 0
    check (buffer_min >= 0),
  add column if not exists online_bookable boolean not null default false;

-- ── 8. EXTEND emma_appointments ──────────────────────────────────────────
-- Add the scheduling dimensions. user_id is UNCHANGED (ownership / RLS / the
-- existing rescue engine all keep firing). provider_id is the NEW scheduling
-- key the EXCLUDE constraint and slot engine use.
alter table public.emma_appointments
  add column if not exists provider_id     uuid references public.scheduling_providers(id) on delete set null,
  add column if not exists resource_id     uuid references public.scheduling_resources(id) on delete set null,
  -- Live-hold expiry (status='held' until slot_held_until; swept after).
  add column if not exists slot_held_until timestamptz,
  -- Capability token for the public confirm step (mirrors /book token pattern).
  add column if not exists booking_token   text,
  -- Native self-book contact (emma_appointments has no contact fields today;
  -- the booker is not necessarily an existing knowledge_nodes patient).
  add column if not exists booking_name    text,
  add column if not exists booking_email   text,
  add column if not exists booking_phone   text;

-- Generated UTC span of the appointment. '[)' (inclusive lower, exclusive
-- upper) is the tstzrange default — so a 10:00–10:30 and a 10:30–11:00 booking
-- do NOT overlap. make_interval(mins => ...) keeps the expression IMMUTABLE,
-- which a STORED generated column requires. duration_min is NOT NULL default 30
-- on every existing row, so this computes for all history with no backfill.
-- NOTE: buffer_min is deliberately NOT included here — buffer is enforced by the
-- slot engine on read, not by the physical no-overlap guarantee.
alter table public.emma_appointments
  add column if not exists during tstzrange
    generated always as (
      public.scheduling_appt_during(scheduled_at, duration_min)
    ) stored;

-- Expand the source CHECK to admit native bookings. Reproduces the existing
-- allowed set (from 20260530010000) + the two native sources.
alter table public.emma_appointments
  drop constraint if exists emma_appointments_source_check;
alter table public.emma_appointments
  add constraint emma_appointments_source_check
  check (source in (
    'manual',
    'pms-api',
    -- native scheduler (this product)
    'native-online', 'native-manual',
    -- v381 live-API sources
    'acuity', 'mindbody', 'jane', 'square', 'boulevard',
    -- v367 CSV dialects
    'csv-acuity', 'csv-boulevard', 'csv-mangomint', 'csv-vagaro',
    'csv-aestheticspro', 'csv-aestheticrecord', 'csv-generic',
    'csv-calendly', 'csv-glossgenius', 'csv-zenoti', 'csv-square',
    'csv-simplepractice', 'csv-pabau', 'csv-janeapp', 'csv-wellnessliving',
    'csv-fresha', 'csv-mindbody', 'csv-symplast', 'csv-nextech',
    'csv-patientnow', 'csv-repeatmd', 'csv-booker', 'csv-moxie',
    'csv-schedulicity', 'csv-meevo'
  ));

-- The HOLD step parks a booking at status='held' (slot_held_until in the future)
-- until the patient confirms or the sweep releases it. The original status CHECK
-- (from 20260517000000) admits only scheduled/confirmed/cancelled/no_show/
-- showed/rescheduled — with no 'held', every hold-write would throw 23514 and the
-- headline feature would be dead on arrival. Add 'held'. Existing rows all carry
-- legacy values ⊂ the new set, so re-adding validates clean against history.
alter table public.emma_appointments
  drop constraint if exists emma_appointments_status_check;
alter table public.emma_appointments
  add constraint emma_appointments_status_check
  check (status in (
    'scheduled', 'confirmed', 'cancelled',
    'no_show', 'showed', 'rescheduled',
    'held'
  ));

-- ── 9. The no-double-booking guarantee (the part that must never fail) ────
-- Overlap is made physically impossible at the DB layer, keyed PER provider and
-- PER resource (not per tenant) so the guarantee is already multi-provider /
-- multi-room correct. Existing rows have NULL provider_id/resource_id, and the
-- WHERE clauses exclude NULLs, so adding these to the live table touches zero
-- existing rows — no validation failure, no backfill.
--
-- A provider can never be in two non-cancelled appointments at once:
alter table public.emma_appointments
  drop constraint if exists no_provider_overlap;
alter table public.emma_appointments
  add constraint no_provider_overlap
  exclude using gist (
    provider_id with =,
    during      with &&
  ) where (status <> 'cancelled' and provider_id is not null);

-- A room/chair/device can never hold two non-cancelled appointments at once:
alter table public.emma_appointments
  drop constraint if exists no_resource_overlap;
alter table public.emma_appointments
  add constraint no_resource_overlap
  exclude using gist (
    resource_id with =,
    during      with &&
  ) where (status <> 'cancelled' and resource_id is not null);

-- ── 10. Supporting indexes for the booking hot paths ─────────────────────
-- Slot-engine "busy" lookup: this provider's live appointments by time.
create index if not exists emma_appointments_provider_during_idx
  on public.emma_appointments (provider_id, scheduled_at)
  where status <> 'cancelled' and provider_id is not null;
-- Public confirm step: resolve a booking by its capability token.
create index if not exists emma_appointments_booking_token_idx
  on public.emma_appointments (booking_token)
  where booking_token is not null;
-- Hold-expiry sweep: find held rows whose hold has lapsed.
create index if not exists emma_appointments_held_expiry_idx
  on public.emma_appointments (slot_held_until)
  where status = 'held';

commit;

-- ── PostgREST schema reload ─────────────────────────────────────────────
notify pgrst, 'reload schema';

-- ── Verify (paste-friendly) ──────────────────────────────────────────────
-- 1) All 6 new tables exist:
-- select table_name from information_schema.tables
--  where table_schema = 'public'
--    and table_name like 'scheduling_%'
--  order by table_name;
--
-- 2) emma_appointments gained the scheduling columns (incl. generated `during`):
-- select column_name, data_type, is_generated
--   from information_schema.columns
--  where table_schema = 'public' and table_name = 'emma_appointments'
--    and column_name in ('provider_id','resource_id','during','slot_held_until',
--                        'booking_token','booking_name','booking_email','booking_phone')
--  order by column_name;
--
-- 3) services gained scheduling columns:
-- select column_name, data_type, column_default
--   from information_schema.columns
--  where table_schema = 'public' and table_name = 'services'
--    and column_name in ('duration_min','buffer_min','online_bookable')
--  order by column_name;
--
-- 4) Both EXCLUDE constraints are present:
-- select conname, contype from pg_constraint
--  where conrelid = 'public.emma_appointments'::regclass
--    and conname in ('no_provider_overlap','no_resource_overlap');
--
-- 5) btree_gist is installed:
-- select extname from pg_extension where extname = 'btree_gist';
--
-- 6) PROOF the guarantee works — should FAIL with a 23P01 exclusion_violation
--    on the second insert (run in a throwaway tx, then rollback). Replace the
--    UUIDs with a real tenant_id + a seeded provider_id first:
-- begin;
--   insert into public.scheduling_providers (id, tenant_id, name)
--     values ('00000000-0000-0000-0000-0000000000aa', '<TENANT_ID>', 'Test Provider');
--   insert into public.emma_appointments (user_id, provider_id, scheduled_at, duration_min, status, source)
--     values ('<OWNER_USER_ID>', '00000000-0000-0000-0000-0000000000aa', '2026-07-10 17:00:00+00', 30, 'confirmed', 'native-manual');
--   -- This second insert OVERLAPS the first for the same provider → must error:
--   insert into public.emma_appointments (user_id, provider_id, scheduled_at, duration_min, status, source)
--     values ('<OWNER_USER_ID>', '00000000-0000-0000-0000-0000000000aa', '2026-07-10 17:15:00+00', 30, 'confirmed', 'native-manual');
-- rollback;
