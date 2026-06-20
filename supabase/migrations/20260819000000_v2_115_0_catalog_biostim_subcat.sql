-- v2.115.0 — Catalog foundation for the Brand-Substitution recommender (Pillar 2).
--
-- The intelligence (Brand Economics 2.1 → recommender 2.2) groups substitutable
-- brands BY CATEGORY, so the catalog taxonomy is now load-bearing. Two fixes:
--
--   1) Add `biostimulator` as a first-class category (products + canonical_brands).
--      Today Sculptra/Radiesse are filed as 'filler' — clinically wrong for
--      substitution (you don't swap an HA filler for a collagen biostimulator).
--      Also add `facial` to products so canonical 'facial' brands stop dumping
--      into 'other'.
--   2) Add OPTIONAL sub-category fields — `subcategory_area` (primary
--      substitution group, e.g. cheek/lip/jaw) + `subcategory_family`
--      (secondary refiner) — on products AND canonical_brands. Free-text,
--      nullable; the owner seeds defaults in canonical_brands and products
--      inherit them on the recategorize sweep. Structure only — no enum.
--
-- Re-point existing canonical Sculptra/Radiesse → biostimulator so the next
-- recategorize sweep fixes the tenant's products.

-- ── 1) products.category CHECK → add biostimulator + facial ──────────────────
alter table public.products drop constraint if exists products_category_check;
alter table public.products add constraint products_category_check
  check (category in ('tox','filler','biostimulator','laser_consumable','facial','skincare','other'));

-- ── 2) canonical_brands.category CHECK → add biostimulator ───────────────────
alter table public.canonical_brands drop constraint if exists canonical_brands_category_check;
alter table public.canonical_brands add constraint canonical_brands_category_check
  check (category in ('tox','filler','biostimulator','laser','facial','skincare','other'));

-- ── 3) Optional sub-category fields (area + family) ──────────────────────────
alter table public.products add column if not exists subcategory_area   text;
alter table public.products add column if not exists subcategory_family text;
alter table public.canonical_brands add column if not exists subcategory_area   text;
alter table public.canonical_brands add column if not exists subcategory_family text;

-- ── 4) Re-point known biostimulators in the canonical registry ───────────────
update public.canonical_brands
  set category = 'biostimulator'
  where lower(display_name) in ('sculptra','radiesse')
    and category <> 'biostimulator';
