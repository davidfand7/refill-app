-- Emma(OS) per-spa no-show recovery policy config (v360).
--
-- One row per spa. All the knobs the owner controls for the no-show
-- recovery engine: pre-show cadence timing, tone, grace credit allocation,
-- reliability tier thresholds, opt-in footer text, agent on/off toggles.
--
-- Settings grow across the v360-v366 ship sequence — v361 adds rescue
-- settings, v362 adds reliability tier thresholds, v364 adds the
-- (off-by-default) deposit-credit policy. This migration creates the
-- table with v360-scope columns; later migrations ADD columns.
--
-- Defaults are tuned for the typical solo-to-5-staff med spa. Spa owner
-- can override every value via the /app/emma/settings/noshow UI.
--
-- Established 2026-05-17 (Promotions Engine v360).

create table if not exists public.emma_noshow_policies (
  id                          uuid        primary key default gen_random_uuid(),
  user_id                     uuid        not null references auth.users(id) on delete cascade,

  -- ── Pre-show agent settings ─────────────────────────────────────────

  -- Master on/off. When false, no pre-show reminders go out for this spa
  -- regardless of any other settings below.
  preshow_enabled             boolean     not null default true,

  -- Cadence offsets in hours BEFORE the appointment. The sweep fires
  -- a reminder when scheduled_at - offset is in the current 15-min window.
  -- Default = T-48h + T-24h + T-3h. Owner can add/remove offsets.
  preshow_cadence_hours       integer[]   not null default '{48,24,3}',

  -- Tone selector. Drives prompt + template selection for the LLM
  -- composition. Default 'warm' matches Emma's brand voice.
  preshow_tone                text        not null default 'warm'
                              check (preshow_tone in ('warm', 'professional', 'casual')),

  -- Channel preference. 'sms' = text only, 'email' = email only,
  -- 'auto' = SMS if phone on file else email.
  preshow_channel             text        not null default 'auto'
                              check (preshow_channel in ('sms', 'email', 'auto')),

  -- ── Universal opt-in footer (per Grasshopper, all outbound communications)

  -- The text appended to every Emma-outbound message inviting the patient
  -- to join the last-minute openings list. Default copy is a starting
  -- point; spa owner customizes.
  optin_footer_text           text        not null default 'Want first dibs on last-minute openings?',

  -- The URL the footer links to. The /waitlist/optin/<token> route
  -- backs this in v361. Until v361 ships, this can point to any
  -- spa-controlled URL (their own form).
  optin_list_url              text,

  -- Master toggle for the footer. Owners who don't want it can disable.
  optin_footer_enabled        boolean     not null default true,

  -- ── Grace credit policy (the no-fines, no-shame mechanic) ───────────

  -- Number of "free" last-minute cancellations a patient gets in a
  -- rolling 6-month window before pattern detection escalates.
  grace_credits_per_6mo       integer     not null default 2,

  -- ── Reliability tier thresholds (reserved for v362) ─────────────────

  -- jsonb: { trusted_max_noshows: 0, regular_min_visits: 3,
  --          vip_min_visits: 12, in_recovery_threshold: 3 }
  -- v360 ships defaults; v362's reliability engine actually reads them.
  reliability_tier_thresholds jsonb       not null default
    '{"trusted_max_noshows": 0,
      "regular_min_visits": 3,
      "vip_min_visits": 12,
      "in_recovery_threshold": 3,
      "in_recovery_window_months": 6}'::jsonb,

  -- ── Rescue agent settings (v361 will populate; v360 reserves) ───────

  rescue_enabled              boolean     not null default false,
  rescue_max_concurrent       integer     not null default 5,
  rescue_outreach_window_min  integer     not null default 90,

  -- ── Deposit-credit policy (v364 will populate; v360 reserves) ───────

  -- CRITICAL: ships OFF by default. The marketing line is "Emma never
  -- punishes your patients — unless you tell us to." Don't change this
  -- default without a strong reason.
  deposit_enabled             boolean     not null default false,
  deposit_amount_usd          numeric(10,2),
  deposit_trigger             text        check (deposit_trigger in
                                                  ('in_recovery_tier',
                                                   'new_patient',
                                                   'high_value_treatment')),
  deposit_refund_window_hours integer     not null default 24,

  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),

  unique (user_id)
);

alter table public.emma_noshow_policies enable row level security;

do $$ begin
  create policy "users_own_emma_noshow_policies"
    on public.emma_noshow_policies for all
    using  (auth.uid() = user_id)
    with check (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "service_role_emma_noshow_policies"
    on public.emma_noshow_policies for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

create trigger emma_noshow_policies_set_updated_at
  before update on public.emma_noshow_policies
  for each row execute function public.set_updated_at();

comment on table public.emma_noshow_policies is
  'Per-spa configuration for the no-show recovery engine. One row per spa. All knobs the owner controls — pre-show cadence, tone, grace credits, reliability tier thresholds, rescue settings, deposit policy. Smart defaults ship per column; owner overrides via /app/emma/settings/noshow.';
