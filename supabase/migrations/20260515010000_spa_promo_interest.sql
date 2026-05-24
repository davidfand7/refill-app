-- v341 — Phase 3 (Emma-side): "Eligible promos for the spa" surface.
--
-- The first Emma(OS)/spa-owner Phase 3 ship. A spa owner sees the manufacturer
-- promos she's eligible for at `/app/emma/promos`, with [VERIFIED] tier+savings
-- math per promo. Eligibility = the spa offers a service whose
-- attachments.matchedProduct.manufacturer matches the promo's manufacturer.
--
-- This table records the "express interest" signal from spa → rep. The spa
-- side reads/writes its own rows; the rep-side surface that consumes these
-- (e.g. "3 practices interested in your 7-Years-of-Jeuveau promo") ships
-- separately in a follow-up (v341.1+).
--
-- Cross-tenant promo READ is handled by the service-role admin client in the
-- spa-side server fn — same pattern as the existing
-- `crossReferenceServices()` in spa-claim.functions.ts that reads
-- node_type='product' across user_ids. No new RLS needed on knowledge_nodes
-- (the service-role bypass policy on that table is already in place).

create table if not exists public.spa_promo_interest (
  id                  uuid        primary key default gen_random_uuid(),
  spa_user_id         uuid        not null references auth.users(id) on delete cascade,
  -- The rep who owns the promotion node — captured at insert time so the
  -- rep-side query is a cheap (rep_user_id, promotion_node_id) join and
  -- doesn't require service-role bypass on every read.
  rep_user_id         uuid        not null references auth.users(id) on delete cascade,
  promotion_node_id   uuid        not null references public.knowledge_nodes(id) on delete cascade,
  -- "interested" = the spa hit Express Interest; "dismissed" = the spa hit
  -- Dismiss (the promo card hides on subsequent loads). NULL would mean
  -- "no signal yet"; we never insert a row without one of these set.
  status              text        not null check (status in ('interested', 'dismissed')),
  -- Optional message the spa typed when expressing interest. Capped at 500
  -- chars in app validation; column itself is unbounded for future-proofing.
  message             text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (spa_user_id, promotion_node_id)
);

alter table public.spa_promo_interest enable row level security;

-- Spa owner can read/write their own interest signals.
do $$ begin
  create policy "spa_promo_interest_spa_owner"
    on public.spa_promo_interest for all
    using  (auth.uid() = spa_user_id)
    with check (auth.uid() = spa_user_id);
exception when duplicate_object then null;
end $$;

-- Rep can READ interest signals for promos they own (so the rep-side
-- surface in a future ship can show "3 practices interested"). No write —
-- the rep doesn't manipulate the spa's signal.
do $$ begin
  create policy "spa_promo_interest_rep_read"
    on public.spa_promo_interest for select
    using (auth.uid() = rep_user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "spa_promo_interest_service_role"
    on public.spa_promo_interest for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

-- Hot-path index: spa loading their own page filters by spa_user_id +
-- status (interested OR dismissed both used). Partial index keeps it lean.
create index if not exists idx_spa_promo_interest_spa
  on public.spa_promo_interest (spa_user_id, promotion_node_id);

-- Future rep-side index for the "practices interested in my promo" view.
create index if not exists idx_spa_promo_interest_rep
  on public.spa_promo_interest (rep_user_id, promotion_node_id, status)
  where status = 'interested';

comment on table public.spa_promo_interest is
  'Emma-side signal — spa owner expressed interest (or dismissal) on a manufacturer promo. Read by both the spa (own rows, all statuses) and the rep who owns the promo (interested rows only).';
