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
