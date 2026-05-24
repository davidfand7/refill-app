-- v390: Refill incentive offers + reply-capture column (Phase 1.6 slice 3a).
--
-- Two changes that unlock the conversion-conversation layer:
--
--   1. tenant_engagement_events.response_received_at column — pairs with
--      the existing response_text column to support "show me recent
--      replies" admin queries and per-drip reply pills in the lever
--      board. response_text was always nullable; this column lights up
--      at the same moment so we can ORDER BY/filter without parsing
--      timestamps out of free-form text.
--
--   2. incentive_offers table — the levers Grasshopper attaches to
--      individual tenants (or globally). v390 ships the SCHEMA ONLY.
--      Admin UI to create + manage offers lands in v390.1. Reserving
--      the schema now means the table exists when v390.1 wires it up,
--      and any drip-time references (source_drip_event_id) can already
--      point here.
--
-- Offer-type taxonomy (open-ended text column for now; promote to enum
-- once the set stabilizes):
--   - 'trial_extension'        — N additional days, terms: { days: int }
--   - 'revenue_share_discount' — lowered %, terms: { pct: number,
--                                                    duration_months: int }
--   - 'flat_credit'            — one-time $ credit, terms: { usd: int }
--   - 'custom'                 — free-form, terms: { description, value }
--
-- tenant_id nullable so we can also seed "global" offers (e.g. an
-- end-of-quarter promo every active tenant can claim). When non-null,
-- the offer is scoped to that one spa.

-- ── 1. response_received_at on tenant_engagement_events ────────────────
alter table public.tenant_engagement_events
  add column if not exists response_received_at timestamptz;

create index if not exists tenant_engagement_events_response_received_idx
  on public.tenant_engagement_events (response_received_at desc)
  where response_received_at is not null;

-- ── 2. incentive_offers ────────────────────────────────────────────────
create table if not exists public.incentive_offers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id) on delete cascade,
  offer_type text not null,
  terms jsonb not null default '{}'::jsonb,
  valid_from timestamptz not null default now(),
  valid_until timestamptz,
  claimed_at timestamptz,
  source_drip_event_id uuid references public.tenant_engagement_events(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists incentive_offers_tenant_id_idx
  on public.incentive_offers (tenant_id)
  where tenant_id is not null;

create index if not exists incentive_offers_valid_window_idx
  on public.incentive_offers (valid_from, valid_until);

create index if not exists incentive_offers_claimed_at_idx
  on public.incentive_offers (claimed_at desc)
  where claimed_at is not null;

notify pgrst, 'reload schema';

-- Verify:
-- select column_name, data_type
--   from information_schema.columns
--  where table_schema = 'public'
--    and table_name in ('tenant_engagement_events', 'incentive_offers')
--    and column_name in ('response_received_at', 'id', 'offer_type', 'terms')
--  order by table_name, ordinal_position;
