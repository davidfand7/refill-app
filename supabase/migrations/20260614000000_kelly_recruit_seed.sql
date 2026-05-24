-- ─────────────────────────────────────────────────────────────────────────
-- v408 — Kelly recruit-outreach demo seed
-- ─────────────────────────────────────────────────────────────────────────
--
-- WHY
--   v408 ships /app/lizzie/recruit (rep-to-rep recruiting outreach). For
--   the 5/29 Kelly Caffee demo the page can&apos;t feel empty — Kelly needs
--   a working channel with past sends and a non-zero downstream count
--   the moment she lands. This seed mirrors the v405.3 spa-outreach
--   history seed pattern, applied to the rep_recruit purpose.
--
-- WHAT
--   - 2 new demo auth.users + rep_accounts for the converted peer reps
--     (Randi Lopez, Marcus Stein). Both come in as Tier-1 sub-reps
--     under Kelly so her downstream count goes from 7 to 9 and her
--     [my downstream count] placeholder renders a real value on first
--     paint.
--   - 8 outreach_engagement_events with purpose='rep_recruit', staggered
--     across 30 days, mirroring the realistic funnel from the spa seed
--     (2 converted, 1 replied, 3 opened, 2 sent-only).
--   - Both converted rows stamp converted_rep_user_id pointing at the
--     new rep accounts so the recruit-attribution chain is whole end-to-end.
--   - All rows tagged 'DEMO_KELLY_RECRUIT' in source_context — matches
--     the existing 'DEMO_KELLY%' wipe filter so no wipe function update
--     is needed.
--
-- IDEMPOTENCY
--   Insert guarded by NOT EXISTS on the same source_context tag. Re-runs
--   are no-ops after the first apply.
--
-- TO RUN
--   Paste into Supabase SQL editor AFTER 20260613000000_outreach_rep_audience.sql.
--   Per [[feedback-migrations-via-dashboard]]. Order matters — the recruit
--   templates seeded in the prior migration must exist before this seed's
--   engagement_events rows can reference them by (icp, channel, audience).
-- ─────────────────────────────────────────────────────────────────────────

begin;

-- ── (1) auth.users for the 2 converted recruit recipients ────────────────
-- UUIDs continue the c0ffee00-…-00N sequence (existing demo uses 001-008).

insert into auth.users (
  id, instance_id, aud, role,
  email, encrypted_password, email_confirmed_at,
  raw_user_meta_data, raw_app_meta_data,
  created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change
) values
  ('c0ffee00-0000-0000-0000-000000000009'::uuid,
   '00000000-0000-0000-0000-000000000000'::uuid,
   'authenticated', 'authenticated',
   'randi@refill-demo.test', '', now(),
   jsonb_build_object('display_name','Randi Lopez','demo',true),
   jsonb_build_object('provider','email','providers',jsonb_build_array('email')),
   now() - interval '20 days', now(), '', '', '', ''),
  ('c0ffee00-0000-0000-0000-00000000000a'::uuid,
   '00000000-0000-0000-0000-000000000000'::uuid,
   'authenticated', 'authenticated',
   'marcus.stein@refill-demo.test', '', now(),
   jsonb_build_object('display_name','Marcus Stein','demo',true),
   jsonb_build_object('provider','email','providers',jsonb_build_array('email')),
   now() - interval '14 days', now(), '', '', '', '')
on conflict (id) do nothing;

-- auth.identities for the new users (email provider).

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
where u.email in ('randi@refill-demo.test', 'marcus.stein@refill-demo.test')
  and not exists (
    select 1 from auth.identities i where i.user_id = u.id and i.provider = 'email'
  );

-- ── (2) rep_accounts for the 2 new sub-reps ─────────────────────────────

insert into public.rep_accounts (
  rep_user_id, display_name, business_name, status, origin_type,
  territory, joined_at, payout_method, metadata
) values
  ('c0ffee00-0000-0000-0000-000000000009'::uuid,
   'Randi Lopez', 'Lopez Aesthetic Reps', 'active', 'indy_rep',
   jsonb_build_object('states', jsonb_build_array('CO','NM')),
   now() - interval '20 days', 'stripe',
   jsonb_build_object('demo', true, 'recruited_by', 'Kelly Caffee')),
  ('c0ffee00-0000-0000-0000-00000000000a'::uuid,
   'Marcus Stein', 'Stein Med-Aesthetic Partners', 'active', 'indy_rep',
   jsonb_build_object('states', jsonb_build_array('CO','WY')),
   now() - interval '14 days', 'stripe',
   jsonb_build_object('demo', true, 'recruited_by', 'Kelly Caffee'))
on conflict (rep_user_id) do nothing;

-- ── (3) rep_affiliations: both as Tier-1 sub-reps under Kelly ───────────

insert into public.rep_affiliations (
  rep_id, parent_rep_id, tier_level, commission_split, active
) values
  ('c0ffee00-0000-0000-0000-000000000009'::uuid,
   'c0ffee00-0000-0000-0000-000000000001'::uuid, 1, 0.0300, true),
  ('c0ffee00-0000-0000-0000-00000000000a'::uuid,
   'c0ffee00-0000-0000-0000-000000000001'::uuid, 1, 0.0300, true)
on conflict (rep_id, parent_rep_id, tier_level) do nothing;

-- ── (4) Seed 8 rep_recruit engagement events for Kelly ──────────────────
-- Mirrors the v405.3 spa-outreach seed shape. ICP semantics differ slightly:
--   icp=1 = warm peer (Kelly knows them personally)
--   icp=2 = cold peer (adjacent vertical, no prior relationship)
--
-- Two converted rows stamp converted_rep_user_id pointing at the new
-- rep_accounts inserted above. The lookup-by-template ensures historical
-- template_id linkage even though we don&apos;t hardcode template UUIDs.

with template_lookup as (
  select id, icp, channel from public.outreach_templates
   where audience = 'rep' and is_active = true
),
seed_rows as (
  select * from (values
    -- (first_name, email, icp, channel, subject, ago, state, converted_rep)
    ('Randi',     'randi.lopez@axis-aesthetic-network.test', 1, 'email_a',
        'Made $[my month earnings] last month on a side rep gig — want in?',
        interval '23 days', 'converted',
        'c0ffee00-0000-0000-0000-000000000009'::uuid),
    ('Marcus',    'marcus@stein-medaesthetic.test',          2, 'email_a',
        'A rep gig you could moonlight without quitting your day job',
        interval '17 days', 'converted',
        'c0ffee00-0000-0000-0000-00000000000a'::uuid),
    ('Jordan',    'jordan@parkrep.test',                     1, 'email_a',
        'Made $[my month earnings] last month on a side rep gig — want in?',
        interval '14 days', 'replied',
        null::uuid),
    ('Aisha',     'aisha@webbpartners.test',                 1, 'email_no_numbers',
        'Picking up a side rep gig — thought of you',
        interval '9 days', 'opened',
        null::uuid),
    ('Devon',     'devon@mills-channel.test',                2, 'email_a',
        'A rep gig you could moonlight without quitting your day job',
        interval '5 days', 'opened',
        null::uuid),
    ('Tasha',     'tasha@reyesgroup-aesthetic.test',         1, 'email_a',
        'Made $[my month earnings] last month on a side rep gig — want in?',
        interval '20 hours', 'opened',
        null::uuid),
    ('Eddie',     'eddie@vu-medsales.test',                  1, 'loom_script',
        null,
        interval '7 hours', 'sent',
        null::uuid),
    ('Priscilla', 'priscilla@yangrep.test',                  2, 'email_a',
        'A rep gig you could moonlight without quitting your day job',
        interval '42 minutes', 'sent',
        null::uuid)
  ) as r(first_name, email, icp, channel, subject, ago, state, converted_rep_user_id)
)
insert into public.outreach_engagement_events
       (recipient_email, recipient_first_name, template_id, icp, channel,
        send_mode, rendered_subject, rendered_body,
        sent_by, sent_at, opened_at, response_received_at, converted_at,
        converted_rep_user_id, source_context, purpose)
select s.email, s.first_name,
       (select id from template_lookup t where t.icp = s.icp and t.channel = s.channel limit 1),
       s.icp, s.channel,
       'dry_run',
       s.subject,
       '(demo seed — body omitted)',
       'c0ffee00-0000-0000-0000-000000000001'::uuid,
       now() - s.ago,
       case when s.state in ('opened','replied','converted') then now() - s.ago + interval '2 hours' end,
       case when s.state in ('replied','converted')          then now() - s.ago + interval '1 day' end,
       case when s.state = 'converted'                       then now() - s.ago + interval '3 days' end,
       s.converted_rep_user_id,
       'DEMO_KELLY_RECRUIT rep:Kelly Caffee',
       'rep_recruit'
  from seed_rows s
 where not exists (
   select 1 from public.outreach_engagement_events
    where sent_by = 'c0ffee00-0000-0000-0000-000000000001'::uuid
      and source_context = 'DEMO_KELLY_RECRUIT rep:Kelly Caffee'
 );

commit;

notify pgrst, 'reload schema';

-- ── Verify (paste-friendly) ──────────────────────────────────────────────
-- Should return 8 recruit events for Kelly after first apply:
--
-- select count(*) from public.outreach_engagement_events
--  where sent_by = 'c0ffee00-0000-0000-0000-000000000001'::uuid
--    and purpose = 'rep_recruit';
--
-- Confirm both converted rows stamped converted_rep_user_id:
--
-- select recipient_first_name, converted_rep_user_id
--   from public.outreach_engagement_events
--  where source_context = 'DEMO_KELLY_RECRUIT rep:Kelly Caffee'
--    and converted_at is not null;
--
-- Confirm Kelly's downstream count is 7 (5 original + 2 new Tier-1):
--
-- select count(*) from public.rep_affiliations
--  where parent_rep_id = 'c0ffee00-0000-0000-0000-000000000001'::uuid
--    and active = true and tier_level = 1;
