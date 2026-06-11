-- v2.4.2 — Spa-authored offer engine (forward-looking, all four dimensions)
-- ─────────────────────────────────────────────────────────────────────────
-- The spa-authored offer is being promoted from "a fixed dollar amount off a
-- service" into a real, spa-loyal loyalty engine (project_spa_offers_engine).
-- Rather than fork a second table and union it into the hot booking-badge
-- path, we EVOLVE the existing unified offers table (manufacturer_promo_offers,
-- which already carries both source='manufacturer' and source='spa' rows) with
-- additive, nullable columns. Manufacturer rows simply keep the defaults
-- (offer_type='dollars_off', target_cohort='all', is_active=true) and ignore
-- the rest — their ingest path is untouched.
--
-- This ONE migration carries columns for all four dimensions so we never have
-- to migrate again as the UI/logic for each slice lands:
--   1. offer types        — offer_type, value_pct, addon_service_name/label, threshold_usd
--   2. recurrence/timing   — active_weekdays, quantity_cap, redeemed_count
--   3. cohort targeting    — target_cohort
--   4. surfaces + push     — show_on_deals, push_enabled
-- plus is_active (pause an offer without deleting it).
--
-- discount_usd (already present) stays the dollar value for dollars_off /
-- discount_addon / spend_get-reward; value_pct is the percent for percent_off.

alter table public.manufacturer_promo_offers
  -- ── 1. Offer types ──
  add column if not exists offer_type text not null default 'dollars_off'
    check (offer_type in (
      'dollars_off',   -- $X off the matched service
      'percent_off',   -- X% off the matched service
      'free_addon',    -- a named add-on free with the matched service
      'discount_addon',-- $X off a named add-on with the matched service
      'bundle',        -- service + add-on(s) as a package (future slice)
      'bogo',          -- buy-one-get-one (future slice)
      'series',        -- package/series of visits (future slice)
      'first_visit',   -- new-patient-only offer (future slice)
      'spend_get'      -- spend $threshold, get reward (future slice)
    )),
  add column if not exists value_pct numeric(5,2)
    check (value_pct is null or (value_pct > 0 and value_pct <= 100)),
  -- normalized matching key + display label for the add-on side of an offer
  add column if not exists addon_service_name text,
  add column if not exists addon_label text,
  add column if not exists threshold_usd numeric(10,2)
    check (threshold_usd is null or threshold_usd >= 0),

  -- ── 2. Recurrence / scheduling ──
  -- 0..6 = Sun..Sat; null/empty = any day (e.g. {2} = "Tox Tuesdays").
  add column if not exists active_weekdays int[],
  add column if not exists quantity_cap int
    check (quantity_cap is null or quantity_cap > 0),
  add column if not exists redeemed_count int not null default 0,

  -- ── 3. Cohort targeting ──
  add column if not exists target_cohort text not null default 'all'
    check (target_cohort in ('all','lapsed','new','expiring')),

  -- ── 4. Surfaces + push ──
  add column if not exists show_on_deals boolean not null default true,
  add column if not exists push_enabled boolean not null default false,

  -- pause without deleting
  add column if not exists is_active boolean not null default true;

-- Reload PostgREST's schema cache so the new columns are queryable immediately.
notify pgrst, 'reload schema';

-- ── Verify (read-only) ──────────────────────────────────────────────────
-- Expect the new columns present with the defaults above.
select column_name, data_type, column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'manufacturer_promo_offers'
  and column_name in (
    'offer_type','value_pct','addon_service_name','addon_label','threshold_usd',
    'active_weekdays','quantity_cap','redeemed_count','target_cohort',
    'show_on_deals','push_enabled','is_active'
  )
order by column_name;
