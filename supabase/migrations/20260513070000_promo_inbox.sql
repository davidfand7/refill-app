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
