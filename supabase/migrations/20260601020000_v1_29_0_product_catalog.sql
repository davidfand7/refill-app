-- v1.29.0 — Product Catalog schema (Profitability Engine substrate layer §3.1).
--
-- WHY: the broader Profitability Engine (spec v0.1 locked 2026-06-01,
-- Desktop/Refill-Profitability-Engine-Spec-v0_1.html) depends on per-
-- product cost / sales-price / margin and per-service COGS to compute
-- margin-aware patient profitability. This migration ships the three
-- tables that ALL downstream scoring + the Recognition Allocation
-- Engine depend on. Without it: no margin math, no manufacturer-brand
-- affinity, no combo-treatment detection, no manufacturer-rebate-tier
-- tracking.
--
-- WHAT SHIPS:
--   public.products          — per-tenant catalog of physical products
--                              (Botox vials, HA filler syringes, Daxxify,
--                              skincare bottles, laser consumables, etc.)
--   public.services          — per-tenant catalog of services offered
--                              (Botox treatment / unit, filler / syringe,
--                              BBL session, HydraFacial, etc.)
--   public.service_products  — many-to-many junction: what products are
--                              consumed per service, and how much
--
-- ARCHITECTURAL CALLS (CTO, 2026-06-01):
--   - Text + CHECK constraint over Postgres ENUM (matches every modern
--     tenant-scoped table; app_role is the only ENUM in the codebase
--     and that file carries an explanatory comment about the foot-
--     gun that forced it).
--   - RLS enabled with service-role-only policies (matches
--     refill_pricing_plans / refill_invoices / incentive_offers pattern).
--   - Manufacturer values unified with src/lib/product-manufacturer-map.ts
--     TS enum (abbvie | galderma | evolus | merz | skinceuticals | eltamd
--     | neocutis | obagi | revance | rha | sciton | abbvie-coolsculpting)
--     plus generic + in_house for the long tail. Note allergan → abbvie
--     because AbbVie acquired the brand post-2020.
--   - cogs_per_service nullable numeric(10,2) + cogs_source flag — v1.29.3
--     auto-derive rewrites the scalar from linkage and flips the flag.
--
-- WHAT THIS DOESN'T FIX:
--   - No CRUD UI yet (v1.29.1 Products, v1.29.2 Services, v1.29.3 linkage).
--   - No CSV import (v1.29.4, validated against real Acuity export per
--     feedback_validate_against_real_exports).
--   - No price-history ledger (deferred; current state in cost_per_unit /
--     sales_price_per_unit only).
--   - No tenant-customizable categories (hard-coded at v1.x.0; revisit
--     when a second-spa onboarding surfaces a category gap).
--
-- ROLLBACK: drop in reverse FK order:
--   drop table if exists public.service_products;
--   drop table if exists public.services;
--   drop table if exists public.products;

-- ─────────────────────────────────────────────────────────────────────────
-- Shared updated_at trigger function (idempotent — may already exist from
-- prior migrations but create or replace is safe to re-run).
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- products
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists public.products (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(id) on delete cascade,
  brand                 text not null,
  category              text not null check (category in (
                          'tox','filler','laser_consumable','skincare','other'
                        )),
  unit_type             text not null check (unit_type in (
                          'vial','syringe','bottle','session','other'
                        )),
  cost_per_unit         numeric(10,2) not null check (cost_per_unit >= 0),
  sales_price_per_unit  numeric(10,2) not null check (sales_price_per_unit >= 0),
  manufacturer          text check (manufacturer in (
                          'abbvie','galderma','evolus','merz',
                          'skinceuticals','eltamd','neocutis','obagi',
                          'revance','rha','sciton','abbvie-coolsculpting',
                          'generic','in_house'
                        )),
  notes                 text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists products_tenant_id_idx
  on public.products (tenant_id);

create index if not exists products_tenant_category_idx
  on public.products (tenant_id, category);

create index if not exists products_tenant_manufacturer_idx
  on public.products (tenant_id, manufacturer)
  where manufacturer is not null;

drop trigger if exists products_set_updated_at on public.products;
create trigger products_set_updated_at
  before update on public.products
  for each row execute function public.set_updated_at();

alter table public.products enable row level security;

drop policy if exists "products_service_role_all" on public.products;
create policy "products_service_role_all"
  on public.products
  for all
  to service_role
  using (true)
  with check (true);

comment on table public.products is
  'Per-tenant catalog of physical products (Botox vials, HA filler syringes, skincare bottles, laser consumables). Drives margin math + manufacturer-brand affinity for Recognition Allocation Engine. Tenant-scoped, RLS-enabled, service-role-only access.';

-- ─────────────────────────────────────────────────────────────────────────
-- services
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists public.services (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  name              text not null,
  category          text not null check (category in (
                      'tox','filler','laser','facial','skincare','other'
                    )),
  service_price     numeric(10,2) not null check (service_price >= 0),
  cogs_per_service  numeric(10,2) check (cogs_per_service is null or cogs_per_service >= 0),
  cogs_source       text not null default 'manual' check (cogs_source in (
                      'manual','derived'
                    )),
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists services_tenant_id_idx
  on public.services (tenant_id);

create index if not exists services_tenant_category_idx
  on public.services (tenant_id, category);

drop trigger if exists services_set_updated_at on public.services;
create trigger services_set_updated_at
  before update on public.services
  for each row execute function public.set_updated_at();

alter table public.services enable row level security;

drop policy if exists "services_service_role_all" on public.services;
create policy "services_service_role_all"
  on public.services
  for all
  to service_role
  using (true)
  with check (true);

comment on table public.services is
  'Per-tenant catalog of services offered (Botox treatment / unit, filler / syringe, BBL session). cogs_per_service is manual at v1.29.2; v1.29.3 auto-derive rewrites from service_products linkage and flips cogs_source to ''derived''. Tenant-scoped, RLS-enabled, service-role-only access.';

-- ─────────────────────────────────────────────────────────────────────────
-- service_products (many-to-many junction)
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists public.service_products (
  id                     uuid primary key default gen_random_uuid(),
  service_id             uuid not null references public.services(id) on delete cascade,
  product_id             uuid not null references public.products(id) on delete cascade,
  quantity_per_service   numeric(10,4) not null check (quantity_per_service > 0),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (service_id, product_id)
);

create index if not exists service_products_service_id_idx
  on public.service_products (service_id);

create index if not exists service_products_product_id_idx
  on public.service_products (product_id);

drop trigger if exists service_products_set_updated_at on public.service_products;
create trigger service_products_set_updated_at
  before update on public.service_products
  for each row execute function public.set_updated_at();

alter table public.service_products enable row level security;

drop policy if exists "service_products_service_role_all" on public.service_products;
create policy "service_products_service_role_all"
  on public.service_products
  for all
  to service_role
  using (true)
  with check (true);

comment on table public.service_products is
  'Many-to-many: which products are consumed per service and how much. quantity_per_service is numeric(10,4) to allow fractional units (e.g., 0.5 syringe). v1.29.3 derives services.cogs_per_service = sum(product.cost_per_unit * sp.quantity_per_service) when services.cogs_source = ''derived''. RLS-enabled, service-role-only access.';

-- ─────────────────────────────────────────────────────────────────────────
-- Verification (paste into a SQL editor tab after Run)
-- ─────────────────────────────────────────────────────────────────────────

-- select table_name, column_name, data_type, is_nullable
--   from information_schema.columns
--  where table_schema = 'public'
--    and table_name in ('products','services','service_products')
--  order by table_name, ordinal_position;

-- expected:
--   products: id, tenant_id, brand, category, unit_type, cost_per_unit,
--             sales_price_per_unit, manufacturer, notes, created_at, updated_at
--   services: id, tenant_id, name, category, service_price, cogs_per_service,
--             cogs_source, notes, created_at, updated_at
--   service_products: id, service_id, product_id, quantity_per_service,
--                     created_at, updated_at

-- select tablename, rowsecurity
--   from pg_tables
--  where schemaname = 'public'
--    and tablename in ('products','services','service_products');
-- expected: rowsecurity = true on all three.

notify pgrst, 'reload schema';
