-- v1.35.0 — Square Appointments integration: webhook_subscription_id column.
--
-- WHY: Acuity stores a per-spa URL-path secret in emma_scheduler_connections.
-- webhook_secret and tears down subscriptions by URL match. Square issues
-- a subscription_id at createWebhookSubscription time and requires it for
-- the corresponding DELETE call. The columns are semantically different
-- (URL-routing token vs. resource ID) — neither can be silently overloaded
-- without breaking the other platform's lifecycle.
--
-- ONE new column. Backwards-compatible: existing Acuity rows ignore it.
-- For Square: webhook_secret holds the per-subscription signature_key
-- (used as HMAC-SHA256 key for inbound signature verification);
-- webhook_subscription_id holds the subscription's resource ID (used by
-- disconnectScheduler to tear it down on the Square side).
--
-- Square notification URL is single-global (api.webhooks.scheduler.square)
-- so the URL itself doesn't carry tenant-routing info — that's done via
-- merchant_id in payload, stored on platform_account_id.

ALTER TABLE emma_scheduler_connections
  ADD COLUMN IF NOT EXISTS webhook_subscription_id TEXT;

COMMENT ON COLUMN emma_scheduler_connections.webhook_subscription_id IS
  'Square: the per-subscription resource ID returned by /v2/webhooks/subscriptions POST. Used by disconnectScheduler to call DELETE /v2/webhooks/subscriptions/:id. NULL for Acuity (which uses URL-path teardown).';

-- Nudge PostgREST to pick up the new column without waiting for the
-- scheduled cache rebuild.
NOTIFY pgrst, 'reload schema';
