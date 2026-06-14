-- v2.23.0 — Add the 'surface' materializer to the Skill funnel.
--
-- The MATERIALIZER axis (project_skill_funnel) was flip | routine | autonomous.
-- Reward-Expiry Sweep adds a 4th kind: 'surface' — adopting the Skill turns on
-- an in-app, glanceable indicator (an expiry badge on the Recall tab) rather
-- than a flag, a routine, or an authored agent. On/Pause shows/hides it.
--
-- This is exactly the funnel's "a new materializer = a row value + a plug-in
-- fn" design — no rebuild, just widen the check constraint. The constraint was
-- created inline + unnamed in v2_19_0_skill_funnel, so Postgres auto-named it
-- skills_materializer_check; drop + re-add with the wider set.

alter table public.skills drop constraint if exists skills_materializer_check;
alter table public.skills add constraint skills_materializer_check
  check (materializer in ('flip', 'routine', 'autonomous', 'surface'));

notify pgrst, 'reload schema';

-- Verify: constraint accepts the new value.
select conname, pg_get_constraintdef(oid) as def
from pg_constraint
where conrelid = 'public.skills'::regclass
  and conname = 'skills_materializer_check';
