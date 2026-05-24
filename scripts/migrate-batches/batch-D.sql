-- ═══════════════════════════════════════════════════════════════════════
-- BATCH D — Emma engine second half (8 migrations)
--   Recovery events, deposit holds, intelligence layer, billing,
--   CSV dialect cache, reconcile/recommendations/invoice crons.
-- ═══════════════════════════════════════════════════════════════════════

-- ─── 1/8 emma_recovery_events ─────────────────
-- Emma(OS) recovery event attribution (v363).
--
-- The financial foundation of the "free + % of recovered revenue"
-- pricing model. Every dollar Emma recovers must have a traceable,
-- code-computed audit trail. No LLM-generated numbers. [VERIFIED]
-- discipline applies — same convention as Liz's account math.
--
-- One row per recovery event. Provisional rows (verified_at null) are
-- created when an agent reports a save:
--   - Rescue agent fills a freed slot → recordRecoveryEvent('rescue')
--   - Post-show recovery agent (future v362.x) rebooks → 'post_recovery'
--   - Pre-show counterfactual estimate (future, complex) → 'preshow'
--
-- Provisional rows are verified by ONE of two paths:
--   - QBO reconciliation cron: matches recovery_events to
--     patient_transactions by patient + date window, stamps verified_at
--     + verification_source='qbo' + attributed_revenue_usd from the
--     transaction amount
--   - Manual confirm: spa owner clicks "Confirm $X billed" on
--     /app/emma/recovery dashboard, stamps verified_at + 'manual' +
--     verified_by + the amount they entered
--
-- Until verified, attributed_revenue_usd stays null. The v366 pricing
-- engine ONLY counts verified recovery events when computing the
-- monthly invoice — the spa never gets billed for a "save" we can't
-- prove actually billed.
--
-- Established 2026-05-17 (Promotions Engine v363).

create table if not exists public.emma_recovery_events (
  id                       uuid        primary key default gen_random_uuid(),
  user_id                  uuid        not null references auth.users(id) on delete cascade,

  -- The appointment that got saved. May be null for counterfactual
  -- preshow estimates (no specific appointment "saved" — just an
  -- improvement in the no-show rate). For v363 we only record events
  -- with a concrete appointment_id (rescue agent path).
  appointment_id           uuid        references public.emma_appointments(id) on delete set null,

  -- The patient who showed up + billed (so we can match against
  -- patient_transactions during reconciliation).
  patient_node_id          uuid        references public.knowledge_nodes(id) on delete set null,

  -- Which agent recovered this revenue.
  recovery_agent           text        not null
                           check (recovery_agent in (
                             'rescue',          -- v361 same-day slot fill
                             'post_recovery',   -- future post-show rebook
                             'preshow'          -- future counterfactual estimate
                           )),

  -- The mechanism that produced the recovery. Adds context beyond agent
  -- — useful for reporting (e.g. "of our rescue recoveries, how many
  -- came from the in-recovery cohort vs trusted?").
  attribution_method       text        not null default 'direct'
                           check (attribution_method in (
                             'direct',           -- patient claimed offer + showed
                             'counterfactual',   -- statistical estimate
                             'manual_credit'     -- spa owner manually credited
                           )),

  -- The estimated revenue from this save. Stays null until verified.
  -- Once verified, this number is what the v366 pricing model uses
  -- to compute the spa's monthly share.
  attributed_revenue_usd   numeric(12,2),

  -- Verification mechanics.
  verification_source      text        check (verification_source in (
                             'qbo',
                             'stripe',
                             'square',
                             'manual'
                           )),
  verified_at              timestamptz,
  verified_by              text,

  -- The matched transaction (for audit). Null on manual paths.
  matched_transaction_id   uuid        references public.patient_transactions(id) on delete set null,

  notes                    text,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

alter table public.emma_recovery_events enable row level security;

do $$ begin
  create policy "users_own_emma_recovery_events"
    on public.emma_recovery_events for all
    using  (auth.uid() = user_id)
    with check (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "service_role_emma_recovery_events"
    on public.emma_recovery_events for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

-- Reconciliation cron hot path: "find unverified recovery events"
create index if not exists emma_recovery_events_unverified_idx
  on public.emma_recovery_events (user_id, created_at desc)
  where verified_at is null;

-- Monthly invoice computation hot path (v366): "all verified events
-- for this spa in this month"
create index if not exists emma_recovery_events_verified_by_month_idx
  on public.emma_recovery_events (user_id, verified_at desc)
  where verified_at is not null;

-- Per-appointment lookup (idempotency check — don't double-record)
create index if not exists emma_recovery_events_by_appointment_idx
  on public.emma_recovery_events (appointment_id)
  where appointment_id is not null;

create trigger emma_recovery_events_set_updated_at
  before update on public.emma_recovery_events
  for each row execute function public.set_updated_at();

-- Add a back-reference column to emma_appointments. Future ships
-- (v365 intelligence, v366 billing) can join the appointment list
-- back to its recovery event without a separate query.
alter table public.emma_appointments
  add column if not exists recovery_event_id uuid
    references public.emma_recovery_events(id) on delete set null;

create index if not exists emma_appointments_recovery_event_idx
  on public.emma_appointments (recovery_event_id)
  where recovery_event_id is not null;

comment on table public.emma_recovery_events is
  'Per-save audit log. Provisional rows on create (verified_at null); verified by QBO reconciliation cron OR manual spa-owner confirmation. attributed_revenue_usd only populated post-verification. The v366 pricing model bills ONLY verified events — no spa pays for a save we cannot prove billed.';

-- ─── 2/8 emma_reconcile_cron ──────────────────
-- Emma daily reconciliation — matches recovery events to QBO transactions (v363).
--
-- Hits /api/cron/emma-reconcile once a day at 04:30 UTC (after the
-- reliability sweep, before the morning).
--
-- For each spa, the endpoint scans unverified emma_recovery_events
-- (verified_at null) and tries to match them to patient_transactions
-- by patient_node_id + transaction_date in the 14-day window AFTER
-- the rescue claim. On match: stamp verified_at + 'qbo' +
-- attributed_revenue_usd from the transaction.amount_usd. Best-effort
-- — manual confirmation always works as a fallback for any missed
-- match or non-QBO spas.
--
-- v358 secret-rotation note: REPLACE <<REPLACE_WITH_PROD_SCHEDULER_SECRET>>
-- with the current SCHEDULER_SECRET value from the Cloudflare Worker env
-- before pasting.
--
-- Established 2026-05-17 (Promotions Engine v363).

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('emma-reconcile') where exists (
  select 1 from cron.job where jobname = 'emma-reconcile'
);

-- 04:30 UTC daily — well after reliability sweep (02:00) and
-- well before US-Eastern AM rush (~12:30 UTC for early-bird spas).
select cron.schedule(
  'emma-reconcile',
  '30 4 * * *',
  $$
    select net.http_post(
      url     := 'https://refill-app.davidfand303.workers.dev/api/cron/emma-reconcile',
      headers := jsonb_build_object(
        'Content-Type',       'application/json',
        'X-Scheduler-Secret', '<<REPLACE_WITH_PROD_SCHEDULER_SECRET>>'
      ),
      body    := '{}'::jsonb
    );
  $$
);

select jobname, schedule, active
from cron.job
where jobname = 'emma-reconcile';

-- ─── 3/8 emma_deposit_holds ───────────────────
-- Emma(OS) deposit-credit holds (v364).
--
-- The OPTIONAL deposit-credit mechanic for the chronic-offender tail.
-- OFF by default. Most spas will never enable it. The marketing line
-- is "Emma never punishes your patients — unless you tell us to."
--
-- v364 ships the schema + settings activation + intent audit log.
-- v364.x (future) wires the Stripe payment_intent flow that puts an
-- actual hold on the patient's card. For now, when an in-recovery
-- patient books AND policy.deposit_enabled is true, Emma LOGS the
-- intent — a row marked 'intent' in this table. The spa owner sees
-- it on /app/emma/recovery Deposits tab; no money moves yet.
--
-- Status lifecycle (future Stripe wiring):
--   intent     — would-have-been-requested; logged today, no money moves
--   held       — Stripe payment_intent in requires_capture mode (auth)
--   applied    — appointment showed + billed; auth was captured as credit
--   refunded   — patient rescheduled in time; auth was released
--   voided     — spa cancelled the hold manually
--
-- Established 2026-05-17 (Promotions Engine v364).

create table if not exists public.emma_deposit_holds (
  id                  uuid        primary key default gen_random_uuid(),
  user_id             uuid        not null references auth.users(id) on delete cascade,

  -- The appointment the deposit is tied to. Null is invalid; deposits
  -- always reference a specific booking.
  appointment_id      uuid        not null references public.emma_appointments(id) on delete cascade,

  -- The patient on the hook.
  patient_node_id     uuid        not null references public.knowledge_nodes(id) on delete cascade,

  -- The trigger that fired this — useful for reporting which trigger
  -- type is producing the most holds (and for future A/B of triggers).
  trigger_reason      text        not null
                      check (trigger_reason in (
                        'in_recovery_tier',
                        'new_patient',
                        'high_value_treatment'
                      )),

  amount_usd          numeric(10,2) not null,

  -- v1 status enum. Future ships add the rest as Stripe wiring lands.
  status              text        not null default 'intent'
                      check (status in (
                        'intent',
                        'held',
                        'applied',
                        'refunded',
                        'voided'
                      )),

  -- Stripe payment_intent id when wired (v364.x); null on intent-only rows.
  stripe_payment_intent_id text,

  -- Lifecycle timestamps.
  intent_logged_at    timestamptz not null default now(),
  held_at             timestamptz,
  applied_at          timestamptz,
  refunded_at         timestamptz,
  voided_at           timestamptz,

  -- Audit fields.
  voided_by           text,
  notes               text,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- One deposit per appointment. If the appointment is rescheduled
  -- (new emma_appointments row), the deposit follows the new row.
  unique (appointment_id)
);

alter table public.emma_deposit_holds enable row level security;

do $$ begin
  create policy "users_own_emma_deposit_holds"
    on public.emma_deposit_holds for all
    using  (auth.uid() = user_id)
    with check (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "service_role_emma_deposit_holds"
    on public.emma_deposit_holds for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

create index if not exists emma_deposit_holds_by_status_idx
  on public.emma_deposit_holds (user_id, status, intent_logged_at desc);

create index if not exists emma_deposit_holds_by_patient_idx
  on public.emma_deposit_holds (user_id, patient_node_id, intent_logged_at desc);

create trigger emma_deposit_holds_set_updated_at
  before update on public.emma_deposit_holds
  for each row execute function public.set_updated_at();

comment on table public.emma_deposit_holds is
  'Per-appointment deposit-credit lifecycle. Spa-scoped via RLS. v364 ships intent-only logging (status=intent); future v364.x wires Stripe payment_intent for actual card holds. OFF by default policy-side — owner must explicitly enable on /app/emma/settings/noshow.';

-- ─── 4/8 emma_intelligence ────────────────────
-- Emma(OS) cross-spa intelligence + benchmark recommendations (v365).
--
-- THE MOAT-OF-MOATS. Two tables that compound with every spa Emma
-- onboards:
--
--   emma_setting_benchmarks       — aggregated metrics per
--                                    (segment, setting_key, setting_value)
--                                    Computed daily; gated on N>=10 spas
--                                    per cohort before any benchmark surfaces.
--   emma_setting_recommendations  — per-spa actionable suggestions:
--                                    "your T-3h reminder is off; spas like
--                                    yours see +$1,800/mo enabling it."
--                                    Generated weekly + on-demand when the
--                                    spa visits /app/emma/rescue.
--
-- v365 ships the schema + the rules-based starter recommendation
-- generator (best-practice advice that works without N>=10 data). As
-- spas onboard, the recompute logic transitions naturally from starter
-- rules to data-derived benchmarks. The schema is built for both.
--
-- Privacy: benchmarks are aggregate only. No single spa's data is ever
-- exposed in another spa's recommendations — only "spas like yours
-- typically see X" framing. Minimum cohort size of 10 before any
-- benchmark surfaces, enforced at recompute time.
--
-- Established 2026-05-17 (Promotions Engine v365).

-- ── emma_setting_benchmarks ─────────────────────────────────────────────

create table if not exists public.emma_setting_benchmarks (
  id                     uuid        primary key default gen_random_uuid(),

  -- Cohort segmentation. Starter segments (v365):
  --   'all'                     — every spa (always-on fallback)
  --   'small_spa'               — solo to 5 providers (default for now)
  --   'high_volume'             — 500+ appointments/month
  -- Future ships add finer-grained segments (treatment-mix, geo, tenure).
  segment_key            text        not null,

  -- Which setting we're benchmarking.
  --   'preshow_cadence_has_3h'    — bool: does the cadence include T-3h?
  --   'rescue_enabled'            — bool
  --   'preshow_tone'              — 'warm' | 'professional' | 'casual'
  --   'optin_footer_enabled'      — bool
  setting_key            text        not null,

  -- Stringified value for the benchmark bucket. We aggregate
  -- recovery_rate + sample_size grouped by (segment, setting, value).
  setting_value          text        not null,

  -- Aggregate metrics for this cell.
  median_monthly_recovery_usd  numeric(12,2),
  median_recovery_rate         numeric(5,4), -- 0..1
  sample_size                  integer     not null default 0,

  computed_at            timestamptz not null default now(),
  unique (segment_key, setting_key, setting_value)
);

-- Benchmarks are global aggregate — NOT spa-scoped. Service-role-only
-- read access; the recommendations table is the spa-facing surface.
alter table public.emma_setting_benchmarks enable row level security;

do $$ begin
  create policy "service_role_emma_setting_benchmarks"
    on public.emma_setting_benchmarks for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

create index if not exists emma_setting_benchmarks_lookup_idx
  on public.emma_setting_benchmarks (segment_key, setting_key);

-- ── emma_setting_recommendations ────────────────────────────────────────

create table if not exists public.emma_setting_recommendations (
  id                     uuid        primary key default gen_random_uuid(),
  user_id                uuid        not null references auth.users(id) on delete cascade,

  -- The setting we're recommending the spa change.
  setting_key            text        not null,

  -- Current value (string-encoded). Lets the UI show before/after.
  current_value          text,

  -- Suggested value (string-encoded). When the spa hits Apply, this is
  -- parsed back to the appropriate type and used to call
  -- updateNoShowPolicy with the relevant field.
  suggested_value        text        not null,

  -- Source of the recommendation. 'starter_rule' = rules-based best
  -- practice (works without data); 'benchmark_data' = derived from
  -- emma_setting_benchmarks with N>=10 cohort backing it.
  source                 text        not null
                         check (source in ('starter_rule', 'benchmark_data')),

  -- The plain-English headline + body. Code-composed at generate time;
  -- no LLM. Predictable surface.
  headline               text        not null,
  body                   text,

  -- Projected lift in monthly recovered revenue. Conservative — null
  -- when we can't compute one (rare for starter, common for early
  -- benchmark_data rows).
  projected_lift_usd     numeric(12,2),

  -- Lifecycle.
  applied_at             timestamptz,
  dismissed_at           timestamptz,
  dismissed_by           text,

  -- Snapshot of the spa's settings at apply time (for rollback if the
  -- spa later regrets the change). jsonb.
  rollback_snapshot      jsonb,

  generated_at           timestamptz not null default now(),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  -- Don't show the same recommendation twice. One active rec per
  -- (user, setting_key). If the spa dismisses + something changes,
  -- regeneration overwrites the dismissed_at to null on the new row.
  unique (user_id, setting_key)
);

alter table public.emma_setting_recommendations enable row level security;

do $$ begin
  create policy "users_own_emma_setting_recommendations"
    on public.emma_setting_recommendations for all
    using  (auth.uid() = user_id)
    with check (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "service_role_emma_setting_recommendations"
    on public.emma_setting_recommendations for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

create index if not exists emma_setting_recommendations_active_idx
  on public.emma_setting_recommendations (user_id, generated_at desc)
  where applied_at is null and dismissed_at is null;

create trigger emma_setting_recommendations_set_updated_at
  before update on public.emma_setting_recommendations
  for each row execute function public.set_updated_at();

comment on table public.emma_setting_benchmarks is
  'Cross-spa aggregate metrics per (segment, setting, value). Privacy-gated to N>=10 spas per cohort. The data flywheel that powers personalized recommendations as more spas onboard. Service-role read only.';

comment on table public.emma_setting_recommendations is
  'Per-spa actionable suggestions with projected lift. Generated from emma_setting_benchmarks when data is available, or from rules-based starter best practices when not. Spa-scoped via RLS. One active row per (user, setting_key).';

-- ─── 5/8 emma_recommendations_cron ────────────
-- Emma weekly recommendations regen — refreshes setting recommendations
-- across every spa once a week (v365).
--
-- Hits /api/cron/emma-recommendations on Sunday at 06:00 UTC. The
-- foreground regen also fires on-demand when the spa visits
-- /app/emma/rescue, debounced per-spa so we don't recompute on every
-- page hit. The weekly cron is the safety net for spas that haven't
-- visited recently.
--
-- v358 secret-rotation note: REPLACE <<REPLACE_WITH_PROD_SCHEDULER_SECRET>>
-- with the current value before pasting.
--
-- Established 2026-05-17 (Promotions Engine v365).

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('emma-recommendations') where exists (
  select 1 from cron.job where jobname = 'emma-recommendations'
);

-- Sunday 06:00 UTC (weekly).
select cron.schedule(
  'emma-recommendations',
  '0 6 * * 0',
  $$
    select net.http_post(
      url     := 'https://refill-app.davidfand303.workers.dev/api/cron/emma-recommendations',
      headers := jsonb_build_object(
        'Content-Type',       'application/json',
        'X-Scheduler-Secret', '<<9717152588c1f6697da3629b5af89e08ee0ff8fbb2c4bc6f>>'
      ),
      body    := '{}'::jsonb
    );
  $$
);

select jobname, schedule, active
from cron.job
where jobname = 'emma-recommendations';

-- ─── 6/8 emma_billing ─────────────────────────
-- Emma(OS) pricing plan + monthly invoicing (v366 — the killshot).
--
-- The capstone of the no-show recovery engine. Where the $$ actually
-- flows. Per the strategy doc: "free + % of recovered revenue" is the
-- pricing innovation that disintermediates the entire med-spa PMS
-- category. Incumbents charging $200-$500/mo flat with 12-month
-- contracts cannot match this without restructuring their entire
-- revenue model.
--
-- Two tables:
--   emma_pricing_plans  — per-spa plan selection (one active row per
--                          user_id; historical rows preserved for
--                          plan-change audit).
--   emma_invoices       — monthly billing records. Generated on the
--                          1st of each month for prior month's verified
--                          recovery events. v366 ships invoices in
--                          'draft' status; v366.x activates Stripe.
--
-- Three plans:
--   performance — free + 12% of recovered revenue (default, aligns
--                  incentives — the spa only pays when revenue arrives)
--   predictable — $299/mo flat, all features (for owners who hate
--                  revenue share on principle)
--   hybrid      — $99/mo + 8% of recovered (commitment + shared upside)
--
-- v366 ships the schema + UI + math + draft-invoice cron. v366.x adds
-- the Stripe customer + payment_method + actual collection flow when
-- a real spa explicitly opts in. Same pattern as v364 deposits —
-- ship the engine, defer activation.
--
-- Established 2026-05-17 (Promotions Engine v366 — engine complete).

-- ── emma_pricing_plans ──────────────────────────────────────────────────

create table if not exists public.emma_pricing_plans (
  id                       uuid        primary key default gen_random_uuid(),
  user_id                  uuid        not null references auth.users(id) on delete cascade,

  plan                     text        not null
                           check (plan in ('performance', 'predictable', 'hybrid')),

  -- The economic parameters. Snapshotted at plan-selection time so
  -- a future price change doesn't retroactively alter past invoices.
  revenue_share_pct        numeric(5,4)  not null default 0,  -- 0..1 (0.12 = 12%)
  monthly_flat_usd         numeric(10,2) not null default 0,

  -- Lifecycle.
  -- A spa has at most one row with plan_ended_at=null at a time
  -- (the active plan). Plan changes write a new row + close the prior.
  plan_started_at          timestamptz not null default now(),
  plan_ended_at            timestamptz,

  -- Stripe customer linkage. NULL until the spa adds a payment method
  -- (v366.x). For v1 we record the plan but no Stripe entities exist.
  stripe_customer_id       text,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

alter table public.emma_pricing_plans enable row level security;

do $$ begin
  create policy "users_own_emma_pricing_plans"
    on public.emma_pricing_plans for all
    using  (auth.uid() = user_id)
    with check (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "service_role_emma_pricing_plans"
    on public.emma_pricing_plans for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

-- Active-plan hot path: "what plan is this spa on right now?"
create index if not exists emma_pricing_plans_active_idx
  on public.emma_pricing_plans (user_id)
  where plan_ended_at is null;

create trigger emma_pricing_plans_set_updated_at
  before update on public.emma_pricing_plans
  for each row execute function public.set_updated_at();

-- ── emma_invoices ────────────────────────────────────────────────────────

create table if not exists public.emma_invoices (
  id                       uuid        primary key default gen_random_uuid(),
  user_id                  uuid        not null references auth.users(id) on delete cascade,

  -- The billing period. period_start is the 1st of the month at
  -- 00:00 UTC; period_end is the 1st of the next month (exclusive).
  period_start             timestamptz not null,
  period_end               timestamptz not null,

  -- Plan snapshot at invoice time (so future plan changes don't
  -- retroactively alter historical invoices).
  plan_at_invoice          text        not null,
  revenue_share_pct        numeric(5,4) not null,
  monthly_flat_usd         numeric(10,2) not null,

  -- The math. recovered_revenue_usd is the sum of verified
  -- recovery_events in the period; share_due_usd = recovered * pct;
  -- total_due_usd = share_due + monthly_flat.
  recovered_revenue_count  integer     not null default 0,
  recovered_revenue_usd    numeric(12,2) not null default 0,
  share_due_usd            numeric(12,2) not null default 0,
  total_due_usd            numeric(12,2) not null default 0,

  -- Lifecycle.
  status                   text        not null default 'draft'
                           check (status in (
                             'draft',         -- v366 default; not yet pushed to Stripe
                             'sent',          -- v366.x — pushed to Stripe
                             'paid',          -- v366.x — Stripe paid
                             'failed',        -- v366.x — payment failed
                             'void'           -- spa cancelled/disputed
                           )),

  -- Stripe invoice id when wired (v366.x). NULL on draft rows.
  stripe_invoice_id        text,

  -- Audit.
  generated_at             timestamptz not null default now(),
  sent_at                  timestamptz,
  paid_at                  timestamptz,
  voided_at                timestamptz,
  voided_by                text,
  notes                    text,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  -- One invoice per (spa, month).
  unique (user_id, period_start)
);

alter table public.emma_invoices enable row level security;

do $$ begin
  create policy "users_own_emma_invoices"
    on public.emma_invoices for all
    using  (auth.uid() = user_id)
    with check (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "service_role_emma_invoices"
    on public.emma_invoices for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

create index if not exists emma_invoices_by_user_idx
  on public.emma_invoices (user_id, period_start desc);

create index if not exists emma_invoices_by_status_idx
  on public.emma_invoices (user_id, status)
  where status in ('draft', 'sent', 'failed');

create trigger emma_invoices_set_updated_at
  before update on public.emma_invoices
  for each row execute function public.set_updated_at();

comment on table public.emma_pricing_plans is
  'Per-spa pricing plan selection. One active row (plan_ended_at=null) per user_id at a time; historical rows preserved on plan change. Plan economics snapshotted at selection so future price changes don''t alter past invoices.';

comment on table public.emma_invoices is
  'Monthly billing record per (spa, month). Generated on the 1st by the v366 cron from verified emma_recovery_events. v366 ships in draft status — v366.x activates Stripe push + collection.';

-- ─── 7/8 emma_invoice_cron ────────────────────
-- Emma monthly invoice generation — fires /api/cron/emma-invoice on the
-- 1st of each month at 09:00 UTC (v366).
--
-- For each spa with an active emma_pricing_plans row, aggregates verified
-- emma_recovery_events from the prior month, computes the share, generates
-- an emma_invoices row in draft status. v366.x flips draft → sent + pushes
-- to Stripe when the spa adds a payment method.
--
-- v358 secret-rotation note: REPLACE <<REPLACE_WITH_PROD_SCHEDULER_SECRET>>
-- with the current value before pasting.
--
-- Established 2026-05-17 (Promotions Engine v366 — engine complete).

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('emma-invoice') where exists (
  select 1 from cron.job where jobname = 'emma-invoice'
);

-- 1st of every month at 09:00 UTC. Late enough that the prior day's
-- reconciliation cron (04:30 UTC) has settled the last batch of
-- verified recovery events.
select cron.schedule(
  'emma-invoice',
  '0 9 1 * *',
  $$
    select net.http_post(
      url     := 'https://refill-app.davidfand303.workers.dev/api/cron/emma-invoice',
      headers := jsonb_build_object(
        'Content-Type',       'application/json',
        'X-Scheduler-Secret', '<<REPLACE_WITH_PROD_SCHEDULER_SECRET>>'
      ),
      body    := '{}'::jsonb
    );
  $$
);

select jobname, schedule, active
from cron.job
where jobname = 'emma-invoice';

-- ─── 8/8 emma_csv_dialect_cache ───────────────
-- v368: Universal LLM-mapped CSV adapter — per-spa header-hash cache.
--
-- When a spa uploads a CSV the importer can't recognize via the v367
-- hardcoded dialect cascade (or whose generic-fuzzy parse returns zero
-- appointments), we call a single small LLM mapping pass that returns
-- header → canonical-field aliases. The mapping is cached here keyed
-- on (user_id, header_hash) so every subsequent upload of that same
-- CSV shape is free — no LLM call, no latency, deterministic parse.
--
-- The user_corrected_at column captures human-in-the-loop fixes: if the
-- spa edits the mapping in the UI, we stamp it and trust the corrected
-- mapping forever. The LLM never gets to re-overwrite a manual fix.

create table if not exists public.emma_csv_dialect_cache (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Normalized SHA-256 hash of (header row lowercased, joined by |)
  header_hash text not null,
  -- Display-only name the LLM guessed ("Mindbody", "Custom export", etc.)
  detected_platform text,
  -- ColAliases shape: { date: ["Booking Date"], time: ["Start Time"], ... }
  alias_map jsonb not null,
  -- Which LLM produced this mapping (for future model-upgrade re-runs)
  llm_model text not null,
  llm_at timestamptz not null default now(),
  -- Stamped when a user manually edits the mapping. LLM never overwrites this.
  user_corrected_at timestamptz,
  use_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, header_hash)
);

create index if not exists emma_csv_dialect_cache_user_id_idx
  on public.emma_csv_dialect_cache (user_id);

alter table public.emma_csv_dialect_cache enable row level security;

-- Spa owners can see + edit their own cache rows
create policy "spa owners select own dialect cache"
  on public.emma_csv_dialect_cache for select
  using (auth.uid() = user_id);

create policy "spa owners update own dialect cache"
  on public.emma_csv_dialect_cache for update
  using (auth.uid() = user_id);

create policy "spa owners delete own dialect cache"
  on public.emma_csv_dialect_cache for delete
  using (auth.uid() = user_id);

-- Service role full access (the ingest fn writes via service role)
create policy "service role full access on dialect cache"
  on public.emma_csv_dialect_cache for all
  to service_role using (true) with check (true);

-- updated_at auto-touch
create or replace function public.touch_emma_csv_dialect_cache_updated_at()
returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_emma_csv_dialect_cache_updated_at
  on public.emma_csv_dialect_cache;
create trigger trg_emma_csv_dialect_cache_updated_at
  before update on public.emma_csv_dialect_cache
  for each row execute function public.touch_emma_csv_dialect_cache_updated_at();

-- ═══════════════════════════════════════════════════════════════════════
-- BATCH D VERIFY
-- ═══════════════════════════════════════════════════════════════════════
select 'new emma tables' as check_, count(*)::text as result from information_schema.tables where table_schema='public' and table_name in ('emma_recovery_events','emma_deposit_holds','emma_setting_benchmarks','emma_setting_recommendations','emma_invoices','emma_pricing_plans','emma_csv_dialect_cache')
union all select 'total public tables', count(*)::text from information_schema.tables where table_schema='public';
