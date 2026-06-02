-- v1.34.3: Preshow agent — profile-based cadence + per-touchpoint message
-- templates + admin global defaults.
--
-- Per the 2026-06-02 scout of emma_noshow_policies + 2026-06-02 morning
-- conversation locking the four architectural decisions:
--   1. Profiles are user-named with a `(default)` indicator on whichever
--      one is is_default=true. Renaming the default doesn't lose it.
--   2. Backfill in this migration — Rejuv Skin Spa + the demo tenant get
--      a "Default" profile auto-created from their current
--      preshow_cadence_hours / preshow_tone / preshow_channel.
--   3. Old /app/refill/settings/noshow URL → redirect to
--      /app/refill/agents/preshow (handled in route file, not here).
--   4. agent_defaults gets its own dedicated table (not extending
--      feature_flags) — admin-set global defaults that profiles fall
--      back to when fields are unset.
--
-- Substrate-level documentation wall held: the cadence + message
-- templates are per-spa-user-scoped via RLS; admin defaults are
-- service-role-only writes. No cross-tenant leakage paths.
--
-- Related: cron sweep at api.cron.emma-preshow-sweep + dispatch fn in
-- emma-preshow.functions.ts both extend to read profile via
-- patient.softTags.preshowProfileId (added at the application layer,
-- no migration needed since softTags is JSONB on knowledge_nodes).

-- ── 1. agent_defaults — admin global defaults per agent kind ───────────

create table if not exists public.agent_defaults (
  id          uuid        primary key default gen_random_uuid(),
  agent_kind  text        not null
    check (agent_kind in ('preshow', 'rescue', 'attribution', 'recognition')),
  defaults    jsonb       not null default '{}'::jsonb,
  updated_by  uuid        references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (agent_kind)
);

alter table public.agent_defaults enable row level security;

-- Service-role only; admin reads/writes via server fn that gates on
-- user_roles.role = 'admin'.
do $$ begin
  create policy "service_role_agent_defaults"
    on public.agent_defaults for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

create trigger agent_defaults_set_updated_at
  before update on public.agent_defaults
  for each row execute function public.set_updated_at();

-- Seed the preshow defaults so the dispatch fn has a known fallback on
-- day 1 (matches the prior code-baked defaults in
-- emma_noshow_policies.preshow_cadence_hours default).
insert into public.agent_defaults (agent_kind, defaults)
values (
  'preshow',
  '{
    "cadence_hours": [48, 24, 3],
    "tone": "warm",
    "channel": "auto"
  }'::jsonb
)
on conflict (agent_kind) do nothing;

-- ── 2. emma_preshow_profiles — multiple cadence profiles per spa ───────

create table if not exists public.emma_preshow_profiles (
  id                          uuid        primary key default gen_random_uuid(),
  user_id                     uuid        not null references auth.users(id) on delete cascade,

  -- User-editable name. The default profile is just whichever row has
  -- is_default=true regardless of name — Karen can rename "Default" to
  -- "Standard" without losing default status.
  name                        text        not null,
  is_default                  boolean     not null default false,

  -- Unlimited cadence: integer[] of hour-offsets before scheduled_at
  -- the reminder fires. e.g. {120, 72, 48, 24, 12} = 5-day, 3-day,
  -- 48h, 24h, 12h. Cron sweep already handles arrays of arbitrary
  -- length — UI just needs to expose the array.
  cadence_hours               integer[]   not null default '{48,24,3}',

  -- Reserved for v1.34.4 — per-treatment-type overrides. Keyed by
  -- treatment_type (matches emma_appointments.treatment_type), value
  -- is a cadence_hours[] override. Empty {} = use the default array.
  cadence_by_treatment_type   jsonb       not null default '{}'::jsonb,

  tone                        text        not null default 'warm'
                              check (tone in ('warm', 'professional', 'casual')),
  channel                     text        not null default 'auto'
                              check (channel in ('sms', 'email', 'auto')),

  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),

  -- Profile names are unique within a spa.
  unique (user_id, name)
);

-- Exactly-one-default-per-spa, enforced via partial unique index. If
-- Karen marks a different profile default, the old one must flip to
-- false in the same transaction (server fn handles this).
create unique index if not exists emma_preshow_profiles_one_default_per_spa
  on public.emma_preshow_profiles (user_id)
  where is_default = true;

alter table public.emma_preshow_profiles enable row level security;

do $$ begin
  create policy "users_own_emma_preshow_profiles"
    on public.emma_preshow_profiles for all
    using  (auth.uid() = user_id)
    with check (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "service_role_emma_preshow_profiles"
    on public.emma_preshow_profiles for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

create index if not exists emma_preshow_profiles_by_user
  on public.emma_preshow_profiles (user_id);

create trigger emma_preshow_profiles_set_updated_at
  before update on public.emma_preshow_profiles
  for each row execute function public.set_updated_at();

-- ── 3. emma_preshow_message_templates — per profile × offset_hours ─────

-- The actual SMS body template. Variable substitution at dispatch
-- time: {{patient.firstName}}, {{appt.time}}, {{appt.dateTime}},
-- {{appt.treatmentType}}, {{appt.providerName}}, {{spa.name}}.
-- NULL row (or missing row) for an offset = fall back to code-composed
-- default in composePreShowSmsBody.

create table if not exists public.emma_preshow_message_templates (
  id            uuid        primary key default gen_random_uuid(),
  user_id       uuid        not null references auth.users(id) on delete cascade,
  profile_id    uuid        not null references public.emma_preshow_profiles(id) on delete cascade,

  -- Which touchpoint in the cadence_hours array this template applies
  -- to. Stored as the raw hour value (e.g. 48), not array index, so a
  -- template survives Karen reordering or adding new touchpoints
  -- (the 48h template stays attached to the 48h touchpoint).
  offset_hours  integer     not null check (offset_hours >= 0 and offset_hours <= 8760),

  -- SMS body limit accommodates ~10 segments worth of UCS-2 (160 chars
  -- per segment × 10) to give room for branding + variables. The actual
  -- SMS provider may concatenate or split; that's the provider's job.
  body_template text        not null check (length(body_template) <= 1600),

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  unique (profile_id, offset_hours)
);

alter table public.emma_preshow_message_templates enable row level security;

do $$ begin
  create policy "users_own_emma_preshow_message_templates"
    on public.emma_preshow_message_templates for all
    using  (auth.uid() = user_id)
    with check (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "service_role_emma_preshow_message_templates"
    on public.emma_preshow_message_templates for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

create index if not exists emma_preshow_message_templates_by_profile
  on public.emma_preshow_message_templates (profile_id, offset_hours);

create trigger emma_preshow_message_templates_set_updated_at
  before update on public.emma_preshow_message_templates
  for each row execute function public.set_updated_at();

-- ── 4. Backfill — create a "Default" profile for every existing spa ────

-- Per Grasshopper's call: do this in the migration. Only two known
-- existing spas (Rejuv Skin Spa real + demo). Each gets a Default
-- profile mirroring their current preshow_cadence_hours / tone /
-- channel from emma_noshow_policies. Zero behavior change for existing
-- spas — the cron just reads from the new profile table instead of
-- the old per-spa columns.

insert into public.emma_preshow_profiles
  (user_id, name, is_default, cadence_hours, tone, channel)
select
  user_id,
  'Default',
  true,
  preshow_cadence_hours,
  preshow_tone,
  preshow_channel
from public.emma_noshow_policies
on conflict (user_id, name) do nothing;

notify pgrst, 'reload schema';

-- Verify backfill landed:
-- select user_id, name, is_default, cadence_hours, tone, channel
--   from public.emma_preshow_profiles
--  order by user_id, is_default desc;
--
-- Verify defaults seeded:
-- select agent_kind, defaults from public.agent_defaults;
