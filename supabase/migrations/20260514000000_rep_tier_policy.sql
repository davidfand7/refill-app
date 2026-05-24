-- v339.7 — Per-rep tier-recommendation policy
--
-- Hybrid policy locked 2026-05-14 (see project_tier_recommendation_policy
-- memory). Liz's auto-draft replies recommend tiers based on the rep's
-- selling style:
--
--   conservative — match the practice's stated volume exactly. Mention
--                  adjacent tiers as informational only.
--   balanced     — default. Lean upsell when volume is within ~20% of the
--                  next tier (stretch zone). Beyond that, match. Tone is
--                  always "opportunity," never pressure.
--   aggressive   — always pitch the next tier up when one exists. Framed
--                  as a smart-move stretch.
--
-- Math fidelity is unchanged regardless of policy: the [VERIFIED] chip is
-- still computed by CODE looking up the recommended tier in the promo's
-- structured ladder. Only the tier-code recommendation itself is tuned.
--
-- Stored on user_preferences (one row per user, PK on user_id). NULL is
-- treated as 'balanced' at read time, so no backfill required.

alter table public.user_preferences
  add column if not exists rep_tier_policy text
    check (rep_tier_policy in ('conservative', 'balanced', 'aggressive'));

comment on column public.user_preferences.rep_tier_policy is
  'Tier-recommendation selling style for Liz auto-drafts. NULL = balanced (default).';
