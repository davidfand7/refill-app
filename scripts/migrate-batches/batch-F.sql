-- ═══════════════════════════════════════════════════════════════════════
-- BATCH F — Refill core + outreach engine (9 migrations)
--   refill_auth_gate, tenants + memberships, trial drip, incentive
--   offers, refill_billing (invoices + plans + stripe webhook), Stripe
--   mode-aware customer IDs, refill_invoice_cron, outreach templates +
--   engagement events.
-- ═══════════════════════════════════════════════════════════════════════

-- ─── 1/9 refill_auth_gate ─────────────────────
-- v386: Refill auth gate (Phase 1.4)
--
-- Binds csv_scanner_leads to auth.users so a Refill lead can become a
-- claimed account inside the onboarding wizard. Two new columns:
--
--   user_id            — set when the lead is first claimed via magic
--                        link or token-as-auth silent-sign-in. NULL until
--                        claim. ON DELETE SET NULL so an auth.users row
--                        purge doesn't destroy the scan history.
--
--   token_consumed_at  — set the first time followup_report_token is
--                        used to sign someone in. Subsequent hits on the
--                        same token go through the magic-link path
--                        instead. Permanent value once set; we never
--                        unset it.
--
-- The token itself stays valid as a /report viewer (read-only); it just
-- can't be used a second time as a silent-sign-in vector.
--
-- pgrst NOTIFY at the bottom forces PostgREST to reload its schema cache
-- so the new columns are exposed to the JS client immediately.

alter table public.csv_scanner_leads
  add column if not exists user_id uuid
    references auth.users(id) on delete set null,
  add column if not exists token_consumed_at timestamptz;

create index if not exists csv_scanner_leads_user_id_idx
  on public.csv_scanner_leads (user_id)
  where user_id is not null;

create index if not exists csv_scanner_leads_token_consumed_at_idx
  on public.csv_scanner_leads (token_consumed_at)
  where token_consumed_at is not null;

notify pgrst, 'reload schema';

-- Verify (paste-friendly): the columns are present and the indexes exist.
-- select column_name, data_type, is_nullable
--   from information_schema.columns
--  where table_schema = 'public'
--    and table_name = 'csv_scanner_leads'
--    and column_name in ('user_id', 'token_consumed_at');

-- ─── 2/9 refill_tenants ───────────────────────
-- v387: Refill tenants infrastructure (Phase 1.5)
--
-- Two new tables that establish the multi-tenant boundary for Refill spas:
--
--   tenants            — one row per spa. Owns the URL slug, the trial
--                        window, and (later) the billing plan. Slug is
--                        unique across the platform — the constraint
--                        below is what makes `<slug>.getrefill.app`
--                        uniquely resolvable.
--
--   tenant_memberships — joins auth.users to tenants. For Phase 1.5 a
--                        user has exactly one membership (role='owner').
--                        Future shipped phases may add staff/admin roles
--                        per spa, hence the role column being open-ended
--                        rather than a boolean.
--
-- No RLS policies in this migration — all access flows through server
-- functions using the service-role key. Phase 4 (full multi-tenant data
-- propagation across spa-scoped tables) will add row-level enforcement
-- per table. For now keeping RLS-default-deny is the conservative posture.
--
-- The trial_ends_at default of created_at + 30 days encodes the
-- "free 30-day trial" copy from the wizard. plan defaults to 'trial'
-- so the billing engine (Phase 1.6) can stage transitions from
-- 'trial' → 'starter' / 'pro' without any pre-existing nulls to
-- defensively handle.

create table if not exists public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null,
  created_at timestamptz not null default now(),
  trial_starts_at timestamptz not null default now(),
  trial_ends_at timestamptz not null default (now() + interval '30 days'),
  payment_method_added_at timestamptz,
  plan text not null default 'trial'
);

-- Case-insensitive uniqueness via lower(slug). Reserved-slug rejection
-- already lives in src/lib/product-context.ts (isReservedSlug); the DB
-- constraint here guards the race-condition window between the wizard's
-- availability check and the claim insert.
create unique index if not exists tenants_slug_unique_idx
  on public.tenants (lower(slug));

create table if not exists public.tenant_memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'owner',
  created_at timestamptz not null default now(),
  unique (tenant_id, user_id)
);

-- "What tenants does this user belong to" — hot path on every authed
-- Refill request once tenant resolution is wired (Phase 4). Cheap to
-- maintain; carve it now while the table is empty.
create index if not exists tenant_memberships_user_id_idx
  on public.tenant_memberships (user_id);

notify pgrst, 'reload schema';

-- Verify (paste-friendly):
-- select table_name, column_name, data_type
--   from information_schema.columns
--  where table_schema = 'public'
--    and table_name in ('tenants', 'tenant_memberships')
--  order by table_name, ordinal_position;

-- ─── 3/9 refill_trial_drip ────────────────────
-- v388: Refill trial drip engagement (Phase 1.6 slice 1)
--
-- The trial-engagement layer. During the 30-day free trial we send a
-- sequence of "from Karen" check-in emails to keep Refill top of mind,
-- collect product feedback, and warm the spa owner for the eventual
-- plan-pick conversation (which happens NOT here — it lives in /app/billing
-- triggered by drip CTAs or trial-end, per the trial-first-no-money-asks
-- product rule).
--
-- This migration ships the storage substrate. The cron + first send
-- (Day-3 "how's it going?") land in the same v388. Reply parsing lands
-- in v390 (requires Resend inbound on getrefill.app first).
--
-- Schema rationale:
--
--   event_type        — namespaced strings like 'drip:day3', 'drip:day7',
--                       'incentive:offered', 'plan:viewed', 'plan:picked'.
--                       Keep it open-ended; this table is the future
--                       audit trail for the whole conversion funnel, not
--                       just drip sends.
--
--   payload (jsonb)   — Resend message_id, subject, recipient_email
--                       snapshot, any other per-event metadata.
--
--   sent_at           — populated ONLY on successful send. The cron
--                       checks for the absence of a matching
--                       (tenant_id, event_type) row to decide whether
--                       to send. Failed sends just don't insert; the
--                       cron retries on its next run.
--
--   response_text     — NULL until v390 wires inbound reply capture
--                       on getrefill.app. Reserved column.
--
--   source_drip_id    — chaining anchor for v390+ incentive offers
--                       that originate from a specific drip touchpoint
--                       (e.g. trial extension offered in response to a
--                       Day-14 reply).
--
-- Indexes:
--
--   (tenant_id, event_type) — the cron's hot path: "has this tenant
--                             received the Day-3 drip yet?" The
--                             multi-column ordering matters — most
--                             queries filter tenant first then narrow
--                             by event_type.

create table if not exists public.tenant_engagement_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  sent_at timestamptz,
  response_text text,
  source_drip_id uuid references public.tenant_engagement_events(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists tenant_engagement_events_tenant_type_idx
  on public.tenant_engagement_events (tenant_id, event_type);

create index if not exists tenant_engagement_events_sent_at_idx
  on public.tenant_engagement_events (sent_at desc)
  where sent_at is not null;

notify pgrst, 'reload schema';

-- Verify (paste-friendly):
-- select column_name, data_type, is_nullable
--   from information_schema.columns
--  where table_schema = 'public'
--    and table_name = 'tenant_engagement_events'
--  order by ordinal_position;

-- ─── 4/9 refill_incentive_offers ──────────────
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

-- ─── 5/9 refill_billing ───────────────────────
-- v391: Refill customer-side billing — Phase 1.6 slice 4 (billing engine begins).
--
-- The conversion engine reaches the money flow. v388–v390 shipped the
-- engagement drip + reply capture + incentive lever board. v391 ships the
-- backend foundation for Stripe-metered billing: schema, idempotency,
-- Refill-side webhook event routing. UI (Stripe Elements payment method
-- capture + plan picker) lands in v391.1; admin visibility + monthly invoice
-- cron lands in v391.2.
--
-- Per [[project_trial_first_no_money_asks]] no spa is asked for money until
-- the trial WIN has landed. This migration just stands up the substrate so
-- when the spa is ready, the plan-pick → payment-method → first-invoice flow
-- has somewhere to write.
--
-- Four schema changes:
--
--   refill_pricing_plans   — per-tenant plan selection (mirrors emma_pricing_plans
--                            but tenant-scoped; one active row per tenant_id at
--                            a time; full history preserved on plan change for
--                            audit).
--
--   refill_invoices        — monthly billing records per (tenant, month).
--                            Generated by v391.2 cron. Ships in 'draft' status;
--                            Stripe push activates when stripe_customer_id is
--                            non-null on the pricing plan row.
--
--   tenants.stripe_customer_id  — ALTER. Stripe customer identity lives on the
--                            tenant row because it's a stable per-spa identity
--                            that outlives plan changes. Mirrors the killshot
--                            doc's "spa = tenant" identity model.
--
--   stripe_webhook_events  — idempotency table for the shared Stripe webhook
--                            (supabase/functions/stripe-webhook). Inserted at
--                            the top of the handler with ON CONFLICT on
--                            stripe_event_id; if conflict, handler returns 200
--                            immediately. Retrofitted to cover ALL existing
--                            paths (Emma platform subs, payouts, revenue_events
--                            in the WCS engine), not just Refill — the existing
--                            revenue_events insert path has been leaking
--                            duplicates on Stripe retries (no unique constraint
--                            on stripe_event_id inside the metadata jsonb).
--
-- Three Refill pricing plans (codified in src/server/refill-billing.functions.ts
-- as PLAN_ECONOMICS; this migration only validates the values):
--
--   starter      — free + 12% of recovered revenue (the killshot default;
--                  aligns incentives — spa only pays when recovery revenue
--                  arrives)
--   pro          — $99/mo + 8% of recovered (commitment + shared upside)
--
-- ('trial' is NOT a refill_pricing_plans value — it's the absence of a paid
--  plan, encoded by tenants.plan='trial' on the tenant row. A pricing-plans
--  row only exists once the spa has explicitly picked a paid plan post-trial.)
--
-- RLS posture matches the Phase 1.5 tenants migration: service-role only, no
-- user policies. Phase 4 will add per-table tenant-membership-scoped policies
-- across all Refill tables in one coherent sweep. Until then, all access is
-- mediated through server functions that gate on auth + tenant_memberships.

-- ── refill_pricing_plans ────────────────────────────────────────────────

create table if not exists public.refill_pricing_plans (
  id                       uuid        primary key default gen_random_uuid(),
  tenant_id                uuid        not null references public.tenants(id) on delete cascade,

  plan                     text        not null
                           check (plan in ('starter', 'pro')),

  -- Economic parameters snapshotted at plan-selection time so a future
  -- price change doesn't retroactively alter past invoices.
  revenue_share_pct        numeric(5,4)  not null default 0,  -- 0..1 (0.12 = 12%)
  monthly_flat_usd         numeric(10,2) not null default 0,

  -- Lifecycle. A tenant has at most one row with plan_ended_at=null at a
  -- time (the active plan). Plan changes write a new row + close the prior.
  plan_started_at          timestamptz not null default now(),
  plan_ended_at            timestamptz,

  -- Stripe customer linkage on the plan row for symmetry with Emma's pattern.
  -- The authoritative copy lives on tenants.stripe_customer_id (per-spa
  -- identity); this column is a denormalization the v391.1 UI fills in at
  -- payment-method-capture time so the billing-page query is one round-trip.
  -- Phase 4 may drop in favor of joining through tenants.
  stripe_customer_id       text,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

alter table public.refill_pricing_plans enable row level security;

do $$ begin
  create policy "service_role_refill_pricing_plans"
    on public.refill_pricing_plans for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

create index if not exists refill_pricing_plans_active_idx
  on public.refill_pricing_plans (tenant_id)
  where plan_ended_at is null;

create trigger refill_pricing_plans_set_updated_at
  before update on public.refill_pricing_plans
  for each row execute function public.set_updated_at();

comment on table public.refill_pricing_plans is
  'Per-tenant Refill pricing plan selection. One active row (plan_ended_at=null) per tenant_id at a time; historical rows preserved on plan change. Plan economics snapshotted at selection so future price changes don''t alter past invoices.';

-- ── refill_invoices ─────────────────────────────────────────────────────

create table if not exists public.refill_invoices (
  id                       uuid        primary key default gen_random_uuid(),
  tenant_id                uuid        not null references public.tenants(id) on delete cascade,

  -- Billing period. period_start = 1st of month at 00:00 UTC; period_end =
  -- 1st of the next month (exclusive).
  period_start             timestamptz not null,
  period_end               timestamptz not null,

  -- Plan snapshot at invoice time (future plan changes don't rewrite
  -- historical invoices).
  plan_at_invoice          text        not null,
  revenue_share_pct        numeric(5,4) not null,
  monthly_flat_usd         numeric(10,2) not null,

  -- Math. recovered_revenue_usd is the sum of verified recovery events in
  -- the period; share_due_usd = recovered * pct; total_due_usd = share + flat.
  recovered_revenue_count  integer     not null default 0,
  recovered_revenue_usd    numeric(12,2) not null default 0,
  share_due_usd            numeric(12,2) not null default 0,
  total_due_usd            numeric(12,2) not null default 0,

  status                   text        not null default 'draft'
                           check (status in (
                             'draft',         -- generated but not pushed
                             'sent',          -- pushed to Stripe
                             'paid',          -- Stripe paid
                             'failed',        -- payment failed
                             'void'           -- spa cancelled/disputed
                           )),

  stripe_invoice_id        text,

  generated_at             timestamptz not null default now(),
  sent_at                  timestamptz,
  paid_at                  timestamptz,
  voided_at                timestamptz,
  voided_by                text,
  notes                    text,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  -- One invoice per (tenant, month).
  unique (tenant_id, period_start)
);

alter table public.refill_invoices enable row level security;

do $$ begin
  create policy "service_role_refill_invoices"
    on public.refill_invoices for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

create index if not exists refill_invoices_by_tenant_idx
  on public.refill_invoices (tenant_id, period_start desc);

create index if not exists refill_invoices_by_status_idx
  on public.refill_invoices (tenant_id, status)
  where status in ('draft', 'sent', 'failed');

create trigger refill_invoices_set_updated_at
  before update on public.refill_invoices
  for each row execute function public.set_updated_at();

comment on table public.refill_invoices is
  'Monthly billing record per (tenant, month). Generated by the v391.2 cron from verified emma_recovery_events scoped to the tenant''s user_id(s). Ships in draft status — activates Stripe push when refill_pricing_plans.stripe_customer_id is non-null.';

-- ── tenants.stripe_customer_id (the per-spa identity, stable across plans) ─

alter table public.tenants
  add column if not exists stripe_customer_id text;

create index if not exists tenants_stripe_customer_idx
  on public.tenants (stripe_customer_id)
  where stripe_customer_id is not null;

comment on column public.tenants.stripe_customer_id is
  'Stripe customer id (cus_xxx) for this spa. Stable per-tenant identity that outlives plan changes — created once at first payment-method capture (v391.1) and reused across every subscription, plan switch, and invoice. Indexed for webhook reverse-lookup (customer.subscription.updated and friends).';

-- ── stripe_webhook_events (idempotency for the shared Stripe webhook) ─────

create table if not exists public.stripe_webhook_events (
  id                       uuid        primary key default gen_random_uuid(),

  -- The Stripe event id (evt_xxx). Unique even on Stripe retries — this is
  -- the dedup key. Inserted at the top of the webhook handler with
  -- ON CONFLICT DO NOTHING. If the insert fails (conflict), the handler
  -- returns 200 immediately and skips all branches.
  stripe_event_id          text        not null unique,

  event_type               text        not null,

  -- Which product processed this event. 'platform' = existing user_subscriptions
  -- flow; 'wcs' = the revenue_events/revenue_shares creator-share flow;
  -- 'refill' = v391+ tenant-scoped subs; 'emma' reserved for v366.x activation.
  -- Populated by the handler so we can answer 'how many duplicate webhooks
  -- did we suppress for product X this month' without a metadata jsonb scan.
  product                  text,

  received_at              timestamptz not null default now(),
  processed_at             timestamptz,

  -- 'received' on first insert; 'processed' once the handler finishes its
  -- branch successfully; 'failed' if an exception propagates; never set to
  -- 'duplicate' from the handler (a duplicate is denoted by the absence of
  -- a second row — the unique constraint prevents the insert).
  status                   text        not null default 'received'
                           check (status in ('received', 'processed', 'failed')),

  error_message            text,

  -- Full event payload for forensic replay. Keeping it on the row (rather
  -- than fetching from Stripe API later) costs ~5 KB/event but is
  -- invaluable when Stripe rotates a customer id under us or we need to
  -- prove we received an event that the Stripe dashboard claims we didn't.
  payload                  jsonb,

  created_at               timestamptz not null default now()
);

alter table public.stripe_webhook_events enable row level security;

do $$ begin
  create policy "service_role_stripe_webhook_events"
    on public.stripe_webhook_events for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

create index if not exists stripe_webhook_events_received_idx
  on public.stripe_webhook_events (received_at desc);

create index if not exists stripe_webhook_events_status_idx
  on public.stripe_webhook_events (status)
  where status in ('received', 'failed');

comment on table public.stripe_webhook_events is
  'Idempotency + forensic log for the shared Stripe webhook (supabase/functions/stripe-webhook). Insert at top of handler with ON CONFLICT on stripe_event_id; conflict means duplicate retry from Stripe, return 200 and skip branches. Retrofitted for all product paths in v391, not just Refill.';

-- ── PostgREST schema reload (for type generation downstream) ─────────────

notify pgrst, 'reload schema';

-- ── Verify (paste-friendly) ──────────────────────────────────────────────
-- Run these in the SQL editor after the migration completes to confirm the
-- four schema changes landed cleanly.
--
-- select table_name, column_name, data_type
--   from information_schema.columns
--  where table_schema = 'public'
--    and table_name in (
--      'refill_pricing_plans',
--      'refill_invoices',
--      'stripe_webhook_events'
--    )
--  order by table_name, ordinal_position;
--
-- select column_name from information_schema.columns
--  where table_schema='public' and table_name='tenants'
--    and column_name='stripe_customer_id';
--
-- select indexname from pg_indexes
--  where schemaname='public'
--    and tablename in ('refill_pricing_plans','refill_invoices','stripe_webhook_events','tenants');

-- ─── 6/9 stripe_customer_mode_aware ───────────
-- ─────────────────────────────────────────────────────────────────────────
-- v391.2 — Mode-aware Stripe customer storage
-- ─────────────────────────────────────────────────────────────────────────
--
-- WHY THIS EXISTS
--   Stripe runs two disjoint universes (test mode + live mode). A customer
--   id (cus_xxx) created in one is invisible to the other — the API throws
--   "No such customer" if you ever try to reuse a test-mode id under a
--   live-mode key (or vice versa).
--
--   v391.1 stored Stripe customer ids in a single `tenants.stripe_customer_id`
--   column. During verification 2026-05-20 we hit the bug live: a first
--   (mis-configured) attempt minted a LIVE-mode customer + stamped its id,
--   then the test-mode retry tried to reuse it and Stripe threw an
--   unhandled HTTPError. We cleared the column manually and proceeded, but
--   the structural fix is what this migration ships.
--
-- WHAT THIS DOES
--   1. Adds `tenants.stripe_customer_id_test` and `tenants.stripe_customer_id_live`.
--      Each one stores the cus_xxx id Stripe issued in that mode. Both
--      survive mode flips, so dev cycles (test → live → test → ...) don't
--      destroy state.
--   2. Indexes both columns for webhook reverse-lookup. Same shape as the
--      existing tenants_stripe_customer_idx (partial index, NULLs excluded).
--   3. Migrates any existing values from the legacy single column. We
--      can't know which mode it was issued in from the SQL side, so we
--      default to LIVE (the conservative assumption — if a live-mode key
--      issued the id, it would have been to a real spa). If you know an
--      entry was test-mode, manually move it before running.
--   4. Marks the legacy column DEPRECATED via comment. We do NOT drop it
--      in this migration to avoid breaking any in-flight queries; a later
--      cleanup ship (v391.3 or v391.x) will drop it once we're certain.
--
-- READ + WRITE SITES TOUCHED IN v391.2
--   - src/routes/api.refill-checkout.ts (read for reuse, write on create)
--   - src/routes/api.refill-portal.ts   (read to resolve customer)
--   - supabase/functions/stripe-webhook/index.ts handleRefillEvent
--     (writes the column on checkout.session.completed; reverse-looks-up
--     by it on customer.subscription.updated/deleted)
--
-- Mode is derived at runtime from STRIPE_SECRET_KEY prefix
-- (`sk_test_*` → test, anything else → live).
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. Add the two mode-specific columns ────────────────────────────────

alter table public.tenants
  add column if not exists stripe_customer_id_test text,
  add column if not exists stripe_customer_id_live text;

comment on column public.tenants.stripe_customer_id_test is
  'Stripe TEST-mode customer id (cus_xxx) for this spa. Written by api.refill-checkout.ts + stripe-webhook handleRefillEvent when STRIPE_SECRET_KEY starts with sk_test_. Survives mode flips — when prod keys are active, this column is preserved untouched.';

comment on column public.tenants.stripe_customer_id_live is
  'Stripe LIVE-mode customer id (cus_xxx) for this spa. Written by api.refill-checkout.ts + stripe-webhook handleRefillEvent when STRIPE_SECRET_KEY does NOT start with sk_test_. Survives mode flips — when test keys are active, this column is preserved untouched.';

-- ── 2. Indexes for webhook reverse-lookup ──────────────────────────────

create index if not exists tenants_stripe_customer_test_idx
  on public.tenants (stripe_customer_id_test)
  where stripe_customer_id_test is not null;

create index if not exists tenants_stripe_customer_live_idx
  on public.tenants (stripe_customer_id_live)
  where stripe_customer_id_live is not null;

-- ── 3. Best-effort migration of any existing values ─────────────────────
-- This is a no-op for rejuv (the column was cleared manually during v391.1
-- verification). For safety, copy any non-null value into the LIVE column
-- — the conservative assumption is that production-issued ids were
-- live-mode. If you know an entry was test-mode, manually move it before
-- letting code rely on this column.

update public.tenants
   set stripe_customer_id_live = stripe_customer_id
 where stripe_customer_id is not null
   and stripe_customer_id_live is null;

-- ── 4. Deprecate the legacy single column (do NOT drop yet) ─────────────

comment on column public.tenants.stripe_customer_id is
  'DEPRECATED 2026-05-20 (v391.2): use stripe_customer_id_test or stripe_customer_id_live instead. Application code no longer reads or writes this column. Scheduled for drop in a later cleanup ship.';

-- ── 5. PostgREST schema reload (for type generation downstream) ─────────

notify pgrst, 'reload schema';

-- ── Verify (paste-friendly) ──────────────────────────────────────────────
-- Run these in the SQL editor after the migration completes to confirm:
--
-- select column_name, data_type
--   from information_schema.columns
--  where table_schema='public' and table_name='tenants'
--    and column_name in (
--      'stripe_customer_id',
--      'stripe_customer_id_test',
--      'stripe_customer_id_live'
--    )
--  order by column_name;
--
-- select indexname from pg_indexes
--  where schemaname='public'
--    and indexname in (
--      'tenants_stripe_customer_test_idx',
--      'tenants_stripe_customer_live_idx'
--    );
--
-- select id, slug, stripe_customer_id, stripe_customer_id_test, stripe_customer_id_live
--   from public.tenants;

-- ─── 7/9 refill_invoice_cron ──────────────────
-- ─────────────────────────────────────────────────────────────────────────
-- v392 — Refill monthly invoice cron registration
-- ─────────────────────────────────────────────────────────────────────────
--
-- Registers a pg_cron job that fires on the 1st of each month at 09:00 UTC
-- to generate the prior month's invoices for every Refill tenant with an
-- active pricing plan. The job posts to the Supabase Edge Function
-- `refill-invoice`, which proxies to the app's /api/cron/refill-invoice
-- endpoint with the SCHEDULER_SECRET header.
--
-- ARCHITECTURE: two-hop (pg_cron → edge fn → app endpoint), not one-hop
--   pg_cron directly to app. Mirrors the refill-trial-drip pattern (v388)
--   rather than the emma-invoice pattern (v366) so the scheduler secret
--   never lives in pg_cron SQL — only the public anon key does. This makes
--   the scheduler secret rotatable via the Supabase Functions dashboard.
--
-- CADENCE: `0 9 1 * *` — 1st of every month at 09:00 UTC. Matches
--   emma-invoice (v366) so ops staff have a single mental model for "billing
--   runs." 09:00 UTC is comfortably off any spa's open hours in US time.
--
-- IDEMPOTENT: re-running the job on the same day (or any day in the same
--   month) is a no-op for tenants whose invoice already exists. The
--   (tenant_id, period_start) unique constraint on refill_invoices enforces
--   this at the DB level — generateMonthlyInvoicesForAll upserts with
--   onConflict matching the existing row.
--
-- FIRST FIRE: 2026-06-01 09:00 UTC. The first run will create draft
--   invoices for May 2026 recovery events on any tenants that added a paid
--   plan during May (currently zero — rejuv is on trial).
--
-- AUTH IN CRON: the SQL below uses the Supabase project anon key in the
--   Authorization Bearer header. The anon key is a JWT signed by the
--   project's JWT secret, valid for invoking edge functions that have
--   verify_jwt=true (the default). The anon key is PUBLIC — it ships in
--   client JS bundles — so embedding it in pg_cron SQL is fine.
--
-- BEFORE PASTING: replace <<REPLACE_WITH_PROD_ANON_KEY>> below with the
--   anon key from
--   https://supabase.com/dashboard/project/uzjzknuhwyfrrtfusdus/settings/api-keys
--   → "anon public" row → click to reveal → copy the eyJ... value.
-- ─────────────────────────────────────────────────────────────────────────

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Unschedule any prior version of this job before re-registering so this
-- migration is replay-safe.
select cron.unschedule('refill-invoice') where exists (
  select 1 from cron.job where jobname = 'refill-invoice'
);

-- Register: 1st of every month at 09:00 UTC. The edge function reads
-- SCHEDULER_SECRET from its env and forwards to the app's
-- /api/cron/refill-invoice endpoint with the real secret.
select cron.schedule(
  'refill-invoice',
  '0 9 1 * *',
  $$
    select net.http_post(
      url     := 'https://uzjzknuhwyfrrtfusdus.supabase.co/functions/v1/refill-invoice',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer <<REPLACE_WITH_PROD_ANON_KEY>>'
      ),
      body    := '{}'::jsonb
    );
  $$
);

-- ── PostgREST schema reload ──────────────────────────────────────────────

notify pgrst, 'reload schema';

-- ── Verify (paste-friendly) ──────────────────────────────────────────────
-- Run these in the SQL editor after the migration completes to confirm:
--
-- select jobname, schedule, active, jobid
--   from cron.job
--  where jobname = 'refill-invoice';
--
-- -- Inspect recent cron runs (will be empty until the 1st of next month
-- -- or until manually fired):
-- select runid, status, return_message, start_time, end_time
--   from cron.job_run_details
--  where jobid = (select jobid from cron.job where jobname = 'refill-invoice')
--  order by start_time desc
--  limit 10;
--
-- -- Manually fire the cron to verify end-to-end (bypasses the schedule;
-- -- runs the same net.http_post the cron would have):
-- select net.http_post(
--   url     := 'https://uzjzknuhwyfrrtfusdus.supabase.co/functions/v1/refill-invoice',
--   headers := jsonb_build_object(
--     'Content-Type',  'application/json',
--     'Authorization', 'Bearer <<REPLACE_WITH_PROD_ANON_KEY>>'
--   ),
--   body    := '{}'::jsonb
-- );

-- ─── 8/9 outreach_templates ───────────────────
-- ─────────────────────────────────────────────────────────────────────────
-- v393 — Outreach template store (DB-as-source-of-truth for outreach copy)
-- ─────────────────────────────────────────────────────────────────────────
--
-- WHY THIS EXISTS
--   Grasshopper will iterate constantly on outreach copy (subject lines, body
--   tone, Loom scripts) and does not want to ask an engineer for every
--   tweak. v393 moves outreach text OUT of TypeScript files into the DB,
--   with an admin UI for inline edits and bulk-import from the polished
--   HTML doc on Desktop.
--
-- THE MODEL
--   One row per (icp, channel) where channel is a free-form key like
--   'loom_script', 'email_a', 'email_b', 'email_followup_3' etc. Versioning
--   via is_active flag — bulk imports create a new row (is_active=true) and
--   deactivate the prior version (is_active=false). This preserves the
--   entire history of every edit for audit and rollback.
--
-- KEY DECISIONS
--   - icp is a smallint (1, 2, 3) not text — small, fast, matches the doc
--   - channel is text not enum — lets Grasshopper add new channels (e.g.,
--     'email_referral', 'sms_v1') in the polished doc without a migration
--   - subject is nullable (loom_script and SMS variants don't have subjects)
--   - body is required and text (no length cap — long Loom scripts are fine)
--   - loom_url is optional (only populated after the video is recorded)
--   - notes is internal — never sent, surfaces in admin UI for context
--   - The partial unique index on (icp, channel) WHERE is_active enforces
--     "exactly one active version per slot" while still allowing the full
--     version history to live alongside
--
-- SEND-TIME CONTRACT (for the future sending ship)
--   const tpl = await getActiveTemplate({ icp: 2, channel: 'email_a' });
--   const subject = renderPlaceholders(tpl.subject, prospect);
--   const body = renderPlaceholders(tpl.body, prospect);
--   // ...Resend POST with plus-addressed Reply-To
--
-- PER [[project_outreach_paused]] this ship lands the substrate but no
-- outbound email actually fires until Grasshopper signals outreach is live.
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists public.outreach_templates (
  id           uuid        primary key default gen_random_uuid(),

  -- 1 = Karen's network, 2 = tier-2 independents, 3 = Acuity users.
  -- The semantic mapping lives in the polished outreach doc; this column
  -- just stores the integer.
  icp          smallint    not null check (icp in (1, 2, 3)),

  -- Channel key — free-form so new channels can land via doc upload
  -- without a migration. Established v393 set: 'loom_script', 'email_a',
  -- 'email_b', 'email_followup_3', 'email_followup_4', 'email_followup_12'.
  channel      text        not null,

  -- Email subject line (null for loom_script and any future no-subject channels).
  subject      text,

  -- The actual copy. For email channels this is the body HTML/text. For
  -- loom_script this is the full talking-head script with timestamps.
  body         text        not null,

  -- Optional Loom video URL (populated after the video is recorded). Only
  -- meaningful when channel='loom_script'.
  loom_url     text,

  -- Internal notes — surfaces in admin UI for context, never sent.
  notes        text,

  -- Versioning. Each bulk-import or inline edit creates a new row and
  -- deactivates the prior version for (icp, channel). version increments
  -- monotonically per slot.
  version      integer     not null default 1,
  is_active    boolean     not null default true,

  -- Who/when. updated_at is set by the application code (server fns) on
  -- every write — no DB trigger because the count of writers is small and
  -- explicit assignment is easier to audit.
  created_by   uuid        references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Exactly one active version per (icp, channel). Allows multiple historical
-- rows for audit while enforcing single source of truth at send-time.
create unique index if not exists outreach_templates_active_unique
  on public.outreach_templates (icp, channel)
  where is_active;

-- Lookup index for the send-time hot path: getActiveTemplate(icp, channel).
create index if not exists outreach_templates_lookup_idx
  on public.outreach_templates (icp, channel, is_active);

-- History queries.
create index if not exists outreach_templates_updated_idx
  on public.outreach_templates (updated_at desc);

comment on table public.outreach_templates is
  'Source of truth for outreach copy (subjects, bodies, Loom scripts) by ICP + channel. Editable inline via /app/admin/outreach OR bulk-imported from the polished Refill-Outreach-Pack-v1.html doc. Versioned via is_active flag; partial unique index enforces one-active-per-slot.';

comment on column public.outreach_templates.icp is
  '1=Karen network (warm), 2=tier-2 indep (cold), 3=Acuity users (warm-tech). Semantic mapping lives in the outreach pack doc.';

comment on column public.outreach_templates.channel is
  'Free-form channel key. Established set: loom_script, email_a, email_b, email_followup_N. Adding new channels does not require a migration — just upload a doc with the new data-channel attribute.';

-- ── RLS ─────────────────────────────────────────────────────────────────
-- Service-role only. All access goes through admin-gated server fns
-- (src/server/refill-outreach.ts) which do requireAdmin via user_roles.
-- Direct client access (anon/authenticated) is denied — outreach copy
-- is an admin surface, not a tenant surface.

alter table public.outreach_templates enable row level security;

do $$ begin
  create policy "service_role_outreach_templates"
    on public.outreach_templates for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

-- ── PostgREST schema reload ─────────────────────────────────────────────

notify pgrst, 'reload schema';

-- ── Verify (paste-friendly) ──────────────────────────────────────────────
-- Run after the migration completes to confirm the table + indexes landed:
--
-- select column_name, data_type, is_nullable
--   from information_schema.columns
--  where table_schema='public' and table_name='outreach_templates'
--  order by ordinal_position;
--
-- select indexname from pg_indexes
--  where schemaname='public' and tablename='outreach_templates';
--
-- -- After Po imports the v1 doc via /app/admin/outreach, this query shows
-- -- the seeded templates (should be 12):
-- select icp, channel, version,
--        coalesce(subject, '(no subject)') as subject_preview,
--        length(body) as body_chars
--   from public.outreach_templates
--  where is_active
--  order by icp, channel;

-- ─── 9/9 outreach_engagement_events ───────────
-- ─────────────────────────────────────────────────────────────────────────
-- v394 — Outreach engagement events (prospect-side mirror of tenant_engagement_events)
-- ─────────────────────────────────────────────────────────────────────────
--
-- WHY A SIBLING TABLE INSTEAD OF EXTENDING tenant_engagement_events
--   Prospects aren't tenants. Until a prospect signs up at /start, they
--   have no tenant_id. tenant_engagement_events has tenant_id NOT NULL by
--   design (it's a tenant-scoped table; queries fan out by tenant_id all
--   the time). Loosening that constraint would degrade tenant-scoped
--   query semantics across the codebase for every existing caller.
--
--   The sibling table keeps both scopes clean:
--     - tenant_engagement_events: tenant-scoped (drips, offers, post-signup)
--     - outreach_engagement_events: prospect-scoped (cold sends, replies)
--
--   When a prospect converts (signs up), we record converted_tenant_id
--   on the outreach_engagement_events row so analytics can correlate
--   pre-signup outreach with post-signup engagement.
--
-- KEY DECISIONS
--   - id is a UUID — used directly as the plus-address Reply-To token,
--     same pattern as tenant_engagement_events for drips
--   - rendered_subject / rendered_body store the POST-SUBSTITUTION text
--     that actually went out (so analytics + replays see what the recipient
--     saw, not the template)
--   - template_id is a soft FK to outreach_templates — survives template
--     edits (ON DELETE SET NULL) so historical sends keep their snapshot
--   - send_mode tracks 'dry_run' (system bench), 'test' (operator preview),
--     or 'live' (real outbound). Three modes are different audit categories
--   - resend_email_id is populated only when send_mode='live' (Resend
--     wasn't actually called for dry_run/test)
--   - Partial unique index on (recipient_email, template_id) WHERE
--     send_mode='live' prevents accidental double-sends of the same live
--     template to the same recipient. dry_run and test can repeat freely.
--
-- REPLY ROUTING
--   The inbound dispatcher at /api/resend/inbound calls
--   routeInboundOutreachReply after the drip handler. The plus-address
--   token is this row's id (a UUID). The outreach handler looks up the
--   row directly and stamps response_text + response_received_at.
--
-- PER [[project_outreach_paused]] no outbound email actually fires until
-- Grasshopper signals — v394 stubs the pipeline but defaults send_mode to
-- 'dry_run'. The OUTREACH_LIVE env flag is the only thing that changes
-- mode behavior.
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists public.outreach_engagement_events (
  id                       uuid        primary key default gen_random_uuid(),

  -- ── Recipient (prospect-side, not a tenant yet) ─────────────────────
  recipient_email          text        not null,
  recipient_first_name     text,
  recipient_last_name      text,

  -- Free-form sourcing context — "Met at Allergan dinner 2024",
  -- "Acuity user via inurl: search", etc. Useful for audit + per-source
  -- conversion analysis later.
  source_context           text,

  -- ── Template snapshot ───────────────────────────────────────────────
  -- Soft FK so historical engagement rows survive template deletions /
  -- replacements. The rendered_* columns below preserve what was sent
  -- even if the template gets edited later.
  template_id              uuid        references public.outreach_templates(id) on delete set null,
  icp                      smallint    not null check (icp in (1, 2, 3)),
  channel                  text        not null,

  -- ── Send tracking ───────────────────────────────────────────────────
  send_mode                text        not null
                            check (send_mode in ('dry_run', 'test', 'live')),
  -- Set only when send_mode='live' and Resend returned an id.
  resend_email_id          text,
  -- The post-substitution copy that actually went out. Null subject is
  -- allowed for loom_script channel (which has no subject).
  rendered_subject         text,
  rendered_body            text        not null,

  -- ── Timing ──────────────────────────────────────────────────────────
  sent_at                  timestamptz not null default now(),
  opened_at                timestamptz,
  clicked_at               timestamptz,

  -- ── Reply tracking ──────────────────────────────────────────────────
  response_text            text,
  response_received_at     timestamptz,

  -- ── Conversion linkage ──────────────────────────────────────────────
  -- Populated when this prospect signs up at /start and a tenant_memberships
  -- row gets created tying them to their new tenant.
  converted_tenant_id      uuid        references public.tenants(id) on delete set null,
  converted_at             timestamptz,

  -- ── Audit ───────────────────────────────────────────────────────────
  sent_by                  uuid        references auth.users(id) on delete set null,
  created_at               timestamptz not null default now()
);

-- Live-mode dedup: don't send the same template to the same recipient
-- live twice. dry_run/test paths can repeat freely (those don't fire
-- email). Partial index avoids polluting the index with the noisy
-- bench-mode rows.
create unique index if not exists outreach_eng_live_dedup
  on public.outreach_engagement_events (recipient_email, template_id)
  where send_mode = 'live';

-- Sorted-by-recency queries (admin recent-sends panel, future v2).
create index if not exists outreach_eng_sent_idx
  on public.outreach_engagement_events (sent_at desc);

-- Per (icp, channel, mode) analytics (open rates, reply rates per variant).
create index if not exists outreach_eng_icp_channel_idx
  on public.outreach_engagement_events (icp, channel, send_mode);

-- Replies queryable by id (already PK, but explicit for the inbound router
-- which does eq("id", token) lookups). PK serves this.

comment on table public.outreach_engagement_events is
  'Prospect-side engagement log for cold outreach. Sibling to tenant_engagement_events. Tracks what was sent (rendered snapshot), to whom, in what mode, and whether they replied or converted. Plus-address Reply-To token = id.';

comment on column public.outreach_engagement_events.send_mode is
  'dry_run = system bench (no email), test = operator preview (no email, UI shows rendered), live = real Resend POST.';

comment on column public.outreach_engagement_events.template_id is
  'Soft FK — historical sends survive template edits. The rendered_* columns preserve the exact text that went out.';

-- ── RLS ─────────────────────────────────────────────────────────────────
-- Service-role only. All access through admin-gated server fns.

alter table public.outreach_engagement_events enable row level security;

do $$ begin
  create policy "service_role_outreach_engagement_events"
    on public.outreach_engagement_events for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

notify pgrst, 'reload schema';

-- ── Verify (paste-friendly) ──────────────────────────────────────────────
-- select column_name, data_type, is_nullable
--   from information_schema.columns
--  where table_schema='public' and table_name='outreach_engagement_events'
--  order by ordinal_position;
--
-- select indexname from pg_indexes
--  where schemaname='public' and tablename='outreach_engagement_events';

-- ═══════════════════════════════════════════════════════════════════════
-- BATCH F VERIFY
-- ═══════════════════════════════════════════════════════════════════════
select 'new tables' as check_, count(*)::text as result from information_schema.tables where table_schema='public' and table_name in ('tenants','tenant_memberships','tenant_engagement_events','incentive_offers','refill_invoices','refill_pricing_plans','stripe_webhook_events','outreach_templates','outreach_engagement_events')
union all select 'total public tables', count(*)::text from information_schema.tables where table_schema='public';
