-- Emma(OS) per-spa sender domains (v355).
--
-- Replaces the EMMA_FROM_EMAIL global with a per-tenant verified sender.
-- Each spa can register their own domain ("rejuvmedical.com"), prove
-- ownership via DNS records published by Resend, then send campaigns
-- as "Emma at Rejuv <hello@rejuvmedical.com>" instead of the platform
-- default "Emma <hello@notify.openagentic.site>".
--
-- One row per spa per domain. Resend's domain object is the source of
-- truth for verification status; we mirror just enough to render the UI
-- without round-tripping to Resend on every page load (we DO refresh on
-- the Verify button + at send time when status='pending').
--
-- Tenant boundary: every row scoped by user_id with RLS. Reps don't
-- read this — outbound sender identity is a spa-side concern.
--
-- Storage shape (NOT a column-per-DNS-record): Resend returns a
-- `records` array with mixed types (SPF TXT, DKIM CNAME, MX) that
-- evolves with their infra. Persisting it verbatim as jsonb lets the
-- UI render whatever Resend currently asks for without a schema
-- migration every time they tweak.
--
-- Send-time fallback: when the spa has no row (or status != 'verified'),
-- emma-blast.functions.ts falls back to the platform default. Status
-- transitions: 'pending' → 'verified' (DNS published + Resend confirms)
-- or 'failed' (Resend gave up after retries). No row = use default.
--
-- Established 2026-05-16 (Promotions Engine v355).

create table if not exists public.emma_sender_domains (
  id                  uuid        primary key default gen_random_uuid(),
  user_id             uuid        not null references auth.users(id) on delete cascade,

  -- The apex / subdomain the spa registered, e.g. "rejuvmedical.com"
  -- or "send.rejuvmedical.com". One row per (user_id, domain).
  domain              text        not null,

  -- The visible parts of the From address. Resolves to
  --   "<from_display_name> <from_local_part@domain>"
  -- e.g. "Emma at Rejuv <hello@rejuvmedical.com>".
  -- Both have sane defaults so the spa only has to click Connect.
  from_local_part     text        not null default 'hello',
  from_display_name   text        not null default 'Emma',

  -- The Resend domain object id. Lets us GET /domains/:id on refresh
  -- without listing every domain on the account.
  resend_domain_id    text,

  -- Mirrored from Resend. 'pending' until DNS is published, 'verified'
  -- once Resend confirms, 'failed' if Resend gives up. We also use
  -- 'pending' as the initial state immediately after POST /domains.
  status              text        not null default 'pending'
                      check (status in ('pending', 'verified', 'failed')),

  -- Verbatim records[] array from Resend's domain object. Each entry
  -- carries { record: 'SPF'|'DKIM'|..., name, type, value, ttl, status }.
  -- The UI renders this for the spa to paste into their DNS provider.
  dns_records         jsonb       not null default '[]'::jsonb,

  -- Last time we asked Resend "is this verified yet?". Throttled to
  -- once per ~10s in the UI to avoid hammering the API.
  last_checked_at     timestamptz,

  verified_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  unique (user_id, domain)
);

alter table public.emma_sender_domains enable row level security;

do $$ begin
  create policy "users_own_emma_sender_domains"
    on public.emma_sender_domains for all
    using  (auth.uid() = user_id)
    with check (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "service_role_emma_sender_domains"
    on public.emma_sender_domains for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

-- Send-time hot path: "does this spa have a verified sender?" Lookup is
-- by user_id, filtered to status='verified'. Most spas have 0 or 1
-- verified rows, so this index is small and the planner can pick the
-- first verified row in one seek.
create index if not exists emma_sender_domains_active_idx
  on public.emma_sender_domains (user_id)
  where status = 'verified';

create trigger emma_sender_domains_set_updated_at
  before update on public.emma_sender_domains
  for each row execute function public.set_updated_at();

comment on table public.emma_sender_domains is
  'Per-spa Emma email sender. One row per (user_id, domain). status=verified means safe to use at send time; otherwise fall back to platform EMMA_FROM_EMAIL. Resend is the source of truth for verification; dns_records mirrors the records[] array verbatim for UI rendering.';
