-- ═══════════════════════════════════════════════════════════════════════
-- BATCH E — Scan funnel + Emma post-scan additions (9 migrations)
--   scan_public (csv_scanner_leads), scan_followup tokens, hosted
--   reports, refill_setup_intent, waitlist intent, rescue proxy,
--   scheduler OAuth connections, appointment source canonicalization.
-- ═══════════════════════════════════════════════════════════════════════

-- ─── 1/9 scan_public ──────────────────────────
-- v369: Public /scan page — global header cache + scan-lead capture.
--
-- The public scanner is the viral funnel for Emma: any med-spa owner can
-- drop their PMS CSV at /scan, see exactly how much no-show revenue they
-- are leaking + how much Emma would recover, no signup. The page parses
-- everything client-side so patient data never leaves the browser.
--
-- This migration adds two tables:
--
-- public_csv_dialect_cache — global header-shape cache, no user_id. Every
--   scan teaches every future scan. Header shapes are not PII (they are
--   vendor product structure), so global caching is safe and compounds.
--   First scan from a new platform pays the LLM tax; everyone else benefits.
--
-- csv_scanner_leads — opt-in email capture from the /scan page. Lead row
--   carries detected platform + sample-size stats so the follow-up email
--   can reference what they uploaded ("the 47-appointment Acuity export
--   you scanned showed ~$3,200 in monthly leak").

create table if not exists public.public_csv_dialect_cache (
  id uuid primary key default gen_random_uuid(),
  -- SHA-256 of (header row lowercased, joined by |) — global key
  header_hash text not null unique,
  detected_platform text,
  alias_map jsonb not null,
  llm_model text not null,
  llm_at timestamptz not null default now(),
  scan_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists public_csv_dialect_cache_platform_idx
  on public.public_csv_dialect_cache (detected_platform);

alter table public.public_csv_dialect_cache enable row level security;

-- No anon reads — only service role. The mapper endpoint hits this server-side.
create policy "service role full access on public cache"
  on public.public_csv_dialect_cache for all
  to service_role using (true) with check (true);


create table if not exists public.csv_scanner_leads (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  detected_platform text,
  -- Free-form referral source ("DM from David", "Twitter", "direct", etc.)
  source text,
  -- Snapshot of the receipt the user saw — so the follow-up email is specific
  appointment_count int,
  date_range_start date,
  date_range_end date,
  noshow_count int,
  estimated_monthly_leak_usd numeric(12, 2),
  estimated_monthly_recovery_usd numeric(12, 2),
  -- Headers seen (for vendor catalog) — no PHI since rows stay in browser
  header_sample text[],
  -- Whether the LLM mapper was needed (catalog signal)
  was_ai_mapped boolean not null default false,
  ip_hash text,
  user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists csv_scanner_leads_email_idx
  on public.csv_scanner_leads (lower(email));
create index if not exists csv_scanner_leads_created_at_idx
  on public.csv_scanner_leads (created_at desc);

alter table public.csv_scanner_leads enable row level security;

-- Public can INSERT only (lead capture). No read, no update, no delete.
-- Service role has full access for admin / outreach.
create policy "anon insert scan leads"
  on public.csv_scanner_leads for insert
  to anon
  with check (true);

create policy "service role full access on scan leads"
  on public.csv_scanner_leads for all
  to service_role using (true) with check (true);


-- updated_at auto-touch for the cache table
create or replace function public.touch_public_csv_dialect_cache_updated_at()
returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_public_csv_dialect_cache_updated_at
  on public.public_csv_dialect_cache;
create trigger trg_public_csv_dialect_cache_updated_at
  before update on public.public_csv_dialect_cache
  for each row execute function public.touch_public_csv_dialect_cache_updated_at();

-- ─── 2/9 scan_followup ────────────────────────
-- v369.1: Scan follow-up email send audit trail.
--
-- captureScanLead inserts the lead row, then fires the follow-up email
-- (Draft A — the "we did your homework" send) fire-and-forget. The send
-- result is written back here so we can: (a) avoid duplicate sends on
-- retry, (b) surface failures in an admin view, (c) measure reply rates
-- per platform / per dollar bucket later.
--
-- All three columns are nullable — null on followup_sent_at means the
-- send was never attempted (e.g. lead with no usable math, or send pre-
-- flight bailed). Errors land in followup_error as plain-text reason.

alter table public.csv_scanner_leads
  add column if not exists followup_sent_at timestamptz,
  add column if not exists followup_message_id text,
  add column if not exists followup_error text;

create index if not exists csv_scanner_leads_followup_sent_at_idx
  on public.csv_scanner_leads (followup_sent_at);

-- ─── 3/9 scan_report_hosting ──────────────────
-- v371.1: host the scan follow-up HTML report at a tokenized URL
-- instead of attaching it to the email.
--
-- Why: Gmail web (and most other email clients) renders .html attachments
-- as raw source code for XSS-safety reasons. Sending the report as an
-- attachment looks like a bug to the recipient. Hosting it behind a
-- token-gated URL — same pattern as /rescue/claim/<token> — gives us
-- in-browser rendering, mobile compatibility, no attachment friction.
--
-- The token is the capability (no auth required). It is opaque and
-- random; the lead owner is the one who controls who else sees the URL.

alter table public.csv_scanner_leads
  add column if not exists followup_report_html text,
  add column if not exists followup_report_token text;

-- Unique index so /report/<token> lookups are O(1) AND tokens never collide.
create unique index if not exists csv_scanner_leads_followup_report_token_idx
  on public.csv_scanner_leads (followup_report_token)
  where followup_report_token is not null;

-- ─── 4/9 refill_setup_intent ──────────────────
-- v372: thin manual-onboarding intake — captures spa owners who clicked
-- "Set up Refill for my spa" from /scan, /story, the report, or the
-- follow-up email. Adds columns to csv_scanner_leads so we keep ONE
-- leads pipeline (a scan + an intent can live on the same row if email
-- matches; otherwise an intent-only row gets inserted with no scan data).
--
-- The intake is intentionally tiny: practice name, current scheduler,
-- estimated cancels/mo, optional phone + notes. Karen + David receive an
-- email per intent and manually onboard within 24hrs. When the in-app
-- self-serve flow ships (v37x.x), this intake becomes a pre-fill source.

alter table public.csv_scanner_leads
  add column if not exists setup_intent_at timestamptz,
  add column if not exists setup_intent_practice_name text,
  add column if not exists setup_intent_scheduler text,
  add column if not exists setup_intent_phone text,
  add column if not exists setup_intent_estimated_monthly_cancels int,
  add column if not exists setup_intent_notes text,
  add column if not exists setup_intent_notified_at timestamptz,
  add column if not exists setup_intent_notified_error text;

create index if not exists csv_scanner_leads_setup_intent_at_idx
  on public.csv_scanner_leads (setup_intent_at desc)
  where setup_intent_at is not null;

-- ─── 5/9 emma_waitlist_intent ─────────────────
-- v373: extend emma_waitlist for Type B (treatment-matched-already-scheduled)
-- waitlist intent. v361 shipped the catchall variant + per-patient
-- treatment_types filter; v373 adds the semantic distinction between
-- "patient opted into a general catchall waitlist" and "patient is
-- already scheduled for a Tox and wants an earlier Tox slot if one opens."
--
-- The rescue dispatcher already filters by treatment_types (existing,
-- since v361). v373 adds intent context for analytics + display:
--   - intent_type: 'catchall' | 'earlier_appointment'
--   - scheduled_appointment_id: nullable FK to emma_appointments,
--     used when Type B patient is waiting for an earlier-than-X slot
--
-- "Stay" rule (v373): when a Type B patient claims an earlier slot,
-- their original scheduled_appointment_id appointment STAYS — the
-- system does NOT auto-cancel. That second appointment becomes its own
-- opportunity for the rescue agent on its own day. Karen + David
-- decide manually whether to cancel the redundant appointment.

alter table public.emma_waitlist
  add column if not exists intent_type text not null default 'catchall'
    check (intent_type in ('catchall', 'earlier_appointment')),
  add column if not exists scheduled_appointment_id uuid
    references public.emma_appointments(id) on delete set null;

-- Partial index for the "earlier-than-this-appointment" lookup path —
-- when a Type B patient's scheduled appointment day comes around, the
-- preshow agent may want to clean up the redundant waitlist entry.
create index if not exists emma_waitlist_scheduled_appointment_idx
  on public.emma_waitlist (scheduled_appointment_id)
  where scheduled_appointment_id is not null;

-- v362 reliability tier integration (forward-prep, no behavior change
-- yet in v373) — when v374 ships tiered blast waves, the rescue
-- dispatcher will join emma_waitlist → knowledge_nodes →
-- emma_reliability_status and order by tier (vip → trusted → regular →
-- in_recovery). The data is already there; v373 leaves the existing
-- lifetime-spend sort in place until v374 actively replaces it.

-- ─── 6/9 emma_rescue_proxy ────────────────────
-- v379: rescue proxy mode (Karen-in-the-loop, trial-mode pilot).
--
-- Adds two nullable TEXT columns to emma_noshow_policies. When EITHER is
-- non-null, the rescue dispatcher routes the entire batch of offer URLs
-- to the proxy address(es) in a single aggregated message INSTEAD of
-- firing one SMS per waitlist patient. The spa owner (Karen, for Rejuv
-- Skin Spa) then hand-forwards individual URLs to actual patients — or
-- pastes the proxy email into a Claude Desktop session that drafts them
-- in iMessage automatically.
--
-- Use cases:
--   1. Bandwidth porting in flight — engine PROVEN end-to-end on real
--      Rejuv data without depending on carrier delivery to patients.
--      Twilio outbound to Karen's personal number works today; Bandwidth
--      porting only gates patient-facing delivery.
--   2. New-pilot onboarding — any future spa can opt into "Karen-in-the-
--      loop trial mode" for the first month before they invest in 10DLC
--      brand registration + carrier porting. Lowers onboarding friction
--      massively without compromising the engine architecture.
--
-- When both columns are null, behavior is byte-identical to v378 — the
-- per-patient send loop runs unchanged.

alter table public.emma_noshow_policies
  add column if not exists rescue_proxy_phone text,
  add column if not exists rescue_proxy_email text;

comment on column public.emma_noshow_policies.rescue_proxy_phone is
  'v379 trial-mode: when set, rescue dispatch sends ONE aggregated SMS to this number instead of per-patient SMSes. Karen forwards URLs to patients manually.';
comment on column public.emma_noshow_policies.rescue_proxy_email is
  'v379 trial-mode: when set, rescue dispatch sends ONE aggregated email to this address with formatted draft messages per offer.';

-- Reload PostgREST schema cache so the new columns are immediately
-- queryable by the server. Per the project convention.
notify pgrst, 'reload schema';

-- Verify: confirm both columns landed on the policies table.
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'emma_noshow_policies'
  and column_name in ('rescue_proxy_phone', 'rescue_proxy_email')
order by column_name;

-- ─── 7/9 emma_scheduler_connections ───────────
-- v381: Real-time scheduler connectivity (Acuity first, multi-platform shape).
--
-- Closes the last major architectural gap before the unattended pilot
-- can run for 5 business days: appointments + status changes flow into
-- emma_appointments WITHOUT anyone uploading a CSV or flipping a status
-- by hand. When a no-show happens in the spa's Acuity calendar, the
-- engine fires within seconds — not when a human notices and flips it
-- in /app/emma/appointments.
--
-- Architecture:
--   1. Spa owner clicks "Connect Acuity" in /app/emma/settings/scheduler
--   2. OAuth redirect → user authorizes Refill in their Acuity account
--   3. We exchange the code for an access_token + store as a connection
--   4. We programmatically register 4 webhooks via Acuity API
--      (appointment.scheduled, .canceled, .rescheduled, .changed) using
--      a per-spa webhook_secret in the URL path so each callback is
--      attributable to one connection
--   5. We backfill the next 90 days of appointments + the patient roster
--   6. Webhook receiver hits the existing emma_appointments upsert path
--      → updateAppointmentStatus trigger graph fires unchanged
--
-- The `platform` discriminator on both tables is the abstraction that
-- lets Mindbody, JaneApp, Square, Boulevard slot in as future ships
-- without schema migration. v381 implements ONLY 'acuity'; the others
-- will reuse the same shape with platform-specific fetchers.

-- ─── emma_scheduler_connections ────────────────────────────────────────────
-- One row per spa per platform. Today: at most one row per spa
-- (single scheduler integration). Future: multi-location spas could
-- have multiple rows on the same platform — the unique constraint
-- is per (user_id, platform), not just user_id.

create table if not exists public.emma_scheduler_connections (
  id                       uuid        primary key default gen_random_uuid(),
  user_id                  uuid        not null references auth.users(id) on delete cascade,
  platform                 text        not null check (platform in ('acuity', 'mindbody', 'jane', 'square', 'boulevard')),

  -- The third-party's stable account identifier. For Acuity, this is
  -- the user_id returned by GET /api/v1/me. We use it to verify the
  -- OAuth callback bound the right spa (defense against a stolen code
  -- being exchanged against a wrong account).
  platform_account_id      text,
  platform_account_email   text,

  -- OAuth tokens. Plaintext for v381 — Supabase encrypts at rest, RLS
  -- gates access at the API layer, service_role policy gates server
  -- code paths. Future ship adds app-layer encryption via pgsodium
  -- when we have a key-management story.
  access_token             text,
  refresh_token            text,
  token_expires_at         timestamptz,
  oauth_scope              text,

  -- Per-spa secret embedded in the webhook URL path. Random hex,
  -- generated server-side on connect, rotated on disconnect/reconnect.
  -- The webhook receiver looks up the connection by this secret —
  -- avoids needing to thread connection_id through Acuity's payload.
  webhook_secret           text        not null unique default encode(gen_random_bytes(24), 'hex'),

  -- Status surface for the settings UI.
  --   connected     — live; webhooks firing; backfill complete
  --   pending       — backfill in flight or token freshly obtained
  --   reauth_needed — token expired and refresh failed; user must reconnect
  --   error         — last sync hit a hard failure (see last_error)
  --   disconnected  — user clicked Disconnect; soft-deleted (retained for audit)
  status                   text        not null default 'pending'
                                       check (status in ('connected', 'pending', 'reauth_needed', 'error', 'disconnected')),
  last_sync_at             timestamptz,
  last_error               text,

  -- Connect/disconnect timeline for audit.
  connected_at             timestamptz,
  disconnected_at          timestamptz,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  unique (user_id, platform)
);

alter table public.emma_scheduler_connections enable row level security;

do $$ begin
  create policy "users_own_emma_scheduler_connections"
    on public.emma_scheduler_connections for all
    using  (auth.uid() = user_id)
    with check (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "service_role_emma_scheduler_connections"
    on public.emma_scheduler_connections for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

create index if not exists emma_scheduler_connections_user_idx
  on public.emma_scheduler_connections (user_id);
create index if not exists emma_scheduler_connections_status_idx
  on public.emma_scheduler_connections (status);

comment on table public.emma_scheduler_connections is
  'v381 — per-spa OAuth connection to an external scheduling platform. One row per (user_id, platform). Status drives the settings UI; webhook_secret is the per-spa URL path segment.';
comment on column public.emma_scheduler_connections.webhook_secret is
  'Random hex embedded in the webhook URL: /api/webhooks/scheduler/<platform>/<webhook_secret>. Receiver looks up the connection by this value. Rotated on disconnect/reconnect.';
comment on column public.emma_scheduler_connections.platform is
  'Discriminator. v381 only implements acuity; mindbody/jane/square/boulevard reserved for future ships using the same architecture.';

-- ─── emma_scheduler_webhook_events ─────────────────────────────────────────
-- Audit log of inbound webhook events. Append-only; one row per webhook
-- POST received. Records both successes and failures so we can:
--   (a) replay missed events from raw_payload during reconcile
--   (b) debug "the engine didn't fire" reports by inspecting what we got
--   (c) detect duplicate webhook deliveries (Acuity retries on non-2xx)
--
-- Processing semantics:
--   - received_at populated on insert (every event lands here first)
--   - processed_at stamped when the appointment upsert succeeds
--   - error populated when processing fails (network, parse, etc.);
--     processed_at stays null so the row is identifiable as broken
--   - Idempotency on (platform, platform_event_id) where the platform
--     provides one. Acuity doesn't include a webhook delivery ID, so
--     we hash (action + appointment_id + received_at-bucketed) instead

create table if not exists public.emma_scheduler_webhook_events (
  id                       uuid        primary key default gen_random_uuid(),
  connection_id            uuid        not null references public.emma_scheduler_connections(id) on delete cascade,
  user_id                  uuid        not null references auth.users(id) on delete cascade,
  platform                 text        not null,

  -- Acuity event types: appointment.scheduled, .canceled, .rescheduled, .changed
  -- Stored verbatim from the platform.
  event_type               text        not null,

  -- The platform's appointment ID (Acuity returns "id" as a number;
  -- we store as text for forward-compat with platforms that use uuid
  -- or other string IDs).
  external_appointment_id  text,

  raw_payload              jsonb       not null,

  -- Maps to the row in emma_appointments after successful upsert.
  -- Null on first insert; populated by the receiver once the upsert
  -- returns the appointment.id.
  emma_appointment_id      uuid,

  received_at              timestamptz not null default now(),
  processed_at             timestamptz,
  error                    text
);

alter table public.emma_scheduler_webhook_events enable row level security;

do $$ begin
  create policy "users_own_emma_scheduler_webhook_events"
    on public.emma_scheduler_webhook_events for select
    using (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "service_role_emma_scheduler_webhook_events"
    on public.emma_scheduler_webhook_events for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

create index if not exists emma_scheduler_webhook_events_connection_idx
  on public.emma_scheduler_webhook_events (connection_id, received_at desc);
create index if not exists emma_scheduler_webhook_events_unprocessed_idx
  on public.emma_scheduler_webhook_events (received_at)
  where processed_at is null;
create index if not exists emma_scheduler_webhook_events_external_id_idx
  on public.emma_scheduler_webhook_events (platform, external_appointment_id);

comment on table public.emma_scheduler_webhook_events is
  'v381 — append-only audit log of inbound scheduler webhook events. processed_at null + error not null = a known-broken event; processed_at not null = successful upsert into emma_appointments.';

-- Reload PostgREST schema cache so the new tables are immediately
-- queryable by the server. Per the project convention.
notify pgrst, 'reload schema';

-- ─── Verify ────────────────────────────────────────────────────────────────
-- Confirm both tables landed with the expected columns.
select
  table_name,
  count(*) filter (where column_name = 'webhook_secret') as has_webhook_secret,
  count(*) filter (where column_name = 'access_token') as has_access_token,
  count(*) filter (where column_name = 'platform') as has_platform,
  count(*) as total_columns
from information_schema.columns
where table_schema = 'public'
  and table_name in ('emma_scheduler_connections', 'emma_scheduler_webhook_events')
group by table_name
order by table_name;

-- ─── 8/9 emma_appointments_source_expand ──────
-- v381.3: Expand emma_appointments.source check constraint.
--
-- The original constraint (from v360, file 20260517000000_emma_appointments.sql)
-- allowed 9 source values: manual, pms-api, and 7 csv-* dialects. Two
-- expansions never landed in a constraint migration and are now blocking
-- writes:
--
--   1. v367 added 17 more csv-* dialects via the universal CSV importer
--      (Calendly, GlossGenius, Zenoti, Square, SimplePractice, Pabau,
--      JaneApp, WellnessLiving, Fresha, Mindbody, Symplast, Nextech,
--      PatientNow, RepeatMD, Booker, Moxie, Schedulicity, Meevo).
--      Today Rejuv only has csv-acuity rows so the gap never surfaced;
--      any new spa uploading a non-Acuity CSV would have hit it.
--
--   2. v381 introduced live-API ingestion (source='acuity', etc) for the
--      real-time scheduler connector. First click-through caught the
--      constraint here.
--
-- This migration drops the old constraint and re-adds it with the full
-- current vocabulary. The list is the union of every dialect string the
-- code currently writes plus the five live-API platform names matching
-- emma_scheduler_connections.platform.

alter table public.emma_appointments
  drop constraint if exists emma_appointments_source_check;

alter table public.emma_appointments
  add constraint emma_appointments_source_check
  check (source in (
    'manual',
    'pms-api',
    -- v381 live-API sources (one per scheduling platform)
    'acuity', 'mindbody', 'jane', 'square', 'boulevard',
    -- v367 CSV dialects
    'csv-acuity', 'csv-boulevard', 'csv-mangomint', 'csv-vagaro',
    'csv-aestheticspro', 'csv-aestheticrecord', 'csv-generic',
    'csv-calendly', 'csv-glossgenius', 'csv-zenoti', 'csv-square',
    'csv-simplepractice', 'csv-pabau', 'csv-janeapp', 'csv-wellnessliving',
    'csv-fresha', 'csv-mindbody', 'csv-symplast', 'csv-nextech',
    'csv-patientnow', 'csv-repeatmd', 'csv-booker', 'csv-moxie',
    'csv-schedulicity', 'csv-meevo'
  ));

notify pgrst, 'reload schema';

-- Verify: the new constraint should accept 'acuity' as a valid source.
-- The query returns the count of distinct source values currently in
-- use so we can confirm nothing existing was blocked.
select source, count(*)
from public.emma_appointments
group by source
order by count(*) desc;

-- ─── 9/9 emma_rescue_one_active_per_apt ───────
-- v381.4: race-safe lock on rescue dispatch per appointment.
--
-- v381 connected the Acuity webhook to dispatchRescueAttempt. First
-- live-fire test caught a race: Acuity fires BOTH appointment.canceled
-- AND appointment.changed for a single status flip, within the same
-- second. Both webhooks pass the in-code idempotency check (steps 3+
-- in dispatchRescueAttempt) at near-identical times because neither
-- has inserted yet — both then proceed to insert a fresh
-- emma_rescue_attempts row → two attempts, two offers, two proxy
-- emails, two iMessage drafts.
--
-- Fix: a partial unique index that constrains "at most one active
-- attempt per (user_id, freed_appointment_id)" at the database layer.
-- The losing concurrent insert will fail with SQLSTATE 23505 and the
-- caller code falls back to returning the winning row's identity.
-- Same race-safe pattern v361 uses for emma_rescue_offers claims.
--
-- Existing data is already deduplicated (see manual cleanup in chat
-- 2026-05-19 11:30 — one race-duplicate from this morning's test was
-- closed_unfilled before this migration runs). If the index creation
-- fails because some other duplicate landed between cleanup and
-- migration, the verify SELECT below will surface them so we can
-- close them and retry.

create unique index if not exists emma_rescue_attempts_one_active_per_apt
  on public.emma_rescue_attempts (user_id, freed_appointment_id)
  where status = 'active';

comment on index public.emma_rescue_attempts_one_active_per_apt is
  'v381.4: partial unique guarantees at most one active rescue attempt per (user, appointment). Race-safety against concurrent dispatchRescueAttempt callers (Acuity canceled+changed double-fire). Losing INSERT gets 23505; caller falls back to SELECT winner.';

notify pgrst, 'reload schema';

-- Verify: should return zero rows. If any rows return, those are
-- pre-existing duplicates that need cleanup before the index applies.
select user_id, freed_appointment_id, count(*) as active_count
from public.emma_rescue_attempts
where status = 'active'
group by user_id, freed_appointment_id
having count(*) > 1;

-- ═══════════════════════════════════════════════════════════════════════
-- BATCH E VERIFY
-- ═══════════════════════════════════════════════════════════════════════
select 'new tables' as check_, count(*)::text as result from information_schema.tables where table_schema='public' and table_name in ('csv_scanner_leads','public_csv_dialect_cache','emma_scheduler_connections','emma_scheduler_webhook_events')
union all select 'total public tables', count(*)::text from information_schema.tables where table_schema='public';
