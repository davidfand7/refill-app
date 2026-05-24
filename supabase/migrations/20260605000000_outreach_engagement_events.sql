-- ─────────────────────────────────────────────────────────────────────────
-- v394 — Outreach engagement events (prospect-side mirror of tenant_engagement_events)
-- ─────────────────────────────────────────────────────────────────────────
--
-- WHY A SIBLING TABLE INSTEAD OF EXTENDING tenant_engagement_events
--   Prospects aren't tenants. Until a prospect signs up at /start, they
--   have no tenant_id. tenant_engagement_events has tenant_id NOT NULL by
--   design (it's a tenant-scoped table; queries fan out by tenant_id all
--   the time). Loosening that constraint would degrade tenant-scoped
--   query semantics across the codebase for every existing caller.
--
--   The sibling table keeps both scopes clean:
--     - tenant_engagement_events: tenant-scoped (drips, offers, post-signup)
--     - outreach_engagement_events: prospect-scoped (cold sends, replies)
--
--   When a prospect converts (signs up), we record converted_tenant_id
--   on the outreach_engagement_events row so analytics can correlate
--   pre-signup outreach with post-signup engagement.
--
-- KEY DECISIONS
--   - id is a UUID — used directly as the plus-address Reply-To token,
--     same pattern as tenant_engagement_events for drips
--   - rendered_subject / rendered_body store the POST-SUBSTITUTION text
--     that actually went out (so analytics + replays see what the recipient
--     saw, not the template)
--   - template_id is a soft FK to outreach_templates — survives template
--     edits (ON DELETE SET NULL) so historical sends keep their snapshot
--   - send_mode tracks 'dry_run' (system bench), 'test' (operator preview),
--     or 'live' (real outbound). Three modes are different audit categories
--   - resend_email_id is populated only when send_mode='live' (Resend
--     wasn't actually called for dry_run/test)
--   - Partial unique index on (recipient_email, template_id) WHERE
--     send_mode='live' prevents accidental double-sends of the same live
--     template to the same recipient. dry_run and test can repeat freely.
--
-- REPLY ROUTING
--   The inbound dispatcher at /api/resend/inbound calls
--   routeInboundOutreachReply after the drip handler. The plus-address
--   token is this row's id (a UUID). The outreach handler looks up the
--   row directly and stamps response_text + response_received_at.
--
-- PER [[project_outreach_paused]] no outbound email actually fires until
-- Grasshopper signals — v394 stubs the pipeline but defaults send_mode to
-- 'dry_run'. The OUTREACH_LIVE env flag is the only thing that changes
-- mode behavior.
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists public.outreach_engagement_events (
  id                       uuid        primary key default gen_random_uuid(),

  -- ── Recipient (prospect-side, not a tenant yet) ─────────────────────
  recipient_email          text        not null,
  recipient_first_name     text,
  recipient_last_name      text,

  -- Free-form sourcing context — "Met at Allergan dinner 2024",
  -- "Acuity user via inurl: search", etc. Useful for audit + per-source
  -- conversion analysis later.
  source_context           text,

  -- ── Template snapshot ───────────────────────────────────────────────
  -- Soft FK so historical engagement rows survive template deletions /
  -- replacements. The rendered_* columns below preserve what was sent
  -- even if the template gets edited later.
  template_id              uuid        references public.outreach_templates(id) on delete set null,
  icp                      smallint    not null check (icp in (1, 2, 3)),
  channel                  text        not null,

  -- ── Send tracking ───────────────────────────────────────────────────
  send_mode                text        not null
                            check (send_mode in ('dry_run', 'test', 'live')),
  -- Set only when send_mode='live' and Resend returned an id.
  resend_email_id          text,
  -- The post-substitution copy that actually went out. Null subject is
  -- allowed for loom_script channel (which has no subject).
  rendered_subject         text,
  rendered_body            text        not null,

  -- ── Timing ──────────────────────────────────────────────────────────
  sent_at                  timestamptz not null default now(),
  opened_at                timestamptz,
  clicked_at               timestamptz,

  -- ── Reply tracking ──────────────────────────────────────────────────
  response_text            text,
  response_received_at     timestamptz,

  -- ── Conversion linkage ──────────────────────────────────────────────
  -- Populated when this prospect signs up at /start and a tenant_memberships
  -- row gets created tying them to their new tenant.
  converted_tenant_id      uuid        references public.tenants(id) on delete set null,
  converted_at             timestamptz,

  -- ── Audit ───────────────────────────────────────────────────────────
  sent_by                  uuid        references auth.users(id) on delete set null,
  created_at               timestamptz not null default now()
);

-- Live-mode dedup: don't send the same template to the same recipient
-- live twice. dry_run/test paths can repeat freely (those don't fire
-- email). Partial index avoids polluting the index with the noisy
-- bench-mode rows.
create unique index if not exists outreach_eng_live_dedup
  on public.outreach_engagement_events (recipient_email, template_id)
  where send_mode = 'live';

-- Sorted-by-recency queries (admin recent-sends panel, future v2).
create index if not exists outreach_eng_sent_idx
  on public.outreach_engagement_events (sent_at desc);

-- Per (icp, channel, mode) analytics (open rates, reply rates per variant).
create index if not exists outreach_eng_icp_channel_idx
  on public.outreach_engagement_events (icp, channel, send_mode);

-- Replies queryable by id (already PK, but explicit for the inbound router
-- which does eq("id", token) lookups). PK serves this.

comment on table public.outreach_engagement_events is
  'Prospect-side engagement log for cold outreach. Sibling to tenant_engagement_events. Tracks what was sent (rendered snapshot), to whom, in what mode, and whether they replied or converted. Plus-address Reply-To token = id.';

comment on column public.outreach_engagement_events.send_mode is
  'dry_run = system bench (no email), test = operator preview (no email, UI shows rendered), live = real Resend POST.';

comment on column public.outreach_engagement_events.template_id is
  'Soft FK — historical sends survive template edits. The rendered_* columns preserve the exact text that went out.';

-- ── RLS ─────────────────────────────────────────────────────────────────
-- Service-role only. All access through admin-gated server fns.

alter table public.outreach_engagement_events enable row level security;

do $$ begin
  create policy "service_role_outreach_engagement_events"
    on public.outreach_engagement_events for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

notify pgrst, 'reload schema';

-- ── Verify (paste-friendly) ──────────────────────────────────────────────
-- select column_name, data_type, is_nullable
--   from information_schema.columns
--  where table_schema='public' and table_name='outreach_engagement_events'
--  order by ordinal_position;
--
-- select indexname from pg_indexes
--  where schemaname='public' and tablename='outreach_engagement_events';
