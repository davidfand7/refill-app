-- Emma(OS) same-day rescue — attempts + offers (v361).
--
-- When an appointment flips to 'cancelled' or 'no_show' with a future
-- scheduled_at, the rescue dispatcher picks 3-5 fit-patients from the
-- waitlist and fires parallel SMS with claim links. First patient to
-- tap the link claims the slot.
--
-- Two tables:
--   emma_rescue_attempts — parent: one row per appointment cancellation
--   emma_rescue_offers   — children: one row per patient contacted
--
-- The race-safe claim mechanic relies on:
--   UPDATE emma_rescue_offers SET claimed_at = now()
--     WHERE id = $offer_id AND claimed_at IS NULL
--     RETURNING *
-- Only one concurrent claim wins. Loser sees a "Sorry, just taken"
-- page.
--
-- Established 2026-05-17 (Promotions Engine v361).

-- ── emma_noshow_policies extension ──────────────────────────────────────

alter table public.emma_noshow_policies
  add column if not exists rescue_eligible_treatments text[] not null default '{}';

comment on column public.emma_noshow_policies.rescue_eligible_treatments is
  'Empty = rescue runs for any treatment type. Populated = rescue only fires when the freed appointment treatment_type is in this list.';

-- ── emma_rescue_attempts ────────────────────────────────────────────────

create table if not exists public.emma_rescue_attempts (
  id                       uuid        primary key default gen_random_uuid(),
  user_id                  uuid        not null references auth.users(id) on delete cascade,
  freed_appointment_id     uuid        not null references public.emma_appointments(id) on delete cascade,

  triggered_at             timestamptz not null default now(),
  outreach_count           integer     not null default 0,

  -- Final state. Set when the rescue concludes (filled OR closed).
  status                   text        not null default 'active'
                           check (status in ('active', 'filled', 'closed_unfilled', 'cancelled')),

  filled_at                timestamptz,
  -- The offer that won. References emma_rescue_offers(id).
  filled_by_offer_id       uuid,
  closed_at                timestamptz,
  notes                    text,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

alter table public.emma_rescue_attempts enable row level security;

do $$ begin
  create policy "users_own_emma_rescue_attempts"
    on public.emma_rescue_attempts for all
    using  (auth.uid() = user_id)
    with check (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "service_role_emma_rescue_attempts"
    on public.emma_rescue_attempts for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

create index if not exists emma_rescue_attempts_by_user_idx
  on public.emma_rescue_attempts (user_id, triggered_at desc);

create index if not exists emma_rescue_attempts_active_idx
  on public.emma_rescue_attempts (user_id, status)
  where status = 'active';

create trigger emma_rescue_attempts_set_updated_at
  before update on public.emma_rescue_attempts
  for each row execute function public.set_updated_at();

-- ── emma_rescue_offers ──────────────────────────────────────────────────

create table if not exists public.emma_rescue_offers (
  id                       uuid        primary key default gen_random_uuid(),
  user_id                  uuid        not null references auth.users(id) on delete cascade,
  rescue_attempt_id        uuid        not null references public.emma_rescue_attempts(id) on delete cascade,
  appointment_id           uuid        not null references public.emma_appointments(id) on delete cascade,
  patient_node_id          uuid        not null references public.knowledge_nodes(id) on delete cascade,

  -- Public capability token. Patient hits /rescue/claim/<token>.
  token                    uuid        not null unique default gen_random_uuid(),

  sent_at                  timestamptz not null default now(),
  claimed_at               timestamptz,
  declined_at              timestamptz,
  expired_at               timestamptz,

  -- Twilio SID for the SMS we sent. For audit + linking to inbound.
  message_id               text,

  -- Error reason when the outreach itself failed (no phone, twilio
  -- error, etc.). Null = sent ok.
  send_error               text,

  created_at               timestamptz not null default now(),

  unique (rescue_attempt_id, patient_node_id)
);

alter table public.emma_rescue_offers enable row level security;

do $$ begin
  create policy "users_own_emma_rescue_offers"
    on public.emma_rescue_offers for all
    using  (auth.uid() = user_id)
    with check (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "service_role_emma_rescue_offers"
    on public.emma_rescue_offers for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

-- Foreign-key constraint added after the table exists so the column
-- can reference emma_rescue_offers from emma_rescue_attempts.
do $$ begin
  alter table public.emma_rescue_attempts
    add constraint emma_rescue_attempts_filled_by_offer_fk
      foreign key (filled_by_offer_id)
      references public.emma_rescue_offers(id) on delete set null;
exception when duplicate_object then null;
end $$;

create index if not exists emma_rescue_offers_by_attempt_idx
  on public.emma_rescue_offers (rescue_attempt_id, sent_at desc);

create index if not exists emma_rescue_offers_unclaimed_idx
  on public.emma_rescue_offers (rescue_attempt_id)
  where claimed_at is null and declined_at is null and expired_at is null;

comment on table public.emma_rescue_attempts is
  'Parent record for each rescue cycle — one per appointment cancellation. Status transitions: active → filled (someone claimed) | closed_unfilled (window expired) | cancelled (spa pulled it).';

comment on table public.emma_rescue_offers is
  'Per-patient outreach within a rescue attempt. Race-safe claim: UPDATE WHERE claimed_at IS NULL RETURNING * — only one concurrent winner. Token is public capability for /rescue/claim/<token>.';
