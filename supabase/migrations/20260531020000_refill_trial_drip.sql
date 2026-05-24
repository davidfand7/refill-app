-- v388: Refill trial drip engagement (Phase 1.6 slice 1)
--
-- The trial-engagement layer. During the 30-day free trial we send a
-- sequence of "from Karen" check-in emails to keep Refill top of mind,
-- collect product feedback, and warm the spa owner for the eventual
-- plan-pick conversation (which happens NOT here — it lives in /app/billing
-- triggered by drip CTAs or trial-end, per the trial-first-no-money-asks
-- product rule).
--
-- This migration ships the storage substrate. The cron + first send
-- (Day-3 "how's it going?") land in the same v388. Reply parsing lands
-- in v390 (requires Resend inbound on getrefill.app first).
--
-- Schema rationale:
--
--   event_type        — namespaced strings like 'drip:day3', 'drip:day7',
--                       'incentive:offered', 'plan:viewed', 'plan:picked'.
--                       Keep it open-ended; this table is the future
--                       audit trail for the whole conversion funnel, not
--                       just drip sends.
--
--   payload (jsonb)   — Resend message_id, subject, recipient_email
--                       snapshot, any other per-event metadata.
--
--   sent_at           — populated ONLY on successful send. The cron
--                       checks for the absence of a matching
--                       (tenant_id, event_type) row to decide whether
--                       to send. Failed sends just don't insert; the
--                       cron retries on its next run.
--
--   response_text     — NULL until v390 wires inbound reply capture
--                       on getrefill.app. Reserved column.
--
--   source_drip_id    — chaining anchor for v390+ incentive offers
--                       that originate from a specific drip touchpoint
--                       (e.g. trial extension offered in response to a
--                       Day-14 reply).
--
-- Indexes:
--
--   (tenant_id, event_type) — the cron's hot path: "has this tenant
--                             received the Day-3 drip yet?" The
--                             multi-column ordering matters — most
--                             queries filter tenant first then narrow
--                             by event_type.

create table if not exists public.tenant_engagement_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  sent_at timestamptz,
  response_text text,
  source_drip_id uuid references public.tenant_engagement_events(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists tenant_engagement_events_tenant_type_idx
  on public.tenant_engagement_events (tenant_id, event_type);

create index if not exists tenant_engagement_events_sent_at_idx
  on public.tenant_engagement_events (sent_at desc)
  where sent_at is not null;

notify pgrst, 'reload schema';

-- Verify (paste-friendly):
-- select column_name, data_type, is_nullable
--   from information_schema.columns
--  where table_schema = 'public'
--    and table_name = 'tenant_engagement_events'
--  order by ordinal_position;
