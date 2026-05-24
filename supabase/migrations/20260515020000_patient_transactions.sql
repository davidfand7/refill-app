-- Patient Architecture P1 — line-item transaction store for Emma(OS).
--
-- Backs the spa-side patient book ingested from QuickBooks "Sales by Patient
-- Detail" exports. Identity + summary live in knowledge_nodes (node_type
-- 'patient', context 'patients'); the per-line transaction grain lives here.
--
-- The 80%-multi-line-invoice rule + the loyalty redemption pattern (Evolus
-- Reward as a negative-amount line attached to the Jeuveau purchase) mean
-- invoice-aggregation flattens the strongest cohort signal in the dataset.
-- Per-line grain is structural, not preference. See Patient-Architecture-
-- Design.html on Desktop for the full design pass.
--
-- Idempotency: re-uploading the same CSV is safe. The unique constraint
-- (user_id, patient_node_id, transaction_date, invoice_num, product_name,
-- line_index) collapses re-imports to no-ops.
--
-- Tenant boundary: every row is scoped by spa user_id with RLS. Reps NEVER
-- see this table directly; cross-tenant access happens only via aggregated
-- server functions gated by per-rep consent (Phase 4).
--
-- Established 2026-05-15 (Patient Architecture P1).

create table if not exists public.patient_transactions (
  id                   uuid        primary key default gen_random_uuid(),
  user_id              uuid        not null references auth.users(id) on delete cascade,
  patient_node_id      uuid        not null references public.knowledge_nodes(id) on delete cascade,
  transaction_date     date        not null,
  -- QuickBooks "Num" column; many older rows have no invoice number, so the
  -- column is nullable. The unique constraint below uses coalesce to keep
  -- "no invoice" rows from collapsing into a single line.
  invoice_num          text,
  -- Ordinal within an invoice (0,1,2…). Lets two identical product lines on
  -- the same invoice coexist without violating the unique constraint.
  line_index           integer     not null default 0,
  product_name         text        not null,
  -- Resolved via src/lib/product-manufacturer-map.ts. NULL for unknowns —
  -- they surface in an admin queue for human review.
  product_manufacturer text,
  -- 'toxin' | 'filler' | 'device' | 'retail' | 'reward' | 'payment' |
  -- 'discount' | 'note'. Distinguishes negative-amount loyalty redemptions
  -- from refunds for downstream analysis (see Decision 6 in the design doc).
  product_kind         text,
  description          text,
  -- Nullable because some rows (services, notes) ship with empty quantity.
  quantity             numeric,
  unit_price_usd       numeric,
  -- Positive = charged; negative = redemption / refund / discount.
  amount_usd           numeric     not null,
  -- Running balance as captured by QuickBooks (informational only).
  balance_usd          numeric,
  source               text        not null default 'quickbooks-csv',
  -- Filename + 1-based source row, for audit traceability back to the CSV.
  source_ref           text,
  created_at           timestamptz not null default now(),

  -- Idempotency key — re-uploading the same CSV is a no-op.
  constraint patient_transactions_dedupe_unique unique
    (user_id, patient_node_id, transaction_date, invoice_num, product_name, line_index)
);

alter table public.patient_transactions enable row level security;

do $$ begin
  create policy "users_own_patient_transactions"
    on public.patient_transactions for all
    using  (auth.uid() = user_id)
    with check (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "service_role_patient_transactions"
    on public.patient_transactions for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

-- Patient detail view (P2): all lines for one patient, newest first.
create index if not exists patient_transactions_by_patient_idx
  on public.patient_transactions (user_id, patient_node_id, transaction_date desc);

-- Cohort filters (P3): "how many Jeuveau patients in the last quarter".
create index if not exists patient_transactions_by_manufacturer_idx
  on public.patient_transactions (user_id, product_manufacturer, transaction_date desc)
  where product_manufacturer is not null;

-- Recent activity / "Today" cards.
create index if not exists patient_transactions_by_date_idx
  on public.patient_transactions (user_id, transaction_date desc);

comment on table public.patient_transactions is
  'Line-item patient transaction store for Emma(OS). One row per CSV line. Patient identity + summary live in knowledge_nodes (node_type=''patient''); aggregations queried here. Spa-scoped via RLS; reps never see this table directly.';
