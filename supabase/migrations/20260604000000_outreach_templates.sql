-- ─────────────────────────────────────────────────────────────────────────
-- v393 — Outreach template store (DB-as-source-of-truth for outreach copy)
-- ─────────────────────────────────────────────────────────────────────────
--
-- WHY THIS EXISTS
--   Grasshopper will iterate constantly on outreach copy (subject lines, body
--   tone, Loom scripts) and does not want to ask an engineer for every
--   tweak. v393 moves outreach text OUT of TypeScript files into the DB,
--   with an admin UI for inline edits and bulk-import from the polished
--   HTML doc on Desktop.
--
-- THE MODEL
--   One row per (icp, channel) where channel is a free-form key like
--   'loom_script', 'email_a', 'email_b', 'email_followup_3' etc. Versioning
--   via is_active flag — bulk imports create a new row (is_active=true) and
--   deactivate the prior version (is_active=false). This preserves the
--   entire history of every edit for audit and rollback.
--
-- KEY DECISIONS
--   - icp is a smallint (1, 2, 3) not text — small, fast, matches the doc
--   - channel is text not enum — lets Grasshopper add new channels (e.g.,
--     'email_referral', 'sms_v1') in the polished doc without a migration
--   - subject is nullable (loom_script and SMS variants don't have subjects)
--   - body is required and text (no length cap — long Loom scripts are fine)
--   - loom_url is optional (only populated after the video is recorded)
--   - notes is internal — never sent, surfaces in admin UI for context
--   - The partial unique index on (icp, channel) WHERE is_active enforces
--     "exactly one active version per slot" while still allowing the full
--     version history to live alongside
--
-- SEND-TIME CONTRACT (for the future sending ship)
--   const tpl = await getActiveTemplate({ icp: 2, channel: 'email_a' });
--   const subject = renderPlaceholders(tpl.subject, prospect);
--   const body = renderPlaceholders(tpl.body, prospect);
--   // ...Resend POST with plus-addressed Reply-To
--
-- PER [[project_outreach_paused]] this ship lands the substrate but no
-- outbound email actually fires until Grasshopper signals outreach is live.
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists public.outreach_templates (
  id           uuid        primary key default gen_random_uuid(),

  -- 1 = Karen's network, 2 = tier-2 independents, 3 = Acuity users.
  -- The semantic mapping lives in the polished outreach doc; this column
  -- just stores the integer.
  icp          smallint    not null check (icp in (1, 2, 3)),

  -- Channel key — free-form so new channels can land via doc upload
  -- without a migration. Established v393 set: 'loom_script', 'email_a',
  -- 'email_b', 'email_followup_3', 'email_followup_4', 'email_followup_12'.
  channel      text        not null,

  -- Email subject line (null for loom_script and any future no-subject channels).
  subject      text,

  -- The actual copy. For email channels this is the body HTML/text. For
  -- loom_script this is the full talking-head script with timestamps.
  body         text        not null,

  -- Optional Loom video URL (populated after the video is recorded). Only
  -- meaningful when channel='loom_script'.
  loom_url     text,

  -- Internal notes — surfaces in admin UI for context, never sent.
  notes        text,

  -- Versioning. Each bulk-import or inline edit creates a new row and
  -- deactivates the prior version for (icp, channel). version increments
  -- monotonically per slot.
  version      integer     not null default 1,
  is_active    boolean     not null default true,

  -- Who/when. updated_at is set by the application code (server fns) on
  -- every write — no DB trigger because the count of writers is small and
  -- explicit assignment is easier to audit.
  created_by   uuid        references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Exactly one active version per (icp, channel). Allows multiple historical
-- rows for audit while enforcing single source of truth at send-time.
create unique index if not exists outreach_templates_active_unique
  on public.outreach_templates (icp, channel)
  where is_active;

-- Lookup index for the send-time hot path: getActiveTemplate(icp, channel).
create index if not exists outreach_templates_lookup_idx
  on public.outreach_templates (icp, channel, is_active);

-- History queries.
create index if not exists outreach_templates_updated_idx
  on public.outreach_templates (updated_at desc);

comment on table public.outreach_templates is
  'Source of truth for outreach copy (subjects, bodies, Loom scripts) by ICP + channel. Editable inline via /app/admin/outreach OR bulk-imported from the polished Refill-Outreach-Pack-v1.html doc. Versioned via is_active flag; partial unique index enforces one-active-per-slot.';

comment on column public.outreach_templates.icp is
  '1=Karen network (warm), 2=tier-2 indep (cold), 3=Acuity users (warm-tech). Semantic mapping lives in the outreach pack doc.';

comment on column public.outreach_templates.channel is
  'Free-form channel key. Established set: loom_script, email_a, email_b, email_followup_N. Adding new channels does not require a migration — just upload a doc with the new data-channel attribute.';

-- ── RLS ─────────────────────────────────────────────────────────────────
-- Service-role only. All access goes through admin-gated server fns
-- (src/server/refill-outreach.ts) which do requireAdmin via user_roles.
-- Direct client access (anon/authenticated) is denied — outreach copy
-- is an admin surface, not a tenant surface.

alter table public.outreach_templates enable row level security;

do $$ begin
  create policy "service_role_outreach_templates"
    on public.outreach_templates for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

-- ── PostgREST schema reload ─────────────────────────────────────────────

notify pgrst, 'reload schema';

-- ── Verify (paste-friendly) ──────────────────────────────────────────────
-- Run after the migration completes to confirm the table + indexes landed:
--
-- select column_name, data_type, is_nullable
--   from information_schema.columns
--  where table_schema='public' and table_name='outreach_templates'
--  order by ordinal_position;
--
-- select indexname from pg_indexes
--  where schemaname='public' and tablename='outreach_templates';
--
-- -- After Po imports the v1 doc via /app/admin/outreach, this query shows
-- -- the seeded templates (should be 12):
-- select icp, channel, version,
--        coalesce(subject, '(no subject)') as subject_preview,
--        length(body) as body_chars
--   from public.outreach_templates
--  where is_active
--  order by icp, channel;
