-- v1.34.2: rebate_inventory_units — unit-lifecycle table for the Recognition
-- Allocation Engine. Each row tracks the deploy lifecycle of an inventory
-- knowledge_node (either node_type='rebate_inventory_documented' or
-- node_type='rebate_inventory_anonymous'). The node holds declarative
-- metadata (manufacturer, SKU, source provenance); this table holds the
-- mutable units_total / units_deployed state.
--
-- 1:1 with the inventory node (unique node_id). New earning events =
-- new nodes + new rows, preserving the per-event audit trail (rather
-- than mutating an existing node's total).
--
-- Established 2026-06-02 per Recognition Allocation Engine spec v0.1
-- (see Desktop/Refill-Recognition-Allocation-Engine-Spec-v0_1.html).
--
-- Compliance / documentation-wall note: the wall holds at SCHEMA level.
-- There is NO 'reps' table, NO 'deals' table, NO per-row provenance link
-- to a specific verbal deal. The inventory data alone is documentable
-- (manufacturer + SKU + units + optional portal source); the deal
-- context (rep, quota-bridging, off-the-record sample currency) lives
-- entirely in Karen's head per the scout we did 2026-06-02.
--
-- Related schema: knowledge_nodes (generic JSONB substrate). Two new
-- node_types are introduced at the application layer with no migration
-- needed:
--   - 'rebate_inventory_documented' (portal-issued, with provenance in
--     attachments: manufacturer, program, period, source_ref)
--   - 'rebate_inventory_anonymous' (on-hand, NO provenance in attachments,
--     just brand + SKU)

create table if not exists public.rebate_inventory_units (
  id                uuid        primary key default gen_random_uuid(),
  user_id           uuid        not null references auth.users(id) on delete cascade,
  node_id           uuid        not null references public.knowledge_nodes(id) on delete cascade,

  -- The unit lifecycle. Both columns are integers (whole units; partial
  -- syringes / partial vials aren't a real-world concept).
  units_total       integer     not null check (units_total >= 0),
  units_deployed    integer     not null default 0 check (units_deployed >= 0),

  -- Audit-friendly soft delete. Allocation engine filters this OUT.
  soft_deleted_at   timestamptz,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- 1:1 with the inventory node — each earning event mints its own node
  -- + lifecycle row. Re-earning later = new node, new row, new audit trail.
  constraint rebate_inventory_units_node_unique unique (node_id),

  -- Defense: units_deployed never exceeds units_total. The allocation
  -- engine in v1.34.3 will respect this, but the DB enforces it too.
  constraint rebate_inventory_units_deploy_under_total
    check (units_deployed <= units_total)
);

alter table public.rebate_inventory_units enable row level security;

-- Tenant scope: the row's user_id must match auth.uid (or service-role bypass).
do $$ begin
  create policy "users_own_rebate_inventory_units"
    on public.rebate_inventory_units for all
    using  (auth.uid() = user_id)
    with check (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "service_role_rebate_inventory_units"
    on public.rebate_inventory_units for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

-- Hot-path index: Pool Entry surface lists a tenant's active inventory
-- ordered newest-first. Partial WHERE soft_deleted_at IS NULL keeps the
-- index narrow as deletes accumulate.
create index if not exists rebate_inventory_units_user_active_idx
  on public.rebate_inventory_units (user_id, created_at desc)
  where soft_deleted_at is null;

-- Allocation engine index (v1.34.3): find rows with units still to deploy.
-- Partial WHERE handles both soft-delete and fully-deployed exclusions.
create index if not exists rebate_inventory_units_deployable_idx
  on public.rebate_inventory_units (user_id)
  where soft_deleted_at is null and units_deployed < units_total;

notify pgrst, 'reload schema';

-- Verify:
-- select column_name, data_type
--   from information_schema.columns
--  where table_schema = 'public' and table_name = 'rebate_inventory_units'
--  order by ordinal_position;
