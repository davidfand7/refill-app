-- Emma(OS) waitlist + per-patient opt-in tokens (v361).
--
-- Patients opt into the spa's last-minute openings list via:
--   1. Tapping the universal opt-in footer Emma appends to every
--      outbound message (the footer URL resolves to a stable per-patient
--      token, so one tap = opted in)
--   2. The spa owner marking them opted-in manually (future: patient
--      detail page toggle)
--
-- Opted-in patients are the candidate pool for the v361 same-day rescue
-- agent: when an appointment cancels/no-shows with future scheduled_at,
-- the agent picks 3-5 fit patients (treatment match + availability
-- match + lifetime value rank) and sends them parallel SMS with a claim
-- link. First-tap wins.
--
-- Tenant boundary: every row scoped by user_id with RLS. Tokens are
-- opaque uuids; even a leaked token only lets a specific patient opt
-- in/out of a specific spa's list.
--
-- Established 2026-05-17 (Promotions Engine v361).

-- ── emma_waitlist ────────────────────────────────────────────────────────

create table if not exists public.emma_waitlist (
  id                    uuid        primary key default gen_random_uuid(),
  user_id               uuid        not null references auth.users(id) on delete cascade,
  patient_node_id       uuid        not null references public.knowledge_nodes(id) on delete cascade,

  -- Treatment-type filter. Empty = open to any rescue treatment.
  -- Populated = patient only wants notifications for these.
  treatment_types       text[]      not null default '{}',

  -- Provider preference. Empty = no preference.
  preferred_providers   text[]      not null default '{}',

  -- Availability windows. jsonb shape:
  --   { "weekday_morning": bool, "weekday_afternoon": bool, "weekday_evening": bool,
  --     "weekend_morning": bool, "weekend_afternoon": bool, "weekend_evening": bool }
  -- Empty = open to any time. Rescue dispatcher cross-checks this
  -- against the freed slot's day-of-week + hour-of-day.
  availability_windows  jsonb       not null default '{}'::jsonb,

  status                text        not null default 'active'
                        check (status in ('active', 'paused', 'revoked')),

  -- Where the opt-in originated. Useful for understanding what drove
  -- the list growth (and for compliance — TCPA wants to know how each
  -- patient on the list got there).
  opt_in_source         text        not null
                        check (opt_in_source in (
                          'footer-link',
                          'spa-manual',
                          'patient-detail-toggle'
                        )),

  opted_in_at           timestamptz not null default now(),
  revoked_at            timestamptz,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  unique (user_id, patient_node_id)
);

alter table public.emma_waitlist enable row level security;

do $$ begin
  create policy "users_own_emma_waitlist"
    on public.emma_waitlist for all
    using  (auth.uid() = user_id)
    with check (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "service_role_emma_waitlist"
    on public.emma_waitlist for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

-- Rescue dispatcher hot path: "find active waitlist members for this spa."
create index if not exists emma_waitlist_active_idx
  on public.emma_waitlist (user_id)
  where status = 'active';

create trigger emma_waitlist_set_updated_at
  before update on public.emma_waitlist
  for each row execute function public.set_updated_at();

-- ── emma_waitlist_tokens ────────────────────────────────────────────────

-- One stable token per (user_id, patient_node_id). Used in:
--   - The universal opt-in footer URL appended to every Emma message
--     (/waitlist/optin/<token>)
--   - Future: the manage-preferences page (/waitlist/manage/<token>)
--
-- Tokens are minted lazily on first need by the preshow agent or
-- rescue dispatcher — no need to bulk-mint for the whole patient roster.

create table if not exists public.emma_waitlist_tokens (
  token                 uuid        primary key default gen_random_uuid(),
  user_id               uuid        not null references auth.users(id) on delete cascade,
  patient_node_id       uuid        not null references public.knowledge_nodes(id) on delete cascade,
  created_at            timestamptz not null default now(),
  last_used_at          timestamptz,

  unique (user_id, patient_node_id)
);

alter table public.emma_waitlist_tokens enable row level security;

do $$ begin
  create policy "service_role_emma_waitlist_tokens"
    on public.emma_waitlist_tokens for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

-- Note: NO user-facing RLS policy on tokens. Token lookup happens
-- service-role-only via the public landing page server fns. The patient
-- never authenticates; the token IS the capability.

comment on table public.emma_waitlist is
  'Per-spa waitlist of patients who opted in to receive notifications when last-minute slots free up. Source of the candidate pool for the v361 rescue dispatcher. Spa-scoped via RLS.';

comment on table public.emma_waitlist_tokens is
  'Stable per-(spa, patient) tokens for opt-in / manage URLs in Emma-outbound messages. Token = capability — service-role lookup only, no patient auth.';
