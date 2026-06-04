-- v1.42.0 — Light Mode email-forward connector.
--
-- WHY: For spas on a scheduler whose API is gated behind Enterprise tier,
-- a Support ticket, a developer-portal approval, or a CSM sales motion
-- (Boulevard / Mindbody / Booker / Jane / Zenoti), Refill cannot wait
-- weeks for credentials before delivering value. Every one of those
-- platforms ALREADY emails the spa owner on booking / cancellation /
-- no-show events. If the owner forwards those emails to a per-spa
-- Refill inbound address, Refill receives a continuous event feed
-- without touching the vendor's API or portal. 100% ToS-clean: owner
-- is forwarding their OWN mail.
--
-- Two new tables:
-- (1) emma_light_mode_connections — per-spa per-platform Light Mode
--     enrollment row. Holds the per-spa inbound email address (unique
--     random slug), the platform whose mail it parses, status, last
--     event timestamp, parser-confidence stats.
-- (2) emma_email_quarantine — append-only queue of inbound emails the
--     parser could not classify (unknown sender, broken template, etc.)
--     so the operator + Refill engineering can review + fix.
--
-- See briefs:
--   /Users/david_air/Desktop/David Claude Projects/Refill-LightMode-Spec-v1.html
--   /Users/david_air/Desktop/David Claude Projects/Refill-PlaidMode-BackPocket-v1.html

CREATE TABLE IF NOT EXISTS public.emma_light_mode_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id UUID REFERENCES public.tenants(id) ON DELETE CASCADE,

  -- Which scheduler platform's emails this connection parses.
  platform TEXT NOT NULL CHECK (platform IN (
    'acuity', 'square', 'vagaro',
    'boulevard', 'mindbody', 'booker', 'jane', 'zenoti'
  )),

  -- The per-spa inbound email address local-part. Unique 12+ char hex
  -- slug, base of the full address: <slug>@inbound.getrefill.app.
  -- Salted so unguessable + per-spa per-platform isolated.
  inbound_slug TEXT NOT NULL UNIQUE DEFAULT
    encode(gen_random_bytes(8), 'hex'),

  -- UI status. 'pending' = wizard not finished (no test email yet),
  -- 'active' = at least one parsed event landed, 'paused' = admin off,
  -- 'silent' = > 24h since last event when we expected one.
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'active', 'paused', 'silent'
  )),

  -- Last successful parse timestamp + total parsed events counter.
  last_event_at TIMESTAMPTZ,
  events_parsed_total INTEGER NOT NULL DEFAULT 0,
  events_quarantined_total INTEGER NOT NULL DEFAULT 0,

  -- Optional friendly note for the operator (e.g. "set up by Karen
  -- 2026-06-03 via Gmail filter on noreply@zenoti.com").
  notes TEXT,

  -- Last error if pipeline failed (for the same warning vs error
  -- UI split pattern the scheduler page already uses).
  last_error TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One Light Mode row per spa per platform.
  UNIQUE (user_id, platform)
);

COMMENT ON TABLE public.emma_light_mode_connections IS
  'Light Mode email-forward connector. Per-spa per-platform enrollment row holding the inbound address slug + status + counters.';

COMMENT ON COLUMN public.emma_light_mode_connections.inbound_slug IS
  'Local-part of <slug>@inbound.getrefill.app. Configured as a Resend Inbound Route → POST /api/resend/inbound-lite. Webhook handler looks up the connection by slug.';

CREATE INDEX IF NOT EXISTS idx_emma_light_mode_connections_user
  ON public.emma_light_mode_connections (user_id);

CREATE INDEX IF NOT EXISTS idx_emma_light_mode_connections_slug
  ON public.emma_light_mode_connections (inbound_slug);

CREATE INDEX IF NOT EXISTS idx_emma_light_mode_connections_tenant
  ON public.emma_light_mode_connections (tenant_id) WHERE tenant_id IS NOT NULL;

ALTER TABLE public.emma_light_mode_connections ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY users_own_light_mode_connections
    ON public.emma_light_mode_connections FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY service_role_light_mode_connections
    ON public.emma_light_mode_connections FOR ALL
    USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- emma_email_quarantine: unparseable inbound emails for review
-- ============================================================

CREATE TABLE IF NOT EXISTS public.emma_email_quarantine (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The Light Mode connection this email arrived for. NULL if the
  -- inbound slug didn't match any known connection (orphan).
  light_mode_connection_id UUID
    REFERENCES public.emma_light_mode_connections(id) ON DELETE SET NULL,

  -- Denormalized for fast filtering at admin / spa-side dashboards.
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  platform TEXT,

  -- The raw email envelope + body. Held verbatim so parser fixes can
  -- be retroactively applied without losing the original signal.
  inbound_slug TEXT,
  from_address TEXT,
  to_address TEXT,
  subject TEXT,
  raw_html TEXT,
  raw_text TEXT,
  message_id TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Why the parser couldn't classify. Free-form tag — e.g.
  -- "no_platform_match", "subject_no_match", "body_no_match",
  -- "event_type_unknown", "platform_disabled".
  reason TEXT,

  -- Per-parser confidence score (0-1) at time of quarantine. Useful
  -- for tuning thresholds.
  parser_confidence NUMERIC(3, 2),

  -- Set when operator reviews + resolves the quarantine row.
  reviewed_at TIMESTAMPTZ,
  reviewed_by UUID REFERENCES auth.users(id),
  reviewed_notes TEXT,
  reviewed_outcome TEXT CHECK (reviewed_outcome IN (
    'ignored', 'reparsed', 'parser_fix_filed', 'spam'
  )),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.emma_email_quarantine IS
  'Light Mode quarantine queue. Inbound emails the parser could not classify land here for human review. Append-only; original raw envelope retained so retro-parsing is possible after a parser fix.';

CREATE INDEX IF NOT EXISTS idx_emma_email_quarantine_user
  ON public.emma_email_quarantine (user_id) WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_emma_email_quarantine_unreviewed
  ON public.emma_email_quarantine (received_at DESC)
  WHERE reviewed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_emma_email_quarantine_platform
  ON public.emma_email_quarantine (platform, received_at DESC);

ALTER TABLE public.emma_email_quarantine ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY users_read_own_email_quarantine
    ON public.emma_email_quarantine FOR SELECT
    USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY service_role_email_quarantine
    ON public.emma_email_quarantine FOR ALL
    USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- Nudge PostgREST to pick up the new tables.
-- ============================================================

NOTIFY pgrst, 'reload schema';

-- Verification: paste this after the migration applies to confirm.
-- SELECT table_name FROM information_schema.tables
--   WHERE table_schema = 'public'
--     AND table_name IN ('emma_light_mode_connections', 'emma_email_quarantine');
