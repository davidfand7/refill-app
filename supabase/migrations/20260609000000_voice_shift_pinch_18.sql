-- ─────────────────────────────────────────────────────────────────────────
-- v403 — Pinch #18 voice-shift: rep-as-messenger for ICP-2 email_a + email_b
-- ─────────────────────────────────────────────────────────────────────────
--
-- WHY
--   The 2026-05-22 Kelly Caffee dry-run surfaced a dissonance in the
--   outreach send path: when a REP (Kelly) sends an ICP-2 template, the
--   From: line correctly shows "Kelly Caffee" — but the BODY is voiced
--   first-person Karen ("I'm Karen, RN-owner..."). Recipient reads From=
--   Kelly, Body=Karen — confusing at best, dishonest at worst.
--
-- WHAT THIS MIGRATION DOES
--   Inserts new versioned rows for (icp=2, channel='email_a') and
--   (icp=2, channel='email_b') with voice-shifted bodies that:
--     - Open in the sender's voice ([from first name] here — ...)
--     - Recast Karen as the friend/credibility-source (third-person)
--     - End with the sender's first-name signature
--   Existing active rows are flagged is_active=false in the same txn so
--   the partial unique index (one active per slot) never has a window of
--   violation.
--
-- SCOPE
--   ICP-2 only (cold tier-2 independents — Kelly's volume case for 5/29).
--   ICP-1 (Karen's own warm network) and ICP-3 (Acuity warm-tech) are
--   intentionally NOT touched: ICP-1 is meant for Karen sending to her
--   own friends and reads correctly in first-person. ICP-3 voice-shift
--   is deferred until v403.x because that path is lower-volume and the
--   demo arc doesn't hit it.
--
-- PLACEHOLDER CONTRACT
--   New tokens [from] and [from first name] resolve via PlaceholderContext
--   in src/server/refill-outreach-send.ts (v403). Admin sends without a
--   rep principal default senderName='Karen Anderson' / senderFirstName=
--   'Karen' so legacy templates that DON'T use [from] are unaffected.
--
-- TO RUN
--   Paste into Supabase SQL editor on the production project.
--   Per [[feedback-migrations-via-dashboard]] — never `db push --linked`.
-- ─────────────────────────────────────────────────────────────────────────

begin;

-- ── ICP-2 email_a (Variant A — killshot subject lead) ────────────────────

update public.outreach_templates
   set is_active = false,
       updated_at = now()
 where icp = 2
   and channel = 'email_a'
   and is_active = true;

insert into public.outreach_templates
       (icp, channel, subject, body, version, is_active, notes)
values (2, 'email_a',
        'Free unless it recovers money for you',
        $body$<p>Hi [first name],</p>
<p>[from first name] here — a friend of mine, Karen Anderson, is an RN-owner of a med-spa in Minnesota. She got so burned out on Tuesday-night cancellation chasing that she built a tool to handle it. I think you'll want to see it.</p>
<p>It's called Refill (<a href="https://getrefill.app">getrefill.app</a>). It watches the booking system, drafts the recovery message the second a cancellation hits, the spa just hits send.</p>
<p>Pricing is structured the way Karen wanted it as an operator: free unless it recovers money for you, then 12% of what it recovers. No monthly, no contract.</p>
<p>If you want a 2-minute Loom of it running on Karen's spa, reply "Loom" and I'll send it over. If not, no worries — you won't hear from me again.</p>
<p>— [from first name]</p>$body$,
        (select coalesce(max(version), 0) + 1
           from public.outreach_templates
          where icp = 2 and channel = 'email_a'),
        true,
        'v403 Pinch #18 — rep-as-messenger voice (third-person Karen, [from first name] signature). Replaces first-person Karen voice that read dishonest when a non-Karen rep dispatched the send.');

-- ── ICP-2 email_b (Variant B — peer-credibility lead) ────────────────────

update public.outreach_templates
   set is_active = false,
       updated_at = now()
 where icp = 2
   and channel = 'email_b'
   and is_active = true;

insert into public.outreach_templates
       (icp, channel, subject, body, version, is_active, notes)
values (2, 'email_b',
        'An RN-owner I know built something for the cancellation problem',
        $body$<p>Hi [first name],</p>
<p>[from first name] here — wanted to put something in front of you that I think you'll want to see. A friend of mine, Karen Anderson, is an RN-owner of a med-spa in Minnesota (Rejuv). Last fall she got so burned out on Tuesday-evening cancellation chasing — the texts at 9 PM, the rebooking spreadsheet, the "did anyone want the slot?" group messages — that she built a tool for her own spa to handle it. It plugs into the booking system, drafts the recovery message to the right patient, the spa just hits send.</p>
<p>It's been running on Rejuv for [N] weeks. They've recovered $[exact figure] doing nothing different.</p>
<p>She's calling it Refill (<a href="https://getrefill.app">getrefill.app</a>), and she's opening it up to a small number of other independent spas. Pricing is structured the way Karen would want it as an operator: <strong>free unless it recovers money for you, then 12% of what it recovers. No monthly fee, no contract, no setup fee.</strong></p>
<p>If you want a 2-minute Loom of how it works on Karen's spa, reply "Loom." If you want to talk it through, reply "call." If you're not interested, ignore this and we're done — I won't bug you.</p>
<p>— [from first name]</p>$body$,
        (select coalesce(max(version), 0) + 1
           from public.outreach_templates
          where icp = 2 and channel = 'email_b'),
        true,
        'v403 Pinch #18 — rep-as-messenger voice. Subject re-anchored from "RN-owner to RN-owner" (only true for Karen) to "An RN-owner I know" (true for any rep introducing Karen).');

commit;

-- ── PostgREST schema reload (defensive — no schema change but harmless) ──

notify pgrst, 'reload schema';

-- ── Verify (paste-friendly) ──────────────────────────────────────────────
-- Run after the migration to confirm exactly one active version per slot
-- and the new bodies reference the [from first name] placeholder:
--
-- select icp, channel, version, is_active,
--        substring(body for 80) as body_preview
--   from public.outreach_templates
--  where icp = 2 and channel in ('email_a','email_b')
--  order by channel, version desc;
--
-- -- Body must contain [from first name] in the opener AND signature.
-- select icp, channel,
--        position('[from first name]' in body) as opener_position
--   from public.outreach_templates
--  where icp = 2 and channel in ('email_a','email_b') and is_active = true;
