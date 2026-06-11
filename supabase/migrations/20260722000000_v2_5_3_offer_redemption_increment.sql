-- v2.5.3 — Atomic offer-redemption increment
-- ─────────────────────────────────────────────────────────────────────────
-- recordCrossSellWin counted a capped offer's redemption with a read-modify-
-- write (load redeemed_count, +1, write back). Two concurrent bookings on the
-- same capped offer both read the same value and both write back the same +1,
-- losing one — so a "first 20" cap drifts and under-counts under load.
--
-- The fix is a single atomic UPDATE (the row lock serializes concurrent
-- increments), exposed as an RPC the server calls instead of the read-write.
-- The increment is still a soft visibility limit (the offer stops badging once
-- the count reaches the cap); the booking + $5 win are unaffected — this only
-- makes the COUNT correct.

create or replace function public.increment_offer_redemption(p_offer_id uuid)
returns void
language sql
as $$
  update public.manufacturer_promo_offers
     set redeemed_count = coalesce(redeemed_count, 0) + 1
   where id = p_offer_id;
$$;

-- Reload PostgREST so the RPC is callable immediately.
notify pgrst, 'reload schema';

-- ── Verify (read-only) ──────────────────────────────────────────────────
select proname, pg_get_function_identity_arguments(oid) as args
from pg_proc
where proname = 'increment_offer_redemption';
