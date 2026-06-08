-- v1.91.0 — Manufacturer Import → RewardSignal (Patient-Profitability OS · P0).
-- ─────────────────────────────────────────────────────────────────────────────
-- A manufacturer "rewards" export (Evolus Patient Insights, Allergan Allē,
-- Galderma ASPIRE) is a per-patient SNAPSHOT of loyalty status per brand —
-- NOT a transaction log. We ingest it, match each patient to the spa's own
-- patient graph (knowledge_nodes), and surface the money-on-the-table the
-- manufacturer's own 0-click email never moves. This feeds Phase 1 (Recall).
--
-- Keyed by user_id (consistent with knowledge_nodes / patient_transactions),
-- not tenant_id. All access is via the service-role admin() client in
-- manufacturer-reward-ingest.functions.ts, so RLS is service-role-only —
-- same posture as the scheduling tables.

-- 1. One row per CSV upload — the import receipt, persisted.
create table if not exists public.reward_signal_imports (
  id                    uuid        primary key default gen_random_uuid(),
  user_id               uuid        not null,
  manufacturer          text        not null,            -- 'evolus' | 'abbvie' | 'galderma'
  program               text,                            -- 'Evolus Rewards'
  source_filename       text,
  row_count             integer     not null default 0,  -- CSV data rows (patients)
  entry_count           integer     not null default 0,  -- reward entries produced (patient×brand)
  matched_count         integer     not null default 0,  -- entries linked to a patient node
  new_contacts_count    integer     not null default 0,  -- entries with contact but no matched patient
  contacts_filled_count integer     not null default 0,  -- matched patients whose blank phone/email we filled
  imported_at           timestamptz not null default now(),
  created_at            timestamptz not null default now()
);

create index if not exists reward_signal_imports_user_idx
  on public.reward_signal_imports (user_id, imported_at desc);

alter table public.reward_signal_imports enable row level security;
do $$ begin
  create policy "service_role_reward_signal_imports"
    on public.reward_signal_imports for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

-- 2. Per patient × brand snapshot. Upsert-latest on (user, manufacturer,
--    brand_product, match_key) so a re-uploaded export collapses onto one
--    row per patient-brand; row_hash lets the server skip unchanged rows.
create table if not exists public.patient_reward_entries (
  id                uuid          primary key default gen_random_uuid(),
  user_id           uuid          not null,
  import_id         uuid          references public.reward_signal_imports(id) on delete set null,
  patient_node_id   uuid          references public.knowledge_nodes(id) on delete set null,
  manufacturer      text          not null,
  program           text,
  brand_product     text          not null,              -- 'Jeuveau' | 'Evolysse Form & Smooth'
  product_kind      text,                                -- 'toxin' | 'filler'
  status_raw        text,                                -- vendor string, verbatim
  status_norm       text          not null default 'unknown', -- eligible|expiring_soon|expired|not_yet_eligible|unknown
  eligible_date     date,
  expiration_date   date,
  reward_amount_usd numeric(12,2),
  contact_name      text,
  contact_phone     text,
  contact_email     text,
  zip               text,
  last_visit        date,
  member_since      date,
  total_checkins    integer,
  match_key         text          not null,              -- e:<email> | p:<phone10> | n:<name-tokens> | u:unknown
  row_hash          text          not null,
  created_at        timestamptz   not null default now(),
  updated_at        timestamptz   not null default now(),
  unique (user_id, manufacturer, brand_product, match_key)
);

create index if not exists patient_reward_entries_user_status_idx
  on public.patient_reward_entries (user_id, status_norm);
create index if not exists patient_reward_entries_user_exp_idx
  on public.patient_reward_entries (user_id, expiration_date);
create index if not exists patient_reward_entries_node_idx
  on public.patient_reward_entries (user_id, patient_node_id);

alter table public.patient_reward_entries enable row level security;
do $$ begin
  create policy "service_role_patient_reward_entries"
    on public.patient_reward_entries for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

notify pgrst, 'reload schema';

-- Verify (run after applying):
-- select count(*) from public.reward_signal_imports;
-- select status_norm, count(*) from public.patient_reward_entries group by status_norm order by 2 desc;
-- select count(*) filter (where patient_node_id is not null) as matched,
--        count(*) filter (where patient_node_id is null)     as unmatched
--   from public.patient_reward_entries;
