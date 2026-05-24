-- Reports v1 — schema for named, versioned tabular datasets uploaded by reps.
--
-- A "Report" is a named dataset (e.g. "Galderma Accounts — L Territory")
-- backed by a CSV/XLS export from a manufacturer portal. Re-uploading the
-- same report by key REPLACES the prior version (insert new rows, update
-- existing, DELETE orphans). This is what the Knowledge Base enrichment
-- v304 generic-CSV path was missing: a stable identity for the dataset
-- across versions, and orphan deletion when rows fall off a re-upload.
--
-- Two tables:
--   report_uploads — one row per (user, report_key). Holds metadata +
--                    the saved column_mapping so re-uploads pick up where
--                    the user left off.
--   report_rows    — one row per data row in the CSV. lookup_key is the
--                    stable identity within a report (e.g. MKID or
--                    slugified Outlet Name); data is the full row jsonb.
--
-- Future projection: a recognized report_type (e.g. 'galderma-accounts')
-- will project report_rows into knowledge_nodes with node_type='account'
-- so Liz can query report data via the memory-graph tool. v307 is data-
-- layer only; projection ships in v308 alongside the upload UI.
--
-- Established 2026-05-12 (Reports v1 foundation).

create table if not exists public.report_uploads (
  id                  uuid        primary key default gen_random_uuid(),
  user_id             uuid        not null references auth.users(id) on delete cascade,
  report_key          text        not null,
  report_label        text        not null,
  -- Optional type hint — 'galderma-accounts', 'allergan-accounts', etc.
  -- When set + recognized, server fns project rows into knowledge_nodes.
  report_type         text,
  -- jsonb shape: {
  --   header_row_index: 1,                        // 0-based; 1 means row 2 is the header
  --   unique_key: { kind: 'column' | 'source_row', column?: 'MKID' },
  --   columns: { 'MKID': 'unique_key', 'Outlet Name': 'title', ... }
  -- }
  column_mapping      jsonb       not null default '{}'::jsonb,
  source_filename     text,
  -- last diff result: { created, updated, unchanged, removed }
  last_diff_summary   jsonb       not null default '{}'::jsonb,
  row_count           integer     not null default 0,
  last_uploaded_at    timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint report_uploads_user_key_unique unique (user_id, report_key),
  constraint report_uploads_report_key_check check (
    char_length(report_key) between 1 and 200
    and report_key ~ '^[a-z0-9][a-z0-9_-]*$'
  )
);

alter table public.report_uploads enable row level security;

do $$ begin
  create policy "users_own_report_uploads"
    on public.report_uploads for all
    using  (auth.uid() = user_id)
    with check (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "service_role_report_uploads"
    on public.report_uploads for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

create index if not exists report_uploads_recent_idx
  on public.report_uploads (user_id, last_uploaded_at desc nulls last);

create index if not exists report_uploads_type_idx
  on public.report_uploads (user_id, report_type)
  where report_type is not null;

-- ── rows ────────────────────────────────────────────────────────────────────

create table if not exists public.report_rows (
  id                  uuid        primary key default gen_random_uuid(),
  report_upload_id    uuid        not null references public.report_uploads(id) on delete cascade,
  -- Denormalized for RLS efficiency — RLS checks user_id directly without a
  -- join into report_uploads. Kept in sync via server fns on insert.
  user_id             uuid        not null references auth.users(id) on delete cascade,
  -- Stable identity within this report. For Galderma it's typically MKID;
  -- when MKID is blank (anonymized seeds) we fall back to Outlet Name slug.
  lookup_key          text        not null,
  -- 1-based source row number in the original CSV (for human-friendly
  -- error messages and diff display).
  source_row          integer,
  -- Full row payload — header → cell value, all strings (numeric coercion
  -- happens at query-time, not import-time, so we never lose precision).
  data                jsonb       not null,
  -- sha256 of canonicalized data — used to detect "this row already existed
  -- and didn't change" so re-uploads only touch rows that actually moved.
  content_hash        text        not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint report_rows_report_key_unique unique (report_upload_id, lookup_key)
);

alter table public.report_rows enable row level security;

do $$ begin
  create policy "users_own_report_rows"
    on public.report_rows for all
    using  (auth.uid() = user_id)
    with check (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "service_role_report_rows"
    on public.report_rows for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

create index if not exists report_rows_by_report_idx
  on public.report_rows (report_upload_id, lookup_key);

create index if not exists report_rows_by_user_idx
  on public.report_rows (user_id, report_upload_id);

create index if not exists report_rows_content_hash_idx
  on public.report_rows (report_upload_id, content_hash);

comment on table public.report_uploads is
  'A named, versioned tabular dataset uploaded by a rep. Re-uploads diff against the prior version by lookup_key — insert new, update changed, delete orphans.';

comment on table public.report_rows is
  'One row per data row in a report CSV. lookup_key is the stable identity within a report; data is the full row payload as jsonb.';
