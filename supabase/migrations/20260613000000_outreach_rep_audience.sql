-- ─────────────────────────────────────────────────────────────────────────
-- v408 — Outreach audience split + recruit templates substrate
-- ─────────────────────────────────────────────────────────────────────────
--
-- WHY
--   Today /app/lizzie/outreach is rep→spa outreach (Kelly emails med-spas
--   she wants to recruit as Refill tenants). The platform's COMPOUNDING
--   growth mechanic is rep→REP outreach (Kelly recruits OTHER REPS into
--   her downstream, then earns 1% cascade on every spa THEY introduce,
--   forever). v408 adds the substrate.
--
-- DESIGN
--   - outreach_templates gets an `audience` column ('spa' | 'rep'). The
--     send-pipeline filter switches by audience so the existing spa
--     library stays untouched while a parallel rep library accumulates.
--   - outreach_engagement_events gets a `purpose` column ('spa_outreach'
--     | 'rep_recruit') so the analytics, past-sends panel, and conversion
--     stamping can branch on intent. Existing rows default to 'spa_outreach'.
--   - outreach_engagement_events also gets `converted_rep_user_id` (sibling
--     of the existing `converted_tenant_id`): when a recruit recipient
--     signs up as a sub-rep we stamp the new rep_accounts.rep_user_id here.
--     For spa conversions, converted_tenant_id stays the conversion column.
--   - The existing partial unique index on (icp, channel) WHERE is_active
--     is rebuilt as (icp, channel, audience) WHERE is_active. This lets
--     spa and rep audiences share an (icp, channel) slot without colliding.
--
-- RECRUIT TEMPLATES SEEDED HERE
--   ICP-1 email_a (rep)            — warm peer, references [my month earnings]
--   ICP-1 email_no_numbers (rep)   — green-rep starter (no earnings refs)
--   ICP-1 loom_script (rep)        — talking-head script
--   ICP-2 email_a (rep)            — cold peer in adjacent vertical
--
-- PLACEHOLDER CONTRACT
--   New tokens [my commission rate] / [my month earnings] / [my downstream
--   count] resolve via PlaceholderContext in src/server/refill-outreach-send.ts
--   (v408). Values are pulled live from getMyLiveEarnings + getMyNetwork at
--   send time. Per [[feedback-math-must-be-exact]] — if a value is unknown
--   or zero, the literal placeholder stays in the body so it's visible the
--   number is missing rather than silently rendering "$0".
--
-- TO RUN
--   Paste into Supabase SQL editor on production. Per [[feedback-migrations-via-dashboard]].
-- ─────────────────────────────────────────────────────────────────────────

begin;

-- ── 1) audience column on outreach_templates ─────────────────────────────

alter table public.outreach_templates
  add column if not exists audience text not null default 'spa'
    check (audience in ('spa', 'rep'));

-- Rebuild the partial unique index to include audience so (icp, channel)
-- can be shared across spa + rep audiences without collision.
drop index if exists public.outreach_templates_active_unique;
create unique index outreach_templates_active_unique
  on public.outreach_templates (icp, channel, audience)
  where is_active;

comment on column public.outreach_templates.audience is
  'spa = rep-to-spa outreach (default; original library). rep = rep-to-rep recruit outreach (v408+). Send pipeline filters by audience to keep the two libraries semantically separate while sharing the substrate.';

-- ── 2) purpose + converted_rep_user_id on outreach_engagement_events ────

alter table public.outreach_engagement_events
  add column if not exists purpose text not null default 'spa_outreach'
    check (purpose in ('spa_outreach', 'rep_recruit'));

alter table public.outreach_engagement_events
  add column if not exists converted_rep_user_id uuid
    references public.rep_accounts(rep_user_id) on delete set null;

-- Per-(purpose, sent_at) sort hot path for the past-sends panel filtering.
create index if not exists outreach_eng_purpose_sent_idx
  on public.outreach_engagement_events (purpose, sent_at desc);

create index if not exists outreach_eng_converted_rep_idx
  on public.outreach_engagement_events (converted_rep_user_id)
  where converted_rep_user_id is not null;

comment on column public.outreach_engagement_events.purpose is
  'spa_outreach = rep emails a med-spa (existing flow). rep_recruit = rep emails another rep (v408+). Separates conversion semantics and lets the past-sends panel + analytics filter cleanly.';

comment on column public.outreach_engagement_events.converted_rep_user_id is
  'Set when this engagement event converted a recipient into a sub-rep under the sender. Sibling of converted_tenant_id (which stamps when the recipient converts into a tenant). Stamped by ensureMyRepAccount when it consumes the refill_recruit_event cookie.';

-- ── 3) Seed 4 recruit templates (audience='rep') ─────────────────────────
-- ICP semantics for the rep audience:
--   ICP-1 = warm peer (you've met them, you know their name)
--   ICP-2 = cold peer (adjacent vertical, never met)
--   ICP-3 = (reserved; not used in v408)

insert into public.outreach_templates
       (icp, channel, audience, subject, body, version, is_active, notes)
values
  (1, 'email_a', 'rep',
   'Made $[my month earnings] last month on a side rep gig — want in?',
   $body$<p>Hey [first name] — [from first name].</p>
<p>I&apos;ve been quietly building out a side rep book on a med-spa product called Refill the last few months. It&apos;s automated no-show recovery for med-spas — they pay nothing unless it recovers real revenue for them, then 12% of what it recovers. The product sells itself once the spa sees the recovery in their first week.</p>
<p>My take is [my commission rate] of every recovered dollar on spas I introduce. Lifetime. No decay. Last month I cleared $[my month earnings] doing roughly an hour a week. I have [my downstream count] reps in my downstream now and they each clip 1% cascade for me on what THEIR spas recover.</p>
<p>I&apos;m looking for 2-3 more reps in your network. You&apos;d come in directly under me at the same 3% direct rate. Want me to send you the 90-second walkthrough?</p>
<p>— [from first name]</p>$body$,
   1, true,
   'v408 ICP-1 warm peer recruit — voiced from rep, leans on [my month earnings] + [my downstream count] for credibility. Green reps with $0 earnings should use email_no_numbers instead.'),

  (1, 'email_no_numbers', 'rep',
   'Picking up a side rep gig — thought of you',
   $body$<p>Hey [first name] — [from first name].</p>
<p>Just picked up a side rep book on a med-spa product called Refill. Automated no-show recovery — the spa pays nothing unless it recovers real revenue, then 12% of what it recovers. Pricing structure means the spa says yes pretty easily.</p>
<p>Rep economics are unusually clean: [my commission rate] of every recovered dollar on spas I introduce, lifetime, no decay. Plus 1% cascade on every spa my downstream reps introduce. Math compounds fast if you have any med-spa relationships.</p>
<p>You came to mind because of your network. Want me to send you the 90-second walkthrough so you can see if it fits?</p>
<p>— [from first name]</p>$body$,
   1, true,
   'v408 ICP-1 warm peer recruit — green-rep version. No references to my earnings or downstream count. Use this until I have real numbers to share (per [[feedback-math-must-be-exact]] — better to ship without numbers than ship with $0).'),

  (1, 'loom_script', 'rep',
   null,
   $body$<p>(00:00) Hey [first name], [from first name] here. Quick 90 seconds.</p>
<p>(00:05) I&apos;ve been quietly building a side rep book on a product called Refill. It&apos;s automated no-show recovery for med-spas. The spa pays nothing unless it recovers real money for them, then 12% of what it recovered. No monthly, no contract, no setup fee.</p>
<p>(00:25) Why I&apos;m calling you specifically: I&apos;m looking for 2-3 reps to come in under me. You&apos;d be at the same 3% direct rate I&apos;m at — no haircut for coming through me. I take a 1% cascade on what your spas recover, which doesn&apos;t come out of your pocket; it comes out of the 8% Refill keeps.</p>
<p>(00:50) Rep math: 3% direct, lifetime, no decay. I&apos;m at $[my month earnings] last month with [my downstream count] reps in my downstream. The compounding is real.</p>
<p>(01:10) If you want to dig in, reply to the email I just sent and I&apos;ll send the rep onboarding link. Takes about three minutes to set up. Talk soon.</p>$body$,
   1, true,
   'v408 ICP-1 loom_script for rep audience. Voiced from sender, references same live placeholders as email_a.'),

  (2, 'email_a', 'rep',
   'A rep gig you could moonlight without quitting your day job',
   $body$<p>Hi [first name],</p>
<p>You don&apos;t know me — [from first name]. I rep a product called Refill (med-spa no-show recovery) on the side. Pinging you because the rep math is unusually clean and I think it&apos;d fit alongside what you already do.</p>
<p>Refill charges spas nothing unless it recovers revenue for them, then 12% of what it recovers. No monthly fee, no contract — which makes the pitch unusually easy. Spa says yes the moment they see their first recovery.</p>
<p>Rep take is [my commission rate] direct, lifetime, on every recovered dollar on spas you introduce. Plus 1% cascade on spas YOUR sub-reps introduce. No quota, no exclusivity, no W-2 — pure 1099 referral, paid through Stripe Connect.</p>
<p>Reply &quot;walkthrough&quot; if you want the 90-second Loom. Reply &quot;not for me&quot; and I won&apos;t bug you again.</p>
<p>— [from first name]</p>$body$,
   1, true,
   'v408 ICP-2 cold peer recruit — assumes no prior relationship. Leads with the structural pitch (free + 12% of recovered revenue), surfaces [my commission rate] but not [my month earnings] (cold pitch shouldn&apos;t lean on personal credibility).')
on conflict do nothing;

commit;

-- ── PostgREST schema reload ─────────────────────────────────────────────
notify pgrst, 'reload schema';

-- ── Verify (paste-friendly) ──────────────────────────────────────────────
-- Should return 4 rep-audience templates after first apply:
--
-- select icp, channel, audience, version,
--        coalesce(subject, '(no subject — loom)') as subject_preview
--   from public.outreach_templates
--  where audience = 'rep' and is_active = true
--  order by icp, channel;
--
-- Confirm engagement events backfilled with default purpose:
--
-- select purpose, count(*) from public.outreach_engagement_events
--  group by purpose;
--
-- Confirm new columns + index landed:
--
-- select column_name from information_schema.columns
--  where table_schema = 'public' and table_name = 'outreach_engagement_events'
--    and column_name in ('purpose', 'converted_rep_user_id');
--
-- select indexname from pg_indexes
--  where schemaname = 'public'
--    and indexname in ('outreach_templates_active_unique',
--                      'outreach_eng_purpose_sent_idx',
--                      'outreach_eng_converted_rep_idx');
