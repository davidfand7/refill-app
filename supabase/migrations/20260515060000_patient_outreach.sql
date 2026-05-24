-- Promotions Engine Phase 3.1 — per-message outreach log.
--
-- One row per sent or received message. The Phase 3.0 patient_outreach_state
-- table tracks the LATEST state of each (campaign, patient) pair; this table
-- is the full audit + reply trail. Joins back to patient_outreach_state via
-- patient_outreach_state_id.
--
-- Inbound rows (direction='inbound') will land when the Twilio + Resend
-- inbound webhooks are wired for Emma (separate ship). Phase 3.1 only writes
-- outbound rows; the schema reserves space so the inbound ship is code-only.
--
-- Tenant boundary: every row scoped by spa user_id with RLS. Reps NEVER see
-- this — outbound messages and replies are between the spa and their patient.
--
-- Established 2026-05-15 (Promotions Engine Phase 3.1).

create table if not exists public.patient_outreach (
  id                         uuid        primary key default gen_random_uuid(),
  user_id                    uuid        not null references auth.users(id) on delete cascade,
  patient_outreach_state_id  uuid        not null references public.patient_outreach_state(id) on delete cascade,

  direction                  text        not null,    -- 'outbound' | 'inbound'
  channel                    text        not null,    -- 'sms' | 'email'
  subject                    text,                    -- null for SMS
  body                       text        not null,

  sent_at                    timestamptz,
  read_at                    timestamptz,             -- email open
  opened_at                  timestamptz,             -- alias for read_at — set when an open pixel fires
  replied_at                 timestamptz,             -- set on first inbound reply

  -- Idempotency + cross-reference: Twilio SID or Resend email id.
  -- Used by webhook handlers to look up which conversation an inbound
  -- belongs to.
  message_id                 text,

  -- Public token for the booking landing page (Phase 4 — Emma side).
  intent_token               text,

  -- Free-text skip/error reason when sent_at is null. e.g. 'velocity_cap',
  -- 'quiet_hours', 'banned', 'opted_out', 'twilio:429', 'resend:bad-from'.
  skip_reason                text,

  created_at                 timestamptz not null default now()
);

alter table public.patient_outreach enable row level security;

do $$ begin
  create policy "users_own_patient_outreach"
    on public.patient_outreach for all
    using  (auth.uid() = user_id)
    with check (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "service_role_patient_outreach"
    on public.patient_outreach for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

-- Velocity cap lookup: "has THIS patient received any outbound from us in
-- the last N days?". Filtered to direction='outbound' for the hottest path.
create index if not exists patient_outreach_velocity_idx
  on public.patient_outreach (user_id, patient_outreach_state_id, sent_at desc)
  where direction = 'outbound' and sent_at is not null;

-- Inbound webhook lookup: "find the state row this message replies to."
create index if not exists patient_outreach_message_id_idx
  on public.patient_outreach (user_id, message_id)
  where message_id is not null;

-- Per-state-row history: "all messages for this (campaign, patient) pair."
create index if not exists patient_outreach_by_state_idx
  on public.patient_outreach (user_id, patient_outreach_state_id, created_at desc);

comment on table public.patient_outreach is
  'Per-message log for the Emma(OS) Promotions Engine. One row per outbound or inbound SMS/email. Spa-scoped via RLS. patient_outreach_state holds the latest state; this is the full audit trail.';
