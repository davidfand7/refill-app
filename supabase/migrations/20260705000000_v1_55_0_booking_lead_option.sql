-- ════════════════════════════════════════════════════════════════════════════
-- v1.55.0 — Booking "lead option": which smart choice leads on the public page
-- ════════════════════════════════════════════════════════════════════════════
--
-- When a service is priced differently across providers, the patient booking
-- page offers TWO smart options: "First available" (soonest) and "Best deal"
-- (cheapest with an opening). This setting decides which one LEADS (shown first,
-- emphasized). DEFAULT = 'best_deal' — best deal trumps first available.
--
-- (When all providers price a service the same, only "First available" shows, so
-- this setting has no visible effect there.)
--
-- Additive + reversible: one nullable-with-default column on the existing
-- per-tenant scheduling_settings row.
-- ════════════════════════════════════════════════════════════════════════════

alter table public.scheduling_settings
  add column if not exists booking_lead_option text not null default 'best_deal'
    check (booking_lead_option in ('best_deal', 'first_available'));

notify pgrst, 'reload schema';

-- ── Verify (run after applying) ──────────────────────────────────────────────
-- select column_name, data_type, column_default, is_nullable
--   from information_schema.columns
--  where table_schema = 'public' and table_name = 'scheduling_settings'
--    and column_name = 'booking_lead_option';
--   → column_default should be 'best_deal'::text, is_nullable = 'NO'.
