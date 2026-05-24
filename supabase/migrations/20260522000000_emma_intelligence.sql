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
