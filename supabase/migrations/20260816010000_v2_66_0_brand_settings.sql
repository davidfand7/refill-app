-- v2.66.0 — "Your Brand" white-label spine.
--
-- THE GIVE / THE GET (feedback_give_before_you_get, project_your_brand_white_label):
-- v2.65.0 shipped the free give — every spa already gets a tasteful, fully
-- SmartSpa-branded experience. This migration lays the spine for the GET: the
-- paid white-label flip, where a spa replaces SmartSpa's name/logo/accent with
-- its OWN on every patient-facing surface. On-thesis (project_antilockin_positioning):
-- the spa owning its patient face is "earned usefulness," not hostage-taking —
-- the spa's brand, the spa's patients, we're the engine underneath.
--
-- TWO TIERS, ONE TABLE:
--   FREE  — assistant_name. Naming the assistant costs nothing and rides along
--           for every spa. (Scout finding: assistant_name has no LIVE patient
--           surface yet — its real payoff lands with the auto-responder — but
--           we store + honor it now so it's set when that ships.)
--   PAID  — brand_display_name + accent_color + logo_url + remove_powered_by.
--           These only take effect when the spa is BOTH entitled (we/billing
--           flipped it on) AND has branding_active = true (the owner's own
--           master switch). resolveBrand() (src/server/brand-resolver.ts) is
--           the single gate; see mergeBrand() in src/lib/brand.ts for the rule.
--
-- ENTITLEMENT: `entitled` is server/billing-controlled — owner editor fns never
-- write it (setBrandSettingsFn omits it). For the Rejuv demo we force it on via
-- inline SQL after this migration (no local DB creds → Supabase SQL editor
-- dashboard-paste, per feedback_sql_placement).
--
-- One row per spa (unique user_id), keyed exactly like local_agents /
-- emma_scheduler_connections. All server writes go through the service role
-- (bypasses RLS); owner may read their own row for the editor + preview.

create table if not exists brand_settings (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users (id) on delete cascade,

  -- FREE tier. Persona/sender name for the assistant ("Ruby", "Skin Concierge").
  -- NULL → falls back to the (brand) name in mergeBrand.
  assistant_name     text,

  -- PAID tier. The spa's own product name shown to patients + in emails,
  -- replacing "SmartSpa". NULL → REFILL_BRAND.name.
  brand_display_name text,
  -- PAID. CSS hex accent ("#7c3aed"). NULL → REFILL_BRAND.visual.accent.
  accent_color       text,
  -- PAID. Absolute URL to the spa's logo image. NULL → letter mark / wordmark.
  logo_url           text,
  -- PAID. When true, suppress the "powered by SmartSpa" footer/badge.
  remove_powered_by  boolean not null default false,

  -- The owner's master switch for the paid white-label. Off = patients see
  -- SmartSpa even if the paid fields are filled in (lets the owner prep the
  -- brand before going live).
  branding_active    boolean not null default false,

  -- Server/billing-controlled entitlement. Paid fields are inert until this is
  -- true, regardless of branding_active. Owner editor fns never write this.
  entitled           boolean not null default false,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (user_id)
);

alter table brand_settings enable row level security;

-- Owner may read their own brand row (the editor + live preview render from it).
drop policy if exists brand_settings_owner_select on brand_settings;
create policy brand_settings_owner_select on brand_settings
  for select using (auth.uid() = user_id);

-- All writes (owner saves via server fn, billing flips entitled) go through the
-- service role, which bypasses RLS — mirrors local_agents / emma_scheduler_connections.
drop policy if exists brand_settings_service_all on brand_settings;
create policy brand_settings_service_all on brand_settings
  for all using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

notify pgrst, 'reload schema';
