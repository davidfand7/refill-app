-- ─────────────────────────────────────────────────────────────────────────
-- v405.3 — Kelly demo outreach history seed (Pinch #13)
-- ─────────────────────────────────────────────────────────────────────────
--
-- WHY
--   The new "Your recent sends" panel at the bottom of /app/lizzie/outreach
--   shows the rep's outreach_engagement_events filtered by sent_by=me.
--   Kelly's seed has no engagement events &mdash; the panel would render empty
--   in the 5/29 demo, undermining the methodology (the page should look
--   like a working channel, not a fresh install).
--
-- WHAT
--   8 seeded outreach send rows tied to Kelly (sent_by=c0ffee00-...-001):
--     - Mixed across ICP-2 email_a + email_b (the templates Kelly demos)
--     - All send_mode='dry_run' (matches OUTREACH_LIVE=false production)
--     - Staggered sent_at: 3 in last 24h (fresh feel), 2 in last week,
--       3 in last 30 days (older history)
--     - Conversion progression: 2 converted (signed up as sub-reps/spas),
--       3 opened, 1 replied, 2 sent-only — mirrors realistic funnel
--     - Recipient names mapped to the Tier-1 sub-reps Kelly already has
--       seeded (Maria/Tony/Sarah/Jasmine/Marcus) PLUS 3 fictional
--       prospects who haven't converted yet
--   All rows tagged 'DEMO_KELLY' in source_context so wipe can match.
--
-- WIPE FUNCTION
--   Updated to also drop outreach_engagement_events where source_context
--   like 'DEMO_KELLY%'. Previously the wipe function only matched
--   rep_commission_ledger + emma_recovery_events on notes; engagement
--   events use source_context as their tag column instead.
--
-- IDEMPOTENCY
--   Insert is gated by a SELECT-then-INSERT check on source_context. Re-
--   running the migration after first apply is a no-op (zero rows match
--   the WHERE NOT EXISTS clause).
--
-- TO RUN
--   Paste into Supabase SQL editor. Per [[feedback-migrations-via-dashboard]].
-- ─────────────────────────────────────────────────────────────────────────

begin;

-- ── Seed 8 engagement events for Kelly ───────────────────────────────────
-- Use a CTE pattern so the conversion-state columns can be set inline per
-- row. Each row's sent_at is computed from now() + an interval so the
-- demo always shows "today" / "3d ago" / "21d ago" no matter when the
-- migration is applied.

with seed_rows as (
  select * from (values
    -- (recipient_first_name, recipient_email, icp, channel, subject, ago,  state)
    -- "state" drives which engagement columns get populated:
    --   sent  | opened | replied | converted
    --   -----+--------+---------+----------
    ('Maria',    'maria@boutique-aesthetic-advisors.test',  2, 'email_b',
        'An RN-owner I know built something for the cancellation problem',
        interval '23 days', 'converted'),
    ('Tony',     'tony@reyes-medspa-consulting.test',       2, 'email_b',
        'An RN-owner I know built something for the cancellation problem',
        interval '17 days', 'converted'),
    ('Sarah',    'sarah@kim-aesthetics-group.test',         2, 'email_a',
        'Free unless it recovers money for you',
        interval '14 days', 'replied'),
    ('Jasmine',  'jasmine@patel-beauty-partners.test',      2, 'email_a',
        'Free unless it recovers money for you',
        interval '9 days',  'opened'),
    ('Marcus',   'marcus@williams-medaesthetic.test',       2, 'email_b',
        'An RN-owner I know built something for the cancellation problem',
        interval '5 days',  'opened'),
    ('Diane',    'diane@northstarderm.test',                2, 'email_a',
        'Free unless it recovers money for you',
        interval '20 hours','opened'),
    ('Chen',     'chen.lin@bluespringaesthetics.test',      2, 'email_b',
        'An RN-owner I know built something for the cancellation problem',
        interval '7 hours', 'sent'),
    ('Priya',    'priya@cedarvalleyrn.test',                2, 'email_a',
        'Free unless it recovers money for you',
        interval '42 minutes', 'sent')
  ) as r(first_name, email, icp, channel, subject, ago, state)
)
insert into public.outreach_engagement_events
       (recipient_email, recipient_first_name, icp, channel,
        send_mode, rendered_subject, rendered_body,
        sent_by, sent_at, opened_at, response_received_at, converted_at,
        source_context)
select s.email, s.first_name, s.icp, s.channel,
       'dry_run',
       s.subject,
       -- Body placeholder — the demo panel doesn't render this, but the
       -- column is NOT NULL. Real production sends carry the rendered HTML.
       '(demo seed — body omitted)',
       'c0ffee00-0000-0000-0000-000000000001'::uuid,
       now() - s.ago,
       case when s.state in ('opened','replied','converted') then now() - s.ago + interval '2 hours' end,
       case when s.state in ('replied','converted')          then now() - s.ago + interval '1 day' end,
       case when s.state = 'converted'                       then now() - s.ago + interval '3 days' end,
       'DEMO_KELLY rep:Kelly Caffee'
  from seed_rows s
 where not exists (
   select 1 from public.outreach_engagement_events
    where sent_by = 'c0ffee00-0000-0000-0000-000000000001'::uuid
      and source_context like 'DEMO_KELLY%'
 );

-- ── Update wipe function to also clean engagement events ────────────────
-- The existing wipe_kelly_demo_data() drops ledger + recovery events but
-- doesn't know about outreach_engagement_events. Extend it.

create or replace function public.wipe_kelly_demo_data()
returns table (deleted_table text, row_count bigint)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_events_deleted     bigint;
  v_ledger_deleted     bigint;
  v_outreach_deleted   bigint;
  v_referrals_deleted  bigint;
  v_affil_deleted      bigint;
  v_reps_deleted       bigint;
  v_idents_deleted     bigint;
  v_users_deleted      bigint;
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
    delete from public.outreach_engagement_events
    where source_context like 'DEMO_KELLY%'
    returning 1
  )
  select count(*) into v_outreach_deleted from d;

  with d as (
    delete from public.rep_referral_links
    where rep_user_id in (
      select rep_user_id from public.rep_accounts where metadata->>'demo' = 'true'
    )
    returning 1
  )
  select count(*) into v_referrals_deleted from d;

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
    ('emma_recovery_events',        v_events_deleted),
    ('rep_commission_ledger',       v_ledger_deleted),
    ('outreach_engagement_events',  v_outreach_deleted),
    ('rep_referral_links',          v_referrals_deleted),
    ('rep_affiliations',            v_affil_deleted),
    ('rep_accounts',                v_reps_deleted),
    ('auth.identities',             v_idents_deleted),
    ('auth.users',                  v_users_deleted);
end;
$fn$;

commit;

notify pgrst, 'reload schema';

-- ── Verify (paste-friendly) ──────────────────────────────────────────────
-- Should return 8 rows after first apply, idempotent after that:
--
-- select count(*) from public.outreach_engagement_events
--  where sent_by = 'c0ffee00-0000-0000-0000-000000000001'::uuid
--    and source_context like 'DEMO_KELLY%';
--
-- Confirm wipe function recognizes the new tables:
--
-- select prosrc from pg_proc where proname = 'wipe_kelly_demo_data';
