-- v2.145.0 — Per-tenant VERIFIED volume ladders.
--
-- When a portal-import batch carries a volume-tier ladder (read off the spa's
-- portal, e.g. Evolus Jeuveau 250/150/100/50/20/1 vials), we persist the REAL
-- per-rung prices for THAT tenant here — never in the shared cross-tenant
-- manufacturer_programs.tiers (which holds the generic estimate ladder for all
-- spas). Shape: { [brand_family]: { unitType, currentPrice, capturedAt,
-- tiers: [{ qty, minUnits, price }] } }. Drives the "Verified ladder" display
-- on Programs & tiers and future buy-optimization.

alter table public.tenant_manufacturer_tiers
  add column if not exists verified_ladders jsonb not null default '{}'::jsonb;
