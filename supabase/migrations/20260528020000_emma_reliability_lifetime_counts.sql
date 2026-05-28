-- v1.26.4 — lifetime no-show / cancellation tracking on emma_reliability_status.
--
-- Karen's original ask for the A-list "exclude unreliable" rule was "never had
-- a cancellation/no-show ever" — but v1.25.4 shipped with a 6mo rolling window
-- because the only materialized counts on emma_reliability_status were
-- no_shows_6mo + cancellations_6mo. The 6mo rule is correct for tier semantics
-- (in_recovery should be recoverable; window roll-past should restore trusted)
-- but the A-list filter is a different decision — a spa owner who wants "never
-- cancelled" as a VIP criterion should be able to filter on lifetime totals.
--
-- This migration adds two denormalized lifetime columns. Same shape as the
-- existing 6mo columns. The v1.25.7 RPC (refill_recompute_reliability_counts)
-- and the per-row trigger (recomputeReliabilityForPatient TS fn) both get
-- updated to populate them. Tier semantics are NOT changed — the existing
-- in_recovery_threshold + in_recovery_window_months still drive tier
-- transitions off the 6mo window, as designed.
--
-- Pattern is consistent with the rest of emma_reliability_status: counts are
-- materialized at appointment-status transitions (foreground trigger) + bulk
-- ingest sweep (RPC) + daily cron (safety net). Never computed on the fly at
-- read time per the table-level comment.

alter table public.emma_reliability_status
  add column if not exists no_shows_lifetime      integer not null default 0,
  add column if not exists cancellations_lifetime integer not null default 0;

-- Backfill from emma_appointments. Same shape as the v1.25.7 RPC body but
-- without the 6mo window filter. Idempotent against existing rows; preserves
-- tier, grace_credits_used, last_activity_at, and the 6mo columns.
with rollup as (
  select
    a.user_id,
    a.patient_node_id,
    count(*) filter (where a.status = 'no_show')   as no_shows_lifetime,
    count(*) filter (where a.status = 'cancelled') as cancellations_lifetime
  from public.emma_appointments a
  where a.patient_node_id is not null
  group by a.user_id, a.patient_node_id
)
update public.emma_reliability_status r
   set no_shows_lifetime      = rollup.no_shows_lifetime,
       cancellations_lifetime = rollup.cancellations_lifetime
  from rollup
 where r.user_id = rollup.user_id
   and r.patient_node_id = rollup.patient_node_id;

-- Update the RPC to write lifetime alongside 6mo. Single statement, one CTE
-- adds the two new aggregates; INSERT + ON CONFLICT both extended.
create or replace function public.refill_recompute_reliability_counts(
  p_user_id uuid
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_touched int := 0;
begin
  with rollup as (
    select
      a.user_id,
      a.patient_node_id,
      count(*) filter (
        where a.status = 'no_show'
          and a.scheduled_at >= now() - interval '6 months'
      ) as no_shows_6mo,
      count(*) filter (
        where a.status = 'cancelled'
          and a.scheduled_at >= now() - interval '6 months'
      ) as cancellations_6mo,
      count(*) filter (where a.status = 'no_show')   as no_shows_lifetime,
      count(*) filter (where a.status = 'cancelled') as cancellations_lifetime,
      count(*) as total_visits
    from public.emma_appointments a
    where a.user_id = p_user_id
      and a.patient_node_id is not null
    group by a.user_id, a.patient_node_id
  )
  insert into public.emma_reliability_status (
    user_id,
    patient_node_id,
    no_shows_6mo,
    cancellations_6mo,
    no_shows_lifetime,
    cancellations_lifetime,
    total_visits,
    recomputed_at
  )
  select
    user_id,
    patient_node_id,
    no_shows_6mo,
    cancellations_6mo,
    no_shows_lifetime,
    cancellations_lifetime,
    total_visits,
    now()
  from rollup
  on conflict (user_id, patient_node_id) do update set
    no_shows_6mo           = excluded.no_shows_6mo,
    cancellations_6mo      = excluded.cancellations_6mo,
    no_shows_lifetime      = excluded.no_shows_lifetime,
    cancellations_lifetime = excluded.cancellations_lifetime,
    total_visits           = excluded.total_visits,
    recomputed_at          = excluded.recomputed_at;

  get diagnostics v_touched = row_count;
  return v_touched;
end;
$$;

grant execute on function public.refill_recompute_reliability_counts(uuid)
  to service_role;

notify pgrst, 'reload schema';

-- ─── Verify ─────────────────────────────────────────────────────────────────
-- select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--  where table_schema = 'public'
--    and table_name = 'emma_reliability_status'
--    and column_name in ('no_shows_lifetime', 'cancellations_lifetime');
--
-- -- Top lifetime offenders for spot-check (run as service_role / dashboard):
-- select kn.title,
--        r.cancellations_lifetime,
--        r.no_shows_lifetime,
--        r.cancellations_6mo,
--        r.no_shows_6mo
--   from public.emma_reliability_status r
--   join public.knowledge_nodes kn on kn.id = r.patient_node_id
--  where r.cancellations_lifetime + r.no_shows_lifetime > 0
--  order by r.cancellations_lifetime + r.no_shows_lifetime desc
--  limit 20;
