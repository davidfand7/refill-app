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
