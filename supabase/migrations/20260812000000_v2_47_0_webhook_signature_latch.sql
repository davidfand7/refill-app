-- v2.47.0 — Acuity webhook HMAC enforcement: self-calibrating signature latch.
--
-- Acuity's docs are ambiguous on whether OAuth-registered ("dynamic")
-- webhooks sign the body with the OAuth client_secret or a per-account API
-- key. Until v2.47.0 we computed the HMAC but ran ADVISORY-only (audited the
-- mismatch, never rejected) to avoid silently dropping legitimate webhooks if
-- our key guess were wrong — the worst outcome under the connection-health
-- doctrine (a silent feed break that looks like SmartSpa is broken).
--
-- This column lets the receiver self-calibrate per connection: the first time
-- a delivery's signature validates against the client_secret, we stamp the key
-- as PROVEN for that connection. From then on, an invalid signature on that
-- connection is a forgery and is hard-rejected (401). A connection we've never
-- validated stays advisory (the 48-char path secret remains the gate), so a
-- first/legitimate webhook can never be silently dropped.
--
-- Idempotent: nullable, no backfill needed (NULL = "key not yet proven").
alter table public.emma_scheduler_connections
  add column if not exists webhook_signature_verified_at timestamptz;

comment on column public.emma_scheduler_connections.webhook_signature_verified_at is
  'First instant a webhook signature validated against the OAuth client_secret for this connection. NULL = not yet proven (signature enforcement stays advisory). Once set, invalid signatures on this connection are hard-rejected as forgeries. (v2.47.0)';
