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
