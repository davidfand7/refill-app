-- v2.130.0 — Multi-manufacturer master catalog + loyalty/tier pricing.
--
-- WHY: every new tenant boots into an EMPTY products table — a blank-slate,
-- CSV-homework onboarding foreign to spa operators. This migration ships the
-- reference substrate so a spa can boot FULLY LOADED with real manufacturer
-- products + real numbers, then just pick their loyalty tier and the cost
-- layer snaps to their economics. Real portal "Your Price" (pulled via vision)
-- later OVERRIDES the tier estimate (project_vision_ingestion_moat).
--
-- Must be multi-manufacturer but SEGREGATED: each manufacturer has its own
-- program (Allergan APP vs Galderma ASPIRE vs Merz Xperience+), its own
-- packaging + tier math. They live together in one catalog (so the recommender
-- substitutes across brands) but their programs never bleed into each other.
--
-- WHAT SHIPS:
--   public.manufacturer_programs  — reference: one loyalty program per
--                                   manufacturer (tier matrix as jsonb).
--                                   Cross-tenant, like canonical_brands.
--   public.manufacturer_catalog   — reference: master SKU-level product book
--                                   per manufacturer (list_price, packaging,
--                                   brand_family, default sub-cat). The SEED
--                                   SOURCE for a tenant's catalog.
--   public.tenant_manufacturer_tiers — per-tenant: which tier the spa selected
--                                   for each manufacturer ("select your tier").
--   products + 6 cols             — list_price, brand_family, sku,
--                                   units_per_box, cost_source, catalog_ref_id.
--
-- COST MODEL: cost_per_unit stays the single source of truth for margin
-- (read in ~11 places + service-COGS). The tier resolver COMPUTES effective
-- cost from list_price × tiers and WRITES it, stamping cost_source. Vision/
-- portal "Your Price" overwrites it (cost_source='portal'). Re-resolving a
-- tier must never clobber a portal/manual cost.
--
-- SEED: Allergan APP fully (reference_allergan_app_tiers) + the complete
-- Allergan Advantage book (~60 SKUs, captured via vision from the price-list
-- screens). Galderma/Merz/Evolus/Revance seeded as status='stub' shells
-- ("coming soon — forward your price list").
--
-- ROLLBACK:
--   alter table public.products drop column if exists catalog_ref_id, ...;
--   drop table if exists public.tenant_manufacturer_tiers;
--   drop table if exists public.manufacturer_catalog;
--   drop table if exists public.manufacturer_programs;

-- ─────────────────────────────────────────────────────────────────────────
-- manufacturer_programs (reference, cross-tenant)
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists public.manufacturer_programs (
  id            uuid primary key default gen_random_uuid(),
  manufacturer  text not null unique check (manufacturer in (
                  'abbvie','galderma','evolus','merz',
                  'skinceuticals','eltamd','neocutis','obagi',
                  'revance','rha','sciton','abbvie-coolsculpting',
                  'generic','in_house'
                )),
  program_name  text not null,
  program_type  text,
  status        text not null default 'stub' check (status in ('active','stub')),
  tiers         jsonb not null default '{}'::jsonb,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

drop trigger if exists manufacturer_programs_set_updated_at on public.manufacturer_programs;
create trigger manufacturer_programs_set_updated_at
  before update on public.manufacturer_programs
  for each row execute function public.set_updated_at();

alter table public.manufacturer_programs enable row level security;

drop policy if exists "manufacturer_programs_read_authenticated" on public.manufacturer_programs;
create policy "manufacturer_programs_read_authenticated"
  on public.manufacturer_programs for select to authenticated using (true);

drop policy if exists "manufacturer_programs_service_role_all" on public.manufacturer_programs;
create policy "manufacturer_programs_service_role_all"
  on public.manufacturer_programs for all to service_role using (true) with check (true);

comment on table public.manufacturer_programs is
  'Reference: one loyalty/rebate program per manufacturer; tier matrix in tiers jsonb. Cross-tenant. status=stub renders "coming soon" until real data arrives via vision.';

-- ─────────────────────────────────────────────────────────────────────────
-- manufacturer_catalog (reference master product book, cross-tenant)
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists public.manufacturer_catalog (
  id                     uuid primary key default gen_random_uuid(),
  manufacturer           text not null check (manufacturer in (
                           'abbvie','galderma','evolus','merz',
                           'skinceuticals','eltamd','neocutis','obagi',
                           'revance','rha','sciton','abbvie-coolsculpting',
                           'generic','in_house'
                         )),
  brand_family           text,                       -- Hylacross/Vycross/Skincare/Surgery/null
  product_name           text not null,
  sku                    text,
  category               text not null,              -- products-compatible: tox/filler/skincare/other
  unit_type              text not null,              -- vial/syringe/bottle/session/other
  units_per_box          integer not null default 1, -- packaging divisor (Allergan filler box = 2 syringes)
  list_price             numeric(10,2) not null check (list_price >= 0),  -- per BOX (as the vendor shows)
  default_subcategory_area text,                     -- comma-joined canonical sub-cats (from face-map)
  status                 text not null default 'active' check (status in ('active','stub')),
  sort_order             integer,
  notes                  text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (manufacturer, sku)
);

create index if not exists manufacturer_catalog_manufacturer_idx
  on public.manufacturer_catalog (manufacturer);

drop trigger if exists manufacturer_catalog_set_updated_at on public.manufacturer_catalog;
create trigger manufacturer_catalog_set_updated_at
  before update on public.manufacturer_catalog
  for each row execute function public.set_updated_at();

alter table public.manufacturer_catalog enable row level security;

drop policy if exists "manufacturer_catalog_read_authenticated" on public.manufacturer_catalog;
create policy "manufacturer_catalog_read_authenticated"
  on public.manufacturer_catalog for select to authenticated using (true);

drop policy if exists "manufacturer_catalog_service_role_all" on public.manufacturer_catalog;
create policy "manufacturer_catalog_service_role_all"
  on public.manufacturer_catalog for all to service_role using (true) with check (true);

comment on table public.manufacturer_catalog is
  'Reference master SKU book per manufacturer (the seed source for a tenant catalog). list_price is per BOX; units_per_box divides to per-unit. Cross-tenant.';

-- ─────────────────────────────────────────────────────────────────────────
-- tenant_manufacturer_tiers (per-tenant tier selection)
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists public.tenant_manufacturer_tiers (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  manufacturer  text not null,
  selection     jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, manufacturer)
);

create index if not exists tenant_manufacturer_tiers_tenant_idx
  on public.tenant_manufacturer_tiers (tenant_id);

drop trigger if exists tenant_manufacturer_tiers_set_updated_at on public.tenant_manufacturer_tiers;
create trigger tenant_manufacturer_tiers_set_updated_at
  before update on public.tenant_manufacturer_tiers
  for each row execute function public.set_updated_at();

alter table public.tenant_manufacturer_tiers enable row level security;

drop policy if exists "tenant_manufacturer_tiers_service_role_all" on public.tenant_manufacturer_tiers;
create policy "tenant_manufacturer_tiers_service_role_all"
  on public.tenant_manufacturer_tiers for all to service_role using (true) with check (true);

comment on table public.tenant_manufacturer_tiers is
  'Per-tenant loyalty-tier selection per manufacturer ("select your tier"). selection jsonb e.g. {portfolioLevel, brandTiers:{Hylacross,Vycross,Skincare,Surgery}}.';

-- ─────────────────────────────────────────────────────────────────────────
-- products: add list_price / brand_family / sku / units_per_box /
--           cost_source / catalog_ref_id
-- ─────────────────────────────────────────────────────────────────────────

alter table public.products
  add column if not exists list_price     numeric(10,2) check (list_price is null or list_price >= 0),
  add column if not exists brand_family   text,
  add column if not exists sku            text,
  add column if not exists units_per_box  integer,
  add column if not exists cost_source    text not null default 'manual'
                             check (cost_source in ('tier_estimate','portal','manual','unset')),
  add column if not exists catalog_ref_id uuid references public.manufacturer_catalog(id) on delete set null;

create index if not exists products_catalog_ref_idx
  on public.products (catalog_ref_id) where catalog_ref_id is not null;

comment on column public.products.cost_source is
  'Provenance of cost_per_unit: tier_estimate (computed from loyalty tier), portal (real "Your Price" via vision), manual (owner-entered), unset (placeholder). Tier re-resolve never overwrites portal/manual.';

-- ═════════════════════════════════════════════════════════════════════════
-- Seed: manufacturer_programs
-- ═════════════════════════════════════════════════════════════════════════

-- Allergan Partner Privileges (APP) — full matrix (reference_allergan_app_tiers).
-- Stack: brandTier applied FIRST, then portfolio (multiplicative). $500 = 1 pt.
insert into public.manufacturer_programs (manufacturer, program_name, program_type, status, tiers, notes) values
  ('abbvie', 'Allergan Partner Privileges (APP)', 'portfolio_plus_brand_tier', 'active',
   '{
      "stacking": "brandTier_then_portfolio",
      "dollarsPerPoint": 500,
      "portfolioLevels": [
        {"key": "Silver",        "points": 50,   "discountPct": 0},
        {"key": "Gold",          "points": 250,  "discountPct": 0},
        {"key": "Gold Plus",     "points": 400,  "discountPct": 2},
        {"key": "Platinum",      "points": 600,  "discountPct": 4},
        {"key": "Platinum Plus", "points": 1000, "discountPct": 6},
        {"key": "Diamond",       "points": 1500, "discountPct": 8},
        {"key": "Diamond Plus",  "points": 2000, "discountPct": 10},
        {"key": "Premier",       "points": 2500, "discountPct": 12},
        {"key": "Premier Plus",  "points": 3500, "discountPct": 14}
      ],
      "brandTierThresholds": [
        {"tier": 1, "points": 25}, {"tier": 2, "points": 125}, {"tier": 3, "points": 300},
        {"tier": 4, "points": 500}, {"tier": 5, "points": 750}, {"tier": 6, "points": 1200},
        {"tier": 7, "points": 1800}
      ],
      "brandFamilies": {
        "Hylacross": [10, 20, 25, 30, 40, 45, 50],
        "Vycross":   [5, 10, 15, 20, 30, 35, 40],
        "Skincare":  [2, 5, 10, 15, 20, 25, 30],
        "Surgery":   [2, 5, 10, 15, 20, 25, 30]
      }
    }'::jsonb,
   'Brand families: Hylacross=Ultra/Ultra Plus; Vycross=Voluma/Vollure/Volbella/Volux/Skinvive; Skincare=SkinMedica/DiamondGlow/Latisse; Botox+Kybella earn portfolio only (no brand tier).'),
  ('galderma', 'Galderma ASPIRE / GAIN', 'loyalty', 'stub', '{}'::jsonb, 'Coming soon — forward your Galderma price list.'),
  ('merz',     'Merz Xperience+',        'loyalty', 'stub', '{}'::jsonb, 'Coming soon — forward your Merz price list.'),
  ('evolus',   'Evolus Rewards',         'loyalty', 'stub', '{}'::jsonb, 'Coming soon — forward your Evolus price list.'),
  ('revance',  'Revance RHA/Daxxify',    'loyalty', 'stub', '{}'::jsonb, 'Coming soon — forward your Revance price list.')
on conflict (manufacturer) do nothing;

-- ═════════════════════════════════════════════════════════════════════════
-- Seed: manufacturer_catalog — full Allergan Advantage book (vision-captured).
-- list_price = per BOX (as shown). units_per_box: Allergan filler box = 2
-- syringes; Botox/skincare = 1; Kybella = 4 vials. Sub-cats from Juvéderm map.
-- ═════════════════════════════════════════════════════════════════════════

insert into public.manufacturer_catalog
  (manufacturer, brand_family, product_name, sku, category, unit_type, units_per_box, list_price, default_subcategory_area, status, sort_order, notes) values
  -- ─── Injectables: BOTOX (tox) ───────────────────────────────────────────
  ('abbvie', null, 'Botox Cosmetic 100 Units (1 vial)', '92326', 'tox', 'vial', 1, 656.00, null, 'active', 10, 'Portfolio points only, no brand tier'),
  ('abbvie', null, 'Botox Cosmetic 50 Units (1 vial)',  '93919', 'tox', 'vial', 1, 362.00, null, 'active', 11, null),
  -- ─── Injectables: Juvéderm HYLACROSS (filler) ──────────────────────────
  ('abbvie', 'Hylacross', 'Juvederm Ultra Plus XC 0.55 CC', '96209', 'filler', 'syringe', 2, 574.00, 'NLF', 'active', 20, null),
  ('abbvie', 'Hylacross', 'Juvederm Ultra Plus XC 1.0 ML',  '94155', 'filler', 'syringe', 2, 698.00, 'NLF', 'active', 21, null),
  ('abbvie', 'Hylacross', 'Juvederm Ultra XC 0.55 CC',      '96207', 'filler', 'syringe', 2, 574.00, 'Lips', 'active', 22, null),
  ('abbvie', 'Hylacross', 'Juvederm Ultra XC 1.0 ML',       '94154', 'filler', 'syringe', 2, 698.00, 'Lips', 'active', 23, null),
  -- ─── Injectables: Juvéderm VYCROSS (filler) ─────────────────────────────
  ('abbvie', 'Vycross', 'Juvederm Volbella XC 0.55 ML', '96183', 'filler', 'syringe', 2, 410.00, 'Undereyes / Tear trough, Lips, Liplines', 'active', 24, null),
  ('abbvie', 'Vycross', 'Juvederm Volbella XC 1.0 ML',  '96181', 'filler', 'syringe', 2, 752.00, 'Undereyes / Tear trough, Lips, Liplines', 'active', 25, null),
  ('abbvie', 'Vycross', 'Juvederm Vollure XC 1.0 ML',   '95661', 'filler', 'syringe', 2, 752.00, 'NLF', 'active', 26, null),
  ('abbvie', 'Vycross', 'Juvederm Voluma XC 1.0 ML',    '94640', 'filler', 'syringe', 2, 833.00, 'Mid-face, Chin', 'active', 27, null),
  ('abbvie', 'Vycross', 'Juvederm Volux XC',            '20073770', 'filler', 'syringe', 2, 860.00, 'Jawline', 'active', 28, 'Tier-banded (<6) on portal'),
  ('abbvie', 'Vycross', 'Skinvive by Juvederm',         '98307', 'filler', 'syringe', 2, 380.00, null, 'active', 29, 'Skin-quality booster — ungrouped (never substitutes for structural HA)'),
  -- ─── Injectables: Kybella + cannulas ────────────────────────────────────
  ('abbvie', null, 'Kybella 10 mg/ml 2 ml (4 vials)', '95706', 'other', 'vial', 4, 1200.00, null, 'active', 30, 'Deoxycholic acid; portfolio points only'),
  ('abbvie', null, 'Juvederm Voluma XC TSK Cannula Steriglide (4 pack)',  '96688', 'other', 'other', 1, 34.00, null, 'active', 40, 'Supply'),
  ('abbvie', null, 'Juvederm Voluma XC TSK Cannula Steriglide (10 pack)', '96689', 'other', 'other', 1, 72.00, null, 'active', 41, 'Supply'),
  -- ─── SkinMedica (skincare; brand_family Skincare) ───────────────────────
  ('abbvie', 'Skincare', 'AHA/BHA Exfoliating Cream 1.7 fl oz',   '20086693', 'skincare', 'bottle', 1, 24.00, null, 'active', 100, null),
  ('abbvie', 'Skincare', 'AHA/BHA Exfoliating Cleanser 6 oz',     '20086695', 'skincare', 'bottle', 1, 24.00, null, 'active', 101, null),
  ('abbvie', 'Skincare', 'Dermal Repair Cream 1.7 fl oz',         '20086508', 'skincare', 'bottle', 1, 67.00, null, 'active', 102, null),
  ('abbvie', 'Skincare', 'Essential Defense Everyday Clear SPF 47 1.7 fl oz', '20086597', 'skincare', 'bottle', 1, 20.00, null, 'active', 103, null),
  ('abbvie', 'Skincare', 'Essential Defense Mineral Shield SPF 32 Tinted 1.7 fl oz', '20087547', 'skincare', 'bottle', 1, 20.00, null, 'active', 104, null),
  ('abbvie', 'Skincare', 'Essential Defense Mineral Shield SPF 35/PA++++', '20087377', 'skincare', 'bottle', 1, 20.00, null, 'active', 105, null),
  ('abbvie', 'Skincare', 'Even & Correct Advanced Brightening 1.7 fl oz', '20086722', 'skincare', 'bottle', 1, 89.00, null, 'active', 106, null),
  ('abbvie', 'Skincare', 'Even & Correct Brightening Treatment Pads', '20086468', 'skincare', 'bottle', 1, 30.00, null, 'active', 107, null),
  ('abbvie', 'Skincare', 'Even & Correct Dark Spot Cream 0.5 fl oz', '20086697', 'skincare', 'bottle', 1, 44.00, null, 'active', 108, null),
  ('abbvie', 'Skincare', 'Facial Cleanser 6.0 fl oz',             '20087549', 'skincare', 'bottle', 1, 20.00, null, 'active', 109, null),
  ('abbvie', 'Skincare', 'Firm & Tone Body Lotion 6.0 fl oz',     '20087551', 'skincare', 'bottle', 1, 82.50, null, 'active', 110, null),
  ('abbvie', 'Skincare', 'HA5 Hydra Collagen Hydrating Foaming Cleanser 5 oz', '20084480', 'skincare', 'bottle', 1, 24.00, null, 'active', 111, null),
  ('abbvie', 'Skincare', 'HA5 Hydra Collagen Hydrator 1.7 fl oz', '20079961', 'skincare', 'bottle', 1, 96.00, null, 'active', 112, null),
  ('abbvie', 'Skincare', 'HA5 Hydra Collagen Facial Mist 3.4 oz', '20086624', 'skincare', 'bottle', 1, 29.00, null, 'active', 113, null),
  ('abbvie', 'Skincare', 'HA5 Hydra Collagen Facial Mist 1 oz Travel', '20091752', 'skincare', 'bottle', 1, 12.00, null, 'active', 114, null),
  ('abbvie', 'Skincare', 'HA5 Hydra Collagen Water Burst Moisturizer 1.7 oz', '20084846', 'skincare', 'bottle', 1, 39.00, null, 'active', 115, null),
  ('abbvie', 'Skincare', 'HA5 Smooth and Plump Lip System',       '95996', 'skincare', 'bottle', 1, 34.00, null, 'active', 116, null),
  ('abbvie', 'Skincare', 'Illuminize Peel Multipack',             '94943', 'skincare', 'bottle', 1, 149.00, null, 'active', 117, null),
  ('abbvie', 'Skincare', 'Instant Bright Eye Cream 0.5 fl oz',    '20086701', 'skincare', 'bottle', 1, 46.00, null, 'active', 118, null),
  ('abbvie', 'Skincare', 'Instant Bright Eye Masks Set of 6',     '96722', 'skincare', 'bottle', 1, 25.00, null, 'active', 119, null),
  ('abbvie', 'Skincare', 'Lumivive System',                       '96202', 'skincare', 'bottle', 1, 134.00, null, 'active', 120, null),
  ('abbvie', 'Skincare', 'Neck Correct Neck and Décolleté Cream 1.7 fl oz', '20086704', 'skincare', 'bottle', 1, 67.50, null, 'active', 121, null),
  ('abbvie', 'Skincare', 'Pore Purifying Acne Treatment 1.7 fl oz', '20086593', 'skincare', 'bottle', 1, 44.00, null, 'active', 122, null),
  ('abbvie', 'Skincare', 'Pore Purifying Gel Cleanser 6 fl oz',   '20086375', 'skincare', 'bottle', 1, 24.00, null, 'active', 123, null),
  ('abbvie', 'Skincare', 'Post Procedure Repair Complex 1 oz',    '20084177', 'skincare', 'bottle', 1, 92.50, null, 'active', 124, null),
  ('abbvie', 'Skincare', 'Procedure 360 System',                  '96313', 'skincare', 'bottle', 1, 163.00, null, 'active', 125, null),
  ('abbvie', 'Skincare', 'Rejuvenative Moisturizer 2.0 fl oz',    '20087553', 'skincare', 'bottle', 1, 30.00, null, 'active', 126, null),
  ('abbvie', 'Skincare', 'Rejuvenize Peel Multipack',             '94941', 'skincare', 'bottle', 1, 398.00, null, 'active', 127, null),
  ('abbvie', 'Skincare', 'Replenish Hydrating Cream',             '95274', 'skincare', 'bottle', 1, 34.00, null, 'active', 128, null),
  ('abbvie', 'Skincare', 'Restorative Ointment 2.6 oz',           '20084176', 'skincare', 'bottle', 1, 26.00, null, 'active', 129, null),
  ('abbvie', 'Skincare', 'Retinol Complex 0.25 1.0 fl oz',        '20086707', 'skincare', 'bottle', 1, 32.00, null, 'active', 130, null),
  ('abbvie', 'Skincare', 'Retinol Complex 0.5 1.0 fl oz',         '20086709', 'skincare', 'bottle', 1, 40.00, null, 'active', 131, null),
  ('abbvie', 'Skincare', 'Retinol Complex 1.0 1.0 fl oz',         '20086711', 'skincare', 'bottle', 1, 48.00, null, 'active', 132, null),
  ('abbvie', 'Skincare', 'Scar Recovery Gel with Centelline 2.0 oz', '94939', 'skincare', 'bottle', 1, 53.00, null, 'active', 133, null),
  ('abbvie', 'Skincare', 'The Favorites Collection',              '20083065', 'skincare', 'bottle', 1, 257.50, null, 'active', 134, null),
  ('abbvie', 'Skincare', 'The SkinMedica Method Collection',      '20084847', 'skincare', 'bottle', 1, 157.50, null, 'active', 135, null),
  ('abbvie', 'Skincare', 'TNS Ceramide Treatment Cream',          '20087539', 'skincare', 'bottle', 1, 36.00, null, 'active', 136, null),
  ('abbvie', 'Skincare', 'TNS Recovery Complex 1.0 fl oz',        '20086712', 'skincare', 'bottle', 1, 115.00, null, 'active', 137, null),
  ('abbvie', 'Skincare', 'TNS Advanced+ Serum 1.0 fl oz',         '20086513', 'skincare', 'bottle', 1, 147.50, null, 'active', 138, null),
  ('abbvie', 'Skincare', 'TNS Eye Repair 0.5 fl oz',              '20087541', 'skincare', 'bottle', 1, 53.00, null, 'active', 139, null),
  ('abbvie', 'Skincare', 'Total Defense + Repair SPF 34/PA++++',  '95494', 'skincare', 'bottle', 1, 35.00, null, 'active', 140, null),
  ('abbvie', 'Skincare', 'Ultra Sheer Moisturizer',              '94952', 'skincare', 'bottle', 1, 30.00, null, 'active', 141, null),
  ('abbvie', 'Skincare', 'Vitalize Peel Multipack',              '94942', 'skincare', 'bottle', 1, 256.00, null, 'active', 142, null),
  ('abbvie', 'Skincare', 'Vitamin C+E Complex 1 fl oz',          '20086626', 'skincare', 'bottle', 1, 53.00, null, 'active', 143, null),
  -- ─── Latisse (Skincare brand tier; Rx eyelash) ──────────────────────────
  ('abbvie', 'Skincare', 'Latisse 0.03% 5 ml (140 applicators)', '94511', 'skincare', 'bottle', 1, 114.99, null, 'active', 150, null),
  ('abbvie', 'Skincare', 'Latisse 0.03% 3 ml (70 applicators)',  '94847', 'skincare', 'bottle', 1, 94.99, null, 'active', 151, null),
  -- ─── Diamond Glow infusion serums (Skincare brand tier) ─────────────────
  ('abbvie', 'Skincare', 'DG HA5 Pro-Infusion Serum w. O3 12ct',     '98418', 'skincare', 'bottle', 1, 420.00, null, 'active', 160, null),
  ('abbvie', 'Skincare', 'DG TNS Advanced+ Serum w. O3 12ct',        '96973', 'skincare', 'bottle', 1, 420.00, null, 'active', 161, null),
  ('abbvie', 'Skincare', 'DG Vitamin C Serum w. O3 12ct',            '96886', 'skincare', 'bottle', 1, 360.00, null, 'active', 162, null),
  ('abbvie', 'Skincare', 'DG Even & Correct Brightening Serum 12ct', '98549', 'skincare', 'bottle', 1, 420.00, null, 'active', 163, null)
on conflict (manufacturer, sku) do nothing;

notify pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────────────────
-- Verify (paste after Run):
--   select status, count(*) from public.manufacturer_catalog group by status;
--   -- expect: active = 65 (all abbvie)
--   select manufacturer, status, program_name from public.manufacturer_programs order by manufacturer;
--   -- expect: abbvie=active, galderma/merz/evolus/revance=stub
--   select column_name from information_schema.columns
--     where table_name='products' and column_name in
--     ('list_price','brand_family','sku','units_per_box','cost_source','catalog_ref_id');
--   -- expect: all 6
-- ─────────────────────────────────────────────────────────────────────────
