-- v2.22.0 — Recall Digest gate: the honest "Auto-Recall" Skill.
--
-- Recall shipped as a MANUAL surface (listRecallTargets + draft + book). To make
-- "Auto-Recall" an honest adoptable Skill, it needs a real enable-gate + a real
-- scheduled job — not a toggle that does nothing. This migration adds the gate;
-- the companion *_cron.sql registers the weekly job that reads it.
--
-- The flag lives on emma_noshow_policies — the de-facto per-spa agent-settings
-- row that already carries preshow_enabled / rescue_enabled / rescue_proxy_email.
-- The Skill's adopt/On flips recall_digest_enabled true (skills.functions.ts
-- POLICY_GATE); pause flips it off. recall_digest_last_sent_at is the cron's
-- 6-day dedup guard, stamped after each successful send.
--
-- The digest emails the OWNER a heads-up only — it never messages a patient.
-- Autonomous patient outreach is the Tier-2 line and is deliberately not here.

alter table public.emma_noshow_policies
  add column if not exists recall_digest_enabled boolean not null default false;

alter table public.emma_noshow_policies
  add column if not exists recall_digest_last_sent_at timestamptz;

notify pgrst, 'reload schema';

-- Verify: both columns exist, default off.
select
  count(*)                                              as policy_rows,
  count(*) filter (where recall_digest_enabled)         as digest_on
from public.emma_noshow_policies;
