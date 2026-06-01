-- v1.30.0 — Canonical Brands registry (system-wide cross-tenant reference).
--
-- WHY: regex-based name inference (v1.29.4.x) misses sub-brand families
-- like Restylane Refyne / Defyne / Kysse / Lyft, Juvederm Voluma / Vollure /
-- Volbella, RHA 2/3/4, and laser variants without explicit keywords.
-- Grasshopper&rsquo;s call (2026-06-01): maintain a canonical brand database
-- the platform owns; CSV imports match against it; new brands surface
-- as suggestions for admin to promote. Every spa benefits from the
-- accumulating registry — the cross-tenant intelligence flywheel
-- predicted by project_data_intelligence_thesis fires for the first
-- time.
--
-- WHAT SHIPS:
--   public.canonical_brands (system-wide, NOT tenant-scoped):
--     display_name  text             — canonical product/brand name
--     aliases       text[]           — case-insensitive name variants
--     category      text (CHECK)     — service-taxonomy category
--     manufacturer  text (CHECK)     — manufacturer enum
--     unit_type     text (CHECK)     — vial / syringe / bottle / session / other
--     notes         text             — admin-curated description
--
-- AUTH: RLS enabled. authenticated role gets SELECT (every spa can read
-- the registry). service_role gets full access (admin writes via server
-- fns or Supabase dashboard).
--
-- WHAT THIS DOESN&rsquo;T FIX:
--   - Admin CRUD UI (admin pastes SQL or uses Supabase dashboard at v1.30.0;
--     proper /app/admin/canonical-brands surface is queued for v1.30.x).
--   - Suggest-new-brand workflow from import preview (queued).
--   - Tenant-level brand overrides (deferred — single global registry now).
--   - Auto-link products to canonical brands (queued for products-CSV import).
--
-- ROLLBACK: drop table public.canonical_brands;

create table if not exists public.canonical_brands (
  id            uuid primary key default gen_random_uuid(),
  display_name  text not null,
  aliases       text[] not null default '{}',
  category      text not null check (category in (
                  'tox','filler','laser','facial','skincare','other'
                )),
  manufacturer  text check (manufacturer in (
                  'abbvie','galderma','evolus','merz',
                  'skinceuticals','eltamd','neocutis','obagi',
                  'revance','rha','sciton','abbvie-coolsculpting',
                  'generic','in_house'
                )),
  unit_type     text not null check (unit_type in (
                  'vial','syringe','bottle','session','other'
                )),
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index if not exists canonical_brands_display_name_lower_idx
  on public.canonical_brands (lower(display_name));
create index if not exists canonical_brands_category_idx
  on public.canonical_brands (category);
create index if not exists canonical_brands_manufacturer_idx
  on public.canonical_brands (manufacturer)
  where manufacturer is not null;

drop trigger if exists canonical_brands_set_updated_at on public.canonical_brands;
create trigger canonical_brands_set_updated_at
  before update on public.canonical_brands
  for each row execute function public.set_updated_at();

alter table public.canonical_brands enable row level security;

drop policy if exists "canonical_brands_read_authenticated" on public.canonical_brands;
create policy "canonical_brands_read_authenticated"
  on public.canonical_brands
  for select
  to authenticated
  using (true);

drop policy if exists "canonical_brands_service_role_all" on public.canonical_brands;
create policy "canonical_brands_service_role_all"
  on public.canonical_brands
  for all
  to service_role
  using (true)
  with check (true);

comment on table public.canonical_brands is
  'System-wide registry of aesthetics-industry product/service brands. CSV imports + recategorize sweeps match against display_name + aliases (case-insensitive, word-boundary). Cross-tenant: every spa benefits. Admin-curated.';

-- ═════════════════════════════════════════════════════════════════════════
-- Seed: ~50 brands covering the major aesthetics market.
-- on conflict (lower(display_name)) do nothing — safe to re-run.
-- ═════════════════════════════════════════════════════════════════════════

insert into public.canonical_brands (display_name, aliases, category, manufacturer, unit_type, notes) values
  -- ─── Tox (5) ─────────────────────────────────────────────────────────
  ('Botox',           ARRAY['Botox','Botox Cosmetic','Botox 100u','BTX','Botulinum toxin','OnabotulinumtoxinA'], 'tox',     'abbvie',   'vial', '100u vial typical'),
  ('Dysport',         ARRAY['Dysport','AbobotulinumtoxinA'],                                                     'tox',     'galderma', 'vial', null),
  ('Xeomin',          ARRAY['Xeomin','IncobotulinumtoxinA'],                                                     'tox',     'merz',     'vial', null),
  ('Jeuveau',         ARRAY['Jeuveau','Newtox','#Newtox','PrabotulinumtoxinA'],                                  'tox',     'evolus',   'vial', null),
  ('Daxxify',         ARRAY['Daxxify','Daxi','DaxibotulinumtoxinA'],                                             'tox',     'revance',  'vial', null),

  -- ─── Filler / Juvederm line (6) ──────────────────────────────────────
  ('Juvederm Ultra',       ARRAY['Juvederm Ultra','Juvederm Ultra XC'],                          'filler', 'abbvie', 'syringe', null),
  ('Juvederm Ultra Plus',  ARRAY['Juvederm Ultra Plus','Juvederm Ultra Plus XC','Ultra Plus'],   'filler', 'abbvie', 'syringe', null),
  ('Juvederm Voluma',      ARRAY['Voluma','Voluma XC','Juvederm Voluma','Juvederm Voluma XC'],   'filler', 'abbvie', 'syringe', null),
  ('Juvederm Vollure',     ARRAY['Vollure','Vollure XC','Juvederm Vollure'],                     'filler', 'abbvie', 'syringe', null),
  ('Juvederm Volbella',    ARRAY['Volbella','Volbella XC','Juvederm Volbella'],                  'filler', 'abbvie', 'syringe', null),
  ('Juvederm Volux',       ARRAY['Volux','Juvederm Volux'],                                      'filler', 'abbvie', 'syringe', null),

  -- ─── Filler / Restylane line (8) ─────────────────────────────────────
  ('Restylane',         ARRAY['Restylane','Restylane-L'],                              'filler', 'galderma', 'syringe', 'Base product'),
  ('Restylane Lyft',    ARRAY['Lyft','Restylane Lyft','Perlane'],                      'filler', 'galderma', 'syringe', 'Formerly Perlane'),
  ('Restylane Silk',    ARRAY['Silk','Restylane Silk'],                                'filler', 'galderma', 'syringe', null),
  ('Restylane Refyne',  ARRAY['Refyne','Restylane Refyne','Restylane-Refyne'],         'filler', 'galderma', 'syringe', null),
  ('Restylane Defyne',  ARRAY['Defyne','Restylane Defyne','Restylane-Defyne'],         'filler', 'galderma', 'syringe', null),
  ('Restylane Kysse',   ARRAY['Kysse','Restylane Kysse'],                              'filler', 'galderma', 'syringe', null),
  ('Restylane Contour', ARRAY['Restylane Contour','Contour'],                          'filler', 'galderma', 'syringe', null),
  ('Restylane Eyelight',ARRAY['Eyelight','Restylane Eyelight'],                        'filler', 'galderma', 'syringe', null),

  -- ─── Filler / RHA Collection (5) ─────────────────────────────────────
  ('RHA 2',             ARRAY['RHA 2','RHA2'],                       'filler', 'rha', 'syringe', null),
  ('RHA 3',             ARRAY['RHA 3','RHA3'],                       'filler', 'rha', 'syringe', null),
  ('RHA 4',             ARRAY['RHA 4','RHA4'],                       'filler', 'rha', 'syringe', null),
  ('RHA Redensity',     ARRAY['RHA Redensity','Redensity'],          'filler', 'rha', 'syringe', null),
  ('Versa',             ARRAY['Versa','Revanesse Versa'],            'filler', 'generic', 'syringe', 'Prollenium'),

  -- ─── Filler / Merz + Galderma extras (3) ─────────────────────────────
  ('Belotero Balance',  ARRAY['Belotero','Belotero Balance'],        'filler', 'merz',     'syringe', null),
  ('Radiesse',          ARRAY['Radiesse','Radiesse Plus'],           'filler', 'merz',     'syringe', null),
  ('Sculptra',          ARRAY['Sculptra','Sculptra Aesthetic'],      'filler', 'galderma', 'vial',    'Reconstituted'),

  -- ─── Laser (9) ───────────────────────────────────────────────────────
  ('BBL',                 ARRAY['BBL','BroadBand Light','Forever Young BBL','BBL Hero'],  'laser', 'sciton',  'session', 'BroadBand Light'),
  ('Halo',                ARRAY['Halo','Halo Laser','Halo Hybrid Fractional'],            'laser', 'sciton',  'session', null),
  ('Moxi',                ARRAY['Moxi','Moxi Laser'],                                     'laser', 'sciton',  'session', null),
  ('Fraxel',              ARRAY['Fraxel','Fraxel Dual','Fraxel Re:Pair'],                 'laser', 'generic', 'session', 'Solta/Bausch'),
  ('CO2 Fractional',      ARRAY['CO2','CO2 Fractional','CO2 Laser','Fractional CO2','Co2 fractional'], 'laser', 'generic', 'session', null),
  ('Thulium',             ARRAY['Thulium','Thulium Laser','LaseMD','LaseMD Ultra'],       'laser', 'generic', 'session', null),
  ('IPL',                 ARRAY['IPL','Intense Pulsed Light'],                            'laser', 'generic', 'session', null),
  ('Morpheus8',           ARRAY['Morpheus','Morpheus8','RF Microneedling','RF Microneedle'], 'laser', 'generic', 'session', 'InMode'),
  ('Laser Hair Removal',  ARRAY['Laser Hair Removal','LHR'],                              'laser', 'generic', 'session', null),

  -- ─── Skincare / SkinCeuticals (3) ────────────────────────────────────
  ('SkinCeuticals C E Ferulic', ARRAY['C E Ferulic','CE Ferulic','C+E Ferulic','SkinCeuticals CE Ferulic'], 'skincare', 'skinceuticals', 'bottle', null),
  ('SkinCeuticals Phloretin CF',ARRAY['Phloretin CF','SkinCeuticals Phloretin'],                            'skincare', 'skinceuticals', 'bottle', null),
  ('SkinCeuticals HA Intensifier', ARRAY['HA Intensifier','SkinCeuticals HA Intensifier'],                  'skincare', 'skinceuticals', 'bottle', null),

  -- ─── Skincare / EltaMD (3) ───────────────────────────────────────────
  ('EltaMD UV Clear',     ARRAY['UV Clear','EltaMD UV Clear','Elta UV Clear'],            'skincare', 'eltamd', 'bottle', null),
  ('EltaMD UV Daily',     ARRAY['UV Daily','EltaMD UV Daily'],                            'skincare', 'eltamd', 'bottle', null),
  ('EltaMD UV Sport',     ARRAY['UV Sport','EltaMD UV Sport'],                            'skincare', 'eltamd', 'bottle', null),

  -- ─── Skincare / Other major lines (6) ────────────────────────────────
  ('ZO Daily Power Defense', ARRAY['ZO Daily Power Defense','Daily Power Defense'],       'skincare', 'generic', 'bottle', 'ZO Skin Health'),
  ('Obagi Nu-Derm',          ARRAY['Obagi Nu-Derm','Nu-Derm'],                            'skincare', 'obagi',   'bottle', null),
  ('Neocutis Bio-Cream',     ARRAY['Bio-Cream','Neocutis Bio-Cream','Bio-Serum'],         'skincare', 'neocutis','bottle', null),
  ('Alastin Restorative',    ARRAY['Alastin Restorative','Restorative Skin Complex'],     'skincare', 'generic', 'bottle', null),
  ('Revision Nectifirm',     ARRAY['Nectifirm','Revision Nectifirm'],                     'skincare', 'generic', 'bottle', null),
  ('Anthelios',              ARRAY['Anthelios','Laroche-Posay Anthelios','La Roche-Posay Anthelios'], 'skincare', 'generic', 'bottle', 'La Roche-Posay'),

  -- ─── Facial / Procedure (4) ──────────────────────────────────────────
  ('HydraFacial',     ARRAY['HydraFacial','Hydra Facial'],            'facial', 'generic', 'session', null),
  ('Diamond Glow',    ARRAY['Diamond Glow','DiamondGlow'],            'facial', 'abbvie',  'session', 'AbbVie/Allergan'),
  ('AquaGold',        ARRAY['AquaGold','AquaGold Fine Touch'],        'facial', 'generic', 'session', null),
  ('Dermaplane',      ARRAY['Dermaplane','Dermaplaning'],             'facial', 'generic', 'session', null)

on conflict (lower(display_name)) do nothing;

notify pgrst, 'reload schema';

-- Verify
-- select category, count(*) from public.canonical_brands group by category order by category;
-- expected: tox=5, filler=22, laser=9, skincare=12, facial=4 (total 52)
