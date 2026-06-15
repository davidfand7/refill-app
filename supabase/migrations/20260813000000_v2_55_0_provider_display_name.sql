-- v2.55.0 — Sticky provider rename.
--
-- The Acuity mirror keeps `scheduling_providers.name` synced to the calendar's
-- name on every run (it's the source of truth + the key appointment-linking
-- matches on). So an in-app rename written to `name` would be silently
-- overwritten on the next reconcile. This adds a DISTINCT owner override that
-- the mirror never touches — exactly the pattern `hidden_at` (v2.46.0) uses for
-- show/hide. NULL = no override → fall back to the Acuity `name`.
--
-- Motivating case: Rejuv's Acuity calendar is literally named "Rejuv Skin Spa"
-- but is actually Karen's column. The owner can now rename it to "Karen" and
-- have it stick across re-mirrors.

alter table scheduling_providers
  add column if not exists display_name text;

notify pgrst, 'reload schema';
