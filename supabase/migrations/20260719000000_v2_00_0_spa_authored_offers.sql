-- v2.0.0 — Cross-Sell: spa-authored offers (Patient-Profitability OS · Phase 2).
--
-- Promo offers now come from TWO peer sources: the manufacturer promo
-- calendar (source='manufacturer', ingested wholesale) AND offers the spa
-- writes itself (source='spa', e.g. "add a HydraFacial — $50 off"). Both flow
-- through the SAME at-booking badge + $5 cross_sell_addon win pipeline.
--
-- Two changes to manufacturer_promo_offers:
--   1. add `source` so a manufacturer-calendar re-upload (full-snapshot
--      replace) only wipes its OWN rows and leaves spa-authored offers intact.
--   2. drop NOT NULL on `manufacturer` — a spa offer has no manufacturer.

alter table public.manufacturer_promo_offers
  add column if not exists source text not null default 'manufacturer';

do $$ begin
  alter table public.manufacturer_promo_offers
    add constraint manufacturer_promo_offers_source_check
    check (source in ('manufacturer', 'spa'));
exception when duplicate_object then null;
end $$;

alter table public.manufacturer_promo_offers
  alter column manufacturer drop not null;

notify pgrst, 'reload schema';

-- Verify: column present, existing rows defaulted to 'manufacturer'.
select source, count(*) from public.manufacturer_promo_offers group by source;
