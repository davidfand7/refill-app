-- v2.24.0 — agent_actions: the immutable action ledger (Tier-2 Autonomous · Slice 1).
--
-- The dispute-proof spine under autonomy: one APPEND-ONLY row per action an
-- agent takes on the spa's behalf — what, for whom, on which channel, at what
-- confidence, and whether the AGENT initiated it autonomously or the owner did.
-- "The agent sent X to Y at Z" becomes a fact, not a guess.
--
-- Contrast with messaging_activity (v2.11.0): that is a MUTABLE per-channel
-- heartbeat for the delivery health card. This is the opposite — one immutable
-- row PER action, never updated. Code never writes an UPDATE/DELETE path against
-- it (append-only by construction). Service-role writes; users read their own.
--
-- Slice 1 wires two producers: the recall-digest cron (autonomous owner-facing
-- send — re-fireable, so it's the verification path) and the rescue direct-mode
-- SMS (the real autonomous patient send). Later slices read this for the
-- frequency-cap/dedup gate and surface it in an activity view.

create table if not exists public.agent_actions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  agent           text not null,              -- 'rescue' | 'recall_digest' | …
  action          text not null,              -- 'sms_sent' | 'digest_emailed' | …
  channel         text,                       -- 'sms' | 'email' | 'imessage' | null
  patient_node_id uuid,                        -- patient-directed actions; null for owner-facing
  count           integer not null default 1,
  confidence_tier text,                       -- 'explicit'|'open'|'blind'|'high'|'learned'|null
  initiated_by    text not null default 'autonomous'
                    check (initiated_by in ('autonomous', 'owner')),
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

-- Fast per-tenant reads (activity view) + the frequency-cap gate's window scan.
create index if not exists agent_actions_user_created
  on public.agent_actions (user_id, created_at desc);
-- Per-patient lookback for the cross-agent dedup gate (Slice 2).
create index if not exists agent_actions_patient
  on public.agent_actions (user_id, patient_node_id, created_at desc)
  where patient_node_id is not null;

alter table public.agent_actions enable row level security;

do $$ begin
  create policy "service_role_agent_actions"
    on public.agent_actions for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "users_read_own_agent_actions"
    on public.agent_actions for select
    using (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

notify pgrst, 'reload schema';

-- Verify: table exists, starts empty.
select 'agent_actions' as tbl, count(*) as n from public.agent_actions;
