-- ════════════════════════════════════════════════════════════════════════════
-- v1.56.0 — Per-service provider opt-out (scheduling_provider_services.offered)
-- ════════════════════════════════════════════════════════════════════════════
--
-- Lets a spa say "this provider does NOT perform this service" (e.g. an
-- aesthetician isn't offered for tox). Same delta-model as the price/duration
-- overrides — the row is the customization point:
--
--   • NO row                       → provider OFFERS the service, all inherited.
--   • row, offered = true          → offers it (and may carry price/duration overrides).
--   • row, offered = false         → does NOT offer it (excluded from public booking,
--                                    first-available, and best-deal).
--
-- So absence still means "offers, inherit everything" — no backfill needed, every
-- existing spa keeps offering every bookable service until an owner opts someone
-- out. A row now persists when offered=false even with no price/duration override.
--
-- Additive + reversible.
-- ════════════════════════════════════════════════════════════════════════════

alter table public.scheduling_provider_services
  add column if not exists offered boolean not null default true;

notify pgrst, 'reload schema';

-- ── Verify (run after applying) ──────────────────────────────────────────────
-- select column_name, data_type, column_default, is_nullable
--   from information_schema.columns
--  where table_schema = 'public' and table_name = 'scheduling_provider_services'
--    and column_name = 'offered';
--   → column_default 'true', is_nullable 'NO'.
