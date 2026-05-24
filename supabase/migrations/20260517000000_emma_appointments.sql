-- Emma(OS) appointment foundation (v360).
--
-- Until v360 Emma had zero appointment data. patient_outreach_state
-- reserved 'booked'/'showed'/'no_show' states but no code wrote them.
-- This migration creates the source of truth for actual appointments:
-- imported from the spa's PMS (Acuity, Boulevard, Mangomint, etc.) via
-- CSV upload today, via API integrations later.
--
-- Why a dedicated table (not knowledge_nodes attachments): appointments
-- have a state machine, frequent send-time reads (the pre-show sweep
-- runs every 15 min looking for upcoming appointments), and benefit
-- from strongly-typed columns + partial indexes. Same pattern as
-- emma_sender_domains (v355) and emma_appointments_state_events below.
--
-- Tenant boundary: every row scoped by spa user_id with RLS. Reps don't
-- read this — appointments are spa-side concerns.
--
-- Established 2026-05-17 (Promotions Engine v360).

create table if not exists public.emma_appointments (
  id                  uuid        primary key default gen_random_uuid(),
  user_id             uuid        not null references auth.users(id) on delete cascade,

  -- The patient this appointment is for. NULL when the CSV row matched no
  -- existing patient AND we chose not to auto-create a stub. The pre-show
  -- agent skips appointments with null patient_node_id.
  patient_node_id     uuid        references public.knowledge_nodes(id) on delete set null,

  scheduled_at        timestamptz not null,
  duration_min        integer     not null default 30,
  treatment_type      text,
  provider_name       text,

  -- State machine. Status transitions go through emma_appointment_status_events
  -- so we have an audit trail of every change (and the trigger that flipped it).
  status              text        not null default 'scheduled'
                      check (status in (
                        'scheduled', 'confirmed', 'cancelled',
                        'no_show', 'showed', 'rescheduled'
                      )),

  -- The PMS's own appointment ID (when we can extract it from the CSV).
  -- Lets us match on re-import without duplicating.
  external_id         text,

  -- Where this row came from. Detection happens in the SMART importer.
  source              text        not null default 'manual'
                      check (source in (
                        'manual', 'pms-api',
                        'csv-acuity', 'csv-boulevard', 'csv-mangomint',
                        'csv-vagaro', 'csv-aestheticspro', 'csv-aestheticrecord',
                        'csv-generic'
                      )),

  -- Free-form notes from the import.
  notes               text,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- Idempotent re-import: same (user, external_id, source) = same appointment.
  -- When external_id is null (manual entries) the index allows duplicates.
  unique (user_id, external_id, source)
);

alter table public.emma_appointments enable row level security;

do $$ begin
  create policy "users_own_emma_appointments"
    on public.emma_appointments for all
    using  (auth.uid() = user_id)
    with check (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "service_role_emma_appointments"
    on public.emma_appointments for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

-- Pre-show sweep hot path: "find appointments hitting cadence threshold."
-- Query shape: WHERE user_id = $1 AND status IN ('scheduled', 'confirmed')
--   AND scheduled_at BETWEEN now() AND now() + interval '7 days'
create index if not exists emma_appointments_upcoming_idx
  on public.emma_appointments (user_id, scheduled_at)
  where status in ('scheduled', 'confirmed');

-- Patient timeline: "show me every appointment for this patient."
create index if not exists emma_appointments_by_patient_idx
  on public.emma_appointments (user_id, patient_node_id, scheduled_at desc)
  where patient_node_id is not null;

-- updated_at touch trigger.
create or replace function public.touch_emma_appointments()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end
$$;

drop trigger if exists trg_touch_emma_appointments on public.emma_appointments;
create trigger trg_touch_emma_appointments
  before update on public.emma_appointments
  for each row execute function public.touch_emma_appointments();

-- ── Status change audit log ────────────────────────────────────────────

create table if not exists public.emma_appointment_status_events (
  id                  uuid        primary key default gen_random_uuid(),
  user_id             uuid        not null references auth.users(id) on delete cascade,
  appointment_id      uuid        not null references public.emma_appointments(id) on delete cascade,

  from_status         text        not null,
  to_status           text        not null,
  -- Who/what triggered the change. 'spa-owner' = manual UI action,
  -- 'csv-import' = CSV re-import flipped it, 'preshow-agent' = the
  -- cadence sweep advanced it, 'rescue-agent' = same-day rescue agent
  -- claimed/released it, 'patient' = the patient's own action (rare).
  triggered_by        text        not null,
  reason              text,

  created_at          timestamptz not null default now()
);

alter table public.emma_appointment_status_events enable row level security;

do $$ begin
  create policy "users_own_emma_appointment_status_events"
    on public.emma_appointment_status_events for all
    using  (auth.uid() = user_id)
    with check (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "service_role_emma_appointment_status_events"
    on public.emma_appointment_status_events for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

create index if not exists emma_appointment_status_events_by_apt_idx
  on public.emma_appointment_status_events (appointment_id, created_at desc);

comment on table public.emma_appointments is
  'Source of truth for spa appointment data. Ingested from PMS CSV exports (Acuity, Boulevard, Mangomint, Vagaro, AR) or manually entered. Drives the pre-show reminder cadence, same-day rescue agent, and recovery attribution. Spa-scoped via RLS.';

comment on table public.emma_appointment_status_events is
  'Append-only audit log of every status transition on emma_appointments. Used for pattern detection (chronic no-shows), recovery attribution, and "who flipped this when" diagnostics.';
