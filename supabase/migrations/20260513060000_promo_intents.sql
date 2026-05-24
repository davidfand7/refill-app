-- Promo intents — public landing page table for the Promotions Engine (v337).
--
-- Mirrors sample_order_intents but for promo-blast outreach rather than
-- one-off sample-order sends. When a rep sends a promo blast via v336's
-- sendPromoBlast, this row is minted before Resend delivery; the public
-- /promo/<token> landing page reads from it.
--
-- Why a SEPARATE table instead of extending sample_order_intents:
--   - The shapes are genuinely different. sample_order_intents.order_snapshot
--     is a frozen LizSampleOrder (line items, total, [VERIFIED] math). Promo
--     intents instead carry the rep's recommended tier + the promo's full
--     ladder so the practice owner can SELECT which tier to commit to.
--   - The lifecycle is different. Sample-order intents go targeted →
--     viewed → confirmed (one-shot accept/reject). Promo intents support
--     multiple "confirms" as the practice owner picks then changes their
--     mind about tier — each confirm re-stamps with the latest selection.
--   - Foreign keys cleaner. The v334 promotion_outreach.intent_token had
--     been FK'd to sample_order_intents.token, which was wrong; that FK
--     gets dropped here (or rather, we keep promotion_outreach.intent_token
--     as untyped text since it now points at this NEW table on promo blasts).
--
-- The promo + account + recommended tier are captured at SEND time so
-- the landing page renders the same content the rep saw when they sent —
-- no prompt drift or schema changes can move the offer after the fact.
--
-- Established 2026-05-13 (v337 — practice-facing promo landing page).

create table if not exists public.promo_intents (
  id                       uuid        primary key default gen_random_uuid(),

  -- Public URL slug. Unguessable. 32 random bytes → ~43 chars base64url.
  -- Same generator as sample_order_intents.token (256 bits of entropy).
  token                    text        not null unique,

  -- Rep who sent. Cascade with the user (same pattern as
  -- sample_order_intents) — if the rep is deleted, the promo URLs they
  -- minted die with them.
  rep_user_id              uuid        not null references auth.users(id) on delete cascade,

  -- Anchors for the promo + the targeted account. SET NULL on delete so
  -- the public URL keeps working even if the rep cleans up their nodes
  -- (renders with the frozen snapshot below).
  promotion_node_id        uuid        references public.knowledge_nodes(id) on delete set null,
  account_node_id          uuid        references public.knowledge_nodes(id) on delete set null,

  -- Frozen snapshot at send time. This is what renders on the landing
  -- page regardless of whether the underlying promo/account nodes have
  -- changed since. Shape:
  --   {
  --     promo: { title, manufacturer, promo_kind, ends, tier_ladder: [...], ... },
  --     account: { title, lookup_key, address, contact_name, current_tier: {...} },
  --     recommended_tier_code: "7QUEEN"
  --   }
  snapshot                 jsonb       not null,

  -- Where the promo email was sent.
  practice_email           text        not null,

  -- Rep display fields surfaced on the landing page ("From {repName}").
  rep_name                 text        not null,
  rep_email                text,

  sent_at                  timestamptz not null default now(),

  -- View tracking. first_viewed_at = the moment the practice owner first
  -- loaded the landing page. last_viewed_at + view_count for ongoing
  -- engagement signal.
  first_viewed_at          timestamptz,
  last_viewed_at           timestamptz,
  view_count               integer     not null default 0,

  -- Confirmation tracking. Unlike sample_order_intents (one-shot), the
  -- practice owner can re-confirm with a different tier — confirmed_at is
  -- the FIRST confirmation (sticky), confirmed_tier_code + confirmed_units
  -- + confirmed_by_name + confirmed_note update on each re-submit so the
  -- rep sees the latest state.
  confirmed_at             timestamptz,
  confirmed_by_name        text,
  confirmed_note           text,
  confirmed_tier_code      text,
  confirmed_units          integer,

  -- Rep-controlled kill-switch. Setting this makes the landing page show
  -- a friendly "this offer is no longer current — reach out to your rep
  -- for an updated quote" card. UI for this lands in a later phase.
  revoked_at               timestamptz,

  constraint promo_intents_token_check check (
    char_length(token) between 16 and 128
  )
);

alter table public.promo_intents enable row level security;

-- Reps can read their own intents (for the per-account state badges in
-- the composer). Public lookups go through server fns using service-role
-- so the practice owner doesn't need an auth session.
do $$ begin
  create policy "reps_own_promo_intents"
    on public.promo_intents for select
    using (auth.uid() = rep_user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "service_role_promo_intents"
    on public.promo_intents for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

-- Hot-path index: every landing page load looks up by token.
create unique index if not exists promo_intents_token_idx
  on public.promo_intents (token);

-- Per-promo composer view: load all of a rep's intents for one promo
-- to populate the Opened/Confirmed badges on the per-account rows.
create index if not exists promo_intents_rep_promo_idx
  on public.promo_intents (rep_user_id, promotion_node_id, sent_at desc);

-- Per-account drill-in: every promo intent against one practice.
create index if not exists promo_intents_account_idx
  on public.promo_intents (account_node_id, sent_at desc)
  where account_node_id is not null;
