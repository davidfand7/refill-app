-- v2.142.3 — Idempotency for emailed portal imports.
--
-- Resend can deliver one inbound email to more than one configured webhook
-- (we observed the same screenshot hit BOTH /api/resend/inbound and
-- /api/resend/inbound-rewards), double-staging the same import. Stamp each
-- batch with the Resend message id and enforce one batch per (tenant, message)
-- so a re-delivery becomes a no-op (the second insert conflicts and the caller
-- returns the existing batch). NULL message ids (in-app uploads) are exempt.

alter table public.portal_import_batches
  add column if not exists source_message_id text;

create unique index if not exists uq_portal_import_batches_msg
  on public.portal_import_batches (tenant_id, source_message_id)
  where source_message_id is not null;
