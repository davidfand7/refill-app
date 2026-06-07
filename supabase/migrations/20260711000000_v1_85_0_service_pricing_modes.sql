-- v1.85.0 — Explicit pricing modes on services: Free, and fee-credited consults.
-- ─────────────────────────────────────────────────────────────────────────────
-- Closes the "$0 is ambiguous" gap:
--   • is_free   — the service is intentionally FREE / no-charge. Shows "Free",
--                 stays bookable, and the set-price guardrail skips it (it's not
--                 "unpriced"). Distinct from price 0 + is_free=false = unpriced.
--   • fee_credit — for a PAID service (typically a consult), the fee is applied
--                 toward a treatment. Renders a standard "applied toward your
--                 treatment" line on the booking page.

alter table public.services
  add column if not exists is_free   boolean not null default false,
  add column if not exists fee_credit boolean not null default false;

notify pgrst, 'reload schema';

-- Verify (run after applying):
-- select name, service_price, is_free, fee_credit from public.services limit 20;
