-- v2.34.0 — Reschedule Reminders · Slice 1: canonical no-show definition + cancel timing
-- ─────────────────────────────────────────────────────────────────────────
-- "Reschedule Reminders" (renamed from No-Show Follow-Up) brings back patients
-- who cancelled OR no-showed — on the SPA'S OWN definition of each. A cancel is
-- notice given before the appointment AND at/beyond the spa's required notice
-- window; a no-show is no notice, OR a "cancel" given inside the window (a late
-- cancel, reclassified as a no-show).
--
-- That distinction needs the cancellation MOMENT to compute notice lead-time
-- (= scheduled_at - cancelled_at). The schema never captured it, so we add it.
--
-- Slice 1 = the canonical primitive + the settings, NO sending yet. The notice
-- rule lives on emma_noshow_policies (the per-spa settings row), consumed in v1
-- by Reschedule Reminders + the preshow settings card; a later slice points the
-- reliability/grace engines at the SAME rule (spa-wide), without a rewrite.

-- ── 1. Cancel timing on the appointment ──────────────────────────────────
alter table public.emma_appointments
  add column if not exists cancelled_at timestamptz;

comment on column public.emma_appointments.cancelled_at is
  'When the appointment was cancelled. Written on the live in-app cancel path; '
  'backfilled from the status-event audit trail. NULL for no-shows and for '
  'cancels whose timing is unknown (e.g. some CSV imports) — the classifier '
  'treats NULL as "notice unknown" and never brands such a row a no-show. '
  'Notice lead-time = scheduled_at - cancelled_at.';

-- ── 2. The canonical no-show rule + Reschedule settings on the policy row ─
alter table public.emma_noshow_policies
  -- Master on/off for the Reschedule Reminders agent (also the Skill's gate).
  add column if not exists reschedule_enabled boolean not null default false,
  -- THE canonical notice rule: a cancellation with less than this many hours'
  -- notice counts as a no-show. Default 24h. (0..336 = up to two weeks.)
  add column if not exists noshow_notice_hours integer not null default 24
    check (noshow_notice_hours >= 0 and noshow_notice_hours <= 336),
  -- Which outcome classes the operator wants to follow up.
  add column if not exists reschedule_target_cancels boolean not null default true,
  add column if not exists reschedule_target_noshows boolean not null default true,
  -- How far back the sweep looks for un-followed-up outcomes (1..90 days).
  add column if not exists reschedule_lookback_days integer not null default 14
    check (reschedule_lookback_days >= 1 and reschedule_lookback_days <= 90);

-- ── 3. Backfill cancel timing from the audit trail ───────────────────────
-- The most recent status event that moved an appointment INTO 'cancelled' is
-- the cancellation moment. Only stamp rows that are still cancelled and not
-- already timed. Live in-app cancels get a real time; CSV cancels with no
-- event stay NULL (an honest "notice unknown", never a fabricated lead-time).
update public.emma_appointments a
   set cancelled_at = e.created_at
  from (
    select distinct on (appointment_id) appointment_id, created_at
      from public.emma_appointment_status_events
     where to_status = 'cancelled'
     order by appointment_id, created_at desc
  ) e
 where e.appointment_id = a.id
   and a.status = 'cancelled'
   and a.cancelled_at is null;

-- ── 4. Index for the recent cancel/no-show sweep + preview ───────────────
create index if not exists idx_emma_appointments_user_status_sched
  on public.emma_appointments (user_id, status, scheduled_at desc);

notify pgrst, 'reload schema';

-- ── Verify (read-only) ───────────────────────────────────────────────────
-- Expect new_policy_cols = 5, and cancelled_timed ≤ cancelled_total (how many
-- historical cancels we could time from the audit trail).
select
  (select count(*) from public.emma_appointments where status = 'cancelled') as cancelled_total,
  (select count(*) from public.emma_appointments where status = 'cancelled' and cancelled_at is not null) as cancelled_timed,
  (select count(*) from public.emma_appointments where status = 'no_show') as no_show_total,
  (select count(*) from information_schema.columns
     where table_schema = 'public' and table_name = 'emma_noshow_policies'
       and column_name in (
         'reschedule_enabled','noshow_notice_hours','reschedule_target_cancels',
         'reschedule_target_noshows','reschedule_lookback_days'
       )) as new_policy_cols;
