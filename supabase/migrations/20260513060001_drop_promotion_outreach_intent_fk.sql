-- v337 follow-up: drop the FK constraint on promotion_outreach.intent_token.
--
-- The v334 migration declared:
--   intent_token text references public.sample_order_intents(token) on delete set null
--
-- which presumed promo blasts would reuse the v325 sample_order_intents
-- mechanism. v337 introduced a SEPARATE promo_intents table (different
-- shape, different lifecycle — see migration 20260513060000). Tokens
-- written to promotion_outreach.intent_token now point at promo_intents,
-- not sample_order_intents, so the original FK rejects valid inserts.
--
-- We don't add a new FK to promo_intents here because:
--   - promotion_outreach existed before promo_intents (cross-table FK ordering
--     would be awkward in a fresh-DB rebuild)
--   - the token-as-capability pattern means we look these up via the server
--     fns (which are explicit) rather than ad-hoc joins
--   - keeping intent_token as untyped text gives us flexibility if a third
--     intent-shape ever appears (meeting_intents, fulfillment_intents, etc.)

alter table public.promotion_outreach
  drop constraint if exists promotion_outreach_intent_token_fkey;

-- Keep the index — still useful for the outreach → intent join in the UI.
