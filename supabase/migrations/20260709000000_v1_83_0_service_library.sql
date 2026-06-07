-- v1.83.0 — Service Library (P1 schema + P0 first seed slice).
-- ─────────────────────────────────────────────────────────────────────────────
-- A global, tenant-agnostic catalog of common med-spa services. Owners CURATE
-- from it (select what they offer) — onboarding becomes curation, not data entry.
-- COPY-ON-SELECT: picking an entry creates a normal tenant `services` row they
-- own/edit/price/reorder; this table is a template, never the live source.
--   • categories use our slugs for built-ins (tox/filler/laser/facial) and
--     readable names for the rest (they become the tenant's category on select).
--   • NO prices seeded (regional pricing varies too much) — duration only.
--   • sort_order gives a sensible "most-popular-first" order within a category.

create table if not exists public.service_library (
  id                   uuid        primary key default gen_random_uuid(),
  category             text        not null,
  name                 text        not null,
  default_duration_min integer     not null default 30 check (default_duration_min between 5 and 1440),
  suggested_price      numeric,                      -- nullable by design (left blank)
  description          text,
  sort_order           integer     not null default 0,
  is_active            boolean     not null default true,
  created_at           timestamptz not null default now(),
  unique (category, name)
);

create index if not exists service_library_category_idx
  on public.service_library (category, sort_order, name);

alter table public.service_library enable row level security;
do $$ begin
  create policy "service_role_service_library"
    on public.service_library for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

-- Provenance on tenant copies: which library entry a service came from (null =
-- custom / pre-library). Cheap now; powers a future "new in library" prompt.
alter table public.services
  add column if not exists library_id uuid;

-- ── P0: first seed slice (most-popular services) ─────────────────────────────
insert into public.service_library (category, name, default_duration_min, sort_order) values
  -- Tox (neuromodulators)
  ('tox','Tox (any)',15,1),('tox','Botox',15,2),('tox','Dysport',15,3),
  ('tox','Jeuveau',15,4),('tox','Xeomin',15,5),('tox','Daxxify',15,6),
  -- Filler
  ('filler','Filler (any)',30,10),('filler','Lip Filler',30,11),('filler','Cheek Filler',30,12),
  ('filler','Jawline Filler',30,13),('filler','Chin Filler',30,14),('filler','Under-eye Filler',30,15),
  ('filler','Nasolabial Fold Filler',30,16),('filler','Sculptra',45,17),
  -- Laser (resurfacing / treatment)
  ('laser','CO2 Fractional - Face',60,20),('laser','Laser Genesis',30,21),('laser','Vascular Laser',30,22),
  ('laser','Thulium - Face',45,23),('laser','Pico Laser',30,24),
  -- Facials
  ('facial','Signature Facial',60,30),('facial','HydraFacial',45,31),('facial','Dermaplane',30,32),
  ('facial','Microneedling',45,33),('facial','Microneedling w/ PRP',60,34),
  -- IPL / BBL
  ('IPL/BBL','BBL - Full Face',30,40),('IPL/BBL','BBL - Partial Face',30,41),('IPL/BBL','BBL - Neck',30,42),
  ('IPL/BBL','BBL - Chest',45,43),('IPL/BBL','BBL - Hands',30,44),('IPL/BBL','BBL - Spot Treatment',15,45),
  -- Laser Hair Removal
  ('Laser Hair Removal','LHR - Face',15,50),('Laser Hair Removal','LHR - Underarms',15,51),
  ('Laser Hair Removal','LHR - Bikini',30,52),('Laser Hair Removal','LHR - Brazilian',30,53),
  ('Laser Hair Removal','LHR - Lower Legs',30,54),('Laser Hair Removal','LHR - Full Legs',45,55),
  ('Laser Hair Removal','LHR - Back',45,56),
  -- RF Microneedling
  ('RF Microneedling','RF Micro - Face',45,60),('RF Microneedling','RF Micro - Neck',30,61),
  ('RF Microneedling','RF Micro - Face + Neck',60,62),('RF Microneedling','RF Micro - Chest',45,63),
  -- Body Contouring
  ('Body Contouring','CoolSculpting - Small Area',45,70),('Body Contouring','CoolSculpting - Large Area',60,71),
  ('Body Contouring','EmSculpt',30,72),('Body Contouring','Skin Tightening (HIFU)',60,73),
  -- Peels
  ('Peels','Chemical Peel',30,80),('Peels','VI Peel',30,81),('Peels','Custom Peel',30,82),
  -- Wellness
  ('Wellness','IV Drip',45,90),('Wellness','B12 Injection',15,91),('Wellness','Weight Management Consult',30,92),
  -- Consults
  ('Consults','New Client Consultation',30,100),('Consults','Treatment Consultation',15,101)
on conflict (category, name) do nothing;

notify pgrst, 'reload schema';

-- Verify (run after applying):
-- select category, count(*) from public.service_library group by category order by 1;
-- select name, default_duration_min from public.service_library where category = 'tox' order by sort_order;
