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
