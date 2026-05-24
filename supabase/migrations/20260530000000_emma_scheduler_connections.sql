-- v381: Real-time scheduler connectivity (Acuity first, multi-platform shape).
--
-- Closes the last major architectural gap before the unattended pilot
-- can run for 5 business days: appointments + status changes flow into
-- emma_appointments WITHOUT anyone uploading a CSV or flipping a status
-- by hand. When a no-show happens in the spa's Acuity calendar, the
-- engine fires within seconds — not when a human notices and flips it
-- in /app/emma/appointments.
--
-- Architecture:
--   1. Spa owner clicks "Connect Acuity" in /app/emma/settings/scheduler
--   2. OAuth redirect → user authorizes Refill in their Acuity account
--   3. We exchange the code for an access_token + store as a connection
--   4. We programmatically register 4 webhooks via Acuity API
--      (appointment.scheduled, .canceled, .rescheduled, .changed) using
--      a per-spa webhook_secret in the URL path so each callback is
--      attributable to one connection
--   5. We backfill the next 90 days of appointments + the patient roster
--   6. Webhook receiver hits the existing emma_appointments upsert path
--      → updateAppointmentStatus trigger graph fires unchanged
--
-- The `platform` discriminator on both tables is the abstraction that
-- lets Mindbody, JaneApp, Square, Boulevard slot in as future ships
-- without schema migration. v381 implements ONLY 'acuity'; the others
-- will reuse the same shape with platform-specific fetchers.

-- ─── emma_scheduler_connections ────────────────────────────────────────────
-- One row per spa per platform. Today: at most one row per spa
-- (single scheduler integration). Future: multi-location spas could
-- have multiple rows on the same platform — the unique constraint
-- is per (user_id, platform), not just user_id.

create table if not exists public.emma_scheduler_connections (
  id                       uuid        primary key default gen_random_uuid(),
  user_id                  uuid        not null references auth.users(id) on delete cascade,
  platform                 text        not null check (platform in ('acuity', 'mindbody', 'jane', 'square', 'boulevard')),

  -- The third-party's stable account identifier. For Acuity, this is
  -- the user_id returned by GET /api/v1/me. We use it to verify the
  -- OAuth callback bound the right spa (defense against a stolen code
  -- being exchanged against a wrong account).
  platform_account_id      text,
  platform_account_email   text,

  -- OAuth tokens. Plaintext for v381 — Supabase encrypts at rest, RLS
  -- gates access at the API layer, service_role policy gates server
  -- code paths. Future ship adds app-layer encryption via pgsodium
  -- when we have a key-management story.
  access_token             text,
  refresh_token            text,
  token_expires_at         timestamptz,
  oauth_scope              text,

  -- Per-spa secret embedded in the webhook URL path. Random hex,
  -- generated server-side on connect, rotated on disconnect/reconnect.
  -- The webhook receiver looks up the connection by this secret —
  -- avoids needing to thread connection_id through Acuity's payload.
  webhook_secret           text        not null unique default encode(gen_random_bytes(24), 'hex'),

  -- Status surface for the settings UI.
  --   connected     — live; webhooks firing; backfill complete
  --   pending       — backfill in flight or token freshly obtained
  --   reauth_needed — token expired and refresh failed; user must reconnect
  --   error         — last sync hit a hard failure (see last_error)
  --   disconnected  — user clicked Disconnect; soft-deleted (retained for audit)
  status                   text        not null default 'pending'
                                       check (status in ('connected', 'pending', 'reauth_needed', 'error', 'disconnected')),
  last_sync_at             timestamptz,
  last_error               text,

  -- Connect/disconnect timeline for audit.
  connected_at             timestamptz,
  disconnected_at          timestamptz,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  unique (user_id, platform)
);

alter table public.emma_scheduler_connections enable row level security;

do $$ begin
  create policy "users_own_emma_scheduler_connections"
    on public.emma_scheduler_connections for all
    using  (auth.uid() = user_id)
    with check (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "service_role_emma_scheduler_connections"
    on public.emma_scheduler_connections for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

create index if not exists emma_scheduler_connections_user_idx
  on public.emma_scheduler_connections (user_id);
create index if not exists emma_scheduler_connections_status_idx
  on public.emma_scheduler_connections (status);

comment on table public.emma_scheduler_connections is
  'v381 — per-spa OAuth connection to an external scheduling platform. One row per (user_id, platform). Status drives the settings UI; webhook_secret is the per-spa URL path segment.';
comment on column public.emma_scheduler_connections.webhook_secret is
  'Random hex embedded in the webhook URL: /api/webhooks/scheduler/<platform>/<webhook_secret>. Receiver looks up the connection by this value. Rotated on disconnect/reconnect.';
comment on column public.emma_scheduler_connections.platform is
  'Discriminator. v381 only implements acuity; mindbody/jane/square/boulevard reserved for future ships using the same architecture.';

-- ─── emma_scheduler_webhook_events ─────────────────────────────────────────
-- Audit log of inbound webhook events. Append-only; one row per webhook
-- POST received. Records both successes and failures so we can:
--   (a) replay missed events from raw_payload during reconcile
--   (b) debug "the engine didn't fire" reports by inspecting what we got
--   (c) detect duplicate webhook deliveries (Acuity retries on non-2xx)
--
-- Processing semantics:
--   - received_at populated on insert (every event lands here first)
--   - processed_at stamped when the appointment upsert succeeds
--   - error populated when processing fails (network, parse, etc.);
--     processed_at stays null so the row is identifiable as broken
--   - Idempotency on (platform, platform_event_id) where the platform
--     provides one. Acuity doesn't include a webhook delivery ID, so
--     we hash (action + appointment_id + received_at-bucketed) instead

create table if not exists public.emma_scheduler_webhook_events (
  id                       uuid        primary key default gen_random_uuid(),
  connection_id            uuid        not null references public.emma_scheduler_connections(id) on delete cascade,
  user_id                  uuid        not null references auth.users(id) on delete cascade,
  platform                 text        not null,

  -- Acuity event types: appointment.scheduled, .canceled, .rescheduled, .changed
  -- Stored verbatim from the platform.
  event_type               text        not null,

  -- The platform's appointment ID (Acuity returns "id" as a number;
  -- we store as text for forward-compat with platforms that use uuid
  -- or other string IDs).
  external_appointment_id  text,

  raw_payload              jsonb       not null,

  -- Maps to the row in emma_appointments after successful upsert.
  -- Null on first insert; populated by the receiver once the upsert
  -- returns the appointment.id.
  emma_appointment_id      uuid,

  received_at              timestamptz not null default now(),
  processed_at             timestamptz,
  error                    text
);

alter table public.emma_scheduler_webhook_events enable row level security;

do $$ begin
  create policy "users_own_emma_scheduler_webhook_events"
    on public.emma_scheduler_webhook_events for select
    using (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "service_role_emma_scheduler_webhook_events"
    on public.emma_scheduler_webhook_events for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

create index if not exists emma_scheduler_webhook_events_connection_idx
  on public.emma_scheduler_webhook_events (connection_id, received_at desc);
create index if not exists emma_scheduler_webhook_events_unprocessed_idx
  on public.emma_scheduler_webhook_events (received_at)
  where processed_at is null;
create index if not exists emma_scheduler_webhook_events_external_id_idx
  on public.emma_scheduler_webhook_events (platform, external_appointment_id);

comment on table public.emma_scheduler_webhook_events is
  'v381 — append-only audit log of inbound scheduler webhook events. processed_at null + error not null = a known-broken event; processed_at not null = successful upsert into emma_appointments.';

-- Reload PostgREST schema cache so the new tables are immediately
-- queryable by the server. Per the project convention.
notify pgrst, 'reload schema';

-- ─── Verify ────────────────────────────────────────────────────────────────
-- Confirm both tables landed with the expected columns.
select
  table_name,
  count(*) filter (where column_name = 'webhook_secret') as has_webhook_secret,
  count(*) filter (where column_name = 'access_token') as has_access_token,
  count(*) filter (where column_name = 'platform') as has_platform,
  count(*) as total_columns
from information_schema.columns
where table_schema = 'public'
  and table_name in ('emma_scheduler_connections', 'emma_scheduler_webhook_events')
group by table_name
order by table_name;
