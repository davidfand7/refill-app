-- ═══════════════════════════════════════════════════════════════════════
-- BATCH B — Spa claim + reports + sample orders + promotions + patient base
--   18 migrations covering /claim-your-business, rep reports/sample orders,
--   promotions engine pillars 1-3, patient ledger + outreach state
-- ═══════════════════════════════════════════════════════════════════════

-- ─── 1/18 spa_claim_sessions ──────────────────────
-- Phase 4.0 W1 (Spa side) — claim-your-business onboarding session storage.
--
-- A spa owner lands on /claim-your-business, pastes their spa URL, FireCrawl
-- pulls their public site, we extract structured fields (spa name, services,
-- hours, scheduling link, policies, contact info) and stage them in a session
-- row. The owner can browse the preview anonymously; only on signup+claim do
-- we materialize knowledge_nodes stamped with their auth.users.id.
--
-- Why a separate table instead of pre-creating knowledge_nodes:
--   knowledge_nodes.user_id is NOT NULL with FK to auth.users — there is no
--   user yet at scrape time. Staging in JSON keeps the graph clean of orphan
--   pre-claim nodes and makes abandoned sessions trivially discardable.
--
-- The session id is a long random uuid; for v1 (pilot/alpha) anyone holding
-- the id can read the session. The data inside is public-website-derived
-- anyway. Hardening (per-session signed URLs, expiring tokens) lands when
-- the surface goes broader — not in v1.

create table if not exists public.spa_claim_sessions (
  id              uuid        primary key default gen_random_uuid(),
  spa_url         text        not null,
  spa_name        text,
  -- Lifecycle: queued → scraping → preview-ready → claimed (or failed at any step).
  scrape_status   text        not null default 'queued'
                    check (scrape_status in ('queued','scraping','preview-ready','claimed','failed')),
  scrape_error    text,
  -- Structured extract (SpaScrapeData shape — see src/server/spa-claim.functions.ts).
  scrape_data     jsonb,
  claimed_by      uuid        references auth.users(id) on delete set null,
  claimed_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.spa_claim_sessions enable row level security;

-- Read-only access for anyone (anon + authenticated) — session id IS the
-- bearer for pre-claim browsing. Writes go through server fns under
-- service-role; no anon INSERT/UPDATE allowed.
do $$ begin
  create policy "anon_read_spa_claim_sessions"
    on public.spa_claim_sessions for select
    using (true);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "service_role_spa_claim_sessions"
    on public.spa_claim_sessions for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

create index if not exists spa_claim_sessions_url_idx
  on public.spa_claim_sessions (spa_url, created_at desc);

create index if not exists spa_claim_sessions_claim_idx
  on public.spa_claim_sessions (claimed_by, claimed_at desc);

-- ─── 2/18 idempotent_spa_claim ───────────────────
-- v265 — Idempotent spa claim: safety net against duplicate spa-profile / services
-- nodes. Pre-v265 the claim flow used pure INSERT, so any repeat claim of the
-- same spa under the same user piled fresh nodes on top of the old ones
-- (Grasshopper saw 77 nodes accumulate on Rejuv during a dev cycle of repeat
-- test claims). v265 also rewrites the application code to do diff-based
-- upsert via materializeSpaNodes — this migration is the database-level
-- belt to that suspenders, so even a future bug or direct DB write can't
-- bring duplicates back.
--
-- Two steps:
--   1. Collapse any existing duplicates per (user_id, context, lookup_key),
--      keeping the most recently-updated row. Required before step 2 — the
--      unique index would otherwise refuse to apply.
--   2. Add a partial unique index covering only the contexts where lookup_key
--      acts as a stable identity ('spa-profile' scalars + 'services' by slug).
--      'policies' is excluded because it has no stable key (free-form text;
--      handled at the app layer by replace-all on save).

-- ── Step 1: dedupe ─────────────────────────────────────────────────────────
-- For each (user_id, context, lookup_key) where context is one of the two
-- targeted contexts and lookup_key is non-null, keep the row with the most
-- recent updated_at (tie-break by created_at desc, then id desc for total
-- determinism). Delete the rest.
with ranked as (
  select
    id,
    row_number() over (
      partition by user_id, context, lookup_key
      order by updated_at desc nulls last, created_at desc, id desc
    ) as rn
  from public.knowledge_nodes
  where context in ('spa-profile', 'services')
    and lookup_key is not null
)
delete from public.knowledge_nodes
where id in (
  select id from ranked where rn > 1
);

-- ── Step 2: partial unique index ───────────────────────────────────────────
-- Enforces "one row per (user, context, lookup_key)" for spa-profile scalars
-- and services. Partial so we don't index every knowledge_nodes row
-- unnecessarily, and so other contexts that legitimately allow duplicates
-- (or NULL lookup_keys) aren't constrained.
create unique index if not exists knowledge_nodes_spa_lookup_unique_idx
  on public.knowledge_nodes (user_id, context, lookup_key)
  where context in ('spa-profile', 'services')
    and lookup_key is not null;

-- ─── 3/18 reports ────────────────────────────────
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

-- ─── 4/18 reports_undo ───────────────────────────
-- Reports v1 — 24-hour undo support.
--
-- Adds two columns to report_uploads so the v309 upload UI can offer an
-- "undo within 24h" affordance after a re-upload. The snapshot captures
-- the rows that were inserted / updated / removed in the most recent
-- upsertReport call so undoReportUpload can replay the prior state
-- without needing a row-history table.
--
-- prior_snapshot shape:
--   {
--     insertedIds:  uuid[],            // rows we inserted (delete on undo)
--     updatedPrior: [                   // rows we updated (restore on undo)
--       { lookupKey, data, contentHash, sourceRow }
--     ],
--     removedRows:  [                   // rows we deleted as orphans (restore on undo)
--       { lookupKey, data, contentHash, sourceRow }
--     ],
--     priorMetadata: {                  // pre-upload report_uploads fields (restore on undo)
--       reportLabel, reportType, columnMapping, sourceFilename, rowCount, lastDiffSummary
--     }
--   }
--
-- Established 2026-05-12 (Reports v1 upload UI, v309).

alter table public.report_uploads
  add column if not exists prior_snapshot jsonb,
  add column if not exists undo_expires_at timestamptz;

create index if not exists report_uploads_undoable_idx
  on public.report_uploads (user_id, undo_expires_at)
  where undo_expires_at is not null;

comment on column public.report_uploads.prior_snapshot is
  'Pre-upsert snapshot captured by upsertReport so undoReportUpload can replay the prior state within 24h. See migration header for shape.';

comment on column public.report_uploads.undo_expires_at is
  'When the prior_snapshot expires (24h after the upsert that captured it). NULL means no undoable upload outstanding.';

-- ─── 5/18 sample_order_intents ───────────────────
-- Sample-order intents — public landing page ("Order NOW") backing table.
--
-- v323 shipped Send-to-Practice: a rep clicks a button under Liz's sample-
-- order reply, the server renders a PDF, Resend delivers it to the practice
-- owner's inbox. v325 closes the conversion loop by giving every send a
-- public landing page the practice owner opens from the email — a clean,
-- standalone URL with the order summary + a "Confirm & forward to Galderma"
-- CTA. Confirming pings the rep (visible in the chat thread) so they know
-- the order landed.
--
-- This table holds the frozen order snapshot at send-time (so prompt drift
-- on Liz's side never changes what the practice sees), plus the public
-- token, view tracking, and confirmation tracking. There is intentionally
-- NO foreign key to agent_chat_turns.id with ON DELETE CASCADE — if a rep
-- clears their chat (v320 "New chat"), the intent record survives because
-- the conversion side of the loop is independent of conversation memory.
-- turn_id is kept as ON DELETE SET NULL only so analytics can stitch later.
--
-- Established 2026-05-13 (v325 — Order NOW landing page).

create table if not exists public.sample_order_intents (
  id                  uuid        primary key default gen_random_uuid(),

  -- Public URL slug — unguessable, used as the sole capability token.
  -- Generated server-side as 32 random bytes, base64url-encoded → ~43 chars.
  token               text        not null unique,

  -- Rep who sent. Cascade-delete with the user so we don't strand orphan
  -- public URLs pointing to a former rep's order.
  rep_user_id         uuid        not null references auth.users(id) on delete cascade,

  -- Optional link back to the Liz chat turn the order came from. Set null
  -- if the rep clears chat (so the public URL keeps working) — see header.
  -- Cleave fix 2026-05-24: dropped FK to public.agent_chat_turns (Agentiport-
  -- only table not ported to refill-app). turn_id stays as nullable UUID for
  -- analytics stitching; no referential integrity guarantee in this product.
  turn_id             uuid,

  -- Where the email was sent. Plain text; not unique (rep may resend to a
  -- different address). Used for the email-pre-fill on the confirmation UI.
  practice_email      text        not null,

  -- Frozen snapshot of the LizSampleOrder at the moment of send. The
  -- landing page renders from this — never re-queries memory-graph — so
  -- the practice owner always sees the same numbers the rep approved.
  order_snapshot      jsonb       not null,

  -- Rep display fields surfaced on the landing page ("Prepared by …").
  -- Captured at send-time for the same freeze-frame reason.
  rep_name            text        not null,
  rep_email           text,

  sent_at             timestamptz not null default now(),

  -- View tracking — incremented every page-load. first_viewed_at gives the
  -- rep a "they opened it · 6:42 PM" signal even before they confirm.
  first_viewed_at     timestamptz,
  last_viewed_at      timestamptz,
  view_count          integer     not null default 0,

  -- Confirmation tracking — set the first time the practice clicks
  -- "Confirm & forward to Galderma". Re-confirms are idempotent and don't
  -- overwrite confirmed_at (so the timestamp the rep sees is "when they
  -- first said yes," not "when they last clicked").
  confirmed_at        timestamptz,
  confirmed_by_name   text,
  confirmed_note      text,

  -- Optional kill-switch for a rep who sent the wrong order. UI not built
  -- in v325 — column reserved so we don't have to migrate again to ship it.
  revoked_at          timestamptz,

  constraint sample_order_intents_token_check check (
    char_length(token) between 16 and 128
  )
);

alter table public.sample_order_intents enable row level security;

-- Reps can see their own intents. The landing page itself does NOT go
-- through this policy — public lookups happen via server fns using the
-- service-role client, since the practice owner has no auth session.
do $$ begin
  create policy "reps_own_sample_order_intents"
    on public.sample_order_intents for select
    using (auth.uid() = rep_user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "service_role_sample_order_intents"
    on public.sample_order_intents for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

-- Lookup by token: the hot path — every landing-page request hits this.
create unique index if not exists sample_order_intents_token_idx
  on public.sample_order_intents (token);

-- Rep dashboard view: "show me everything I sent, newest first."
create index if not exists sample_order_intents_rep_recent_idx
  on public.sample_order_intents (rep_user_id, sent_at desc);

-- Stitch intents back to chat turns when surfacing send-status in the UI.
create index if not exists sample_order_intents_turn_idx
  on public.sample_order_intents (turn_id)
  where turn_id is not null;

-- ─── 6/18 promotions_engine ──────────────────────
-- Promotions Engine — Phase 1 foundation (v334).
--
-- Three new tables operationalize the rep's per-promotion lifecycle:
--
--   promotion_account_state         — one row per (rep, promotion, account)
--                                     tuple. Tracks the state machine
--                                     (targeted → outreached → engaged →
--                                     meeting_scheduled → ... → closed_won/lost),
--                                     committed tier + units, order details,
--                                     and rep notes.
--
--   promotion_outreach              — one row per outreach attempt across
--                                     channels (email / sms / call_log /
--                                     in_person_log). Direction (outbound
--                                     vs. inbound), subject + body, sent_at,
--                                     opened/responded timestamps. Links
--                                     optionally back to the existing
--                                     sample_order_intents.token when the
--                                     outreach went through the v325
--                                     Send-to-Practice + landing-page
--                                     mechanic (which the Promotions Engine
--                                     reuses verbatim).
--
--   promotion_fulfillment_issue     — one row per fulfillment problem
--                                     (incorrect quantity, incentive not
--                                     loaded, shipping delay, etc.). Kept
--                                     separate from a "notes" field so
--                                     fulfillment queue UIs can query
--                                     issues directly without parsing JSON.
--
-- Design notes:
--   - Every table scoped by user_id (the rep). RLS enforces it the same
--     way report_uploads + sample_order_intents do. Multi-tenant isolation
--     stays load-bearing per project_security_privacy_posture.
--   - The promotion itself lives in knowledge_nodes (node_type='promotion'),
--     not in a dedicated table. This keeps the existing v319 schema
--     foundation + the [VERIFIED] / memory-graph patterns intact. Only the
--     operational lifecycle data lives in these new tables.
--   - The account lives in knowledge_nodes too (node_type='account'). These
--     state-tracking rows reference both via foreign keys, but with
--     ON DELETE CASCADE so cleaning up a stale promo / account cleans up
--     its operational rows automatically.
--   - All three tables follow the existing convention: user_id NOT NULL,
--     created_at + updated_at, idempotent migration via if-not-exists +
--     duplicate-object-exception RLS policies.
--
-- Established 2026-05-13 (v334 — Promotions Engine Phase 1 foundation).
-- See ~/Desktop/David Claude Projects/Promotions-Engine-Roadmap.html
-- and memory/project_promotions_engine_spec.md for the full spec.

-- ── promotion_account_state ────────────────────────────────────────────────

create table if not exists public.promotion_account_state (
  id                       uuid        primary key default gen_random_uuid(),
  user_id                  uuid        not null references auth.users(id) on delete cascade,
  promotion_node_id        uuid        not null references public.knowledge_nodes(id) on delete cascade,
  account_node_id          uuid        not null references public.knowledge_nodes(id) on delete cascade,

  -- State machine per the spec. ENFORCED at DB layer so the application
  -- can't accidentally write a state it doesn't model.
  state                    text        not null default 'targeted'
    check (state in (
      'targeted',
      'outreached',
      'engaged',
      'meeting_scheduled',
      'meeting_done',
      'committed',
      'ordered',
      'fulfilled',
      'closed_won',
      'closed_lost',
      'opted_out'
    )),

  -- When state = 'committed' or later, which tier the practice chose.
  -- Matches a `code` in PromotionAttachments.tiers (e.g. "7QUEEN", "TIU2").
  committed_tier_code      text,
  committed_units          integer,

  -- Order placement details (state >= 'ordered').
  order_placed_at          timestamptz,
  order_invoice_number     text,
  order_total_usd          numeric(12, 2),

  -- Free-form structured issues. The promotion_fulfillment_issue table is
  -- the queryable source of truth; this jsonb is a denormalized snapshot
  -- the chat UI can show without a join.
  fulfillment_issues       jsonb       not null default '[]'::jsonb,

  rep_notes                text,
  last_touched_at          timestamptz default now(),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  -- One state row per (rep, promo, account). Re-running outreach against
  -- the same account updates the existing row; doesn't insert duplicates.
  constraint promotion_account_state_unique
    unique (user_id, promotion_node_id, account_node_id)
);

alter table public.promotion_account_state enable row level security;

do $$ begin
  create policy "users_own_promotion_account_state"
    on public.promotion_account_state for all
    using  (auth.uid() = user_id)
    with check (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "service_role_promotion_account_state"
    on public.promotion_account_state for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

-- Per-promo dashboard: rollup of state buckets for one promo.
create index if not exists promotion_account_state_promo_idx
  on public.promotion_account_state (user_id, promotion_node_id, state);

-- Per-account drill-in: every promo state row for one practice.
create index if not exists promotion_account_state_account_idx
  on public.promotion_account_state (user_id, account_node_id, last_touched_at desc);

-- Stale-state cron sweep (Phase 2C — auto-queue follow-ups for outreached
-- rows untouched for X days). Partial because confirmed/closed states
-- never need stale-checking.
create index if not exists promotion_account_state_stale_idx
  on public.promotion_account_state (user_id, last_touched_at)
  where state in ('targeted', 'outreached', 'engaged', 'meeting_scheduled');

-- ── promotion_outreach ─────────────────────────────────────────────────────

create table if not exists public.promotion_outreach (
  id                       uuid        primary key default gen_random_uuid(),
  user_id                  uuid        not null references auth.users(id) on delete cascade,
  state_id                 uuid        not null references public.promotion_account_state(id) on delete cascade,

  kind                     text        not null
    check (kind in ('email', 'sms', 'call_log', 'in_person_log')),
  direction                text        not null
    check (direction in ('outbound', 'inbound')),

  subject                  text,
  body                     text        not null default '',

  -- For email tracking (Phase 2A+) — pixel-based opened_at and Resend
  -- webhook responded_at. Null on call_log / in_person_log entries.
  sent_at                  timestamptz not null default now(),
  opened_at                timestamptz,
  responded_at             timestamptz,
  response_body            text,

  -- v325 reuse — when outreach goes via the Send-to-Practice + landing-page
  -- mechanic, the same token bridges the two systems. Practice-owner views
  -- + confirmations on the landing page automatically link back here.
  intent_token             text        references public.sample_order_intents(token) on delete set null,

  -- Optional structured metadata (channel-specific fields).
  metadata                 jsonb       not null default '{}'::jsonb,

  created_at               timestamptz not null default now()
);

alter table public.promotion_outreach enable row level security;

do $$ begin
  create policy "users_own_promotion_outreach"
    on public.promotion_outreach for all
    using  (auth.uid() = user_id)
    with check (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "service_role_promotion_outreach"
    on public.promotion_outreach for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

-- Per-state timeline view: chronological touches against one (promo, account).
create index if not exists promotion_outreach_state_idx
  on public.promotion_outreach (state_id, sent_at desc);

-- Inbox view (Phase 2B): inbound replies awaiting rep attention.
create index if not exists promotion_outreach_inbound_unread_idx
  on public.promotion_outreach (user_id, sent_at desc)
  where direction = 'inbound';

-- Intent-token join for webhooks (Resend bouncing replies + landing-page
-- confirms back into the engine).
create index if not exists promotion_outreach_intent_idx
  on public.promotion_outreach (intent_token)
  where intent_token is not null;

-- ── promotion_fulfillment_issue ────────────────────────────────────────────

create table if not exists public.promotion_fulfillment_issue (
  id                       uuid        primary key default gen_random_uuid(),
  user_id                  uuid        not null references auth.users(id) on delete cascade,
  state_id                 uuid        not null references public.promotion_account_state(id) on delete cascade,

  kind                     text        not null
    check (kind in (
      'incorrect_quantity',
      'incorrect_product',
      'incentive_not_loaded',
      'physical_goods_not_received',
      'billing_discrepancy',
      'shipping_delay',
      'other'
    )),

  -- Free-text description (what the practice owner said, or what the rep
  -- noticed). Required because issue-kind alone isn't enough context.
  description              text        not null,

  -- Severity (rep-set or LLM-inferred). Used to surface high-severity
  -- issues immediately vs. queueing normal ones in the daily digest.
  severity                 text        not null default 'normal'
    check (severity in ('low', 'normal', 'high', 'urgent')),

  reported_at              timestamptz not null default now(),
  -- Source channel that surfaced this issue — for reporting later.
  reported_via             text        check (reported_via in ('email', 'sms', 'call', 'in_person', 'auto_detected', 'rep_entered')),

  resolved_at              timestamptz,
  resolution_notes         text,

  created_at               timestamptz not null default now()
);

alter table public.promotion_fulfillment_issue enable row level security;

do $$ begin
  create policy "users_own_promotion_fulfillment_issue"
    on public.promotion_fulfillment_issue for all
    using  (auth.uid() = user_id)
    with check (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "service_role_promotion_fulfillment_issue"
    on public.promotion_fulfillment_issue for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

-- Open-issues queue (rep's "what's broken right now" view).
create index if not exists promotion_fulfillment_issue_open_idx
  on public.promotion_fulfillment_issue (user_id, severity, reported_at desc)
  where resolved_at is null;

-- Per-state timeline (issues attached to one promo-account combo).
create index if not exists promotion_fulfillment_issue_state_idx
  on public.promotion_fulfillment_issue (state_id, reported_at desc);

-- ─── 7/18 promo_intents ──────────────────────────
-- Promo intents — public landing page table for the Promotions Engine (v337).
--
-- Mirrors sample_order_intents but for promo-blast outreach rather than
-- one-off sample-order sends. When a rep sends a promo blast via v336's
-- sendPromoBlast, this row is minted before Resend delivery; the public
-- /promo/<token> landing page reads from it.
--
-- Why a SEPARATE table instead of extending sample_order_intents:
--   - The shapes are genuinely different. sample_order_intents.order_snapshot
--     is a frozen LizSampleOrder (line items, total, [VERIFIED] math). Promo
--     intents instead carry the rep's recommended tier + the promo's full
--     ladder so the practice owner can SELECT which tier to commit to.
--   - The lifecycle is different. Sample-order intents go targeted →
--     viewed → confirmed (one-shot accept/reject). Promo intents support
--     multiple "confirms" as the practice owner picks then changes their
--     mind about tier — each confirm re-stamps with the latest selection.
--   - Foreign keys cleaner. The v334 promotion_outreach.intent_token had
--     been FK'd to sample_order_intents.token, which was wrong; that FK
--     gets dropped here (or rather, we keep promotion_outreach.intent_token
--     as untyped text since it now points at this NEW table on promo blasts).
--
-- The promo + account + recommended tier are captured at SEND time so
-- the landing page renders the same content the rep saw when they sent —
-- no prompt drift or schema changes can move the offer after the fact.
--
-- Established 2026-05-13 (v337 — practice-facing promo landing page).

create table if not exists public.promo_intents (
  id                       uuid        primary key default gen_random_uuid(),

  -- Public URL slug. Unguessable. 32 random bytes → ~43 chars base64url.
  -- Same generator as sample_order_intents.token (256 bits of entropy).
  token                    text        not null unique,

  -- Rep who sent. Cascade with the user (same pattern as
  -- sample_order_intents) — if the rep is deleted, the promo URLs they
  -- minted die with them.
  rep_user_id              uuid        not null references auth.users(id) on delete cascade,

  -- Anchors for the promo + the targeted account. SET NULL on delete so
  -- the public URL keeps working even if the rep cleans up their nodes
  -- (renders with the frozen snapshot below).
  promotion_node_id        uuid        references public.knowledge_nodes(id) on delete set null,
  account_node_id          uuid        references public.knowledge_nodes(id) on delete set null,

  -- Frozen snapshot at send time. This is what renders on the landing
  -- page regardless of whether the underlying promo/account nodes have
  -- changed since. Shape:
  --   {
  --     promo: { title, manufacturer, promo_kind, ends, tier_ladder: [...], ... },
  --     account: { title, lookup_key, address, contact_name, current_tier: {...} },
  --     recommended_tier_code: "7QUEEN"
  --   }
  snapshot                 jsonb       not null,

  -- Where the promo email was sent.
  practice_email           text        not null,

  -- Rep display fields surfaced on the landing page ("From {repName}").
  rep_name                 text        not null,
  rep_email                text,

  sent_at                  timestamptz not null default now(),

  -- View tracking. first_viewed_at = the moment the practice owner first
  -- loaded the landing page. last_viewed_at + view_count for ongoing
  -- engagement signal.
  first_viewed_at          timestamptz,
  last_viewed_at           timestamptz,
  view_count               integer     not null default 0,

  -- Confirmation tracking. Unlike sample_order_intents (one-shot), the
  -- practice owner can re-confirm with a different tier — confirmed_at is
  -- the FIRST confirmation (sticky), confirmed_tier_code + confirmed_units
  -- + confirmed_by_name + confirmed_note update on each re-submit so the
  -- rep sees the latest state.
  confirmed_at             timestamptz,
  confirmed_by_name        text,
  confirmed_note           text,
  confirmed_tier_code      text,
  confirmed_units          integer,

  -- Rep-controlled kill-switch. Setting this makes the landing page show
  -- a friendly "this offer is no longer current — reach out to your rep
  -- for an updated quote" card. UI for this lands in a later phase.
  revoked_at               timestamptz,

  constraint promo_intents_token_check check (
    char_length(token) between 16 and 128
  )
);

alter table public.promo_intents enable row level security;

-- Reps can read their own intents (for the per-account state badges in
-- the composer). Public lookups go through server fns using service-role
-- so the practice owner doesn't need an auth session.
do $$ begin
  create policy "reps_own_promo_intents"
    on public.promo_intents for select
    using (auth.uid() = rep_user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "service_role_promo_intents"
    on public.promo_intents for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

-- Hot-path index: every landing page load looks up by token.
create unique index if not exists promo_intents_token_idx
  on public.promo_intents (token);

-- Per-promo composer view: load all of a rep's intents for one promo
-- to populate the Opened/Confirmed badges on the per-account rows.
create index if not exists promo_intents_rep_promo_idx
  on public.promo_intents (rep_user_id, promotion_node_id, sent_at desc);

-- Per-account drill-in: every promo intent against one practice.
create index if not exists promo_intents_account_idx
  on public.promo_intents (account_node_id, sent_at desc)
  where account_node_id is not null;

-- ─── 8/18 drop_promotion_outreach_intent_fk ──────
-- v337 follow-up: drop the FK constraint on promotion_outreach.intent_token.
--
-- The v334 migration declared:
--   intent_token text references public.sample_order_intents(token) on delete set null
--
-- which presumed promo blasts would reuse the v325 sample_order_intents
-- mechanism. v337 introduced a SEPARATE promo_intents table (different
-- shape, different lifecycle — see migration 20260513060000). Tokens
-- written to promotion_outreach.intent_token now point at promo_intents,
-- not sample_order_intents, so the original FK rejects valid inserts.
--
-- We don't add a new FK to promo_intents here because:
--   - promotion_outreach existed before promo_intents (cross-table FK ordering
--     would be awkward in a fresh-DB rebuild)
--   - the token-as-capability pattern means we look these up via the server
--     fns (which are explicit) rather than ad-hoc joins
--   - keeping intent_token as untyped text gives us flexibility if a third
--     intent-shape ever appears (meeting_intents, fulfillment_intents, etc.)

alter table public.promotion_outreach
  drop constraint if exists promotion_outreach_intent_token_fkey;

-- Keep the index — still useful for the outreach → intent join in the UI.

-- ─── 9/18 promo_inbox ────────────────────────────
-- v338 — Promo Reply Inbox (Phase 2B start).
--
-- Closes the inbound side of the Promotions Engine. Practice-owner email
-- replies route back into Lizzie via Resend's inbound webhook, attach to
-- the originating promotion_outreach row, and flip the parent state to
-- 'engaged'. New surface: /app/lizzie/inbox + a Today dashboard card.
--
-- Two structural changes:
--   1. promotion_outreach grows three columns:
--        email_id      — Resend message id (outbound) for In-Reply-To
--                        correlation fallback when plus-address routing
--                        misses. Indexed partial WHERE NOT NULL.
--        in_reply_to   — the In-Reply-To header value on inbound rows
--                        (parsed from the Received Emails API fetch).
--                        Cheap thread reconstruction without a full
--                        joins-on-headers query.
--        read_at       — rep-side unread tracking for the inbox surface.
--
--   2. inbox_unmatched — landing table for replies that can't be routed
--      back to an outreach row (token stripped + In-Reply-To missing).
--      Rep manually links these via the inbox UI (link UI ships v339).
--      Full body cached here so the rep can read + decide without a
--      second API call to Resend.
--
-- Routing strategy locked at v338 architecture:
--   Primary  — plus-addressing on Reply-To: reply+<intent_token>@reply.openagentic.site
--              (intent_token already minted by sendPromoBlast, already
--              indexed via promotion_outreach_intent_idx, already on the
--              outreach row — zero schema change for routing).
--   Fallback — In-Reply-To header → promotion_outreach.email_id lookup.
--   Last     — insert into inbox_unmatched for manual linking later.
--
-- The webhook handler runs server-side with the service role; both new
-- columns + the new table follow the same users_own + service_role
-- policy pattern as the rest of the Promotions Engine schema (v334).
--
-- Established 2026-05-13 (v338 — Promotions Engine Phase 2B, ship 1 of 3).

-- ── promotion_outreach: inbound-correlation columns ──────────────────────

ALTER TABLE public.promotion_outreach
  ADD COLUMN IF NOT EXISTS email_id    text,
  ADD COLUMN IF NOT EXISTS in_reply_to text,
  ADD COLUMN IF NOT EXISTS read_at     timestamptz;

-- Partial index for the In-Reply-To fallback lookup. Only outbound rows
-- carry an email_id today, so the partial keeps the index narrow.
CREATE INDEX IF NOT EXISTS promotion_outreach_email_id_idx
  ON public.promotion_outreach (email_id)
  WHERE email_id IS NOT NULL;

-- ── inbox_unmatched ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.inbox_unmatched (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Resend's message id (the inbound email, not our outbound). Unique
  -- so webhook retries are idempotent at the DB layer — second insert
  -- of the same payload is rejected, handler returns 200.
  resend_email_id       text        NOT NULL UNIQUE,

  from_addr             text        NOT NULL,
  to_addr               text        NOT NULL,
  subject               text,
  body_text             text,
  body_html             text,
  raw_headers           jsonb       NOT NULL DEFAULT '{}'::jsonb,

  received_at           timestamptz NOT NULL DEFAULT now(),

  -- Rep manually links these. Once resolved, the row stays for audit;
  -- the inbox query filters resolved_at IS NULL for the active queue.
  resolved_at           timestamptz,
  resolved_outreach_id  uuid        REFERENCES public.promotion_outreach(id) ON DELETE SET NULL,

  created_at            timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.inbox_unmatched ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "users_own_inbox_unmatched"
    ON public.inbox_unmatched FOR ALL
    USING  (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "service_role_inbox_unmatched"
    ON public.inbox_unmatched FOR ALL
    USING  (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Open queue: replies waiting for the rep to manually link, newest first.
CREATE INDEX IF NOT EXISTS inbox_unmatched_open_idx
  ON public.inbox_unmatched (user_id, received_at DESC)
  WHERE resolved_at IS NULL;

-- ─── 10/18 promo_inbox_drafts ───────────────────
-- v339: Liz auto-drafts a reply when an inbound promo response lands.
--
-- The draft lives on the inbound promotion_outreach row itself (no separate
-- table) — drafts are transient artifacts that become a new outbound row
-- when the rep clicks Send. Storing them on the inbound row keeps the
-- 1:1 relationship simple and means listPromoInbox already returns the
-- draft alongside the inbound metadata without an extra join.
--
-- The verified-line is JSONB rather than free text so the prompt can return
-- structured math (promo, tier, qualifies, savings, etc.) that the UI can
-- render as a chip-style receipt instead of an opaque blob.

alter table public.promotion_outreach
  add column if not exists auto_draft_subject text,
  add column if not exists auto_draft_body text,
  add column if not exists auto_draft_verified jsonb,
  add column if not exists auto_draft_generated_at timestamptz;

comment on column public.promotion_outreach.auto_draft_subject
  is 'v339: Liz pre-drafted reply subject. NULL until generation runs. Only meaningful on direction=inbound rows.';
comment on column public.promotion_outreach.auto_draft_body
  is 'v339: Liz pre-drafted reply body (plain text). Rep can edit before sending.';
comment on column public.promotion_outreach.auto_draft_verified
  is 'v339: Structured [VERIFIED] math line — { promo, tier, qualifies, savings_usd, ... }. Rendered as a chip in the inbox UI above the editable body.';
comment on column public.promotion_outreach.auto_draft_generated_at
  is 'v339: When the auto-draft was generated. Null if generation failed or hasn''t run yet.';

-- ─── 11/18 rep_tier_policy ───────────────────────
-- v339.7 — Per-rep tier-recommendation policy
--
-- Hybrid policy locked 2026-05-14 (see project_tier_recommendation_policy
-- memory). Liz's auto-draft replies recommend tiers based on the rep's
-- selling style:
--
--   conservative — match the practice's stated volume exactly. Mention
--                  adjacent tiers as informational only.
--   balanced     — default. Lean upsell when volume is within ~20% of the
--                  next tier (stretch zone). Beyond that, match. Tone is
--                  always "opportunity," never pressure.
--   aggressive   — always pitch the next tier up when one exists. Framed
--                  as a smart-move stretch.
--
-- Math fidelity is unchanged regardless of policy: the [VERIFIED] chip is
-- still computed by CODE looking up the recommended tier in the promo's
-- structured ladder. Only the tier-code recommendation itself is tuned.
--
-- Stored on user_preferences (one row per user, PK on user_id). NULL is
-- treated as 'balanced' at read time, so no backfill required.

alter table public.user_preferences
  add column if not exists rep_tier_policy text
    check (rep_tier_policy in ('conservative', 'balanced', 'aggressive'));

comment on column public.user_preferences.rep_tier_policy is
  'Tier-recommendation selling style for Liz auto-drafts. NULL = balanced (default).';

-- ─── 12/18 nudge_dismissed_at ────────────────────
-- v340 — Scheduled follow-up cadence (the "5 nudges suggested" daily digest)
--
-- Rep eyes stay in the loop: nudges are never auto-sent. The rep opens
-- /app/lizzie/cadence, sees a list of stale outreached rows with
-- Liz-drafted nudge bodies, and Sends or Dismisses each one.
--
-- "Stale" = state='outreached' AND last_touched_at < now() - 5 days.
-- A dismiss is a soft-hide on the state row: set nudge_dismissed_at, the
-- digest query filters WHERE nudge_dismissed_at IS NULL. If the rep wants
-- to nudge an account they previously dismissed, they can just send a
-- fresh blast from the account or promo detail page — which will refresh
-- last_touched_at and leave the dismissed flag in place (which is fine —
-- the digest is for AI-suggested follow-ups, not the only path to send).
--
-- A successful nudge send naturally bumps last_touched_at via the
-- existing v336 pattern, so the row falls off the digest the same way
-- a manual blast would.
--
-- The existing v336 partial index on
--   (user_id, last_touched_at) WHERE state IN ('targeted', 'outreached', ...)
-- already covers the hot path for digest queries — no new index needed.

alter table public.promotion_account_state
  add column if not exists nudge_dismissed_at timestamptz;

comment on column public.promotion_account_state.nudge_dismissed_at is
  'Set when the rep dismisses an AI-suggested follow-up nudge on the /app/lizzie/cadence digest. NULL = still eligible for a nudge suggestion when the row goes stale.';

-- ─── 13/18 spa_promo_interest ────────────────────
-- v341 — Phase 3 (Emma-side): "Eligible promos for the spa" surface.
--
-- The first Emma(OS)/spa-owner Phase 3 ship. A spa owner sees the manufacturer
-- promos she's eligible for at `/app/emma/promos`, with [VERIFIED] tier+savings
-- math per promo. Eligibility = the spa offers a service whose
-- attachments.matchedProduct.manufacturer matches the promo's manufacturer.
--
-- This table records the "express interest" signal from spa → rep. The spa
-- side reads/writes its own rows; the rep-side surface that consumes these
-- (e.g. "3 practices interested in your 7-Years-of-Jeuveau promo") ships
-- separately in a follow-up (v341.1+).
--
-- Cross-tenant promo READ is handled by the service-role admin client in the
-- spa-side server fn — same pattern as the existing
-- `crossReferenceServices()` in spa-claim.functions.ts that reads
-- node_type='product' across user_ids. No new RLS needed on knowledge_nodes
-- (the service-role bypass policy on that table is already in place).

create table if not exists public.spa_promo_interest (
  id                  uuid        primary key default gen_random_uuid(),
  spa_user_id         uuid        not null references auth.users(id) on delete cascade,
  -- The rep who owns the promotion node — captured at insert time so the
  -- rep-side query is a cheap (rep_user_id, promotion_node_id) join and
  -- doesn't require service-role bypass on every read.
  rep_user_id         uuid        not null references auth.users(id) on delete cascade,
  promotion_node_id   uuid        not null references public.knowledge_nodes(id) on delete cascade,
  -- "interested" = the spa hit Express Interest; "dismissed" = the spa hit
  -- Dismiss (the promo card hides on subsequent loads). NULL would mean
  -- "no signal yet"; we never insert a row without one of these set.
  status              text        not null check (status in ('interested', 'dismissed')),
  -- Optional message the spa typed when expressing interest. Capped at 500
  -- chars in app validation; column itself is unbounded for future-proofing.
  message             text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (spa_user_id, promotion_node_id)
);

alter table public.spa_promo_interest enable row level security;

-- Spa owner can read/write their own interest signals.
do $$ begin
  create policy "spa_promo_interest_spa_owner"
    on public.spa_promo_interest for all
    using  (auth.uid() = spa_user_id)
    with check (auth.uid() = spa_user_id);
exception when duplicate_object then null;
end $$;

-- Rep can READ interest signals for promos they own (so the rep-side
-- surface in a future ship can show "3 practices interested"). No write —
-- the rep doesn't manipulate the spa's signal.
do $$ begin
  create policy "spa_promo_interest_rep_read"
    on public.spa_promo_interest for select
    using (auth.uid() = rep_user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "spa_promo_interest_service_role"
    on public.spa_promo_interest for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

-- Hot-path index: spa loading their own page filters by spa_user_id +
-- status (interested OR dismissed both used). Partial index keeps it lean.
create index if not exists idx_spa_promo_interest_spa
  on public.spa_promo_interest (spa_user_id, promotion_node_id);

-- Future rep-side index for the "practices interested in my promo" view.
create index if not exists idx_spa_promo_interest_rep
  on public.spa_promo_interest (rep_user_id, promotion_node_id, status)
  where status = 'interested';

comment on table public.spa_promo_interest is
  'Emma-side signal — spa owner expressed interest (or dismissal) on a manufacturer promo. Read by both the spa (own rows, all statuses) and the rep who owns the promo (interested rows only).';

-- ─── 14/18 patient_transactions ──────────────────
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

-- ─── 15/18 patient_contact_candidates ────────────
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

-- ─── 16/18 spa_rep_data_share ────────────────────
-- Patient Architecture P4 — spa-rep aggregate consent.
--
-- The cross-tenant boundary between Emma(OS) and Lizzie(OS). Spas own all
-- patient data (RLS-enforced on knowledge_nodes + patient_transactions +
-- patient_contact_candidates), and reps NEVER see individual patient rows.
-- But spas may opt-in to share *aggregates* with specific reps they're
-- already working with — e.g. "Rejuv has 84 active Jeuveau patients" lets
-- the Evolus rep prioritize who to call without ever seeing a name.
--
-- Default is denied: a row missing from this table means no consent. Spas
-- grant per-rep; revocation is a flip of revoked_at, not a delete (so we
-- have an audit trail of "you used to share with me; you stopped on…").
--
-- Why a column-level RLS read policy for the rep:
--   The rep needs to discover "which spas have shared with me" without
--   being able to enumerate other reps' shares OR fish for spas who haven't
--   consented. The rep-read RLS row gate is (rep_user_id = auth.uid() AND
--   revoked_at IS NULL) — they see only their own currently-active grants.
--
-- Established 2026-05-15 (Patient Architecture P4).

create table if not exists public.spa_rep_data_share (
  id            uuid        primary key default gen_random_uuid(),
  spa_user_id   uuid        not null references auth.users(id) on delete cascade,
  rep_user_id   uuid        not null references auth.users(id) on delete cascade,
  -- 'aggregate' is the only level today. Future: 'cohort_lists' (named
  -- patient counts by cohort definition) or 'contact_pool' (consented
  -- patients' phone+email for rep-initiated outreach). Reserved as a
  -- string so adding levels doesn't churn schema.
  share_level   text        not null default 'aggregate',
  granted_at    timestamptz not null default now(),
  revoked_at    timestamptz,
  -- Optional spa-side note about WHY they're sharing — useful when reviewing
  -- the consent later ("granted during 2026-Q2 Evolus promo follow-up").
  spa_note      text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint spa_rep_data_share_unique unique (spa_user_id, rep_user_id),
  constraint spa_rep_data_share_level_check check (
    share_level in ('aggregate', 'cohort_lists', 'contact_pool')
  ),
  -- A row is either active (revoked_at NULL) or revoked (revoked_at set).
  -- Active grants must have a granted_at, revoked grants must have both.
  constraint spa_rep_data_share_timeline_check check (
    granted_at is not null
    and (revoked_at is null or revoked_at >= granted_at)
  )
);

alter table public.spa_rep_data_share enable row level security;

-- Spa side: full ownership of their own grants. The spa decides which reps
-- see what, when, and for how long.
do $$ begin
  create policy "spa_owns_data_share"
    on public.spa_rep_data_share for all
    using  (auth.uid() = spa_user_id)
    with check (auth.uid() = spa_user_id);
exception when duplicate_object then null;
end $$;

-- Rep side: read-only access to their own currently-active grants. Cannot
-- INSERT/UPDATE — only the spa can grant. Cannot read revoked grants
-- (defensive: avoids "the spa used to share but doesn't now" awkwardness).
do $$ begin
  create policy "rep_reads_active_shares"
    on public.spa_rep_data_share for select
    using  (auth.uid() = rep_user_id and revoked_at is null);
exception when duplicate_object then null;
end $$;

-- Service role: full access for the rep-side aggregate fn that has to
-- bypass RLS to compute counts against the spa's patient data.
do $$ begin
  create policy "service_role_data_share"
    on public.spa_rep_data_share for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

-- Lookup: rep's active grants, used when assembling the interest-signal
-- card's per-spa aggregate row.
create index if not exists spa_rep_data_share_by_rep_idx
  on public.spa_rep_data_share (rep_user_id)
  where revoked_at is null;

-- Lookup: spa's full grant history (for the sharing-management surface).
create index if not exists spa_rep_data_share_by_spa_idx
  on public.spa_rep_data_share (spa_user_id, granted_at desc);

-- Updated-at trigger so the spa-side UI can show "last touched X ago"
-- without server-side rewrites.
create or replace function public.touch_spa_rep_data_share()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end
$$;

drop trigger if exists trg_touch_spa_rep_data_share on public.spa_rep_data_share;
create trigger trg_touch_spa_rep_data_share
  before update on public.spa_rep_data_share
  for each row execute function public.touch_spa_rep_data_share();

comment on table public.spa_rep_data_share is
  'Spa-controlled consent for aggregate data sharing with specific reps. Default = absent = denied. Rep can read only their own currently-active grants (revoked_at IS NULL).';

-- ─── 17/18 patient_outreach_state ────────────────
-- Promotions Engine Phase 3 — per-campaign outreach state.
--
-- One row per (campaign_node_id, patient_node_id) tracks the spa's outreach
-- state for that patient on that campaign. Phase 3.0 uses this table to
-- persist draft messages; Phase 3.1 will use it to track send + reply + book
-- state via the `state` enum.
--
-- Why a relational table instead of attachments on the campaign node:
--   The blast composer is row-keyed by patient, and we'll be reading + writing
--   one row at a time as the spa owner edits drafts. A flat relational table
--   with a unique index on (campaign, patient) is the right shape — much
--   simpler than maintaining a 500-key map inside a json blob.
--
-- The roadmap §8 schema lists fields that arrive across phases. This
-- migration ships them all upfront so 3.1 (send + state-machine) is a code
-- change only, no further DDL.
--
-- Tenant boundary: every row scoped by spa user_id with RLS. Reps NEVER see
-- this table — outbound messages and their state are the spa's alone.
--
-- Established 2026-05-15 (Promotions Engine Phase 3.0).

create table if not exists public.patient_outreach_state (
  id                       uuid        primary key default gen_random_uuid(),
  user_id                  uuid        not null references auth.users(id) on delete cascade,
  campaign_node_id         uuid        not null references public.knowledge_nodes(id) on delete cascade,
  patient_node_id          uuid        not null references public.knowledge_nodes(id) on delete cascade,

  -- State machine — populated on cohort-resolve (Phase 3.0 = 'targeted')
  -- and advanced on send / reply / book / show / no-show (Phase 3.1+).
  -- 'opted_out' is reserved for STOP / UNSUBSCRIBE handling.
  state                    text        not null default 'targeted',

  -- Channel locked at send time. Null during Phase 3.0 (draft pre-send).
  channel                  text,

  -- Per-patient draft snapshot — spa-editable, Emma-generated. Shape:
  --   { subject?: string, body: string, verifiedChip?: { ... },
  --     channel: 'sms'|'email'|'both', generatedAt: iso, edited: boolean }
  draft                    jsonb       not null default '{}'::jsonb,

  last_touched_at          timestamptz,
  last_message_id          text,

  -- Phase 3.1 send-mechanic + booking fields (reserved now to avoid a
  -- follow-up migration for the same conceptual table).
  booking_intent_token     text,
  booking_confirmed_at     timestamptz,
  showed_at                timestamptz,
  attributed_revenue_usd   numeric,

  -- Cadence (Phase 7) — when this row is dismissed from the digest, store
  -- the timestamp here so the digest query naturally filters it out.
  nudge_dismissed_at       timestamptz,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  constraint patient_outreach_state_unique
    unique (user_id, campaign_node_id, patient_node_id),
  constraint patient_outreach_state_state_check check (
    state in ('targeted', 'outreached', 'engaged', 'booked', 'showed',
              'no_show', 'closed_won', 'closed_lost', 'opted_out')
  ),
  constraint patient_outreach_state_channel_check check (
    channel is null or channel in ('sms', 'email', 'both')
  )
);

alter table public.patient_outreach_state enable row level security;

do $$ begin
  create policy "users_own_patient_outreach_state"
    on public.patient_outreach_state for all
    using  (auth.uid() = user_id)
    with check (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "service_role_patient_outreach_state"
    on public.patient_outreach_state for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

-- The composer page hits "show me all targets for this campaign, latest
-- touched first" — by-campaign index drives that.
create index if not exists patient_outreach_state_by_campaign_idx
  on public.patient_outreach_state (user_id, campaign_node_id, updated_at desc);

-- Phase 7 cadence digest: "anyone outreached, not engaged, > 5 days quiet,
-- not dismissed" — partial index on the actionable state.
create index if not exists patient_outreach_state_stale_idx
  on public.patient_outreach_state (user_id, last_touched_at desc)
  where state = 'outreached' and nudge_dismissed_at is null;

-- updated_at touch trigger so the composer can show "Saved 2s ago".
create or replace function public.touch_patient_outreach_state()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end
$$;

drop trigger if exists trg_touch_patient_outreach_state on public.patient_outreach_state;
create trigger trg_touch_patient_outreach_state
  before update on public.patient_outreach_state
  for each row execute function public.touch_patient_outreach_state();

comment on table public.patient_outreach_state is
  'Per-(campaign, patient) outreach state for the Emma(OS) Promotions Engine. State machine: targeted → outreached → engaged → booked → showed / no_show / closed_*. Draft snapshot in `draft` jsonb. Spa-scoped via RLS.';

-- ─── 18/18 patient_outreach ─────────────────────
-- Promotions Engine Phase 3.1 — per-message outreach log.
--
-- One row per sent or received message. The Phase 3.0 patient_outreach_state
-- table tracks the LATEST state of each (campaign, patient) pair; this table
-- is the full audit + reply trail. Joins back to patient_outreach_state via
-- patient_outreach_state_id.
--
-- Inbound rows (direction='inbound') will land when the Twilio + Resend
-- inbound webhooks are wired for Emma (separate ship). Phase 3.1 only writes
-- outbound rows; the schema reserves space so the inbound ship is code-only.
--
-- Tenant boundary: every row scoped by spa user_id with RLS. Reps NEVER see
-- this — outbound messages and replies are between the spa and their patient.
--
-- Established 2026-05-15 (Promotions Engine Phase 3.1).

create table if not exists public.patient_outreach (
  id                         uuid        primary key default gen_random_uuid(),
  user_id                    uuid        not null references auth.users(id) on delete cascade,
  patient_outreach_state_id  uuid        not null references public.patient_outreach_state(id) on delete cascade,

  direction                  text        not null,    -- 'outbound' | 'inbound'
  channel                    text        not null,    -- 'sms' | 'email'
  subject                    text,                    -- null for SMS
  body                       text        not null,

  sent_at                    timestamptz,
  read_at                    timestamptz,             -- email open
  opened_at                  timestamptz,             -- alias for read_at — set when an open pixel fires
  replied_at                 timestamptz,             -- set on first inbound reply

  -- Idempotency + cross-reference: Twilio SID or Resend email id.
  -- Used by webhook handlers to look up which conversation an inbound
  -- belongs to.
  message_id                 text,

  -- Public token for the booking landing page (Phase 4 — Emma side).
  intent_token               text,

  -- Free-text skip/error reason when sent_at is null. e.g. 'velocity_cap',
  -- 'quiet_hours', 'banned', 'opted_out', 'twilio:429', 'resend:bad-from'.
  skip_reason                text,

  created_at                 timestamptz not null default now()
);

alter table public.patient_outreach enable row level security;

do $$ begin
  create policy "users_own_patient_outreach"
    on public.patient_outreach for all
    using  (auth.uid() = user_id)
    with check (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "service_role_patient_outreach"
    on public.patient_outreach for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

-- Velocity cap lookup: "has THIS patient received any outbound from us in
-- the last N days?". Filtered to direction='outbound' for the hottest path.
create index if not exists patient_outreach_velocity_idx
  on public.patient_outreach (user_id, patient_outreach_state_id, sent_at desc)
  where direction = 'outbound' and sent_at is not null;

-- Inbound webhook lookup: "find the state row this message replies to."
create index if not exists patient_outreach_message_id_idx
  on public.patient_outreach (user_id, message_id)
  where message_id is not null;

-- Per-state-row history: "all messages for this (campaign, patient) pair."
create index if not exists patient_outreach_by_state_idx
  on public.patient_outreach (user_id, patient_outreach_state_id, created_at desc);

comment on table public.patient_outreach is
  'Per-message log for the Emma(OS) Promotions Engine. One row per outbound or inbound SMS/email. Spa-scoped via RLS. patient_outreach_state holds the latest state; this is the full audit trail.';

-- ═══════════════════════════════════════════════════════════════════════
-- BATCH B VERIFY
-- ═══════════════════════════════════════════════════════════════════════
select 'spa_claim'         as group_, count(*)::text as found from information_schema.tables where table_schema='public' and table_name in ('spa_claim_sessions')
union all select 'reports',                  count(*)::text from information_schema.tables where table_schema='public' and table_name in ('report_uploads','report_rows')
union all select 'sample_orders',            count(*)::text from information_schema.tables where table_schema='public' and table_name in ('sample_order_intents')
union all select 'promotions',               count(*)::text from information_schema.tables where table_schema='public' and table_name in ('promotion_account_state','promo_intents','promo_inbox','promo_inbox_drafts')
union all select 'rep_tier_policy',          count(*)::text from information_schema.tables where table_schema='public' and table_name in ('rep_tier_policy')
union all select 'spa_promo_interest',       count(*)::text from information_schema.tables where table_schema='public' and table_name in ('spa_promo_interest')
union all select 'patient_data',             count(*)::text from information_schema.tables where table_schema='public' and table_name in ('patient_transactions','patient_contact_candidates','patient_outreach','patient_outreach_state')
union all select 'spa_rep_share',            count(*)::text from information_schema.tables where table_schema='public' and table_name in ('spa_rep_data_share');
