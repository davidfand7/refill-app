-- v340 — Scheduled follow-up cadence (the "5 nudges suggested" daily digest)
--
-- Rep eyes stay in the loop: nudges are never auto-sent. The rep opens
-- /app/lizzie/cadence, sees a list of stale outreached rows with
-- Liz-drafted nudge bodies, and Sends or Dismisses each one.
--
-- "Stale" = state='outreached' AND last_touched_at < now() - 5 days.
-- A dismiss is a soft-hide on the state row: set nudge_dismissed_at, the
-- digest query filters WHERE nudge_dismissed_at IS NULL. If the rep wants
-- to nudge an account they previously dismissed, they can just send a
-- fresh blast from the account or promo detail page — which will refresh
-- last_touched_at and leave the dismissed flag in place (which is fine —
-- the digest is for AI-suggested follow-ups, not the only path to send).
--
-- A successful nudge send naturally bumps last_touched_at via the
-- existing v336 pattern, so the row falls off the digest the same way
-- a manual blast would.
--
-- The existing v336 partial index on
--   (user_id, last_touched_at) WHERE state IN ('targeted', 'outreached', ...)
-- already covers the hot path for digest queries — no new index needed.

alter table public.promotion_account_state
  add column if not exists nudge_dismissed_at timestamptz;

comment on column public.promotion_account_state.nudge_dismissed_at is
  'Set when the rep dismisses an AI-suggested follow-up nudge on the /app/lizzie/cadence digest. NULL = still eligible for a nudge suggestion when the row goes stale.';
