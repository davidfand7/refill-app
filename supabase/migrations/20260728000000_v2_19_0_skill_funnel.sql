-- v2.19.0 — The Skill Funnel (Phase 1): the spine + the owned-routine tier.
--
-- The ACTIVE half of the Ownership Flywheel (project_skill_funnel,
-- trusted-onboarding ladder step 6). The wishlist earned-gate (v2.18.3) was
-- the passive half — she asks once she's earned it. This is the half where the
-- agent PROPOSES from observed work (or a curated catalog) and the wish
-- MATERIALIZES into a routine she OWNS, can edit, and can turn off.
--
-- ONE gate (propose → she verifies → she confirms → unlock — the same primitive
-- as the expect-gate / confidence-gate / wishlist), with TWO pluggable axes:
--   • SOURCE     — where a proposal comes from: catalog | mined | concierge
--   • MATERIALIZER — what "yes" produces: flip | routine | autonomous
--
-- The CATALOG itself is catalog-driven IN CODE (src/lib/skill-catalog.ts),
-- exactly like FLAG_CATALOG — the built-in templates are code; these two tables
-- hold the per-tenant INSTANCES. (Phase 3 adds a skill_templates table for
-- custom/concierge-authored ones, the way feature_flags rows override the
-- code catalog.) So Phase 1 only needs the two runtime tables below.
--
-- Lineage: a catalog template → skill_proposals (an instance offered to a
-- tenant; `source` is the whole source axis) → skills (an accepted, OWNED,
-- toggleable routine; `materializer` + `materialized_ref` keep the materializer
-- axis pluggable — a flip points at a flag, a routine at an engine config, an
-- autonomous skill at an authored .claude path — same table, no rebuild).
--
-- Same service-role-only-writes + read-own RLS posture as expected_sources /
-- reward_attribution_holds. Emma-era user-scoping (.eq user_id); tenant_id is
-- carried nullable for forward-compat with the tenant model.

-- ── The proposal queue (mirrors emma_setting_recommendations' lifecycle) ─────
create table if not exists public.skill_proposals (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  tenant_id         uuid,                                   -- forward-compat, nullable
  template_key      text not null,                          -- key into SKILL_CATALOG (code)
  -- The SOURCE axis: how this proposal came to exist.
  source            text not null default 'catalog'
                      check (source in ('catalog', 'mined', 'concierge')),
  -- Denormalized copy so the card renders without resolving the catalog.
  headline          text,
  body              text,
  proposed_config   jsonb not null default '{}'::jsonb,
  projected_lift_usd numeric,
  -- Lifecycle (the gate).
  status            text not null default 'pending'
                      check (status in ('pending', 'accepted', 'dismissed')),
  accepted_at       timestamptz,
  dismissed_at      timestamptz,
  created_by        uuid,                                   -- caller (concierge audit)
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Fast per-tenant read of the open queue (what NotificationCenter surfaces).
create index if not exists skill_proposals_pending
  on public.skill_proposals (user_id, created_at desc)
  where status = 'pending';

alter table public.skill_proposals enable row level security;

do $$ begin
  create policy "service_role_skill_proposals"
    on public.skill_proposals for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "users_read_own_skill_proposals"
    on public.skill_proposals for select
    using (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

-- ── The owned skills (an accepted instance she owns + can toggle) ────────────
create table if not exists public.skills (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  tenant_id          uuid,                                  -- forward-compat, nullable
  template_key       text not null,                         -- key into SKILL_CATALOG (code)
  name               text not null,
  -- The MATERIALIZER axis: what kind of thing this Skill is.
  materializer       text not null default 'routine'
                      check (materializer in ('flip', 'routine', 'autonomous')),
  config             jsonb not null default '{}'::jsonb,
  enabled            boolean not null default true,
  source_proposal_id uuid,                                  -- soft ref to skill_proposals.id
  -- The seam that keeps materializers pluggable: flag_key flipped / engine
  -- config id (e.g. preshow profile) / authored .claude skill path.
  materialized_ref   jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- One owned Skill per template per tenant (adopt is idempotent — re-adopt
-- re-enables rather than duplicating). Phase 2+ can relax this if a spa wants
-- multiple instances of one template.
create unique index if not exists skills_user_template
  on public.skills (user_id, template_key);

create index if not exists skills_user_created
  on public.skills (user_id, created_at desc);

alter table public.skills enable row level security;

do $$ begin
  create policy "service_role_skills"
    on public.skills for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "users_read_own_skills"
    on public.skills for select
    using (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

notify pgrst, 'reload schema';

-- Verify: both tables exist and start empty.
select 'skill_proposals' as tbl, count(*) as n from public.skill_proposals
union all
select 'skills', count(*) from public.skills;
