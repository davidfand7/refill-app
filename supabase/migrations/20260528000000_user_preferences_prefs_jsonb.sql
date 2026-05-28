-- v1.25.1 — A-list automation dashboard.
--
-- Two changes in one migration:
--
-- 1. Extend public.user_preferences with a `prefs jsonb` column so the
--    spa-owner-facing A-list rules dashboard can persist their threshold
--    settings ({ aListRules, aListLastAppliedAt }). Kept as a flexible
--    jsonb so future per-user prefs (notification cadence, dashboard
--    layout, etc.) don't each require their own migration.
--
-- 2. Add a Postgres RPC `refill_bulk_set_vip(user_id, add_ids, remove_ids)`
--    that bulk-updates `knowledge_nodes.attachments.vip` in a single round
--    trip. The existing per-row `setPatientVip` server fn (patient-ingest.
--    functions.ts:603) does a read-modify-write per patient; calling it in
--    a loop for the Apply button on a 1,140-row patient book would be
--    1,140 round trips. The RPC uses `jsonb_set` to merge the `vip` field
--    without clobbering the rest of the PatientSummary blob (lifetimeSpend,
--    lastVisit, productMix, etc. all live in the same attachments jsonb).
--
-- Apply semantics:
--   * v1.25.1 ships ADDITIVE-ONLY by default (Apply passes addIds; never
--     removeIds). This protects manual stars the spa-owner set via the
--     per-row VIP toggle on /app/refill/patients.
--   * The RPC supports remove_ids for the separate "Clear all A-list
--     flags" destructive button, which the UI gates behind a typed-confirm
--     modal.
--
-- user_preferences is one row per user — adding NOT NULL DEFAULT '{}'
-- backfills every existing row inside a single ALTER. Safe at current
-- scale; table has fewer than a dozen rows in prod today.

alter table public.user_preferences
  add column if not exists prefs jsonb not null default '{}'::jsonb;


-- Bulk-apply the A-list / VIP flag on patient rows.
--
-- security definer + explicit user_id filter is the safety boundary —
-- the function only ever touches rows owned by p_user_id, so the caller
-- (always service-role from server fns) cannot escape the tenant
-- boundary through SQL injection of a different uuid array. The server
-- fn wrapper (setPatientVipBulk) verifies admin role via
-- resolveEffectiveUserId BEFORE calling this RPC when viewAsUserId is
-- present.
--
-- jsonb_set(.., '{vip}', 'true'::jsonb, true) — the trailing `true` is
-- create_missing=true so patients whose attachments don't yet have a
-- `vip` key get one; existing keys are replaced. updated_at bump means
-- bulk-applied patients float to the top of the next listPatients query
-- (ordered by updated_at desc) — that's intentional, reads as "recently
-- modified".

create or replace function public.refill_bulk_set_vip(
  p_user_id uuid,
  p_add_ids uuid[],
  p_remove_ids uuid[]
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_added   int := 0;
  v_removed int := 0;
begin
  if p_add_ids is not null and array_length(p_add_ids, 1) > 0 then
    update public.knowledge_nodes
       set attachments = jsonb_set(attachments, '{vip}', 'true'::jsonb, true),
           updated_at = now()
     where user_id = p_user_id
       and node_type = 'patient'
       and id = any(p_add_ids);
    get diagnostics v_added = row_count;
  end if;

  if p_remove_ids is not null and array_length(p_remove_ids, 1) > 0 then
    update public.knowledge_nodes
       set attachments = jsonb_set(attachments, '{vip}', 'false'::jsonb, true),
           updated_at = now()
     where user_id = p_user_id
       and node_type = 'patient'
       and id = any(p_remove_ids);
    get diagnostics v_removed = row_count;
  end if;

  return v_added + v_removed;
end;
$$;

grant execute on function public.refill_bulk_set_vip(uuid, uuid[], uuid[])
  to service_role;

notify pgrst, 'reload schema';

-- ─── Verify ─────────────────────────────────────────────────────────────────
-- Run these after the ALTER + CREATE FUNCTION:
--
-- select column_name, data_type, column_default
--   from information_schema.columns
--  where table_schema = 'public'
--    and table_name = 'user_preferences'
--  order by ordinal_position;
--
-- select proname, pronargs
--   from pg_proc
--  where proname = 'refill_bulk_set_vip';
