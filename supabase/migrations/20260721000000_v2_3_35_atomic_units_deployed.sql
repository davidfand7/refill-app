-- v2.3.35 — Atomic, clamped increment of rebate_inventory_units.units_deployed.
--
-- The allocation confirm path (patchStatus in
-- refill-recognition-allocation.functions.ts) did a read-modify-write:
--
--     select units_deployed        -- read
--     next = min(deployed + units, total)
--     update set units_deployed = next   -- write
--
-- Two defects:
--   (1) LOST-UPDATE RACE — two concurrent confirms of DIFFERENT suggestions
--       that both draw from the SAME rebate_inventory_units row each read the
--       same `units_deployed`, each compute `read + their units`, and the
--       second write clobbers the first. The deployed counter under-counts,
--       so the inventory looks like it has more units available than it does
--       → over-allocation against a manufacturer rebate pool.
--   (2) The old UPDATE filtered by id ONLY (not user_id) — tenant scoping
--       relied on the preceding SELECT. This RPC re-asserts user_id in the
--       WHERE so the mutation itself is tenant-safe.
--
-- Fix: a single UPDATE that reads the column off itself under the row lock
-- Postgres takes for the write — atomic, no lost update under any concurrency.
-- `least(.., units_total)` preserves the original clamp (never deploy past the
-- pool's total). Returns the new value (null if no row matched id+user_id).
--
-- The TS caller now also guards the increment behind a real status transition
-- (pending/dismissed → confirmed), so re-confirming an already-confirmed
-- suggestion (double-click / retry) no longer double-counts the deployment.

create or replace function public.refill_increment_units_deployed(
  p_id uuid,
  p_user_id uuid,
  p_delta integer
)
returns integer
language sql
security definer
set search_path = public
as $$
  update public.rebate_inventory_units
     set units_deployed = least(units_deployed + p_delta, units_total)
   where id = p_id
     and user_id = p_user_id
  returning units_deployed;
$$;

grant execute on function public.refill_increment_units_deployed(uuid, uuid, integer)
  to service_role;

notify pgrst, 'reload schema';

-- ─── Verify ─────────────────────────────────────────────────────────────────
-- select proname, pronargs
--   from pg_proc
--  where proname = 'refill_increment_units_deployed';
--
-- -- functional check (replace the uuids with a real row you own):
-- select public.refill_increment_units_deployed(
--   '00000000-0000-0000-0000-000000000000'::uuid,
--   '00000000-0000-0000-0000-000000000000'::uuid,
--   0
-- );
