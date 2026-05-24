-- ═══════════════════════════════════════════════════════════════════════
-- BATCH H (retry, FINAL) — Tenant finishing + v417 personas
--   FIX: refill_pricing_plans_add_predictable had a broken enum_range
--   smoke-test line that called enum_range(text) — no such function.
--   Removed (non-load-bearing, real verification is the constraint check).
-- ═══════════════════════════════════════════════════════════════════════

-- ─── 1/8 tenants_is_demo ──────────────────────
-- ─────────────────────────────────────────────────────────────────────────
-- v410 — Add is_demo column to public.tenants
-- ─────────────────────────────────────────────────────────────────────────
--
-- WHY
--   v410 ships the Refill standalone-product spa-owner shell. The
--   RefillShellChrome surfaces a DemoBanner when the tenant is a seeded
--   demo persona — mirror of the rep_accounts.metadata->>'demo' pattern
--   that drives the Kelly demo banner. First-class boolean column is
--   cleaner than metadata-json tag (matches the v406 substrate decision
--   to use is_active boolean on outreach_templates rather than tag-based).
--
-- WHAT
--   Adds is_demo boolean column to tenants with default false. Partial
--   index where is_demo=true lets admin queries cheaply list demo tenants.
--
-- TO RUN
--   Paste into Supabase SQL editor BEFORE the Karen demo seed migration
--   (which depends on this column existing). Per [[feedback-migrations-via-dashboard]].
-- ─────────────────────────────────────────────────────────────────────────

begin;

alter table public.tenants
  add column if not exists is_demo boolean not null default false;

create index if not exists tenants_is_demo_idx
  on public.tenants (is_demo) where is_demo = true;

comment on column public.tenants.is_demo is
  'True when this tenant is a seeded demo persona (e.g. Karen demo for the 5/29 walkthrough). Drives the DemoBanner in RefillShellChrome and the wipe_*_demo_data() filters. Defaults false for real production tenants.';

commit;

notify pgrst, 'reload schema';

-- ── Verify (paste-friendly) ──────────────────────────────────────────────
-- select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--  where table_schema='public' and table_name='tenants' and column_name='is_demo';
--
-- select count(*) from public.tenants where is_demo = true;  -- 0 before Karen seed runs

-- ─── 2/8 karen_demo_seed ──────────────────────
-- ─────────────────────────────────────────────────────────────────────────
-- v410 — Karen Anderson demo seed (Rejuv Skin Spa)
-- ─────────────────────────────────────────────────────────────────────────
--
-- WHY
--   v410 ships the Refill standalone-product spa-owner shell. The walk-as-
--   Karen verification methodology (per [[feedback-dry-run-after-major-builds]])
--   needs a Karen persona that signs in via magic link and lands in the
--   Refill chrome with realistic data populated. Mirror of the Kelly demo
--   seed (20260608000000_rep_platform_demo_seed.sql) for the spa-owner
--   side of the product.
--
-- WHAT
--   - auth.users row for Karen (id decaffaa-0000-0000-0000-000000000001,
--     email karen@rejuv-demo.test)
--   - auth.identities for email provider
--   - tenants row: slug "rejuv-demo", name "Rejuv Skin Spa", plan pro,
--     is_demo true
--   - tenant_memberships row tying Karen as owner
--   - ~30 days of emma_appointments (mix of statuses, drives rescue queue
--     and recovery ledger)
--   - ~15 emma_recovery_events spanning 30 days (mix verified + pending,
--     total ~$3,200 recovered — mirrors Rejuv real production scale)
--   - wipe_karen_demo_data() function for clean teardown before Karen-real
--     onboards her actual production tenant
--
-- All seeded rows tagged via:
--   - auth.users: email LIKE '%@rejuv-demo.test'
--   - tenants: is_demo = true
--   - emma_appointments: notes LIKE 'DEMO_KAREN%'
--   - emma_recovery_events: notes LIKE 'DEMO_KAREN%'
--
-- TO RUN
--   Paste into Supabase SQL editor AFTER 20260615000000_tenants_is_demo.sql
--   (which adds the is_demo column this seed populates). Per
--   [[feedback-migrations-via-dashboard]].
-- ─────────────────────────────────────────────────────────────────────────

-- ─── (0) Stable UUIDs ─────────────────────────────────────────────────────
-- Karen Anderson  = decaffaa-0000-0000-0000-000000000001
-- Rejuv Skin Spa  = decaffaa-0000-0000-0000-00000000000a (tenant id)

-- ─── (1) auth.users + auth.identities ─────────────────────────────────────

insert into auth.users (
  id, instance_id, aud, role,
  email, encrypted_password, email_confirmed_at,
  raw_user_meta_data, raw_app_meta_data,
  created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change
) values
  ('decaffaa-0000-0000-0000-000000000001'::uuid,
   '00000000-0000-0000-0000-000000000000'::uuid,
   'authenticated', 'authenticated',
   'karen@rejuv-demo.test', '', now(),
   jsonb_build_object('display_name','Karen Anderson','demo',true),
   jsonb_build_object('provider','email','providers',jsonb_build_array('email')),
   now() - interval '90 days', now(), '', '', '', '')
on conflict (id) do nothing;

insert into auth.identities (
  id, user_id, provider, provider_id, identity_data,
  last_sign_in_at, created_at, updated_at
)
select
  gen_random_uuid(),
  u.id,
  'email',
  u.id::text,
  jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
  null,
  u.created_at,
  now()
from auth.users u
where u.email = 'karen@rejuv-demo.test'
  and not exists (
    select 1 from auth.identities i where i.user_id = u.id and i.provider = 'email'
  );

-- ─── (2) tenants row ──────────────────────────────────────────────────────
-- Trial ended 60 days ago so the billing page renders the post-trial
-- "pro" plan state instead of the trial countdown. Mirrors a real spa
-- that's been on Refill for ~3 months.

insert into public.tenants (
  id, name, slug,
  created_at, trial_starts_at, trial_ends_at,
  plan, is_demo
) values (
  'decaffaa-0000-0000-0000-00000000000a'::uuid,
  'Rejuv Skin Spa',
  'rejuv-demo',
  now() - interval '90 days',
  now() - interval '90 days',
  now() - interval '60 days',
  'pro',
  true
)
on conflict (id) do nothing;

-- ─── (3) tenant_memberships ──────────────────────────────────────────────

insert into public.tenant_memberships (
  user_id, tenant_id, role
) values (
  'decaffaa-0000-0000-0000-000000000001'::uuid,
  'decaffaa-0000-0000-0000-00000000000a'::uuid,
  'owner'
)
on conflict do nothing;

-- ─── (4) emma_appointments — 30 days of mixed-status appointments ─────────
-- Drives the rescue queue + recovery page. Pattern: 60% completed/showed,
-- 15% cancelled, 10% no_show, 15% upcoming scheduled. Total ~25 rows so
-- the page has visible density without overwhelming the demo walk.

insert into public.emma_appointments (
  user_id, scheduled_at, duration_min, treatment_type, provider_name,
  status, source, notes, created_at, updated_at
)
select
  'decaffaa-0000-0000-0000-000000000001'::uuid,
  now() - (g.day || ' days')::interval + (v.hour || ' hours')::interval,
  v.duration,
  v.treatment,
  v.provider,
  v.status,
  'csv-acuity',
  'DEMO_KAREN appointment #' || g.day || '-' || v.hour,
  now() - (g.day || ' days')::interval,
  now() - (g.day || ' days')::interval
from generate_series(0, 29) g(day)
cross join lateral (
  -- Two appointments per day on average; status rotates deterministically.
  values
    (9::int,  60::int, 'Botox',        'Karen Anderson',
       case (g.day % 7)
         when 0 then 'cancelled'
         when 3 then 'no_show'
         else 'showed'
       end),
    (14::int, 45::int, 'Filler',       'Karen Anderson',
       case
         when g.day <= 1 then 'scheduled'  -- upcoming
         when (g.day % 5) = 0 then 'cancelled'
         else 'showed'
       end)
) v(hour, duration, treatment, provider, status)
on conflict (user_id, external_id, source) do nothing;

-- ─── (5) emma_recovery_events — 15 events spanning 30 days ────────────────
-- Mix of verified (10) + unverified (5). Verified events have
-- attributed_revenue_usd populated; unverified stay null until manual
-- reconciliation. Total verified revenue ~$3,200 (mirrors Rejuv scale).

insert into public.emma_recovery_events (
  user_id, recovery_agent, attribution_method,
  attributed_revenue_usd, verification_source, verified_at, verified_by,
  notes, created_at, updated_at
)
select
  'decaffaa-0000-0000-0000-000000000001'::uuid,
  agent.val,
  'direct',
  case when v.is_verified then v.amount else null end,
  case when v.is_verified then 'stripe' else null end,
  case when v.is_verified then v.created_at + interval '4 hours' else null end,
  case when v.is_verified then 'DEMO_VERIFIER' else null end,
  'DEMO_KAREN recovery event',
  v.created_at,
  v.created_at
from (
  values
    -- 4 in last 24h (today/yesterday — drives "Today" trust moment)
    (now() - interval '47 minutes',  true,  340.00),
    (now() - interval '6 hours',     true,  680.00),
    (now() - interval '11 hours',    true,  225.00),
    (now() - interval '20 hours',    false, 0),
    -- 5 in last 7 days
    (now() - interval '2 days',      true,  450.00),
    (now() - interval '3 days',      true,  290.00),
    (now() - interval '4 days',      false, 0),
    (now() - interval '5 days',      true,  175.00),
    (now() - interval '6 days',      true,  520.00),
    -- 6 in last 30 days
    (now() - interval '10 days',     true,  380.00),
    (now() - interval '14 days',     false, 0),
    (now() - interval '18 days',     true,  260.00),
    (now() - interval '22 days',     true,  195.00),
    (now() - interval '25 days',     false, 0),
    (now() - interval '28 days',     true,  410.00)
) as v(created_at, is_verified, amount)
cross join lateral (
  -- Rotate agent type deterministically off the timestamp.
  select case extract(epoch from v.created_at)::bigint % 3
    when 0 then 'rescue'
    when 1 then 'post_recovery'
    else 'preshow'
  end as val
) agent
where not exists (
  select 1 from public.emma_recovery_events
   where user_id = 'decaffaa-0000-0000-0000-000000000001'::uuid
     and notes like 'DEMO_KAREN%'
);

-- ─── (6) wipe_karen_demo_data() function ─────────────────────────────────
-- Parallel to wipe_kelly_demo_data(). One-shot teardown so when the real
-- Karen (production Rejuv) onboards, the demo persona clears cleanly.

create or replace function public.wipe_karen_demo_data()
returns table (deleted_table text, row_count bigint)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_events_deleted     bigint;
  v_apts_deleted       bigint;
  v_memberships_del    bigint;
  v_tenants_deleted    bigint;
  v_idents_deleted     bigint;
  v_users_deleted      bigint;
begin
  with d as (
    delete from public.emma_recovery_events
    where notes like 'DEMO_KAREN%'
    returning 1
  )
  select count(*) into v_events_deleted from d;

  with d as (
    delete from public.emma_appointments
    where notes like 'DEMO_KAREN%'
    returning 1
  )
  select count(*) into v_apts_deleted from d;

  with d as (
    delete from public.tenant_memberships
    where tenant_id in (select id from public.tenants where is_demo = true)
    returning 1
  )
  select count(*) into v_memberships_del from d;

  with d as (
    delete from public.tenants
    where is_demo = true
    returning 1
  )
  select count(*) into v_tenants_deleted from d;

  with d as (
    delete from auth.identities
    where user_id in (select id from auth.users where email like '%@rejuv-demo.test')
    returning 1
  )
  select count(*) into v_idents_deleted from d;

  with d as (
    delete from auth.users
    where email like '%@rejuv-demo.test'
    returning 1
  )
  select count(*) into v_users_deleted from d;

  return query values
    ('emma_recovery_events',  v_events_deleted),
    ('emma_appointments',     v_apts_deleted),
    ('tenant_memberships',    v_memberships_del),
    ('tenants',               v_tenants_deleted),
    ('auth.identities',       v_idents_deleted),
    ('auth.users',            v_users_deleted);
end;
$fn$;

revoke all on function public.wipe_karen_demo_data() from public;
grant execute on function public.wipe_karen_demo_data() to service_role;

comment on function public.wipe_karen_demo_data() is
  'One-shot teardown of the Karen Anderson demo seed (v410). Returns row counts deleted per table. Call from Supabase dashboard SQL editor with: select * from public.wipe_karen_demo_data();';

notify pgrst, 'reload schema';

-- ─── Verify (paste-friendly) ──────────────────────────────────────────────
-- These should each return non-zero after first apply:
--
-- select 'demo_user'      as label, count(*) from auth.users where email = 'karen@rejuv-demo.test';
-- select 'demo_tenant'    as label, count(*) from public.tenants where is_demo = true;
-- select 'demo_membership' as label, count(*) from public.tenant_memberships
--   where tenant_id = 'decaffaa-0000-0000-0000-00000000000a'::uuid;
-- select 'demo_appointments' as label, count(*) from public.emma_appointments where notes like 'DEMO_KAREN%';
-- select 'demo_recoveries'   as label, count(*) from public.emma_recovery_events where notes like 'DEMO_KAREN%';
-- select 'karen_verified_revenue' as label,
--        sum(attributed_revenue_usd)::numeric(12,2)
--   from public.emma_recovery_events
--  where notes like 'DEMO_KAREN%';

-- ─── 3/8 refill_pricing_plans_add_predictable ─
-- v411.1 — extend refill_pricing_plans.plan check constraint to allow 'predictable'.
--
-- v411 shipped the 3-card billing layout with Predictable as a teaser; v411.1
-- wires the third plan end-to-end. The original check constraint from
-- 20260601000000_refill_billing.sql (`plan in ('starter','pro')`) blocks
-- INSERTs with plan='predictable' — we relax it here.
--
-- Refill plan economics per [[project-pricing-killshot]]:
--   starter      — free + 12% of recovered revenue (the killshot default)
--   predictable  — $299/mo flat + 0% revenue share (NEW v411.1)
--   pro          — $99/mo + 8% of recovered (commitment + shared upside)
--
-- No data backfill needed — existing rows are all starter/pro and stay valid
-- under the expanded constraint.

alter table public.refill_pricing_plans
  drop constraint if exists refill_pricing_plans_plan_check;

alter table public.refill_pricing_plans
  add constraint refill_pricing_plans_plan_check
  check (plan in ('starter', 'predictable', 'pro'));

-- Ask PostgREST to reload its schema cache so the API picks up the relaxed
-- constraint immediately without waiting for the periodic refresh.
notify pgrst, 'reload schema';

-- Cleave fix 2026-05-24: removed leftover smoke-test line that called
-- enum_range(null::text) — broken (text isn't an enum) and not load-bearing
-- (the real verification is the constraint check below).
select conname, pg_get_constraintdef(oid)
from pg_constraint
where conname = 'refill_pricing_plans_plan_check';

-- ─── 4/8 tenants_delivery_channel ─────────────
-- v415.1 — tenants.delivery_channel column for onboard wizard Step 4.
--
-- Captures how rescue offers will be delivered to patients for this spa:
--   'proxy'  — Refill drafts on the spa's Mac, owner reviews and taps Send
--              (no carrier setup, no porting, no monthly fees). Recommended
--              default per [[project_trial_first_no_money_asks]] — trial
--              users should never have to commit money / phone porting
--              before they feel the win.
--   'direct' — Refill sends SMS from the spa's own ported number (requires
--              ~3 weeks porting + carrier coordination). Available
--              post-trial; the /onboard wizard surfaces it as disabled
--              with "Available after your first month" copy.
--
-- Lives on `tenants` (not on `emma_noshow_policies`) because the channel is
-- a spa-level operational mode, not a per-policy knob. Policies inherit
-- the channel via the tenant relation. The existing rescue_proxy_phone /
-- rescue_proxy_email columns on emma_noshow_policies are HOW proxy works
-- for that policy; tenants.delivery_channel is WHETHER. Both coexist.
--
-- Default 'proxy' so any pre-existing tenant gets the trial-safe setting
-- without an explicit choice. New tenants from the wizard write this
-- explicitly via the v415.1 claimSlug input addition.

alter table public.tenants
  add column if not exists delivery_channel text not null default 'proxy'
  check (delivery_channel in ('proxy', 'direct'));

notify pgrst, 'reload schema';

-- Verify after paste:
--   select slug, name, delivery_channel, created_at
--   from public.tenants
--   order by created_at desc
--   limit 5;
-- All existing rows should show 'proxy'. New onboard claims will show
-- the user's choice (defaulting to 'proxy' since direct is disabled
-- in the v415.1 wizard).

-- ─── 5/8 v417_admin_personas ──────────────────
-- v417.1 — Admin persona switcher prerequisites.
--
-- The personas themselves already exist from prior demo seeds:
--   kelly@refill-demo.test     (rep, anchor)        — 20260608000000_rep_platform_demo_seed
--   maria@refill-demo.test     (T1 sub-rep)         — same file
--   karen@rejuv-demo.test      (spa owner, Rejuv)   — 20260615010000_karen_demo_seed
--
-- This migration just wires the prerequisites for the v417.1 admin
-- persona switcher at /app/admin/personas:
--   (1) Grant admin role to Grasshopper so he can hit the switcher route
--   (2) Ensure user_preferences.primary_role is set for each persona so
--       post-login dispatch routes Kelly + Maria → /app/rep, Karen →
--       /app/refill
--
-- Passwords get set by the v417.1 bootstrapPersonas server fn (Supabase
-- auth.users.encrypted_password is bcrypt — can't be safely seeded via
-- raw SQL). One-shot button click from /app/admin/personas after this
-- migration applies sets the shared test password on each persona.

-- ─── (1) Grant admin to Grasshopper ──────────────────────────────────────
-- Idempotent — re-running is a no-op if the row already exists.
insert into public.user_roles (user_id, role)
select id, 'admin'
from auth.users
where email = 'davidfand303@gmail.com'
on conflict (user_id, role) do nothing;

-- ─── (2) primary_role on each persona ────────────────────────────────────
-- Without these, post-login dispatch can't route the persona to the
-- right dashboard (rep → /app/rep, spa-owner → /app/refill).
insert into public.user_preferences (user_id, primary_role)
select id, 'rep'
from auth.users
where email in ('kelly@refill-demo.test', 'maria@refill-demo.test')
on conflict (user_id) do update set primary_role = excluded.primary_role;

insert into public.user_preferences (user_id, primary_role)
select id, 'spa-owner'
from auth.users
where email = 'karen@rejuv-demo.test'
on conflict (user_id) do update set primary_role = excluded.primary_role;

notify pgrst, 'reload schema';

-- Verify after paste:
--   select u.email, ur.role, up.primary_role
--   from auth.users u
--   left join public.user_roles ur on ur.user_id = u.id and ur.role = 'admin'
--   left join public.user_preferences up on up.user_id = u.id
--   where u.email in (
--     'davidfand303@gmail.com',
--     'kelly@refill-demo.test',
--     'maria@refill-demo.test',
--     'karen@rejuv-demo.test'
--   )
--   order by u.email;
--
-- Expected rows:
--   davidfand303@gmail.com  | admin | (null or whatever it was)
--   karen@rejuv-demo.test   | (null)| spa-owner
--   kelly@refill-demo.test  | (null)| rep
--   maria@refill-demo.test  | (null)| rep

-- ─── 6/8 v417_admin_testing_identity ──────────
-- v417.1.1 — Dedicated admin testing identity.
--
-- Grasshopper's real account (davidfand303@gmail.com) stays Google-OAuth-
-- only. This adds a separate testing identity (admin@refill-demo.test)
-- with admin role so he can sign in at getrefill.app/login with straight
-- email/password and reach /app/admin/personas without needing Google.
--
-- Password gets set by the v417.1 bootstrap server fn after this
-- migration applies (extended to include admin@refill-demo.test in
-- the persona list).

-- ─── (1) auth.users ──────────────────────────────────────────────────────
-- v417.1.1: encrypted_password set DIRECTLY via pgcrypto bcrypt so admin
-- can sign in at getrefill.app/login with email + password the moment
-- this migration runs — no bootstrap UI dependency. Per
-- [[feedback-google-oauth-not-hooked-up]], Google OAuth is not configured;
-- email/password is the ONLY working admin login. Hardcoded password
-- "RefillTest2026!" matches V417_TEST_PASSWORD in src/server/v417-personas.ts.
-- *.test TLD = no real-money data; acceptable to embed in migration.
insert into auth.users (
  id, instance_id, aud, role,
  email, encrypted_password, email_confirmed_at,
  raw_user_meta_data, raw_app_meta_data,
  created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change
) values
  ('addf1110-0000-0000-0000-000000000001'::uuid,
   '00000000-0000-0000-0000-000000000000'::uuid,
   'authenticated', 'authenticated',
   'admin@refill-demo.test',
   crypt('RefillTest2026!', gen_salt('bf')),
   now(),
   jsonb_build_object('display_name','Refill Admin (test)','demo',true),
   jsonb_build_object('provider','email','providers',jsonb_build_array('email')),
   now(), now(), '', '', '', '')
on conflict (id) do update set
  encrypted_password = excluded.encrypted_password,
  email_confirmed_at = coalesce(auth.users.email_confirmed_at, now());

-- ─── (2) auth.identities ─────────────────────────────────────────────────
insert into auth.identities (
  id, user_id, provider, provider_id, identity_data,
  last_sign_in_at, created_at, updated_at
)
select
  gen_random_uuid(),
  u.id,
  'email',
  u.id::text,
  jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
  null,
  u.created_at,
  now()
from auth.users u
where u.email = 'admin@refill-demo.test'
  and not exists (
    select 1 from auth.identities i
    where i.user_id = u.id and i.provider = 'email'
  );

-- ─── (3) Grant admin role ────────────────────────────────────────────────
insert into public.user_roles (user_id, role)
values ('addf1110-0000-0000-0000-000000000001'::uuid, 'admin')
on conflict (user_id, role) do nothing;

-- ─── (4) primary_role ────────────────────────────────────────────────────
insert into public.user_preferences (user_id, primary_role)
values ('addf1110-0000-0000-0000-000000000001'::uuid, 'developer')
on conflict (user_id) do update set primary_role = excluded.primary_role;

-- ─── (5) Set passwords on Kelly / Maria / Karen ─────────────────────────
-- v417.1.1: Same pgcrypto approach so the personas the v417.1 dropdown
-- signs you in as are testable WITHOUT clicking the bootstrap UI button
-- first. The bootstrap server fn still works (idempotent re-application
-- of the same password) but it's no longer a prerequisite.
update auth.users
set encrypted_password = crypt('RefillTest2026!', gen_salt('bf')),
    email_confirmed_at = coalesce(email_confirmed_at, now())
where email in (
  'kelly@refill-demo.test',
  'maria@refill-demo.test',
  'karen@rejuv-demo.test'
);

notify pgrst, 'reload schema';

-- Verify:
--   select u.email, ur.role, up.primary_role
--   from auth.users u
--   left join public.user_roles ur on ur.user_id = u.id and ur.role = 'admin'
--   left join public.user_preferences up on up.user_id = u.id
--   where u.email = 'admin@refill-demo.test';
-- Expected: admin@refill-demo.test | admin | developer

-- ─── 7/8 v417_admin_refill_next ───────────────
-- v417.1.2 — Seed admin@refill-demo.test user_metadata.refill_next.
--
-- The v410.3 cross-host bridge reads user.user_metadata.refill_next on
-- agentiport.com SIGNED_IN events to know which Refill-host path to
-- redirect to (via /auth/cross-host-bridge). v417.1.2 extends the
-- parser allowlist to include /app/admin/personas. This migration sets
-- that metadata on the admin testing identity so the next admin magic
-- link minted via service-role admin.generateLink lands on
-- app.getrefill.app/app/admin/personas signed in — bypassing both the
-- agentiport.com Site URL Supabase forces AND the user-endpoint
-- signInWithPassword rate limit.
--
-- Schema matches parseRefillNextMetadata in src/lib/cross-host-bridge.ts:
--   { v: 1, path: "/app/admin/personas", lead: null, ref: null, step: 1 }
-- (step is meaningless for admin path but required by the schema; set
-- to 1 satisfies the validator without semantic meaning.)

update auth.users
set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) ||
  jsonb_build_object(
    'refill_next',
    jsonb_build_object(
      'v', 1,
      'path', '/app/admin/personas',
      'lead', null,
      'ref', null,
      'step', 1
    )
  )
where email = 'admin@refill-demo.test';

-- Verify:
--   select email, raw_user_meta_data->>'refill_next' as refill_next
--   from auth.users
--   where email = 'admin@refill-demo.test';
-- Expected: a JSON string starting with {"v":1,"path":"/app/admin/personas",...}

-- ─── 8/8 v417_persona_bridge_metadata ─────────
-- v417.2 — Seed kelly@refill-demo.test + maria@refill-demo.test
-- user_metadata.refill_next so service-role-minted magic links bridge
-- through to app.getrefill.app/app/rep cleanly.
--
-- Mirrors the v417.1.2 admin pattern (20260618020000_v417_admin_refill_next.sql).
-- The v410.3 cross-host bridge reads user_metadata.refill_next on
-- agentiport.com SIGNED_IN events to know which Refill-host path to
-- redirect to. v417.2 extends the parser allowlist to include
-- /app/rep + /app/refill and extends the SYNC fast-path in
-- cross-host-bridge-trigger.tsx to fire on ANY non-onboard path —
-- which kicks in for these personas the next time they sign in via
-- magic link.
--
-- Karen (karen@rejuv-demo.test) intentionally NOT seeded here: she has
-- a tenant_memberships row, and the slow path's tenant-first branch
-- already routes her to BRIDGE_DEFAULT_NEXT (/app/refill). Adding a
-- refill_next metadata to her would still work (the SYNC path would
-- catch her), but we avoid disturbing return-visit semantics where
-- tenant should always win over any stale onboard metadata.
--
-- Schema matches parseRefillNextMetadata in src/lib/cross-host-bridge.ts:
--   { v: 1, path: "/app/rep", lead: null, ref: null, step: 1 }
-- (step is meaningless for non-onboard paths but required by the
-- validator; set to 1 satisfies it without semantic meaning.)

update auth.users
set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) ||
  jsonb_build_object(
    'refill_next',
    jsonb_build_object(
      'v', 1,
      'path', '/app/rep',
      'lead', null,
      'ref', null,
      'step', 1
    )
  )
where email in ('kelly@refill-demo.test', 'maria@refill-demo.test');

notify pgrst, 'reload schema';

-- Verify:
--   select email, raw_user_meta_data->>'refill_next' as refill_next
--   from auth.users
--   where email in ('kelly@refill-demo.test', 'maria@refill-demo.test')
--   order by email;
-- Expected (2 rows):
--   kelly@refill-demo.test | {"v":1,"path":"/app/rep","lead":null,"ref":null,"step":1}
--   maria@refill-demo.test | {"v":1,"path":"/app/rep","lead":null,"ref":null,"step":1}

-- ═══════════════════════════════════════════════════════════════════════
-- BATCH H VERIFY — Phase 2 finish line
-- ═══════════════════════════════════════════════════════════════════════
select 'karen user' as check_, count(*)::text as result from auth.users where email='karen@rejuv-demo.test'
union all select 'admin testing user', count(*)::text from auth.users where email='admin@refill-demo.test'
union all select 'rejuv tenant', count(*)::text from public.tenants where slug='rejuv'
union all select 'tenants.is_demo column', count(*)::text from information_schema.columns where table_schema='public' and table_name='tenants' and column_name='is_demo'
union all select 'tenants.delivery_channel column', count(*)::text from information_schema.columns where table_schema='public' and table_name='tenants' and column_name='delivery_channel'
union all select 'admin role grants', count(*)::text from public.user_roles where role='admin'
union all select 'kelly refill_next', count(*)::text from auth.users where email='kelly@refill-demo.test' and raw_user_meta_data->>'refill_next' is not null
union all select 'maria refill_next', count(*)::text from auth.users where email='maria@refill-demo.test' and raw_user_meta_data->>'refill_next' is not null
union all select 'wipe_karen_demo_data fn', count(*)::text from pg_proc where proname='wipe_karen_demo_data'
union all select 'total public tables', count(*)::text from information_schema.tables where table_schema='public';
