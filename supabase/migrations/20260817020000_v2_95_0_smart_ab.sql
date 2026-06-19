-- v2.95.0 — Smart-A/B engine core (the impartial-arbiter mechanism).
--
-- An A/B experiment is a set of offer rows (manufacturer_promo_offers) that
-- share an experiment_id — each row is one ARM (variant). The winner is chosen
-- by real customer BOOKINGS, measured by a Thompson-sampling bandit
-- (src/lib/smart-ab.ts): not SmartSpa, not the owner, not the manufacturer —
-- the market votes, the AI measures. That impartiality is the crown-jewel
-- thesis (project_manufacturer_ab_arbiter).
--
-- Per-arm counters live on the offer row:
--   ab_impressions — patients assigned/sent this arm
--   ab_conversions — of those, how many booked (the "votes")
--   ab_label       — short variant label for the verdict UI ("$50 off")
--   experiment_id  — null = a normal standalone offer; set = an A/B arm
--
-- Experiment-level state (status, winner, timing) lives in offer_experiments.
-- Idempotent + safe to re-run.

-- ── Arm columns on the shared offers table ──────────────────────────────────
alter table public.manufacturer_promo_offers
  add column if not exists experiment_id uuid,
  add column if not exists ab_impressions integer not null default 0,
  add column if not exists ab_conversions integer not null default 0,
  add column if not exists ab_label text;

create index if not exists idx_mpo_experiment_id
  on public.manufacturer_promo_offers (experiment_id)
  where experiment_id is not null;

-- ── Experiment-level state ──────────────────────────────────────────────────
create table if not exists public.offer_experiments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  -- The plain-English thing being tested ("20% off Tox for lapsed patients").
  base_label text,
  -- running  → the bandit is still shifting reach toward the front-runner
  -- decided  → the bandit auto-stopped at the confidence threshold + switched
  -- stopped  → the owner ended it manually
  status text not null default 'running'
    check (status in ('running', 'decided', 'stopped')),
  -- The winning arm once decided (an id in manufacturer_promo_offers).
  winner_offer_id uuid,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);

create index if not exists idx_offer_experiments_tenant
  on public.offer_experiments (tenant_id);

-- The arm's experiment_id points at offer_experiments(id). Not a hard FK so a
-- calendar full-snapshot re-import of manufacturer arms can't trip a constraint
-- mid-replace; the app keeps them consistent.

-- Atomic per-arm counter bump (single UPDATE under a row lock) so concurrent
-- sends/bookings can't lose increments the way a read-modify-write would.
-- p_conversion=false → just an impression; true → impression + a booking.
create or replace function public.bump_ab_outcome(
  p_offer_id uuid,
  p_conversion boolean
)
returns void
language sql
as $$
  update public.manufacturer_promo_offers
     set ab_impressions = ab_impressions + 1,
         ab_conversions = ab_conversions + (case when p_conversion then 1 else 0 end)
   where id = p_offer_id;
$$;
