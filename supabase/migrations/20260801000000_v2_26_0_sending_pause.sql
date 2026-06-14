-- v2.26.0 — the honest-pause kill switch (Tier-2 Autonomous · Slice 3).
--
-- One per-tenant master switch that halts ALL automated sending — the panic
-- brake that has to exist before an agent ever sends on its own. When
-- sending_paused is true, every agent that dispatches on the spa's behalf
-- (rescue auto-text, pre-show reminder cron, weekly recall digest) polls this
-- flag at its dispatch entry and bails before any message goes out — regardless
-- of its own per-engine enable. It's the one switch above all the others.
--
-- Lives on emma_noshow_policies because that's already the spa's agent-config
-- row that every one of those agents loads anyway (preshow_enabled /
-- rescue_enabled / recall_digest_enabled all live here) — so for rescue +
-- preshow the guard reads a column they're already holding, no extra query.
--
-- sending_paused_at / sending_paused_by record the audit context (when, and
-- which user flipped it); the flip itself also writes an agent_actions row.

alter table public.emma_noshow_policies
  add column if not exists sending_paused boolean not null default false,
  add column if not exists sending_paused_at timestamptz,
  add column if not exists sending_paused_by uuid;

notify pgrst, 'reload schema';

-- Verify: column exists, defaults false (nobody is paused on rollout).
select count(*) filter (where sending_paused) as paused_tenants,
       count(*) as total_tenants
from public.emma_noshow_policies;
