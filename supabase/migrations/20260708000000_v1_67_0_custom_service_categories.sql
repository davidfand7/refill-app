-- v1.67.0 — Custom service categories
-- ─────────────────────────────────────────────────────────────────────────
-- Until now services.category was locked to a fixed 6-value enum
-- ('tox','filler','laser','facial','skincare','other') by a column-level
-- CHECK. Med spas have categories we didn't anticipate (body contouring,
-- wellness/IV, hormone therapy, memberships…), so we relax the constraint to
-- "any non-empty text" and let each tenant define their own. The 6 built-ins
-- stay as canonical slugs (with pretty labels) in app code; custom categories
-- are stored verbatim as the typed display string.
--
-- This ONLY touches services.category. products.category and
-- canonical_brands.category keep their enums on purpose:
--   • products is a different (laser_consumable) taxonomy, not yet customer-facing here.
--   • canonical_brands is the GLOBAL admin brand taxonomy, not per-tenant.
--
-- The inline CHECK from 20260601020000 was unnamed → Postgres auto-named it
-- public.services_category_check. We drop that and replace it with a
-- non-empty guard so a category can never be blank/whitespace.

alter table public.services
  drop constraint if exists services_category_check;

alter table public.services
  add constraint services_category_nonempty
  check (length(btrim(category)) > 0);

-- Tell PostgREST to reload its schema cache so the relaxed constraint takes
-- effect immediately for the app's data path.
notify pgrst, 'reload schema';

-- ── Verify (read-only) ──────────────────────────────────────────────────
-- Expect: services_category_nonempty present, services_category_check gone.
select conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.services'::regclass
  and contype = 'c'
order by conname;
