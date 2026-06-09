-- v1.97.0 — Reward-data email-drop auto-ingest (Patient-Profitability OS).
--
-- Each tenant gets an unguessable inbound address <token>@rewards.getrefill.app.
-- The spa points a manufacturer report (scheduled export, or a Gmail
-- auto-forward rule) at it; Resend Inbound delivers the email to
-- /api/resend/inbound-rewards, which resolves this token → user_id, auto-
-- detects the manufacturer from the CSV headers, and ingests — no dropdown,
-- no manual upload. The token is the only secret; we trust it, not the
-- From sender.

create table if not exists public.reward_ingest_tokens (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null references auth.users(id) on delete cascade,
  token       text        not null unique,
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz
);

-- One active (non-revoked) token per tenant; rotating mints a new row and
-- revokes the old.
create unique index if not exists reward_ingest_tokens_user_active
  on public.reward_ingest_tokens (user_id)
  where revoked_at is null;

-- Fast token → tenant lookup at the inbound endpoint.
create index if not exists reward_ingest_tokens_token_idx
  on public.reward_ingest_tokens (token)
  where revoked_at is null;

alter table public.reward_ingest_tokens enable row level security;

do $$ begin
  create policy "service_role_reward_ingest_tokens"
    on public.reward_ingest_tokens for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "users_read_own_reward_ingest_tokens"
    on public.reward_ingest_tokens for select
    using (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

notify pgrst, 'reload schema';

-- Verify: table is empty + ready.
select count(*) as token_count from public.reward_ingest_tokens;
