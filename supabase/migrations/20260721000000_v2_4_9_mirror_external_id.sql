-- v2.4.9 — Mirror external-id mapping (rename-safe Acuity staging mirror)
-- ─────────────────────────────────────────────────────────────────────────
-- The Acuity staging mirror (v2.4.1) matched providers/services by NAME, so
-- renaming a mirrored provider or service (in SmartSpa or Acuity) made a
-- re-mirror create a duplicate. We anchor each mirrored row to its Acuity id
-- instead: external_source ('acuity') + external_id (the calendar / appointment-
-- type id). A re-mirror then finds the row by id and updates its name, never
-- duplicating. Pre-existing name-mirrored rows are adopted on the next run.
--
-- Additive + nullable: native (non-mirrored) providers/services leave both
-- null and are unaffected. The partial unique index enforces one row per
-- (tenant, source, external id) only when external_id is set.

alter table public.scheduling_providers
  add column if not exists external_source text,
  add column if not exists external_id text;

create unique index if not exists scheduling_providers_external_idx
  on public.scheduling_providers (tenant_id, external_source, external_id)
  where external_id is not null;

alter table public.services
  add column if not exists external_source text,
  add column if not exists external_id text;

create unique index if not exists services_external_idx
  on public.services (tenant_id, external_source, external_id)
  where external_id is not null;

-- Reload PostgREST's schema cache so the new columns are queryable immediately.
notify pgrst, 'reload schema';

-- ── Verify (read-only) ──────────────────────────────────────────────────
select table_name, column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name in ('scheduling_providers', 'services')
  and column_name in ('external_source', 'external_id')
order by table_name, column_name;
