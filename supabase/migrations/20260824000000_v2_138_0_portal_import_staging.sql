-- v2.138.0 — Vision portal-import: staging table for "read your portal Your
-- Price → flip Estimate costs to Verified."
--
-- WHY: Phase 3 auto-seeds every spa's catalog with ESTIMATE costs (tier math).
-- The highest-value upgrade is replacing those with the spa's REAL portal
-- "Your Price" — auth-walled, per-spa-unique, un-exportable numbers that only
-- vision-from-inside-the-spa can capture (see project_vision_ingestion_moat).
--
-- FLOW (two ingest mouths, ONE pipeline): owner uploads a screenshot in-app OR
-- forwards a photo by email → Claude vision extracts {product, price, unit
-- basis} rows → we fuzzy-match to the tenant's catalog → proposals land here as
-- a 'pending_review' batch → owner reviews + confirms in-app → matched rows get
-- cost_per_unit + cost_source='portal' (the green Verified badge from v2.135).
-- NEVER blind-writes; the human-verify step is the accuracy + GIGO backstop
-- (per-box ÷ units_per_box; Allergan box = 2 syringes).
--
-- rows jsonb = array of proposals, each:
--   { parsedName, parsedPrice, parsedUnitBasis ('box'|'unit'|'unknown'),
--     parsedSku, matchedProductId, matchedBrand, matchConfidence
--     ('high'|'medium'|'low'|'none'), currentCostPerUnit, currentCostSource,
--     unitsPerBox, proposedCostPerUnit }
--
-- ROLLBACK: drop table public.portal_import_batches;

create table if not exists public.portal_import_batches (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  source      text not null check (source in ('upload', 'email')),
  manufacturer text,                       -- owner-selected or vision-inferred
  status      text not null default 'pending_review'
              check (status in ('pending_review', 'applied', 'dismissed')),
  rows        jsonb not null default '[]'::jsonb,  -- parsed + matched proposals
  raw_extract text,                        -- raw vision JSON (debugging)
  note        text,
  created_at  timestamptz not null default now(),
  reviewed_at timestamptz
);

create index if not exists portal_import_batches_tenant_idx
  on public.portal_import_batches (tenant_id, status, created_at desc);

-- Server-only: all access is via service-role server fns (admin() client),
-- mirroring the manufacturer_* reference tables. RLS on + no policy = anon /
-- authenticated are blocked; the service role bypasses RLS.
alter table public.portal_import_batches enable row level security;

notify pgrst, 'reload schema';

-- Verify (paste after Run):
--   select count(*) from public.portal_import_batches;   -- expect 0
--   select column_name from information_schema.columns
--     where table_name = 'portal_import_batches' order by ordinal_position;
