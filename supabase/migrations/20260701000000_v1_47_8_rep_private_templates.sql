-- ─────────────────────────────────────────────────────────────────────────
-- v1.47.8 — Rep-private "save as template"
-- ─────────────────────────────────────────────────────────────────────────
--
-- WHY (Grasshopper's GAP, 2026-06-05): when a rep edits a template's body and
-- goes to send, that edited message IS a new template. Instead of stashing an
-- anonymous body, the rep should NAME it and have it become a reusable template
-- they can pick again later. Templates were previously a global, admin-curated
-- library only (owner = nobody). This adds REP-PRIVATE templates alongside the
-- shared library, in the SAME table so the picker + send engine read one source.
--
-- DESIGN
--   - owner_rep_user_id: NULL = global/admin-curated library row (the original
--     behavior, untouched). SET = a template a rep saved; visible only to that
--     rep, shown under a "My templates" group in their picker.
--   - name: the display name the rep types on save. Global templates are still
--     identified by channel and leave this NULL.
--   - No change to the partial unique index outreach_templates_active_unique
--     (icp, channel, audience) WHERE is_active: rep templates are inserted with
--     a GENERATED-unique channel slug (e.g. 'my_<rand>') by the save server fn,
--     so they never collide with the global library or with each other. Keeping
--     the index as-is preserves the global "one active per (icp,channel)" rule.
--   - Send path is unchanged: getActiveTemplateInternal still resolves by
--     (icp, channel, audience, is_active); a rep template just has a unique
--     channel, so it resolves to exactly that row.
--
-- TO RUN
--   Paste into the Supabase SQL editor on production. Per
--   [[feedback-migrations-via-dashboard]] — never `supabase db push`.
-- ─────────────────────────────────────────────────────────────────────────

begin;

alter table public.outreach_templates
  add column if not exists owner_rep_user_id uuid
    references auth.users(id) on delete cascade,
  add column if not exists name text;

-- Picker hot path: a rep's own templates (owner = them), scoped by audience +
-- active. Partial so the index stays small (only rep-owned rows).
create index if not exists outreach_templates_owner_idx
  on public.outreach_templates (owner_rep_user_id, audience, is_active)
  where owner_rep_user_id is not null;

comment on column public.outreach_templates.owner_rep_user_id is
  'NULL = global/admin-curated library template (original behavior). Set = a rep-private template the rep saved from an edited message; visible only to that rep, grouped as "My templates" in their picker.';
comment on column public.outreach_templates.name is
  'Display name for rep-private templates (the rep names it on save). Global templates are identified by channel and leave this NULL.';

commit;

-- ── PostgREST schema reload ─────────────────────────────────────────────
notify pgrst, 'reload schema';

-- ── Verify (paste-friendly) ──────────────────────────────────────────────
-- select column_name, data_type, is_nullable
--   from information_schema.columns
--  where table_schema = 'public' and table_name = 'outreach_templates'
--    and column_name in ('owner_rep_user_id', 'name')
--  order by ordinal_position;
--
-- select indexname from pg_indexes
--  where schemaname = 'public' and indexname = 'outreach_templates_owner_idx';
--
-- -- Globals are untouched (owner NULL):
-- select count(*) as global_templates
--   from public.outreach_templates where owner_rep_user_id is null;
