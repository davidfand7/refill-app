-- Refill Rep Platform — Phase 2G demo seed for the 5/29 Kelly Caffee meeting.
--
-- Creates a fully-populated "Kelly Caffee" demo persona so when Grasshopper
-- signs in as her (via magic link generated through getKellyDemoMagicLink),
-- screens 5/6/7 render with realistic data instead of empty-state.
--
-- Structure:
--   - 1 anchor rep (Kelly Caffee) — tier-1 to herself
--   - 5 direct sub-reps under Kelly (Tier-1 to Kelly's network)
--   - 2 sub-sub-reps (Tier-2 cascade — one under Maria, one under Tony)
--   - ~3 months of commission ledger history (Tier-1 direct + Tier-2 cascade)
--   - ~20 emma_recovery_events spanning the last 30 days, attributed
--     directly to Kelly's user_id — populates her LiveEarningsCard
--
-- ALL seeded rows are tagged so wipe_kelly_demo_data() can clean them up
-- before Kelly's real signup:
--   - rep_accounts: metadata->>'demo' = 'true'
--   - rep_commission_ledger: notes LIKE 'DEMO_KELLY%'
--   - emma_recovery_events: notes LIKE 'DEMO_KELLY%'
--   - auth.users: email LIKE '%@refill-demo.test'
--
-- Apply via Supabase dashboard SQL editor per feedback_migrations_via_dashboard.

-- ─── (0) Stable UUIDs ─────────────────────────────────────────────────────
-- Hardcoded for reproducibility — if you re-apply this migration after a
-- wipe_kelly_demo_data() run, the UUIDs match and the data lands cleanly.

-- Kelly Caffee (anchor) = c0ffee00-0000-0000-0000-000000000001
-- Maria Chen (T1 sub)  = c0ffee00-0000-0000-0000-000000000002
-- Tony Reyes (T1 sub)  = c0ffee00-0000-0000-0000-000000000003
-- Sarah Kim (T1 sub)   = c0ffee00-0000-0000-0000-000000000004
-- Jasmine Patel (T1)   = c0ffee00-0000-0000-0000-000000000005
-- Marcus Williams (T1) = c0ffee00-0000-0000-0000-000000000006
-- Daniela Vargas (T2)  = c0ffee00-0000-0000-0000-000000000007 (under Maria)
-- Brennan OHara (T2)   = c0ffee00-0000-0000-0000-000000000008 (under Tony)

-- ─── (1) auth.users + auth.identities ────────────────────────────────────
-- Direct INSERT into auth schema. Requires service_role (i.e. you must be
-- pasting this into the Supabase dashboard SQL editor or running it via
-- the service-role API). Email confirmed = true so magic link works
-- without a confirmation step. encrypted_password = empty string is fine
-- for magic-link-only users.

insert into auth.users (
  id, instance_id, aud, role,
  email, encrypted_password, email_confirmed_at,
  raw_user_meta_data, raw_app_meta_data,
  created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change
) values
  ('c0ffee00-0000-0000-0000-000000000001'::uuid,
   '00000000-0000-0000-0000-000000000000'::uuid,
   'authenticated', 'authenticated',
   'kelly@refill-demo.test', '', now(),
   jsonb_build_object('display_name','Kelly Caffee','demo',true),
   jsonb_build_object('provider','email','providers',jsonb_build_array('email')),
   now() - interval '120 days', now(), '', '', '', ''),
  ('c0ffee00-0000-0000-0000-000000000002'::uuid,
   '00000000-0000-0000-0000-000000000000'::uuid,
   'authenticated', 'authenticated',
   'maria@refill-demo.test', '', now(),
   jsonb_build_object('display_name','Maria Chen','demo',true),
   jsonb_build_object('provider','email','providers',jsonb_build_array('email')),
   now() - interval '85 days', now(), '', '', '', ''),
  ('c0ffee00-0000-0000-0000-000000000003'::uuid,
   '00000000-0000-0000-0000-000000000000'::uuid,
   'authenticated', 'authenticated',
   'tony@refill-demo.test', '', now(),
   jsonb_build_object('display_name','Tony Reyes','demo',true),
   jsonb_build_object('provider','email','providers',jsonb_build_array('email')),
   now() - interval '78 days', now(), '', '', '', ''),
  ('c0ffee00-0000-0000-0000-000000000004'::uuid,
   '00000000-0000-0000-0000-000000000000'::uuid,
   'authenticated', 'authenticated',
   'sarah@refill-demo.test', '', now(),
   jsonb_build_object('display_name','Sarah Kim','demo',true),
   jsonb_build_object('provider','email','providers',jsonb_build_array('email')),
   now() - interval '70 days', now(), '', '', '', ''),
  ('c0ffee00-0000-0000-0000-000000000005'::uuid,
   '00000000-0000-0000-0000-000000000000'::uuid,
   'authenticated', 'authenticated',
   'jasmine@refill-demo.test', '', now(),
   jsonb_build_object('display_name','Jasmine Patel','demo',true),
   jsonb_build_object('provider','email','providers',jsonb_build_array('email')),
   now() - interval '55 days', now(), '', '', '', ''),
  ('c0ffee00-0000-0000-0000-000000000006'::uuid,
   '00000000-0000-0000-0000-000000000000'::uuid,
   'authenticated', 'authenticated',
   'marcus@refill-demo.test', '', now(),
   jsonb_build_object('display_name','Marcus Williams','demo',true),
   jsonb_build_object('provider','email','providers',jsonb_build_array('email')),
   now() - interval '40 days', now(), '', '', '', ''),
  ('c0ffee00-0000-0000-0000-000000000007'::uuid,
   '00000000-0000-0000-0000-000000000000'::uuid,
   'authenticated', 'authenticated',
   'daniela@refill-demo.test', '', now(),
   jsonb_build_object('display_name','Daniela Vargas','demo',true),
   jsonb_build_object('provider','email','providers',jsonb_build_array('email')),
   now() - interval '45 days', now(), '', '', '', ''),
  ('c0ffee00-0000-0000-0000-000000000008'::uuid,
   '00000000-0000-0000-0000-000000000000'::uuid,
   'authenticated', 'authenticated',
   'brennan@refill-demo.test', '', now(),
   jsonb_build_object('display_name','Brennan OHara','demo',true),
   jsonb_build_object('provider','email','providers',jsonb_build_array('email')),
   now() - interval '38 days', now(), '', '', '', '')
on conflict (id) do nothing;

-- Identities for the email provider (Supabase requires one identity per
-- provider per user). provider_id = same UUID as user, identity_data
-- carries the email + sub claims.

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
where u.email like '%@refill-demo.test'
  and not exists (
    select 1 from auth.identities i where i.user_id = u.id and i.provider = 'email'
  );

-- ─── (2) rep_accounts ────────────────────────────────────────────────────

insert into public.rep_accounts (
  rep_user_id, display_name, business_name, status, origin_type,
  territory, joined_at, payout_method, metadata
) values
  ('c0ffee00-0000-0000-0000-000000000001'::uuid,
   'Kelly Caffee', 'Aesthetic Channel Network', 'active', 'indy_rep',
   jsonb_build_object('states', jsonb_build_array('CO','UT','NE','WY')),
   now() - interval '120 days', 'stripe',
   jsonb_build_object('demo', true, 'is_anchor', true, 'note', 'Kelly Caffee demo persona')),
  ('c0ffee00-0000-0000-0000-000000000002'::uuid,
   'Maria Chen', 'Boutique Aesthetic Advisors', 'active', 'indy_rep',
   jsonb_build_object('states', jsonb_build_array('CO')),
   now() - interval '85 days', 'stripe',
   jsonb_build_object('demo', true)),
  ('c0ffee00-0000-0000-0000-000000000003'::uuid,
   'Tony Reyes', 'Reyes Med Spa Consulting', 'active', 'indy_rep',
   jsonb_build_object('states', jsonb_build_array('UT','NV')),
   now() - interval '78 days', 'stripe',
   jsonb_build_object('demo', true)),
  ('c0ffee00-0000-0000-0000-000000000004'::uuid,
   'Sarah Kim', 'Kim Aesthetics Group', 'active', 'indy_rep',
   jsonb_build_object('states', jsonb_build_array('CO','WY')),
   now() - interval '70 days', 'stripe',
   jsonb_build_object('demo', true)),
  ('c0ffee00-0000-0000-0000-000000000005'::uuid,
   'Jasmine Patel', 'Patel Beauty Partners', 'active', 'indy_rep',
   jsonb_build_object('states', jsonb_build_array('NE')),
   now() - interval '55 days', 'stripe',
   jsonb_build_object('demo', true)),
  ('c0ffee00-0000-0000-0000-000000000006'::uuid,
   'Marcus Williams', 'Williams Med-Aesthetic', 'active', 'indy_rep',
   jsonb_build_object('states', jsonb_build_array('CO')),
   now() - interval '40 days', 'stripe',
   jsonb_build_object('demo', true)),
  ('c0ffee00-0000-0000-0000-000000000007'::uuid,
   'Daniela Vargas', 'Vargas Skin Studio', 'active', 'indy_rep',
   jsonb_build_object('states', jsonb_build_array('CO')),
   now() - interval '45 days', 'stripe',
   jsonb_build_object('demo', true)),
  ('c0ffee00-0000-0000-0000-000000000008'::uuid,
   'Brennan OHara', 'OHara Aesthetic Group', 'active', 'indy_rep',
   jsonb_build_object('states', jsonb_build_array('UT')),
   now() - interval '38 days', 'stripe',
   jsonb_build_object('demo', true))
on conflict (rep_user_id) do nothing;

-- ─── (3) rep_affiliations (the tree) ─────────────────────────────────────
-- Kelly → 5 direct Tier-1 sub-reps (Maria, Tony, Sarah, Jasmine, Marcus)
-- Maria → Daniela (Tier-2 cascade through Maria)
-- Tony  → Brennan (Tier-2 cascade through Tony)
-- commission_split: 0.03 (3%) on direct, 0.01 (1%) on cascade

insert into public.rep_affiliations (
  rep_id, parent_rep_id, tier_level, commission_split, active
) values
  -- Kelly's 5 direct Tier-1 sub-reps
  ('c0ffee00-0000-0000-0000-000000000002'::uuid, 'c0ffee00-0000-0000-0000-000000000001'::uuid, 1, 0.0300, true),
  ('c0ffee00-0000-0000-0000-000000000003'::uuid, 'c0ffee00-0000-0000-0000-000000000001'::uuid, 1, 0.0300, true),
  ('c0ffee00-0000-0000-0000-000000000004'::uuid, 'c0ffee00-0000-0000-0000-000000000001'::uuid, 1, 0.0300, true),
  ('c0ffee00-0000-0000-0000-000000000005'::uuid, 'c0ffee00-0000-0000-0000-000000000001'::uuid, 1, 0.0300, true),
  ('c0ffee00-0000-0000-0000-000000000006'::uuid, 'c0ffee00-0000-0000-0000-000000000001'::uuid, 1, 0.0300, true),
  -- Tier-2 cascade
  ('c0ffee00-0000-0000-0000-000000000007'::uuid, 'c0ffee00-0000-0000-0000-000000000002'::uuid, 1, 0.0300, true),
  ('c0ffee00-0000-0000-0000-000000000008'::uuid, 'c0ffee00-0000-0000-0000-000000000003'::uuid, 1, 0.0300, true)
on conflict (rep_id, parent_rep_id, tier_level) do nothing;

-- ─── (4) rep_commission_ledger — 3 periods of history ────────────────────
-- Kelly's ledger shows two flavors of rows:
--   Tier-1 direct (tier_level=1, commission_split=0.0300) — spas Kelly
--     personally introduced. 8 spas, $5K each, 3 months running.
--   Tier-2 cascade (tier_level=2, commission_split=0.0100) — spas Kelly's
--     sub-reps introduced. ~20 spas across the 5 sub-reps, 1% to Kelly.
--
-- Periods are first-of-month. Use date_trunc to align cleanly regardless
-- of when this migration is applied.

with periods as (
  select
    date_trunc('month', now() - interval '60 days')::date as p3,  -- 2 months ago (paid)
    date_trunc('month', now() - interval '30 days')::date as p2,  -- 1 month ago (paid)
    date_trunc('month', now())::date                      as p1   -- current month (pending)
)
-- Kelly Tier-1 direct: 8 spas × $5,000 recovered/mo × 3% = $1,200/mo Kelly
-- Spread across 3 months. Earlier months are 'paid', current is 'pending'.
insert into public.rep_commission_ledger (
  rep_id, source_invoice_id, source_tenant_id, period_month, tier_level,
  commission_split, source_revenue_usd, commission_usd, status, paid_at, notes
)
select
  'c0ffee00-0000-0000-0000-000000000001'::uuid,
  null, null,
  case when n.month_offset = 2 then p.p3
       when n.month_offset = 1 then p.p2
       else p.p1
  end,
  1, 0.0300,
  5000.00,
  150.00,
  case when n.month_offset >= 1 then 'paid' else 'pending' end,
  case when n.month_offset >= 1 then (p.p2 + interval '7 days')::timestamptz else null end,
  'DEMO_KELLY Tier-1 spa #' || lpad(n.spa_idx::text, 2, '0')
from periods p
cross join (
  -- 8 spas × 3 months = 24 rows
  select g.spa_idx, m.month_offset
  from generate_series(1, 8) g(spa_idx)
  cross join generate_series(0, 2) m(month_offset)
) n;

-- Kelly Tier-2 cascade: 20 spas (across 5 sub-reps) × $5K/mo × 1% = $1,000/mo Kelly
-- Slightly lower volume in older periods (network was still growing).

with periods as (
  select
    date_trunc('month', now() - interval '60 days')::date as p3,
    date_trunc('month', now() - interval '30 days')::date as p2,
    date_trunc('month', now())::date                      as p1
),
cascade_counts as (
  select 0 as month_offset, 6  as spas union all   -- current month
  select 1, 14 union all                            -- 1 mo ago
  select 2, 20                                      -- 2 mo ago (when full ramp hits)
)
insert into public.rep_commission_ledger (
  rep_id, source_invoice_id, source_tenant_id, period_month, tier_level,
  commission_split, source_revenue_usd, commission_usd, status, paid_at, notes
)
select
  'c0ffee00-0000-0000-0000-000000000001'::uuid,
  null, null,
  case when c.month_offset = 2 then p.p3
       when c.month_offset = 1 then p.p2
       else p.p1
  end,
  2, 0.0100,
  5000.00,
  50.00,
  case when c.month_offset >= 1 then 'paid' else 'pending' end,
  case when c.month_offset >= 1 then (p.p2 + interval '7 days')::timestamptz else null end,
  'DEMO_KELLY Tier-2 cascade'
from periods p
cross join cascade_counts c
cross join lateral generate_series(1, c.spas) g(idx);

-- ─── (5) emma_recovery_events — live $$ widget feed ──────────────────────
-- 20 events across the last 30 days, all attributed to Kelly (her direct
-- spas only — sub-rep cascade flows through the ledger, not the live widget).
-- Mix of recovery_agent types (rescue, post_recovery, preshow) and verification
-- states (~70% verified with attributed_revenue_usd, ~30% unverified/pending).
--
-- created_at is staggered: 4 in the last hour (for "Today" + freshness),
-- 4 in the last day, 6 in the last 7 days, 6 in the last 30 days.

insert into public.emma_recovery_events (
  user_id, recovery_agent, attribution_method,
  attributed_revenue_usd, verification_source, verified_at, verified_by,
  referred_by_rep_id, notes, created_at, updated_at
)
select
  'c0ffee00-0000-0000-0000-000000000001'::uuid,                          -- user_id (Kelly herself as spa-owner stand-in)
  agent.val,                                                              -- recovery_agent
  'direct',
  case when v.is_verified then v.amount else null end,                    -- attributed_revenue_usd
  case when v.is_verified then 'stripe' else null end,                    -- verification_source
  case when v.is_verified then v.created_at + interval '4 hours' else null end,  -- verified_at
  case when v.is_verified then 'DEMO_VERIFIER' else null end,
  'c0ffee00-0000-0000-0000-000000000001'::uuid,                          -- referred_by_rep_id = Kelly
  'DEMO_KELLY recovery event',
  v.created_at,
  v.created_at
from (
  values
    -- 4 in last hour (for fresh feel)
    (now() - interval '8 minutes',  true,  475.00),
    (now() - interval '23 minutes', true,  680.00),
    (now() - interval '41 minutes', true,  525.00),
    (now() - interval '54 minutes', false, 0),
    -- 4 in last day (today/yesterday)
    (now() - interval '4 hours',    true,  890.00),
    (now() - interval '7 hours',    true,  340.00),
    (now() - interval '11 hours',   false, 0),
    (now() - interval '19 hours',   true,  720.00),
    -- 6 in last 7 days
    (now() - interval '2 days',     true,  610.00),
    (now() - interval '3 days',     true,  425.00),
    (now() - interval '3 days 8 hours', true,  290.00),
    (now() - interval '4 days',     false, 0),
    (now() - interval '5 days',     true,  520.00),
    (now() - interval '6 days',     true,  775.00),
    -- 6 in last 30 days
    (now() - interval '9 days',     true,  390.00),
    (now() - interval '14 days',    true,  620.00),
    (now() - interval '18 days',    true,  450.00),
    (now() - interval '21 days',    false, 0),
    (now() - interval '25 days',    true,  580.00),
    (now() - interval '28 days',    true,  365.00)
) as v(created_at, is_verified, amount)
cross join lateral (
  -- Rotate through the 3 agent types deterministically based on created_at.
  select case extract(epoch from v.created_at)::bigint % 3
    when 0 then 'rescue'
    when 1 then 'post_recovery'
    else 'preshow'
  end as val
) agent;

-- ─── (6) wipe function — clean revert before Kelly's real signup ─────────

create or replace function public.wipe_kelly_demo_data()
returns table (deleted_table text, row_count bigint)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_events_deleted  bigint;
  v_ledger_deleted  bigint;
  v_affil_deleted   bigint;
  v_reps_deleted    bigint;
  v_idents_deleted  bigint;
  v_users_deleted   bigint;
begin
  with d as (
    delete from public.emma_recovery_events
    where notes like 'DEMO_KELLY%'
    returning 1
  )
  select count(*) into v_events_deleted from d;

  with d as (
    delete from public.rep_commission_ledger
    where notes like 'DEMO_KELLY%'
    returning 1
  )
  select count(*) into v_ledger_deleted from d;

  with d as (
    delete from public.rep_affiliations
    where rep_id in (
      select rep_user_id from public.rep_accounts where metadata->>'demo' = 'true'
    )
    or parent_rep_id in (
      select rep_user_id from public.rep_accounts where metadata->>'demo' = 'true'
    )
    returning 1
  )
  select count(*) into v_affil_deleted from d;

  with d as (
    delete from public.rep_accounts
    where metadata->>'demo' = 'true'
    returning 1
  )
  select count(*) into v_reps_deleted from d;

  with d as (
    delete from auth.identities
    where user_id in (select id from auth.users where email like '%@refill-demo.test')
    returning 1
  )
  select count(*) into v_idents_deleted from d;

  with d as (
    delete from auth.users
    where email like '%@refill-demo.test'
    returning 1
  )
  select count(*) into v_users_deleted from d;

  return query values
    ('emma_recovery_events',  v_events_deleted),
    ('rep_commission_ledger', v_ledger_deleted),
    ('rep_affiliations',      v_affil_deleted),
    ('rep_accounts',          v_reps_deleted),
    ('auth.identities',       v_idents_deleted),
    ('auth.users',            v_users_deleted);
end;
$fn$;

revoke all on function public.wipe_kelly_demo_data() from public;
grant execute on function public.wipe_kelly_demo_data() to service_role;

comment on function public.wipe_kelly_demo_data() is
  'One-shot revert of the Kelly Caffee demo seed (Phase 2G v399). Returns row counts deleted per table. Call from Supabase dashboard SQL editor with: select * from public.wipe_kelly_demo_data();';

-- ─── (7) PostgREST reload ────────────────────────────────────────────────
notify pgrst, 'reload schema';

-- ─── (8) Verify ──────────────────────────────────────────────────────────
-- These should each return non-zero counts after the migration runs cleanly.
-- If any return 0, that step didn't land — investigate before demoing.

select 'demo_users'              as label, count(*) from auth.users where email like '%@refill-demo.test';
select 'demo_reps'               as label, count(*) from public.rep_accounts where metadata->>'demo' = 'true';
select 'demo_affiliations'       as label, count(*) from public.rep_affiliations
  where rep_id in (select rep_user_id from public.rep_accounts where metadata->>'demo' = 'true');
select 'demo_ledger_rows'        as label, count(*) from public.rep_commission_ledger where notes like 'DEMO_KELLY%';
select 'demo_recovery_events'    as label, count(*) from public.emma_recovery_events where notes like 'DEMO_KELLY%';
select 'kelly_lifetime_revenue'  as label, sum(attributed_revenue_usd)::numeric(12,2) from public.emma_recovery_events where notes like 'DEMO_KELLY%';
