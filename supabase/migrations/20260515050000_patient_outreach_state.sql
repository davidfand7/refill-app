-- Promotions Engine Phase 3 — per-campaign outreach state.
--
-- One row per (campaign_node_id, patient_node_id) tracks the spa's outreach
-- state for that patient on that campaign. Phase 3.0 uses this table to
-- persist draft messages; Phase 3.1 will use it to track send + reply + book
-- state via the `state` enum.
--
-- Why a relational table instead of attachments on the campaign node:
--   The blast composer is row-keyed by patient, and we'll be reading + writing
--   one row at a time as the spa owner edits drafts. A flat relational table
--   with a unique index on (campaign, patient) is the right shape — much
--   simpler than maintaining a 500-key map inside a json blob.
--
-- The roadmap §8 schema lists fields that arrive across phases. This
-- migration ships them all upfront so 3.1 (send + state-machine) is a code
-- change only, no further DDL.
--
-- Tenant boundary: every row scoped by spa user_id with RLS. Reps NEVER see
-- this table — outbound messages and their state are the spa's alone.
--
-- Established 2026-05-15 (Promotions Engine Phase 3.0).

create table if not exists public.patient_outreach_state (
  id                       uuid        primary key default gen_random_uuid(),
  user_id                  uuid        not null references auth.users(id) on delete cascade,
  campaign_node_id         uuid        not null references public.knowledge_nodes(id) on delete cascade,
  patient_node_id          uuid        not null references public.knowledge_nodes(id) on delete cascade,

  -- State machine — populated on cohort-resolve (Phase 3.0 = 'targeted')
  -- and advanced on send / reply / book / show / no-show (Phase 3.1+).
  -- 'opted_out' is reserved for STOP / UNSUBSCRIBE handling.
  state                    text        not null default 'targeted',

  -- Channel locked at send time. Null during Phase 3.0 (draft pre-send).
  channel                  text,

  -- Per-patient draft snapshot — spa-editable, Emma-generated. Shape:
  --   { subject?: string, body: string, verifiedChip?: { ... },
  --     channel: 'sms'|'email'|'both', generatedAt: iso, edited: boolean }
  draft                    jsonb       not null default '{}'::jsonb,

  last_touched_at          timestamptz,
  last_message_id          text,

  -- Phase 3.1 send-mechanic + booking fields (reserved now to avoid a
  -- follow-up migration for the same conceptual table).
  booking_intent_token     text,
  booking_confirmed_at     timestamptz,
  showed_at                timestamptz,
  attributed_revenue_usd   numeric,

  -- Cadence (Phase 7) — when this row is dismissed from the digest, store
  -- the timestamp here so the digest query naturally filters it out.
  nudge_dismissed_at       timestamptz,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  constraint patient_outreach_state_unique
    unique (user_id, campaign_node_id, patient_node_id),
  constraint patient_outreach_state_state_check check (
    state in ('targeted', 'outreached', 'engaged', 'booked', 'showed',
              'no_show', 'closed_won', 'closed_lost', 'opted_out')
  ),
  constraint patient_outreach_state_channel_check check (
    channel is null or channel in ('sms', 'email', 'both')
  )
);

alter table public.patient_outreach_state enable row level security;

do $$ begin
  create policy "users_own_patient_outreach_state"
    on public.patient_outreach_state for all
    using  (auth.uid() = user_id)
    with check (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "service_role_patient_outreach_state"
    on public.patient_outreach_state for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

-- The composer page hits "show me all targets for this campaign, latest
-- touched first" — by-campaign index drives that.
create index if not exists patient_outreach_state_by_campaign_idx
  on public.patient_outreach_state (user_id, campaign_node_id, updated_at desc);

-- Phase 7 cadence digest: "anyone outreached, not engaged, > 5 days quiet,
-- not dismissed" — partial index on the actionable state.
create index if not exists patient_outreach_state_stale_idx
  on public.patient_outreach_state (user_id, last_touched_at desc)
  where state = 'outreached' and nudge_dismissed_at is null;

-- updated_at touch trigger so the composer can show "Saved 2s ago".
create or replace function public.touch_patient_outreach_state()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end
$$;

drop trigger if exists trg_touch_patient_outreach_state on public.patient_outreach_state;
create trigger trg_touch_patient_outreach_state
  before update on public.patient_outreach_state
  for each row execute function public.touch_patient_outreach_state();

comment on table public.patient_outreach_state is
  'Per-(campaign, patient) outreach state for the Emma(OS) Promotions Engine. State machine: targeted → outreached → engaged → booked → showed / no_show / closed_*. Draft snapshot in `draft` jsonb. Spa-scoped via RLS.';
