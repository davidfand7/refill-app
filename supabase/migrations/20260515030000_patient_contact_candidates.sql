-- Patient Architecture P1.5 — client-list contact candidates.
--
-- The QuickBooks "Sales by Patient Detail" CSV doesn't carry phone / email /
-- "banned" — those live in a SEPARATE export from the spa's scheduling
-- software. This table is the parsed, deduped landing zone for the client
-- list, so phone/email/banned can be cross-matched into patient nodes AND
-- the unmatched rows stay queryable for fuzzy-match suggestions.
--
-- Why a relational table and not just attachments on knowledge_nodes:
--   - 1,500+ rows per spa is too many for the graph-style nodes pattern.
--   - The fuzzy-match panel needs a SQL surface (Levenshtein lookup) rather
--     than scanning a json array.
--   - The 661 clients-no-sales bucket needs somewhere to live until the spa
--     owner reviews them; the patient table is reserved for confirmed
--     patient identities.
--
-- Linkage flow:
--   1. Client list upload → upsert one row per normalized_name into this table.
--   2. Exact-match step → for each candidate whose normalized_name matches an
--      existing patient knowledge_node, link via linked_patient_node_id and
--      write phone/email/banned/days_since_last_appointment onto the patient's
--      attachments.summary.
--   3. Fuzzy-match panel → for candidates with no exact match, run
--      Levenshtein ≤ 2 on last name + first-letter on first name → propose
--      pairings. Spa owner confirms → same link path runs.
--   4. Unmatched (no candidate proposal accepted) candidates stay in this
--      table with status='unmatched' for future review.
--
-- Established 2026-05-15 (Patient Architecture P1.5).

create table if not exists public.patient_contact_candidates (
  id                          uuid        primary key default gen_random_uuid(),
  user_id                     uuid        not null references auth.users(id) on delete cascade,
  -- "Last, First" canonical display string (built from client list "First Name"
  -- + "Last Name" columns at parse time).
  display_name                text        not null,
  -- Same normalization rule as patient knowledge_nodes lookup_key.
  normalized_name             text        not null,
  first_name                  text,
  last_name                   text,
  -- E.164 normalized (+1XXXXXXXXXX). NULL when the source was blank.
  phone                       text,
  -- As-captured for audit (the client list emits three formats).
  phone_raw                   text,
  email                       text,
  notes                       text,
  -- Sourced from the client list's "Days Since Last Appointment" column.
  days_since_last_appointment integer,
  banned                      boolean     not null default false,
  -- 'matched' | 'unmatched' | 'manual-add' | 'dismissed'
  --   matched     — linked to a patient knowledge_node (exact or confirmed-fuzzy)
  --   unmatched   — no purchase history in the sales CSV, awaiting review
  --   manual-add  — spa owner added contact info for a patient w/o a client row
  --   dismissed   — spa owner explicitly rejected the candidate (e.g. junk row)
  status                      text        not null default 'unmatched',
  linked_patient_node_id      uuid        references public.knowledge_nodes(id) on delete set null,
  -- Audit trail: which CSV + which row.
  source_filename             text,
  source_row                  integer,
  imported_at                 timestamptz not null default now(),
  linked_at                   timestamptz,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),

  constraint patient_contact_candidates_user_name_unique
    unique (user_id, normalized_name),
  constraint patient_contact_candidates_status_check check (
    status in ('matched', 'unmatched', 'manual-add', 'dismissed')
  )
);

alter table public.patient_contact_candidates enable row level security;

do $$ begin
  create policy "users_own_patient_contact_candidates"
    on public.patient_contact_candidates for all
    using  (auth.uid() = user_id)
    with check (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "service_role_patient_contact_candidates"
    on public.patient_contact_candidates for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

-- Fuzzy-match panel scan: pull unmatched candidates for a user, ordered by
-- last name so consecutive scans hit the same Postgres pages.
create index if not exists patient_contact_candidates_unmatched_idx
  on public.patient_contact_candidates (user_id, last_name)
  where status = 'unmatched';

-- Banned-filter scan: any outbound code path filters here before sending.
create index if not exists patient_contact_candidates_banned_idx
  on public.patient_contact_candidates (user_id)
  where banned = true;

-- Linked-row lookup: from a patient node id back to its candidate row (for
-- "remove this contact info" / "this contact is wrong" flows in P2).
create index if not exists patient_contact_candidates_linked_idx
  on public.patient_contact_candidates (user_id, linked_patient_node_id)
  where linked_patient_node_id is not null;

comment on table public.patient_contact_candidates is
  'Parsed rows from the spa''s client-list CSV. Some rows link to a patient knowledge_node (matched), others stay here awaiting human review (unmatched / manual-add). Spa-scoped via RLS; reps never see this table.';
