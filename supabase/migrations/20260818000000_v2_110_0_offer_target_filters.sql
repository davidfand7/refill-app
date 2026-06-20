-- v2.110.0 — Refine targeting: a JSON filter spec that NARROWS an offer's cohort
--
-- The offer engine's `target_cohort` picks a base audience (all / lapsed / new /
-- expiring / vip / waitlist). "Refine targeting" layers optional predicates ON
-- TOP of that base — visit recency, visit count, lifetime spend, reachable-by-
-- text — resolved server-side against knowledge_nodes.attachments (and, in a
-- later pass, patient_transactions for bought-X-not-Y).
--
-- Stored as a single jsonb so the spec can grow without a column-per-filter
-- migration each time. An empty object ('{}') means "no refinement" — the
-- offer behaves exactly as before. A NON-empty spec makes the offer TARGETED
-- (push-only): it drops out of the public badge/Deals pool, and the $5
-- cross-sell win only records when the booking patient actually matches the
-- spec (integrity gate, see recordCrossSellWin). See project_spa_offers_engine.

alter table manufacturer_promo_offers
  add column if not exists filter_spec jsonb not null default '{}'::jsonb;

-- Verify (run after applying):
-- select count(*) as refined_offers
-- from manufacturer_promo_offers
-- where filter_spec is not null and filter_spec <> '{}'::jsonb;
