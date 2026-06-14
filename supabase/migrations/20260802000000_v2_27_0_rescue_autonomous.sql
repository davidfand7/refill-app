-- v2.27.0 — Autonomous Rescue: the earned autonomy flag (Tier-2 Autonomous · Slice 4).
--
-- The funnel's 4th and final materializer ('autonomous') goes live here. One
-- flag on the policy row that flips rescue from DRAFT mode → SEND-WHEN-CONFIDENT:
--   • false (default)  → every confident match is HELD for the owner's one-tap
--                        OK (the review queue = the training ground). Uncertain
--                        ("blind") matches were already held.
--   • true  (earned)   → confident matches auto-send the instant a slot frees;
--                        blind ones still wait. The agent acts on its own.
--
-- The owner EARNS the true state: after approving N held offers (logged in
-- agent_actions as rescue·held_offer_approved), she's shown she trusts the
-- agent's judgment → she can adopt the "Autonomous Rescue" Skill, which sets
-- this flag. Scariest version (blind autonomy) impossible by construction.
--
-- GRANDFATHER: spas already running rescue were ALREADY auto-sending confident
-- matches (the old implicit direct-mode behavior). Default-false would silently
-- switch them to hold-mode, so backfill them to true — no behavior change for
-- anyone live today; only brand-new spas start in the earn-it-first model.

alter table public.emma_noshow_policies
  add column if not exists rescue_autonomous_enabled boolean not null default false;

update public.emma_noshow_policies
  set rescue_autonomous_enabled = true
  where rescue_enabled = true;

notify pgrst, 'reload schema';

-- Verify: how many spas are now autonomous (= those already running rescue).
select count(*) filter (where rescue_autonomous_enabled) as autonomous_spas,
       count(*) filter (where rescue_enabled)            as rescue_spas,
       count(*)                                          as total_spas
from public.emma_noshow_policies;
