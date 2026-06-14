-- v2.32.0 — Weekly-resetting offer cap (the "Tox Tuesday" Skill engine)
-- ─────────────────────────────────────────────────────────────────────────
-- The offer engine already supports a weekday WINDOW (active_weekdays gates
-- isActive) and a redemption CAP (quantity_cap / redeemed_count, enforced by
-- the atomic increment_offer_redemption RPC). But the cap is LIFETIME: once
-- redeemed_count reaches quantity_cap it stays there forever. A recurring
-- weekly offer ("20 patients each Tox Tuesday") needs the cap to RESET every
-- week — which it can't today.
--
-- We add a small, additive, backward-compatible recurrence mode:
--   cap_period       'total' (default — today's lifetime behavior, untouched)
--                    | 'weekly' (the cap counts only THIS week's redemptions)
--   cap_period_start the Monday of the week the current weekly count belongs
--                    to (null until the first weekly redemption stamps it).
--
-- Existing rows (manufacturer + spa) default to cap_period='total', so their
-- behavior is byte-for-byte unchanged. Only offers authored as recurring get
-- 'weekly'.
--
-- The reset is LAZY (no cron): the atomic increment RPC, inside the row lock,
-- notices a stale cap_period_start (a prior week) and resets the count to 1 +
-- restamps the week. The pure isActive() matcher mirrors this — a stored count
-- whose cap_period_start is before this week's Monday reads as 0, so a weekly
-- offer correctly badges again at the start of a new week even before any
-- redemption has reset the row.

alter table public.manufacturer_promo_offers
  add column if not exists cap_period text not null default 'total'
    check (cap_period in ('total', 'weekly')),
  add column if not exists cap_period_start date;

-- ── Week-aware atomic increment ──────────────────────────────────────────
-- Replaces the v2.5.3 lifetime-only increment. The single UPDATE still takes
-- a row lock (serializing concurrent bookings on the same capped offer), so the
-- lost-update class the original fixed stays fixed.
--
-- p_week_start = the Monday (in the spa's own timezone) the caller computed for
-- "today". For 'total' offers, or when p_week_start is null, the math collapses
-- to the exact old behavior: coalesce(redeemed_count,0) + 1, cap_period_start
-- untouched. For 'weekly' offers:
--   • stale/unset week (cap_period_start is null OR < p_week_start) → this is
--     the first redemption of a new week: reset the count to 1 and stamp the
--     week start.
--   • current week → +1, restamp the start (idempotent — already this Monday).
--
-- Adding the second parameter changes the function's identity, so drop the old
-- 1-arg version first (leaving both would make a 1-arg call ambiguous).
drop function if exists public.increment_offer_redemption(uuid);

create or replace function public.increment_offer_redemption(
  p_offer_id uuid,
  p_week_start date default null
)
returns void
language sql
as $$
  update public.manufacturer_promo_offers
     set redeemed_count = case
           when cap_period = 'weekly'
                and p_week_start is not null
                and (cap_period_start is null or cap_period_start < p_week_start)
             then 1
           else coalesce(redeemed_count, 0) + 1
         end,
         cap_period_start = case
           when cap_period = 'weekly' and p_week_start is not null
             then p_week_start
           else cap_period_start
         end
   where id = p_offer_id;
$$;

-- Reload PostgREST so the new columns + RPC signature are live immediately.
notify pgrst, 'reload schema';

-- ── Verify (read-only) ──────────────────────────────────────────────────
-- Expect cap_period (default 'total') + cap_period_start present, and the RPC
-- now taking (uuid, date).
select column_name, data_type, column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'manufacturer_promo_offers'
  and column_name in ('cap_period', 'cap_period_start')
order by column_name;
