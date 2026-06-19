-- v2.107.0 — allow 'vip' and 'waitlist' offer cohorts
--
-- The offer engine's target_cohort started as a text column with a CHECK
-- constraint limited to ('all','lapsed','new','expiring') — see
-- 20260720000000_v2_4_2_spa_offer_engine.sql. The composer now offers two more
-- audiences (VIP / A-list and opted-in Waitlist), both resolved server-side in
-- listOfferCohortTargets. Widen the constraint so those rows can be written.
--
-- The original constraint was added inline via `add column ... check (...)`, so
-- it carries an auto-generated name. Drop it by lookup (robust to the name),
-- then re-add a named one with the two new values.

do $$
declare c text;
begin
  select conname into c
  from pg_constraint
  where conrelid = 'manufacturer_promo_offers'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%target_cohort%';
  if c is not null then
    execute format('alter table manufacturer_promo_offers drop constraint %I', c);
  end if;
end $$;

alter table manufacturer_promo_offers
  add constraint manufacturer_promo_offers_target_cohort_check
  check (target_cohort in ('all','lapsed','new','expiring','vip','waitlist'));

-- Verify (run after applying):
-- select pg_get_constraintdef(oid) from pg_constraint
--   where conrelid='manufacturer_promo_offers'::regclass and contype='c'
--     and pg_get_constraintdef(oid) ilike '%target_cohort%';
