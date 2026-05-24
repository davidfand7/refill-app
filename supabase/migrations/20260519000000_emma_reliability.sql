-- Emma(OS) reliability tier engine + pattern alerts (v362).
--
-- Per-patient reliability tier computed from appointment history. Tiers:
--   'trusted'     — default; no recent no-shows
--   'regular'     — 3+ completed visits
--   'vip'         — 12+ completed visits (per default policy thresholds)
--   'in_recovery' — 3+ no-shows in rolling 6mo (chronic offenders)
--
-- Thresholds are per-spa configurable via
-- emma_noshow_policies.reliability_tier_thresholds jsonb. Default shape:
--   { "trusted_max_noshows": 0,
--     "regular_min_visits": 3,
--     "vip_min_visits": 12,
--     "in_recovery_threshold": 3,
--     "in_recovery_window_months": 6 }
--
-- The reliability row is MATERIALIZED — recomputed by foreground triggers
-- (updateAppointmentStatus fires it) AND by a daily cron sweep (safety
-- net for any missed signals). Never computed on the fly at read time.
--
-- Pattern alerts fire on tier TRANSITIONS only (not initial assignment).
-- e.g. trusted→in_recovery, regular→vip. Surfaces in /app/emma/rescue
-- under the Patterns tab.
--
-- Established 2026-05-17 (Promotions Engine v362).

-- ── emma_reliability_status ─────────────────────────────────────────────

create table if not exists public.emma_reliability_status (
  id                      uuid        primary key default gen_random_uuid(),
  user_id                 uuid        not null references auth.users(id) on delete cascade,
  patient_node_id         uuid        not null references public.knowledge_nodes(id) on delete cascade,

  tier                    text        not null default 'trusted'
                          check (tier in ('trusted', 'regular', 'vip', 'in_recovery')),

  -- Counts from the last recompute (denormalized for fast UI reads).
  no_shows_6mo            integer     not null default 0,
  total_visits            integer     not null default 0,
  cancellations_6mo       integer     not null default 0,

  -- How many grace credits the patient has used in the rolling 6mo
  -- window. Compared against policy.grace_credits_per_6mo by the v364
  -- deposit-credit trigger. v362 just materializes the count.
  grace_credits_used      integer     not null default 0,

  -- When the patient last had any appointment activity (last sent/
  -- showed/no_show timestamp). Used for the "patient has gone quiet"
  -- signal in future ships.
  last_activity_at        timestamptz,

  -- Materialization metadata.
  recomputed_at           timestamptz not null default now(),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  unique (user_id, patient_node_id)
);

alter table public.emma_reliability_status enable row level security;

do $$ begin
  create policy "users_own_emma_reliability_status"
    on public.emma_reliability_status for all
    using  (auth.uid() = user_id)
    with check (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "service_role_emma_reliability_status"
    on public.emma_reliability_status for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

-- "Who's currently in_recovery?" hot path for the v364 deposit trigger.
create index if not exists emma_reliability_status_in_recovery_idx
  on public.emma_reliability_status (user_id, patient_node_id)
  where tier = 'in_recovery';

-- "Show me VIPs" filter on the patient list.
create index if not exists emma_reliability_status_vip_idx
  on public.emma_reliability_status (user_id, patient_node_id)
  where tier = 'vip';

create trigger emma_reliability_status_set_updated_at
  before update on public.emma_reliability_status
  for each row execute function public.set_updated_at();

-- ── emma_pattern_alerts ────────────────────────────────────────────────

create table if not exists public.emma_pattern_alerts (
  id                      uuid        primary key default gen_random_uuid(),
  user_id                 uuid        not null references auth.users(id) on delete cascade,
  patient_node_id         uuid        not null references public.knowledge_nodes(id) on delete cascade,

  -- Alert kind. Drives the message template + the suggested-action set.
  kind                    text        not null
                          check (kind in (
                            'tier_promoted',
                            'tier_demoted',
                            'in_recovery_triggered',
                            'vip_unlocked',
                            'regular_unlocked',
                            'returned_to_trusted'
                          )),

  -- The transition that fired the alert.
  from_tier               text,
  to_tier                 text        not null,

  -- Headline + body computed at firing time. Owner sees these on the
  -- Patterns tab. Code-composed, not LLM (predictable surface).
  headline                text        not null,
  body                    text,

  -- Spa owner action state.
  dismissed_at            timestamptz,
  dismissed_by            text,

  created_at              timestamptz not null default now()
);

alter table public.emma_pattern_alerts enable row level security;

do $$ begin
  create policy "users_own_emma_pattern_alerts"
    on public.emma_pattern_alerts for all
    using  (auth.uid() = user_id)
    with check (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "service_role_emma_pattern_alerts"
    on public.emma_pattern_alerts for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

create index if not exists emma_pattern_alerts_unread_idx
  on public.emma_pattern_alerts (user_id, created_at desc)
  where dismissed_at is null;

create index if not exists emma_pattern_alerts_by_patient_idx
  on public.emma_pattern_alerts (user_id, patient_node_id, created_at desc);

comment on table public.emma_reliability_status is
  'Materialized per-patient reliability tier — recomputed by foreground triggers + daily cron sweep. Tier ∈ {trusted, regular, vip, in_recovery}. Tiers, thresholds, and the 6mo window are all spa-configurable via emma_noshow_policies.reliability_tier_thresholds.';

comment on table public.emma_pattern_alerts is
  'System-generated alerts when a patient transitions between reliability tiers. Surfaced on /app/emma/rescue Patterns tab. Spa owner dismisses; alerts persist for history but stop nagging.';
