-- v1.98.0 — Cross-Sell · Slice A (Patient-Profitability OS · Phase 2).
--
-- Holds the manufacturer promo-calendar offers a spa uploads (Allergan
-- "Dollars Off" patient offers first). Each offer maps to a product; at
-- booking we surface the best currently-active offer as a badge on the
-- matching add-on ("add filler — $75 off through Jun 30"). Keyed by
-- tenant_id so the public booking path (which has tenant_id, not user_id)
-- can hydrate offers with no owner lookup. A promo-calendar upload is a full
-- snapshot, so ingest replaces the tenant's rows wholesale.

create table if not exists public.manufacturer_promo_offers (
  id            uuid        primary key default gen_random_uuid(),
  tenant_id     uuid        not null references public.tenants(id) on delete cascade,
  manufacturer  text        not null,
  -- Normalized product keyword for service-name matching (e.g. "juvederm").
  product       text        not null,
  title         text        not null,
  discount_usd  numeric(10, 2),
  starts_on     date,
  ends_on       date,                 -- null = ongoing / no expiration
  landing_url   text,
  promotion_type text,
  raw_title     text,
  created_at    timestamptz not null default now()
);

create index if not exists manufacturer_promo_offers_tenant_idx
  on public.manufacturer_promo_offers (tenant_id);

alter table public.manufacturer_promo_offers enable row level security;

do $$ begin
  create policy "service_role_manufacturer_promo_offers"
    on public.manufacturer_promo_offers for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

notify pgrst, 'reload schema';

-- Verify: table ready + empty.
select count(*) as offer_count from public.manufacturer_promo_offers;
