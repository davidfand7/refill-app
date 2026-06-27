-- v2.188.0 — Outbound iMessage queue: the spine of the zero-setup sender (Build 2, Path B).
--
-- THE LEAP: today the rescue/at-booking loop reaches the patient through a THREE-
-- part Claude-Desktop chain (Gmail connector + a hand-built routine + the iMessage
-- MCP) — every link a failure point, and the #1 adoption blocker for a non-coder
-- spa owner. Path B deletes all three: SmartSpa simply ENQUEUES the outbound text
-- here, and a tiny signed macOS menubar helper on the spa's own Mac polls the queue
-- and sends it via Messages.app — from the spa's own number (the moat), no Gmail,
-- no Desktop routine, no MCP.
--
-- This migration is the SERVER HALF (the on-ramp): the queue + an atomic claim RPC
-- + the per-spa relay flags. It ships DORMANT — nothing enqueues yet (the live
-- delivery stays the email-draft lane), gated by local_agents.delivery_mode. The
-- helper consumer + the enqueue cutover are the next slices. Auth reuses the
-- heartbeat/run-report spine: the helper presents the same per-spa local_agents
-- secret, and we identify the spa by it.

create table if not exists outbound_imessage_queue (
  id           uuid primary key default gen_random_uuid(),
  -- Which spa owns this send (and the relay Mac that will deliver it). Keyed by
  -- USER_ID — the same identity local_agents + all of recovery keys on.
  user_id      uuid not null references auth.users (id) on delete cascade,
  -- E.164 recipient (+1…) — the helper texts exactly this; SmartSpa normalizes
  -- before enqueue (same normalizePhoneE164 the proxy lane already uses).
  recipient    text not null,
  body         text not null,
  -- Lifecycle: pending → claimed → sent | failed. A claimed row that's never
  -- acked (helper crashed) is reclaimable after a timeout (see the claim RPC).
  status       text not null default 'pending'
                 check (status in ('pending', 'claimed', 'sent', 'failed', 'canceled')),
  -- Claim bookkeeping — the claim_token is the lease: ack must present the same
  -- token, so a reclaimed/duplicate poll can't ack someone else's send.
  claimed_at   timestamptz,
  claim_token  text,
  attempts     integer not null default 0,
  -- Result.
  sent_at      timestamptz,
  error        text,
  -- Provenance + idempotency. dedup_key lets an enqueue be retried safely (the
  -- partial unique below makes a repeat enqueue a no-op rather than a double text).
  source       text,
  dedup_key    text,
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- The claim select reads pending/stale-claimed rows per spa, oldest first.
create index if not exists outbound_imessage_queue_claim_idx
  on outbound_imessage_queue (user_id, status, created_at);

-- Idempotent enqueue: at most one live row per (spa, dedup_key). Partial so rows
-- without a dedup_key (or terminal ones) don't collide. Enqueue uses ON CONFLICT.
create unique index if not exists outbound_imessage_queue_dedup_idx
  on outbound_imessage_queue (user_id, dedup_key)
  where dedup_key is not null and status in ('pending', 'claimed');

alter table outbound_imessage_queue enable row level security;

-- Owner may read their own queue (a future "what's waiting to send" surface).
-- All writes (enqueue, claim, ack) go through the service role, which bypasses
-- RLS — mirrors local_agents.
drop policy if exists outbound_imessage_queue_owner_select on outbound_imessage_queue;
create policy outbound_imessage_queue_owner_select on outbound_imessage_queue
  for select using (auth.uid() = user_id);

drop policy if exists outbound_imessage_queue_service_all on outbound_imessage_queue;
create policy outbound_imessage_queue_service_all on outbound_imessage_queue
  for all using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- ── Atomic claim ────────────────────────────────────────────────────────────
-- PostgREST can't express FOR UPDATE SKIP LOCKED, so the claim is an RPC. It
-- leases up to p_limit rows to one helper poll: pending rows, PLUS claimed rows
-- whose lease has expired (>10 min → the helper crashed mid-send; safe to reclaim
-- because a real send acks in seconds). attempts caps runaway reclaims at 5.
-- SKIP LOCKED means two concurrent polls never hand out the same row.
create or replace function claim_outbound_imessages(
  p_user_id    uuid,
  p_limit      integer,
  p_claim_token text
)
returns setof outbound_imessage_queue
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update outbound_imessage_queue q
  set status      = 'claimed',
      claimed_at  = now(),
      claim_token = p_claim_token,
      attempts    = q.attempts + 1,
      updated_at  = now()
  where q.id in (
    select c.id
    from outbound_imessage_queue c
    where c.user_id = p_user_id
      and c.attempts < 5
      and (
        c.status = 'pending'
        or (c.status = 'claimed' and c.claimed_at < now() - interval '10 minutes')
      )
    order by c.created_at asc
    limit greatest(0, least(p_limit, 50))
    for update skip locked
  )
  returning q.*;
end;
$$;

-- ── Per-spa relay flags (on local_agents — the spa's relay config) ───────────
alter table local_agents
  -- The cutover switch: 'email' = today's draft-email lane (DEFAULT, unchanged);
  -- 'queue' = enqueue here for the local helper. Stays 'email' until a spa's
  -- helper is installed and proven, so this whole table is dormant by default.
  add column if not exists delivery_mode text not null default 'email'
    check (delivery_mode in ('email', 'queue')),
  -- The guardrail toggle (Grasshopper's call: do both). false = the helper STAGES
  -- the text for a human tap (tonight's deliberate safety); true = it auto-sends.
  -- Per-spa, defaults to the safe staged behavior. Returned by the claim endpoint.
  add column if not exists auto_send boolean not null default false;

notify pgrst, 'reload schema';
