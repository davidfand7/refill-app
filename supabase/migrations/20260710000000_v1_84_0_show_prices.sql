-- v1.84.0 — Per-practice "show prices on booking page" toggle.
-- ─────────────────────────────────────────────────────────────────────────────
-- Not every practice displays pricing publicly. When OFF, the patient booking
-- page hides all prices and drops the price-based "Best value" option. When ON,
-- a bookable service still at $0 is treated as UNPRICED — hidden from the public
-- page and flagged owner-side ("Set price") so nothing goes live unpriced.

alter table public.scheduling_settings
  add column if not exists show_prices boolean not null default true;

notify pgrst, 'reload schema';

-- Verify (run after applying):
-- select tenant_id, show_prices from public.scheduling_settings;
