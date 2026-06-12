-- v2.11.0 — messaging_activity: the outbound "messages are going out" heartbeat.
--
-- WHY (the gap v2.10.0's fresh-walk surfaced): Connection Health's new 'delivery'
-- feed reads freshness from patient_outreach.sent_at. But the PRIMARY outbound
-- channel — the iMessage killer-arch (recall/rescue drafts emailed to the spa's
-- proxy inbox → pasted into Claude Desktop → draft_imessage → human taps Send) —
-- writes NO patient_outreach row. That table is coupled to the Emma campaign
-- state machine (patient_outreach_state_id is NOT NULL); recall/rescue targets
-- have no such state. So the blue-bubble channel SmartSpa is built around was
-- INVISIBLE to delivery health — it could read "no text ever sent" while the spa
-- is actively dispatching recall every day.
--
-- THE FIX is a small, purpose-built heartbeat decoupled from any one path's
-- bookkeeping: every outbound dispatch (recall dispatch, rescue dispatch, and
-- room for campaign sends) stamps "I just sent N messages on this channel at T."
-- Delivery health then reads max(patient_outreach.sent_at, this) per channel, so
-- the iMessage path lights the card up. One row per (tenant, channel), upserted
-- to the latest — we only need the freshest beat, so there's no cumulative
-- counter to race on (last_count is the most-recent batch, not a running total).
--
-- HONESTY NOTE: the heartbeat fires at DISPATCH (server-side, reliable), not at
-- the human's actual Send tap (which happens on the Mac, with no callback). That
-- is the right scope for this card: it guards the SYSTEM going silent (engine
-- stops, proxy email stops flowing), which is the doctrine's silent failure —
-- not "did a human tap Send." A future precision upgrade could have the iMessage
-- MCP call back on open; dispatch is the faithful, reliable signal today.

create table if not exists public.messaging_activity (
  user_id          uuid        not null references auth.users(id) on delete cascade,
  -- matches patient_outreach.channel + EXPECTABLE_DELIVERY source_key.
  channel          text        not null check (channel in ('sms', 'email')),
  -- the freshest outbound beat on this channel — what delivery health reads.
  last_activity_at timestamptz not null default now(),
  -- which engine produced the most recent beat: 'recall' | 'rescue' | 'campaign'.
  last_kind        text,
  -- size of the most recent batch (NOT cumulative — avoids an increment race;
  -- the card only needs freshness, this is just context).
  last_count       integer     not null default 0,
  updated_at       timestamptz not null default now(),
  primary key (user_id, channel)
);

-- Fast per-tenant read for the delivery health cards.
create index if not exists messaging_activity_user_idx
  on public.messaging_activity (user_id);

alter table public.messaging_activity enable row level security;

do $$ begin
  create policy "service_role_messaging_activity"
    on public.messaging_activity for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "users_read_own_messaging_activity"
    on public.messaging_activity for select
    using (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

notify pgrst, 'reload schema';

-- Verify: table is empty + ready.
select count(*) as messaging_activity_count from public.messaging_activity;
