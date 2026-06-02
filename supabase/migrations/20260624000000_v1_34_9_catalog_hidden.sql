-- v1.34.9.1 — Catalog Hide affordance (Products + Services).
--
-- WHY: Karen needs a soft-delete state for products and services she no
-- longer offers but doesn't want to permanently delete (history matters
-- for the Profitability Engine + audit trail). Hidden rows disappear
-- from the default list view; "Show hidden" toggle reveals them with
-- an "Unhide" affordance.
--
-- Why a column not a separate table: keeps the catalog query path simple
-- (one WHERE clause vs. an anti-join), matches the v1.34.2.2
-- rebate_inventory soft_deleted_at pattern, partial index keeps the
-- active-list hot path fast.
--
-- WHAT SHIPS:
--   ALTER TABLE products ADD COLUMN hidden_at timestamptz null
--   ALTER TABLE services ADD COLUMN hidden_at timestamptz null
--   partial index for each (active rows only)
--
-- ROLLBACK:
--   ALTER TABLE products DROP COLUMN hidden_at;
--   ALTER TABLE services DROP COLUMN hidden_at;

alter table public.products
  add column if not exists hidden_at timestamptz null;

alter table public.services
  add column if not exists hidden_at timestamptz null;

-- Hot-path indexes: most queries filter to active (hidden_at is null) rows.
create index if not exists products_tenant_active_idx
  on public.products (tenant_id)
  where hidden_at is null;

create index if not exists services_tenant_active_idx
  on public.services (tenant_id)
  where hidden_at is null;

-- Notify PostgREST so the new column shows up in the API immediately.
notify pgrst, 'reload schema';

-- Verify the columns exist:
select
  table_name,
  column_name,
  data_type,
  is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name in ('products', 'services')
  and column_name = 'hidden_at'
order by table_name;
