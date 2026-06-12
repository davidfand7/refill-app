-- v2.14.0 — Confidence-as-a-gate, first instance: reward-attribution holds.
--
-- The trust-repair rung of the onboarding ladder (project_trusted_onboarding,
-- step 7): an agent should ACT only when it's confident, and when it isn't it
-- should DRAFT/ASK rather than guess. Reward ingestion silently picked the FIRST
-- candidate when a $ reward matched more than one patient (a shared household
-- email, two patients whose names collide) — a silent, money-bearing wrong
-- action that poisons the very dollar number a new spa verifies against her own
-- portal in the first minute (the wedge). This is the confidence gate for it:
--
--   * reward_attribution_holds — the "needs your eyes" queue. When the matcher
--     can't narrow a reward to ONE patient, the reward still lands (orphaned,
--     patient_node_id null) but is NOT attributed; instead a hold row captures
--     the candidates so the owner can pick. The gate's anatomy mirrors the
--     expect-gate: the agent declines to act, surfaces a fixable card, the human
--     latches it.
--   * reward_match_aliases — correction TEACHES. When the owner picks, we learn
--     "this exact contact fingerprint → this patient" so the next import auto-
--     resolves it. Keyed on the contact fingerprint (name|email|phone), NOT the
--     bare shared signal, so a spouse on the same email is NOT silently inherited.
--
-- Both follow the same service-role-only RLS + read-own posture as
-- expected_sources / patient_reward_entries (all writes go through the service
-- role in manufacturer-reward-ingest.functions.ts).

-- ── The hold queue ─────────────────────────────────────────────────────────
create table if not exists public.reward_attribution_holds (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  import_id       uuid,                       -- reward_signal_imports.id (soft ref)
  -- Locators: the SAME business tuple patient_reward_entries is unique on, so a
  -- resolve updates exactly the orphaned entry, and a re-import is idempotent.
  manufacturer    text not null,
  brand_product   text not null,
  match_key       text not null,
  -- Denormalized reward facts so the card renders without a join.
  program           text,
  reward_amount_usd numeric,
  expiration_date   date,
  contact_name      text,
  contact_email     text,
  contact_phone     text,
  -- The ambiguity itself.
  fingerprint     text not null,              -- name|email|phone → alias key on resolve
  signals         text[] not null default '{}',  -- which signals hit: email/phone/name
  candidates      jsonb  not null default '[]', -- [{id,name,email,phone}] for the picker
  -- Latch state.
  status          text not null default 'pending'
                    check (status in ('pending', 'resolved', 'dismissed')),
  resolved_node_id uuid,
  resolved_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- One hold per reward tuple per tenant (idempotent upsert on re-import).
create unique index if not exists reward_attribution_holds_tuple
  on public.reward_attribution_holds (user_id, manufacturer, brand_product, match_key);

-- Fast per-tenant read of the open queue.
create index if not exists reward_attribution_holds_pending
  on public.reward_attribution_holds (user_id, created_at desc)
  where status = 'pending';

alter table public.reward_attribution_holds enable row level security;

do $$ begin
  create policy "service_role_reward_attribution_holds"
    on public.reward_attribution_holds for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "users_read_own_reward_attribution_holds"
    on public.reward_attribution_holds for select
    using (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

-- ── The learned aliases (correction teaches) ───────────────────────────────
create table if not exists public.reward_match_aliases (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  fingerprint  text not null,                 -- name|email|phone composite
  node_id      uuid not null,                 -- the patient the owner confirmed
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create unique index if not exists reward_match_aliases_user_fp
  on public.reward_match_aliases (user_id, fingerprint);

alter table public.reward_match_aliases enable row level security;

do $$ begin
  create policy "service_role_reward_match_aliases"
    on public.reward_match_aliases for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "users_read_own_reward_match_aliases"
    on public.reward_match_aliases for select
    using (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

notify pgrst, 'reload schema';

-- Verify: both tables exist and start empty.
select 'reward_attribution_holds' as tbl, count(*) as n from public.reward_attribution_holds
union all
select 'reward_match_aliases', count(*) from public.reward_match_aliases;
