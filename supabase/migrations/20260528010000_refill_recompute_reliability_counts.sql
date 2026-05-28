-- v1.25.7 — fix Workers CPU timeout on bulk appointment ingest.
--
-- v1.25.5 added a post-ingest sync call to recomputeReliabilityForUser
-- which loops recomputeReliabilityForPatient over every distinct
-- patient_node_id. At Karen-scale (~800-1,000 distinct patients) each
-- loop iteration does ~3 DB round trips → 2,400-3,000 RTs total →
-- well past Cloudflare Workers' 30s CPU timeout. The 5,754 inserts
-- still commit (they run before the sweep) but the receipt never
-- returns to the client — UI shows "flash + blank."
--
-- Same exact antipattern that emma-appointments.functions.ts line 498
-- warns about for buildPatientIndex (which was fixed in v372.2 with a
-- single bulk query). This RPC applies the same pattern to the
-- reliability sweep: one SQL statement, server-side aggregation.
--
-- Tier (good/regular/vip/in_recovery) is NOT recomputed here — that
-- logic lives in TS and depends on cross-patient context (grace
-- credits, policy). Tier stays on its existing path: per-row trigger
-- on status flips + daily cron sweep. This RPC only refreshes the
-- *count* columns (no_shows_6mo, cancellations_6mo, total_visits)
-- which is what the A-list excludeUnreliable rule actually reads.
--
-- ON CONFLICT preserves tier — for new rows, tier defaults to
-- 'trusted' per the column default.

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
    total_visits,
    recomputed_at
  )
  select
    user_id,
    patient_node_id,
    no_shows_6mo,
    cancellations_6mo,
    total_visits,
    now()
  from rollup
  on conflict (user_id, patient_node_id) do update set
    no_shows_6mo = excluded.no_shows_6mo,
    cancellations_6mo = excluded.cancellations_6mo,
    total_visits = excluded.total_visits,
    recomputed_at = excluded.recomputed_at;

  get diagnostics v_touched = row_count;
  return v_touched;
end;
$$;

grant execute on function public.refill_recompute_reliability_counts(uuid)
  to service_role;

notify pgrst, 'reload schema';

-- ─── Verify ─────────────────────────────────────────────────────────────────
-- select proname, pronargs
--   from pg_proc
--  where proname = 'refill_recompute_reliability_counts';
