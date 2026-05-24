-- Promotions Engine — Phase 1 foundation (v334).
--
-- Three new tables operationalize the rep's per-promotion lifecycle:
--
--   promotion_account_state         — one row per (rep, promotion, account)
--                                     tuple. Tracks the state machine
--                                     (targeted → outreached → engaged →
--                                     meeting_scheduled → ... → closed_won/lost),
--                                     committed tier + units, order details,
--                                     and rep notes.
--
--   promotion_outreach              — one row per outreach attempt across
--                                     channels (email / sms / call_log /
--                                     in_person_log). Direction (outbound
--                                     vs. inbound), subject + body, sent_at,
--                                     opened/responded timestamps. Links
--                                     optionally back to the existing
--                                     sample_order_intents.token when the
--                                     outreach went through the v325
--                                     Send-to-Practice + landing-page
--                                     mechanic (which the Promotions Engine
--                                     reuses verbatim).
--
--   promotion_fulfillment_issue     — one row per fulfillment problem
--                                     (incorrect quantity, incentive not
--                                     loaded, shipping delay, etc.). Kept
--                                     separate from a "notes" field so
--                                     fulfillment queue UIs can query
--                                     issues directly without parsing JSON.
--
-- Design notes:
--   - Every table scoped by user_id (the rep). RLS enforces it the same
--     way report_uploads + sample_order_intents do. Multi-tenant isolation
--     stays load-bearing per project_security_privacy_posture.
--   - The promotion itself lives in knowledge_nodes (node_type='promotion'),
--     not in a dedicated table. This keeps the existing v319 schema
--     foundation + the [VERIFIED] / memory-graph patterns intact. Only the
--     operational lifecycle data lives in these new tables.
--   - The account lives in knowledge_nodes too (node_type='account'). These
--     state-tracking rows reference both via foreign keys, but with
--     ON DELETE CASCADE so cleaning up a stale promo / account cleans up
--     its operational rows automatically.
--   - All three tables follow the existing convention: user_id NOT NULL,
--     created_at + updated_at, idempotent migration via if-not-exists +
--     duplicate-object-exception RLS policies.
--
-- Established 2026-05-13 (v334 — Promotions Engine Phase 1 foundation).
-- See ~/Desktop/David Claude Projects/Promotions-Engine-Roadmap.html
-- and memory/project_promotions_engine_spec.md for the full spec.

-- ── promotion_account_state ────────────────────────────────────────────────

create table if not exists public.promotion_account_state (
  id                       uuid        primary key default gen_random_uuid(),
  user_id                  uuid        not null references auth.users(id) on delete cascade,
  promotion_node_id        uuid        not null references public.knowledge_nodes(id) on delete cascade,
  account_node_id          uuid        not null references public.knowledge_nodes(id) on delete cascade,

  -- State machine per the spec. ENFORCED at DB layer so the application
  -- can't accidentally write a state it doesn't model.
  state                    text        not null default 'targeted'
    check (state in (
      'targeted',
      'outreached',
      'engaged',
      'meeting_scheduled',
      'meeting_done',
      'committed',
      'ordered',
      'fulfilled',
      'closed_won',
      'closed_lost',
      'opted_out'
    )),

  -- When state = 'committed' or later, which tier the practice chose.
  -- Matches a `code` in PromotionAttachments.tiers (e.g. "7QUEEN", "TIU2").
  committed_tier_code      text,
  committed_units          integer,

  -- Order placement details (state >= 'ordered').
  order_placed_at          timestamptz,
  order_invoice_number     text,
  order_total_usd          numeric(12, 2),

  -- Free-form structured issues. The promotion_fulfillment_issue table is
  -- the queryable source of truth; this jsonb is a denormalized snapshot
  -- the chat UI can show without a join.
  fulfillment_issues       jsonb       not null default '[]'::jsonb,

  rep_notes                text,
  last_touched_at          timestamptz default now(),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  -- One state row per (rep, promo, account). Re-running outreach against
  -- the same account updates the existing row; doesn't insert duplicates.
  constraint promotion_account_state_unique
    unique (user_id, promotion_node_id, account_node_id)
);

alter table public.promotion_account_state enable row level security;

do $$ begin
  create policy "users_own_promotion_account_state"
    on public.promotion_account_state for all
    using  (auth.uid() = user_id)
    with check (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "service_role_promotion_account_state"
    on public.promotion_account_state for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

-- Per-promo dashboard: rollup of state buckets for one promo.
create index if not exists promotion_account_state_promo_idx
  on public.promotion_account_state (user_id, promotion_node_id, state);

-- Per-account drill-in: every promo state row for one practice.
create index if not exists promotion_account_state_account_idx
  on public.promotion_account_state (user_id, account_node_id, last_touched_at desc);

-- Stale-state cron sweep (Phase 2C — auto-queue follow-ups for outreached
-- rows untouched for X days). Partial because confirmed/closed states
-- never need stale-checking.
create index if not exists promotion_account_state_stale_idx
  on public.promotion_account_state (user_id, last_touched_at)
  where state in ('targeted', 'outreached', 'engaged', 'meeting_scheduled');

-- ── promotion_outreach ─────────────────────────────────────────────────────

create table if not exists public.promotion_outreach (
  id                       uuid        primary key default gen_random_uuid(),
  user_id                  uuid        not null references auth.users(id) on delete cascade,
  state_id                 uuid        not null references public.promotion_account_state(id) on delete cascade,

  kind                     text        not null
    check (kind in ('email', 'sms', 'call_log', 'in_person_log')),
  direction                text        not null
    check (direction in ('outbound', 'inbound')),

  subject                  text,
  body                     text        not null default '',

  -- For email tracking (Phase 2A+) — pixel-based opened_at and Resend
  -- webhook responded_at. Null on call_log / in_person_log entries.
  sent_at                  timestamptz not null default now(),
  opened_at                timestamptz,
  responded_at             timestamptz,
  response_body            text,

  -- v325 reuse — when outreach goes via the Send-to-Practice + landing-page
  -- mechanic, the same token bridges the two systems. Practice-owner views
  -- + confirmations on the landing page automatically link back here.
  intent_token             text        references public.sample_order_intents(token) on delete set null,

  -- Optional structured metadata (channel-specific fields).
  metadata                 jsonb       not null default '{}'::jsonb,

  created_at               timestamptz not null default now()
);

alter table public.promotion_outreach enable row level security;

do $$ begin
  create policy "users_own_promotion_outreach"
    on public.promotion_outreach for all
    using  (auth.uid() = user_id)
    with check (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "service_role_promotion_outreach"
    on public.promotion_outreach for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

-- Per-state timeline view: chronological touches against one (promo, account).
create index if not exists promotion_outreach_state_idx
  on public.promotion_outreach (state_id, sent_at desc);

-- Inbox view (Phase 2B): inbound replies awaiting rep attention.
create index if not exists promotion_outreach_inbound_unread_idx
  on public.promotion_outreach (user_id, sent_at desc)
  where direction = 'inbound';

-- Intent-token join for webhooks (Resend bouncing replies + landing-page
-- confirms back into the engine).
create index if not exists promotion_outreach_intent_idx
  on public.promotion_outreach (intent_token)
  where intent_token is not null;

-- ── promotion_fulfillment_issue ────────────────────────────────────────────

create table if not exists public.promotion_fulfillment_issue (
  id                       uuid        primary key default gen_random_uuid(),
  user_id                  uuid        not null references auth.users(id) on delete cascade,
  state_id                 uuid        not null references public.promotion_account_state(id) on delete cascade,

  kind                     text        not null
    check (kind in (
      'incorrect_quantity',
      'incorrect_product',
      'incentive_not_loaded',
      'physical_goods_not_received',
      'billing_discrepancy',
      'shipping_delay',
      'other'
    )),

  -- Free-text description (what the practice owner said, or what the rep
  -- noticed). Required because issue-kind alone isn't enough context.
  description              text        not null,

  -- Severity (rep-set or LLM-inferred). Used to surface high-severity
  -- issues immediately vs. queueing normal ones in the daily digest.
  severity                 text        not null default 'normal'
    check (severity in ('low', 'normal', 'high', 'urgent')),

  reported_at              timestamptz not null default now(),
  -- Source channel that surfaced this issue — for reporting later.
  reported_via             text        check (reported_via in ('email', 'sms', 'call', 'in_person', 'auto_detected', 'rep_entered')),

  resolved_at              timestamptz,
  resolution_notes         text,

  created_at               timestamptz not null default now()
);

alter table public.promotion_fulfillment_issue enable row level security;

do $$ begin
  create policy "users_own_promotion_fulfillment_issue"
    on public.promotion_fulfillment_issue for all
    using  (auth.uid() = user_id)
    with check (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "service_role_promotion_fulfillment_issue"
    on public.promotion_fulfillment_issue for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

-- Open-issues queue (rep's "what's broken right now" view).
create index if not exists promotion_fulfillment_issue_open_idx
  on public.promotion_fulfillment_issue (user_id, severity, reported_at desc)
  where resolved_at is null;

-- Per-state timeline (issues attached to one promo-account combo).
create index if not exists promotion_fulfillment_issue_state_idx
  on public.promotion_fulfillment_issue (state_id, reported_at desc);
