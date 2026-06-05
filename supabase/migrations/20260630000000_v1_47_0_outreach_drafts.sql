-- ─────────────────────────────────────────────────────────────────────────
-- v1.47.0 — Outreach drafts (per-account-draft multi-recipient composer)
-- ─────────────────────────────────────────────────────────────────────────
--
-- WHY THIS EXISTS
--   Today rep Outreach (src/routes/app.rep.outreach.tsx) is a single-recipient
--   SendPanel: the rep free-types ONE email + first name, optionally inline-
--   edits the body (an in-memory bodyOverride that EVAPORATES on navigate-away,
--   discovered in the 2026-06-05 smoke walk), and sends. There is no way to
--   save an edit without sending, and no way to stack/load multiple recipients.
--
--   v1.47.0 turns that panel into a per-account-draft, multi-recipient composer
--   under the LOCKED edit model A: one shared composed body applies to the whole
--   batch via placeholder substitution; the rep opens ONLY the recipients they
--   want to hand-tweak and saves those as per-account overrides. This table is
--   the persistence substrate for that.
--
-- THE MODEL — one flat table, NO batch entity
--   A recipient is fully described by (email, first name, spa name) + optional
--   override = exactly one row. Model A has no cross-recipient state to
--   coordinate, so a separate recipient_lists table would add a join and a
--   lifecycle with zero payoff. The recipient SET is simply "all unsent draft
--   rows for (rep, template)." A nullable batch_label gives optional grouping
--   without a second table.
--
-- KEY DECISIONS
--   - Key (rep_user_id, recipient_email, template_id) — email-keyed NOW,
--     Zoho-contact-FORWARD via a nullable contact_id added now so the future
--     zoho_contacts backfill needs no second migration.
--   - recipient_email is stored LOWERCASED by the server fn (saveOutreachDraft /
--     saveOutreachDraftsBulk). The plain unique index below then doubles as the
--     dedup guard — same convention as outreach_engagement_events' dedup index,
--     and keeps the upsert `on conflict` target dead simple.
--   - subject_override / body_override are NULLABLE. NULL = "use the batch's
--     shared subject/body." Send-time resolution is the identical tri-state to
--     today's single-send (refill-outreach-send.ts): override ?? shared, then
--     substitutePlaceholders. Just sourced from a row instead of a form field.
--   - icp / channel / audience are denormalized from the template. They are
--     immutable per draft (a template edit mints a NEW template row with a new
--     id; this draft's template_id is fixed), so there is no drift risk. They
--     let the composer + send path read send context without a join, mirroring
--     how outreach_engagement_events itself denormalizes icp/channel.
--   - audience ('spa' | 'rep') makes every column Recruit-reusable: the same
--     table + server fns + components serve rep→spa Outreach AND rep→rep Recruit
--     (P5 parity), spa_name simply goes null for audience='rep'.
--   - template_id is ON DELETE CASCADE: templates are only ever DEACTIVATED
--     (is_active=false), never hard-deleted, so the cascade is safe. A draft
--     should not outlive its template.
--   - sent_event_id / sent_at: on send we STAMP the row (link to the
--     outreach_engagement_events row + timestamp), we do NOT delete it. The rep
--     may want send history, and stamping is what makes sendOutreachBatch
--     idempotent (already-sent rows are skipped on re-click).
--
-- SEND ORCHESTRATION (decided 2026-06-05 — Grasshopper: server-batch)
--   sendOutreachBatch (server) loads unsent drafts → resolves override-vs-shared
--   → loops the shared dispatchOneOutreachEmail helper in a concurrency-3 pool
--   → stamps sent_event_id/sent_at → returns per-recipient results. One auth
--   check, one mode resolution, idempotency adjacent to send.
--
-- TO RUN
--   Paste into the Supabase SQL editor on production. Per
--   [[feedback-migrations-via-dashboard]] — never `supabase db push`.
-- ─────────────────────────────────────────────────────────────────────────

begin;

create table if not exists public.outreach_drafts (
  id                   uuid        primary key default gen_random_uuid(),

  -- Owner. Drafts are private to the rep that composed them; ownership is
  -- enforced in the server-fn WHERE (rep_user_id = principal), RLS is
  -- service-role-only below.
  rep_user_id          uuid        not null references auth.users(id) on delete cascade,

  -- The template this draft composes against. CASCADE is safe — templates are
  -- only ever deactivated, never hard-deleted.
  template_id          uuid        not null references public.outreach_templates(id) on delete cascade,

  -- Denormalized, immutable send context (see header). icp matches the
  -- outreach_templates / outreach_engagement_events convention.
  icp                  smallint    not null check (icp in (1, 2, 3)),
  channel              text        not null,
  audience             text        not null default 'spa' check (audience in ('spa', 'rep')),

  -- Recipient. recipient_email is stored LOWERCASED by the server fn so the
  -- unique index below doubles as the dedup guard.
  recipient_email      text        not null,
  recipient_first_name text,
  spa_name             text,                    -- null for audience='rep' (recruit)

  -- Zoho-forward: backfilled by email match when the zoho_contacts table lands.
  contact_id           uuid,

  -- Per-account overrides. NULL = use the batch's shared subject/body.
  subject_override     text,
  body_override        text,

  -- Optional grouping label (no second table needed for batches).
  batch_label          text,

  -- Send tracking. Stamped (not deleted) on send; powers idempotency + history.
  sent_event_id        uuid        references public.outreach_engagement_events(id) on delete set null,
  sent_at              timestamptz,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- Upsert target for Save draft + dedup guard. recipient_email is lowercased by
-- the server fn, so this enforces "one draft per (rep, recipient, template)"
-- and a re-pasted CSV hits `on conflict do nothing` rather than duplicating.
create unique index if not exists outreach_drafts_rep_recipient_template_unique
  on public.outreach_drafts (rep_user_id, recipient_email, template_id);

-- Composer hot path: listOutreachDrafts — this rep's drafts for a template,
-- newest-first.
create index if not exists outreach_drafts_composer_idx
  on public.outreach_drafts (rep_user_id, template_id, created_at desc);

-- Zoho backfill path: UPDATE ... SET contact_id WHERE recipient_email = $1.
create index if not exists outreach_drafts_email_idx
  on public.outreach_drafts (recipient_email);

comment on table public.outreach_drafts is
  'Per-account outreach drafts for the rep multi-recipient composer (v1.47.0, edit model A: shared body + per-account override). One flat row per (rep, recipient, template); the recipient SET is "all unsent rows for (rep, template)". audience-aware so Recruit reuses it. Stamped (not deleted) on send for idempotency + history.';

comment on column public.outreach_drafts.subject_override is
  'NULL = use the batch shared subject. Send resolves subject_override ?? sharedSubject, then substitutePlaceholders.';

comment on column public.outreach_drafts.body_override is
  'NULL = use the batch shared body. Send resolves body_override ?? sharedBody, then substitutePlaceholders.';

comment on column public.outreach_drafts.recipient_email is
  'Stored LOWERCASED by the server fn; the unique (rep_user_id, recipient_email, template_id) index doubles as the dedup guard.';

comment on column public.outreach_drafts.contact_id is
  'Zoho-forward. Nullable now; backfilled by email match when zoho_contacts lands (no second migration needed).';

comment on column public.outreach_drafts.sent_at is
  'Stamped on send (row is NOT deleted). Non-null = already sent; sendOutreachBatch skips these on re-click for idempotency.';

-- ── RLS ─────────────────────────────────────────────────────────────────
-- Service-role only. All access goes through rep/admin-gated server fns
-- (src/server/refill-outreach-drafts.ts) which enforce ownership in the WHERE.
-- Same posture as rep_referral_links / outreach_templates.

alter table public.outreach_drafts enable row level security;

do $$ begin
  create policy "service_role_outreach_drafts"
    on public.outreach_drafts for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

commit;

-- ── PostgREST schema reload ─────────────────────────────────────────────
notify pgrst, 'reload schema';

-- ── Verify (paste-friendly) ──────────────────────────────────────────────
-- Run after the migration completes to confirm the table + indexes landed:
--
-- select column_name, data_type, is_nullable
--   from information_schema.columns
--  where table_schema = 'public' and table_name = 'outreach_drafts'
--  order by ordinal_position;
--
-- select indexname from pg_indexes
--  where schemaname = 'public' and tablename = 'outreach_drafts'
--  order by indexname;
--
-- -- Should be empty until the composer saves its first draft:
-- select count(*) as draft_count from public.outreach_drafts;
