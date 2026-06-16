-- v2.58.0 — Local delivery agent heartbeat.
--
-- THE BLIND LEG (project_rejuv_realtest_and_ux_consolidation, Track A): the
-- no-show rescue loop is fully autonomous + self-healing UP TO the proxy email.
-- Then it goes BLIND: the spa owner's Mac (Claude Desktop + iMessage MCP) reads
-- the proxy email and relays it to the patient by text — a leg SmartSpa has ZERO
-- signal on. If that Mac is asleep, Claude Desktop is closed, or Messages isn't
-- running, rescues silently stop relaying and nothing reports it. That is the
-- exact SILENT-ABSENCE failure the Connection Health doctrine
-- (feedback_connection_health_doctrine) exists to catch — on the one tier we
-- couldn't see.
--
-- THE FIX: a presence heartbeat. A tiny pinger on the spa's Mac POSTs to
-- /api/agent/heartbeat on a fixed cadence (every ~5 min) carrying a per-spa
-- secret + what it can verify (is Messages running, agent version). The absence
-- of a recent ping IS the signal — surfaced as a new 'presence' tier in
-- Connection Health (Live / Quiet / Silent). Unlike the 'delivery' tier (which
-- never hard-breaks because a quiet sending week is legitimate), a heartbeat
-- fires REGARDLESS of workload, so silence is unambiguous: the local relay is
-- offline. We can flag it honestly.
--
-- One row per spa (unique user_id). The secret is the agent's identity: the
-- pinger presents it, we look the spa up by it. No expect_sources gate needed —
-- provisioning a row (clicking "set up the local agent") IS the declaration.

create table if not exists local_agents (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  -- The agent's identity + bearer token. The pinger sends this in the
  -- x-agent-secret header; we look the spa up by it. Random 48-hex.
  secret        text not null unique,
  -- Owner-friendly name for the machine ("Karen's Mac"). NULL → generic label.
  label         text,
  -- Last successful check-in. NULL = provisioned but never pinged (→ "setup").
  -- This is the freshness anchor the presence verdict ages against.
  last_seen_at  timestamptz,
  -- What the agent could verify on its last ping, e.g. { "messages_app": true }.
  -- Absent keys = "unknown" (never used to cry wolf); only an explicit false
  -- downgrades a fresh agent (online but Messages isn't running).
  capabilities  jsonb not null default '{}'::jsonb,
  agent_version text,
  -- Free-text status the agent may report ("ok" / a one-line error).
  last_status   text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_id)
);

alter table local_agents enable row level security;

-- Owner may read their own agent row (the provisioning card reveals the secret).
-- All server writes (heartbeat ingest, provisioning) go through the service role,
-- which bypasses RLS — mirrors emma_scheduler_connections.
drop policy if exists local_agents_owner_select on local_agents;
create policy local_agents_owner_select on local_agents
  for select using (auth.uid() = user_id);

drop policy if exists local_agents_service_all on local_agents;
create policy local_agents_service_all on local_agents
  for all using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

notify pgrst, 'reload schema';
