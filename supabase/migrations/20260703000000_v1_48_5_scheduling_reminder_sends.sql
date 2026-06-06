-- ════════════════════════════════════════════════════════════════════════
-- v1.48.5 — Scheduling reminder dedupe log
-- ════════════════════════════════════════════════════════════════════════
-- One row per (appointment, reminder-kind) that has been sent. The UNIQUE
-- constraint is the race-safe dedupe: the reminder cron CLAIMS a reminder by
-- INSERTing here; a duplicate insert (another cron tick, or a re-run) fails the
-- unique check and is skipped — so a patient is never double-reminded. It's an
-- append-only log (no updated_at, no trigger).
-- ════════════════════════════════════════════════════════════════════════

begin;

create table if not exists public.scheduling_reminder_sends (
  id             uuid        primary key default gen_random_uuid(),
  appointment_id uuid        not null references public.emma_appointments(id) on delete cascade,
  -- 'lead' = the configured N-hours-before reminder. 'sameday' reserved for a
  -- future same-day reminder (not sent yet in MVP).
  kind           text        not null check (kind in ('lead','sameday')),
  sent_at        timestamptz not null default now(),
  unique (appointment_id, kind)
);

create index if not exists scheduling_reminder_sends_appt_idx
  on public.scheduling_reminder_sends (appointment_id);

alter table public.scheduling_reminder_sends enable row level security;
do $$ begin
  create policy "service_role_scheduling_reminder_sends"
    on public.scheduling_reminder_sends for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

commit;

-- ── PostgREST schema reload ─────────────────────────────────────────────
notify pgrst, 'reload schema';

-- ── Verify (paste-friendly) ──────────────────────────────────────────────
-- select column_name, data_type from information_schema.columns
--  where table_schema='public' and table_name='scheduling_reminder_sends'
--  order by ordinal_position;
-- select count(*) as reminder_sends from public.scheduling_reminder_sends;
