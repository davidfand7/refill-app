-- ═══════════════════════════════════════════════════════════════════════
-- BATCH C (retry) — Emma engine first half + set_updated_at() fix-up
--   Prepended 20260515999999_set_updated_at_function.sql (cleave fix:
--   helper trigger function not ported with Agentiport bootstrap).
-- ═══════════════════════════════════════════════════════════════════════

-- ─── 0/11 set_updated_at_function (CLEAVE FIX) ─
-- Cleave fix 2026-05-24 — port the set_updated_at() trigger function.
--
-- The function is referenced by multiple Refill migrations (emma_noshow_policies,
-- emma_waitlist, emma_rescue, emma_reliability, emma_recovery_events,
-- emma_intelligence) as a trigger to auto-bump updated_at on row updates.
-- In openagenticv4 it's defined in the v4_all_features bootstrap migration
-- (20260421100000) which is NOT ported (Agentiport-only platform bootstrap).
--
-- Slotted at 20260515999999 to land BEFORE the first Refill migration that
-- references it (20260516000000_emma_sender_domains).

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- ─── 1/11 emma_sender_domains ─────────────────
-- Emma(OS) per-spa sender domains (v355).
--
-- Replaces the EMMA_FROM_EMAIL global with a per-tenant verified sender.
-- Each spa can register their own domain ("rejuvmedical.com"), prove
-- ownership via DNS records published by Resend, then send campaigns
-- as "Emma at Rejuv <hello@rejuvmedical.com>" instead of the platform
-- default "Emma <hello@notify.openagentic.site>".
--
-- One row per spa per domain. Resend's domain object is the source of
-- truth for verification status; we mirror just enough to render the UI
-- without round-tripping to Resend on every page load (we DO refresh on
-- the Verify button + at send time when status='pending').
--
-- Tenant boundary: every row scoped by user_id with RLS. Reps don't
-- read this — outbound sender identity is a spa-side concern.
--
-- Storage shape (NOT a column-per-DNS-record): Resend returns a
-- `records` array with mixed types (SPF TXT, DKIM CNAME, MX) that
-- evolves with their infra. Persisting it verbatim as jsonb lets the
-- UI render whatever Resend currently asks for without a schema
-- migration every time they tweak.
--
-- Send-time fallback: when the spa has no row (or status != 'verified'),
-- emma-blast.functions.ts falls back to the platform default. Status
-- transitions: 'pending' → 'verified' (DNS published + Resend confirms)
-- or 'failed' (Resend gave up after retries). No row = use default.
--
-- Established 2026-05-16 (Promotions Engine v355).

create table if not exists public.emma_sender_domains (
  id                  uuid        primary key default gen_random_uuid(),
  user_id             uuid        not null references auth.users(id) on delete cascade,

  -- The apex / subdomain the spa registered, e.g. "rejuvmedical.com"
  -- or "send.rejuvmedical.com". One row per (user_id, domain).
  domain              text        not null,

  -- The visible parts of the From address. Resolves to
  --   "<from_display_name> <from_local_part@domain>"
  -- e.g. "Emma at Rejuv <hello@rejuvmedical.com>".
  -- Both have sane defaults so the spa only has to click Connect.
  from_local_part     text        not null default 'hello',
  from_display_name   text        not null default 'Emma',

  -- The Resend domain object id. Lets us GET /domains/:id on refresh
  -- without listing every domain on the account.
  resend_domain_id    text,

  -- Mirrored from Resend. 'pending' until DNS is published, 'verified'
  -- once Resend confirms, 'failed' if Resend gives up. We also use
  -- 'pending' as the initial state immediately after POST /domains.
  status              text        not null default 'pending'
                      check (status in ('pending', 'verified', 'failed')),

  -- Verbatim records[] array from Resend's domain object. Each entry
  -- carries { record: 'SPF'|'DKIM'|..., name, type, value, ttl, status }.
  -- The UI renders this for the spa to paste into their DNS provider.
  dns_records         jsonb       not null default '[]'::jsonb,

  -- Last time we asked Resend "is this verified yet?". Throttled to
  -- once per ~10s in the UI to avoid hammering the API.
  last_checked_at     timestamptz,

  verified_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  unique (user_id, domain)
);

alter table public.emma_sender_domains enable row level security;

do $$ begin
  create policy "users_own_emma_sender_domains"
    on public.emma_sender_domains for all
    using  (auth.uid() = user_id)
    with check (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "service_role_emma_sender_domains"
    on public.emma_sender_domains for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

-- Send-time hot path: "does this spa have a verified sender?" Lookup is
-- by user_id, filtered to status='verified'. Most spas have 0 or 1
-- verified rows, so this index is small and the planner can pick the
-- first verified row in one seek.
create index if not exists emma_sender_domains_active_idx
  on public.emma_sender_domains (user_id)
  where status = 'verified';

create trigger emma_sender_domains_set_updated_at
  before update on public.emma_sender_domains
  for each row execute function public.set_updated_at();

comment on table public.emma_sender_domains is
  'Per-spa Emma email sender. One row per (user_id, domain). status=verified means safe to use at send time; otherwise fall back to platform EMMA_FROM_EMAIL. Resend is the source of truth for verification; dns_records mirrors the records[] array verbatim for UI rendering.';

-- ─── 2/11 patient_outreach_state_scheduled ───
-- Emma(OS) scheduled sends (v356).
--
-- Adds a scheduled_at column on patient_outreach_state plus a new
-- valid state 'scheduled'. The spa owner picks a future datetime in
-- the composer; every targeted row flips to state='scheduled' with
-- scheduled_at set. A pg_cron sweep on /api/cron/emma-sweep wakes
-- every minute, finds rows where state='scheduled' AND
-- scheduled_at <= now(), race-safe locks them via UPDATE...RETURNING
-- with the state guard, and dispatches each through the same
-- compliance + dispatch helper that the foreground Send button uses.
--
-- Why a per-row scheduled_at (not per-campaign): the cron sweep
-- already operates row-by-row for the existing 'targeted' rows the
-- foreground send loop ships, so per-row scheduling keeps the
-- dispatch shape uniform. It also lets a future ship support
-- per-row staggering (drip campaigns) without another migration.
--
-- Why 'scheduled' as a distinct state (not just scheduled_at on
-- targeted rows): the sweep query needs a cheap WHERE clause that
-- doesn't scan every targeted row in the database. A partial index
-- on state='scheduled' keeps the hot path small even at fleet scale.
--
-- Established 2026-05-16 (Promotions Engine v356).

-- 1. Widen the state check to include 'scheduled'.
alter table public.patient_outreach_state
  drop constraint if exists patient_outreach_state_state_check;

alter table public.patient_outreach_state
  add constraint patient_outreach_state_state_check check (
    state in ('targeted', 'scheduled', 'outreached', 'engaged', 'booked',
              'showed', 'no_show', 'closed_won', 'closed_lost', 'opted_out')
  );

-- 2. Add the column. Null = not scheduled (the default for foreground
-- targeted rows). Non-null on a 'scheduled' state means "fire after
-- this time on the next sweep tick".
alter table public.patient_outreach_state
  add column if not exists scheduled_at timestamptz;

-- 3. Partial index for the sweep query. Only indexes scheduled rows
-- (typically a tiny fraction of all state rows), and orders by
-- scheduled_at so the planner can stop scanning the moment it hits
-- the first future row.
create index if not exists patient_outreach_state_due_idx
  on public.patient_outreach_state (scheduled_at)
  where state = 'scheduled' and scheduled_at is not null;

comment on column public.patient_outreach_state.scheduled_at is
  'When state=scheduled, the wall-clock time the cron sweep should fire this row. Null otherwise. The compliance rails (quiet hours, velocity cap, opted_out) still run at dispatch time — a 2 AM scheduled send respects quiet hours.';

-- ─── 3/11 emma_sweep_cron ─────────────────────
-- Emma scheduled-sends sweep — fires /api/cron/emma-sweep every minute.
--
-- The sweep scans patient_outreach_state for state='scheduled' AND
-- scheduled_at <= now(), race-safe locks each due row, and dispatches
-- through the same dispatchOutreach helper the foreground Send button
-- uses. Compliance rails (quiet hours, velocity cap, opted_out, banned)
-- run identically on scheduled sends.
--
-- STEP 1 (one-time, must already be done for the agent scheduler):
--   SCHEDULER_SECRET must be set in the Cloudflare Worker environment.
--   Same value pg_cron uses below — reusing the agent-scheduler secret
--   keeps secret management to one entry.
--
-- STEP 2: Before pasting, REPLACE <<REPLACE_WITH_PROD_SCHEDULER_SECRET>>
-- with the current SCHEDULER_SECRET value from the Cloudflare Worker
-- env. Then paste this file into Supabase Dashboard → SQL Editor and
-- run. pg_cron persists jobs across restarts — one paste per rotation.
--
-- Cadence: every minute. Each tick caps at 200 rows so a 1,000-patient
-- blast scheduled for the same minute completes within ~5 ticks.
-- Lift the cap in /api/cron/emma-sweep once dispatch latency is
-- benchmarked under real load.
--
-- Established 2026-05-16 (Promotions Engine v356).

-- Enable required extensions (no-ops if already enabled — both come
-- from the agent-scheduler migration).
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Remove any prior version of this job (idempotent re-run).
select cron.unschedule('emma-scheduled-sweep') where exists (
  select 1 from cron.job where jobname = 'emma-scheduled-sweep'
);

-- Schedule the sweep every minute. Adjust to '*/5 * * * *' if the
-- per-minute load proves wasteful — the cost is one HTTP call per
-- tick that returns immediately when nothing is due.
select cron.schedule(
  'emma-scheduled-sweep',
  '* * * * *',
  $$
    select net.http_post(
      url     := 'https://refill-app.davidfand303.workers.dev/api/cron/emma-sweep',
      headers := jsonb_build_object(
        'Content-Type',       'application/json',
        'X-Scheduler-Secret', '<<REPLACE_WITH_PROD_SCHEDULER_SECRET>>'
      ),
      body    := '{}'::jsonb
    );
  $$
);

-- Confirm the job is registered.
select jobname, schedule, active
from cron.job
where jobname = 'emma-scheduled-sweep';

-- ─── 4/11 emma_appointments ───────────────────
-- Emma(OS) appointment foundation (v360).
--
-- Until v360 Emma had zero appointment data. patient_outreach_state
-- reserved 'booked'/'showed'/'no_show' states but no code wrote them.
-- This migration creates the source of truth for actual appointments:
-- imported from the spa's PMS (Acuity, Boulevard, Mangomint, etc.) via
-- CSV upload today, via API integrations later.
--
-- Why a dedicated table (not knowledge_nodes attachments): appointments
-- have a state machine, frequent send-time reads (the pre-show sweep
-- runs every 15 min looking for upcoming appointments), and benefit
-- from strongly-typed columns + partial indexes. Same pattern as
-- emma_sender_domains (v355) and emma_appointments_state_events below.
--
-- Tenant boundary: every row scoped by spa user_id with RLS. Reps don't
-- read this — appointments are spa-side concerns.
--
-- Established 2026-05-17 (Promotions Engine v360).

create table if not exists public.emma_appointments (
  id                  uuid        primary key default gen_random_uuid(),
  user_id             uuid        not null references auth.users(id) on delete cascade,

  -- The patient this appointment is for. NULL when the CSV row matched no
  -- existing patient AND we chose not to auto-create a stub. The pre-show
  -- agent skips appointments with null patient_node_id.
  patient_node_id     uuid        references public.knowledge_nodes(id) on delete set null,

  scheduled_at        timestamptz not null,
  duration_min        integer     not null default 30,
  treatment_type      text,
  provider_name       text,

  -- State machine. Status transitions go through emma_appointment_status_events
  -- so we have an audit trail of every change (and the trigger that flipped it).
  status              text        not null default 'scheduled'
                      check (status in (
                        'scheduled', 'confirmed', 'cancelled',
                        'no_show', 'showed', 'rescheduled'
                      )),

  -- The PMS's own appointment ID (when we can extract it from the CSV).
  -- Lets us match on re-import without duplicating.
  external_id         text,

  -- Where this row came from. Detection happens in the SMART importer.
  source              text        not null default 'manual'
                      check (source in (
                        'manual', 'pms-api',
                        'csv-acuity', 'csv-boulevard', 'csv-mangomint',
                        'csv-vagaro', 'csv-aestheticspro', 'csv-aestheticrecord',
                        'csv-generic'
                      )),

  -- Free-form notes from the import.
  notes               text,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- Idempotent re-import: same (user, external_id, source) = same appointment.
  -- When external_id is null (manual entries) the index allows duplicates.
  unique (user_id, external_id, source)
);

alter table public.emma_appointments enable row level security;

do $$ begin
  create policy "users_own_emma_appointments"
    on public.emma_appointments for all
    using  (auth.uid() = user_id)
    with check (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "service_role_emma_appointments"
    on public.emma_appointments for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

-- Pre-show sweep hot path: "find appointments hitting cadence threshold."
-- Query shape: WHERE user_id = $1 AND status IN ('scheduled', 'confirmed')
--   AND scheduled_at BETWEEN now() AND now() + interval '7 days'
create index if not exists emma_appointments_upcoming_idx
  on public.emma_appointments (user_id, scheduled_at)
  where status in ('scheduled', 'confirmed');

-- Patient timeline: "show me every appointment for this patient."
create index if not exists emma_appointments_by_patient_idx
  on public.emma_appointments (user_id, patient_node_id, scheduled_at desc)
  where patient_node_id is not null;

-- updated_at touch trigger.
create or replace function public.touch_emma_appointments()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end
$$;

drop trigger if exists trg_touch_emma_appointments on public.emma_appointments;
create trigger trg_touch_emma_appointments
  before update on public.emma_appointments
  for each row execute function public.touch_emma_appointments();

-- ── Status change audit log ────────────────────────────────────────────

create table if not exists public.emma_appointment_status_events (
  id                  uuid        primary key default gen_random_uuid(),
  user_id             uuid        not null references auth.users(id) on delete cascade,
  appointment_id      uuid        not null references public.emma_appointments(id) on delete cascade,

  from_status         text        not null,
  to_status           text        not null,
  -- Who/what triggered the change. 'spa-owner' = manual UI action,
  -- 'csv-import' = CSV re-import flipped it, 'preshow-agent' = the
  -- cadence sweep advanced it, 'rescue-agent' = same-day rescue agent
  -- claimed/released it, 'patient' = the patient's own action (rare).
  triggered_by        text        not null,
  reason              text,

  created_at          timestamptz not null default now()
);

alter table public.emma_appointment_status_events enable row level security;

do $$ begin
  create policy "users_own_emma_appointment_status_events"
    on public.emma_appointment_status_events for all
    using  (auth.uid() = user_id)
    with check (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "service_role_emma_appointment_status_events"
    on public.emma_appointment_status_events for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

create index if not exists emma_appointment_status_events_by_apt_idx
  on public.emma_appointment_status_events (appointment_id, created_at desc);

comment on table public.emma_appointments is
  'Source of truth for spa appointment data. Ingested from PMS CSV exports (Acuity, Boulevard, Mangomint, Vagaro, AR) or manually entered. Drives the pre-show reminder cadence, same-day rescue agent, and recovery attribution. Spa-scoped via RLS.';

comment on table public.emma_appointment_status_events is
  'Append-only audit log of every status transition on emma_appointments. Used for pattern detection (chronic no-shows), recovery attribution, and "who flipped this when" diagnostics.';

-- ─── 5/11 emma_noshow_policies ────────────────
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

-- ─── 6/11 emma_preshow_cron ───────────────────
-- Emma pre-show reminder sweep — fires /api/cron/emma-preshow-sweep every 15 min.
--
-- The sweep scans emma_appointments for upcoming appointments hitting
-- a cadence threshold (T-48h, T-24h, T-3h by default), composes the
-- reminder with the spa's tone + opt-in footer, dispatches via SMS or
-- email per the policy's preshow_channel setting. Compliance rails
-- (opt-out, quiet hours, velocity cap) run identically to campaign
-- sends.
--
-- v358 (2026-05-16) secret-rotation note: REPLACE the placeholder string
--   <<REPLACE_WITH_PROD_SCHEDULER_SECRET>>
-- with the SCHEDULER_SECRET value currently set in the Cloudflare Worker
-- env before pasting this SQL into Supabase Dashboard SQL Editor.
--
-- Cadence: every 15 min. The sweep is cheap when nothing is due (single
-- query returning zero rows). At 15-min granularity we hit cadence
-- thresholds within ±7.5 min of the target time, which is plenty for
-- the pre-show pattern.
--
-- Established 2026-05-17 (Promotions Engine v360).

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('emma-preshow-sweep') where exists (
  select 1 from cron.job where jobname = 'emma-preshow-sweep'
);

select cron.schedule(
  'emma-preshow-sweep',
  '*/15 * * * *',
  $$
    select net.http_post(
      url     := 'https://refill-app.davidfand303.workers.dev/api/cron/emma-preshow-sweep',
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
where jobname = 'emma-preshow-sweep';

-- ─── 7/11 emma_waitlist ───────────────────────
-- Emma(OS) waitlist + per-patient opt-in tokens (v361).
--
-- Patients opt into the spa's last-minute openings list via:
--   1. Tapping the universal opt-in footer Emma appends to every
--      outbound message (the footer URL resolves to a stable per-patient
--      token, so one tap = opted in)
--   2. The spa owner marking them opted-in manually (future: patient
--      detail page toggle)
--
-- Opted-in patients are the candidate pool for the v361 same-day rescue
-- agent: when an appointment cancels/no-shows with future scheduled_at,
-- the agent picks 3-5 fit patients (treatment match + availability
-- match + lifetime value rank) and sends them parallel SMS with a claim
-- link. First-tap wins.
--
-- Tenant boundary: every row scoped by user_id with RLS. Tokens are
-- opaque uuids; even a leaked token only lets a specific patient opt
-- in/out of a specific spa's list.
--
-- Established 2026-05-17 (Promotions Engine v361).

-- ── emma_waitlist ────────────────────────────────────────────────────────

create table if not exists public.emma_waitlist (
  id                    uuid        primary key default gen_random_uuid(),
  user_id               uuid        not null references auth.users(id) on delete cascade,
  patient_node_id       uuid        not null references public.knowledge_nodes(id) on delete cascade,

  -- Treatment-type filter. Empty = open to any rescue treatment.
  -- Populated = patient only wants notifications for these.
  treatment_types       text[]      not null default '{}',

  -- Provider preference. Empty = no preference.
  preferred_providers   text[]      not null default '{}',

  -- Availability windows. jsonb shape:
  --   { "weekday_morning": bool, "weekday_afternoon": bool, "weekday_evening": bool,
  --     "weekend_morning": bool, "weekend_afternoon": bool, "weekend_evening": bool }
  -- Empty = open to any time. Rescue dispatcher cross-checks this
  -- against the freed slot's day-of-week + hour-of-day.
  availability_windows  jsonb       not null default '{}'::jsonb,

  status                text        not null default 'active'
                        check (status in ('active', 'paused', 'revoked')),

  -- Where the opt-in originated. Useful for understanding what drove
  -- the list growth (and for compliance — TCPA wants to know how each
  -- patient on the list got there).
  opt_in_source         text        not null
                        check (opt_in_source in (
                          'footer-link',
                          'spa-manual',
                          'patient-detail-toggle'
                        )),

  opted_in_at           timestamptz not null default now(),
  revoked_at            timestamptz,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  unique (user_id, patient_node_id)
);

alter table public.emma_waitlist enable row level security;

do $$ begin
  create policy "users_own_emma_waitlist"
    on public.emma_waitlist for all
    using  (auth.uid() = user_id)
    with check (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "service_role_emma_waitlist"
    on public.emma_waitlist for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

-- Rescue dispatcher hot path: "find active waitlist members for this spa."
create index if not exists emma_waitlist_active_idx
  on public.emma_waitlist (user_id)
  where status = 'active';

create trigger emma_waitlist_set_updated_at
  before update on public.emma_waitlist
  for each row execute function public.set_updated_at();

-- ── emma_waitlist_tokens ────────────────────────────────────────────────

-- One stable token per (user_id, patient_node_id). Used in:
--   - The universal opt-in footer URL appended to every Emma message
--     (/waitlist/optin/<token>)
--   - Future: the manage-preferences page (/waitlist/manage/<token>)
--
-- Tokens are minted lazily on first need by the preshow agent or
-- rescue dispatcher — no need to bulk-mint for the whole patient roster.

create table if not exists public.emma_waitlist_tokens (
  token                 uuid        primary key default gen_random_uuid(),
  user_id               uuid        not null references auth.users(id) on delete cascade,
  patient_node_id       uuid        not null references public.knowledge_nodes(id) on delete cascade,
  created_at            timestamptz not null default now(),
  last_used_at          timestamptz,

  unique (user_id, patient_node_id)
);

alter table public.emma_waitlist_tokens enable row level security;

do $$ begin
  create policy "service_role_emma_waitlist_tokens"
    on public.emma_waitlist_tokens for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

-- Note: NO user-facing RLS policy on tokens. Token lookup happens
-- service-role-only via the public landing page server fns. The patient
-- never authenticates; the token IS the capability.

comment on table public.emma_waitlist is
  'Per-spa waitlist of patients who opted in to receive notifications when last-minute slots free up. Source of the candidate pool for the v361 rescue dispatcher. Spa-scoped via RLS.';

comment on table public.emma_waitlist_tokens is
  'Stable per-(spa, patient) tokens for opt-in / manage URLs in Emma-outbound messages. Token = capability — service-role lookup only, no patient auth.';

-- ─── 8/11 emma_rescue ─────────────────────────
-- Emma(OS) same-day rescue — attempts + offers (v361).
--
-- When an appointment flips to 'cancelled' or 'no_show' with a future
-- scheduled_at, the rescue dispatcher picks 3-5 fit-patients from the
-- waitlist and fires parallel SMS with claim links. First patient to
-- tap the link claims the slot.
--
-- Two tables:
--   emma_rescue_attempts — parent: one row per appointment cancellation
--   emma_rescue_offers   — children: one row per patient contacted
--
-- The race-safe claim mechanic relies on:
--   UPDATE emma_rescue_offers SET claimed_at = now()
--     WHERE id = $offer_id AND claimed_at IS NULL
--     RETURNING *
-- Only one concurrent claim wins. Loser sees a "Sorry, just taken"
-- page.
--
-- Established 2026-05-17 (Promotions Engine v361).

-- ── emma_noshow_policies extension ──────────────────────────────────────

alter table public.emma_noshow_policies
  add column if not exists rescue_eligible_treatments text[] not null default '{}';

comment on column public.emma_noshow_policies.rescue_eligible_treatments is
  'Empty = rescue runs for any treatment type. Populated = rescue only fires when the freed appointment treatment_type is in this list.';

-- ── emma_rescue_attempts ────────────────────────────────────────────────

create table if not exists public.emma_rescue_attempts (
  id                       uuid        primary key default gen_random_uuid(),
  user_id                  uuid        not null references auth.users(id) on delete cascade,
  freed_appointment_id     uuid        not null references public.emma_appointments(id) on delete cascade,

  triggered_at             timestamptz not null default now(),
  outreach_count           integer     not null default 0,

  -- Final state. Set when the rescue concludes (filled OR closed).
  status                   text        not null default 'active'
                           check (status in ('active', 'filled', 'closed_unfilled', 'cancelled')),

  filled_at                timestamptz,
  -- The offer that won. References emma_rescue_offers(id).
  filled_by_offer_id       uuid,
  closed_at                timestamptz,
  notes                    text,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

alter table public.emma_rescue_attempts enable row level security;

do $$ begin
  create policy "users_own_emma_rescue_attempts"
    on public.emma_rescue_attempts for all
    using  (auth.uid() = user_id)
    with check (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "service_role_emma_rescue_attempts"
    on public.emma_rescue_attempts for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

create index if not exists emma_rescue_attempts_by_user_idx
  on public.emma_rescue_attempts (user_id, triggered_at desc);

create index if not exists emma_rescue_attempts_active_idx
  on public.emma_rescue_attempts (user_id, status)
  where status = 'active';

create trigger emma_rescue_attempts_set_updated_at
  before update on public.emma_rescue_attempts
  for each row execute function public.set_updated_at();

-- ── emma_rescue_offers ──────────────────────────────────────────────────

create table if not exists public.emma_rescue_offers (
  id                       uuid        primary key default gen_random_uuid(),
  user_id                  uuid        not null references auth.users(id) on delete cascade,
  rescue_attempt_id        uuid        not null references public.emma_rescue_attempts(id) on delete cascade,
  appointment_id           uuid        not null references public.emma_appointments(id) on delete cascade,
  patient_node_id          uuid        not null references public.knowledge_nodes(id) on delete cascade,

  -- Public capability token. Patient hits /rescue/claim/<token>.
  token                    uuid        not null unique default gen_random_uuid(),

  sent_at                  timestamptz not null default now(),
  claimed_at               timestamptz,
  declined_at              timestamptz,
  expired_at               timestamptz,

  -- Twilio SID for the SMS we sent. For audit + linking to inbound.
  message_id               text,

  -- Error reason when the outreach itself failed (no phone, twilio
  -- error, etc.). Null = sent ok.
  send_error               text,

  created_at               timestamptz not null default now(),

  unique (rescue_attempt_id, patient_node_id)
);

alter table public.emma_rescue_offers enable row level security;

do $$ begin
  create policy "users_own_emma_rescue_offers"
    on public.emma_rescue_offers for all
    using  (auth.uid() = user_id)
    with check (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "service_role_emma_rescue_offers"
    on public.emma_rescue_offers for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

-- Foreign-key constraint added after the table exists so the column
-- can reference emma_rescue_offers from emma_rescue_attempts.
do $$ begin
  alter table public.emma_rescue_attempts
    add constraint emma_rescue_attempts_filled_by_offer_fk
      foreign key (filled_by_offer_id)
      references public.emma_rescue_offers(id) on delete set null;
exception when duplicate_object then null;
end $$;

create index if not exists emma_rescue_offers_by_attempt_idx
  on public.emma_rescue_offers (rescue_attempt_id, sent_at desc);

create index if not exists emma_rescue_offers_unclaimed_idx
  on public.emma_rescue_offers (rescue_attempt_id)
  where claimed_at is null and declined_at is null and expired_at is null;

comment on table public.emma_rescue_attempts is
  'Parent record for each rescue cycle — one per appointment cancellation. Status transitions: active → filled (someone claimed) | closed_unfilled (window expired) | cancelled (spa pulled it).';

comment on table public.emma_rescue_offers is
  'Per-patient outreach within a rescue attempt. Race-safe claim: UPDATE WHERE claimed_at IS NULL RETURNING * — only one concurrent winner. Token is public capability for /rescue/claim/<token>.';

-- ─── 9/11 emma_reliability ────────────────────
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

-- ─── 10/11 emma_reliability_cron ──────────────
-- Emma reliability sweep — daily recompute of every patient's tier (v362).
--
-- Hits /api/cron/emma-reliability-sweep once a day at 02:00 UTC.
-- The endpoint iterates every spa and recomputes reliability_status
-- for each patient with appointment history. Tier transitions emit
-- pattern_alerts.
--
-- Why daily not real-time: the foreground updateAppointmentStatus
-- trigger already fires recomputeForPatient on each status flip. The
-- cron is a safety net for missed signals + a place to catch the
-- "6mo window rolled past a no-show" passive transition (a patient
-- can age out of 'in_recovery' without any appointment activity).
--
-- v358 secret-rotation note: REPLACE <<REPLACE_WITH_PROD_SCHEDULER_SECRET>>
-- with the current SCHEDULER_SECRET value from the Cloudflare Worker env.
--
-- Established 2026-05-17 (Promotions Engine v362).

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('emma-reliability-sweep') where exists (
  select 1 from cron.job where jobname = 'emma-reliability-sweep'
);

-- 02:00 UTC daily — off-peak from the agent scheduler + emma preshow.
select cron.schedule(
  'emma-reliability-sweep',
  '0 2 * * *',
  $$
    select net.http_post(
      url     := 'https://refill-app.davidfand303.workers.dev/api/cron/emma-reliability-sweep',
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
where jobname = 'emma-reliability-sweep';

-- ═══════════════════════════════════════════════════════════════════════
-- BATCH C VERIFY
-- ═══════════════════════════════════════════════════════════════════════
select 'set_updated_at fn' as check_, count(*)::text as result from pg_proc where proname='set_updated_at' and pronamespace=(select oid from pg_namespace where nspname='public')
union all select 'emma tables', count(*)::text from information_schema.tables where table_schema='public' and table_name in ('emma_sender_domains','emma_appointments','emma_appointment_status_events','emma_noshow_policies','emma_waitlist','emma_waitlist_tokens','emma_rescue_attempts','emma_rescue_offers','emma_pattern_alerts','emma_reliability_status')
union all select 'total public tables', count(*)::text from information_schema.tables where table_schema='public';
