-- v369: Public /scan page — global header cache + scan-lead capture.
--
-- The public scanner is the viral funnel for Emma: any med-spa owner can
-- drop their PMS CSV at /scan, see exactly how much no-show revenue they
-- are leaking + how much Emma would recover, no signup. The page parses
-- everything client-side so patient data never leaves the browser.
--
-- This migration adds two tables:
--
-- public_csv_dialect_cache — global header-shape cache, no user_id. Every
--   scan teaches every future scan. Header shapes are not PII (they are
--   vendor product structure), so global caching is safe and compounds.
--   First scan from a new platform pays the LLM tax; everyone else benefits.
--
-- csv_scanner_leads — opt-in email capture from the /scan page. Lead row
--   carries detected platform + sample-size stats so the follow-up email
--   can reference what they uploaded ("the 47-appointment Acuity export
--   you scanned showed ~$3,200 in monthly leak").

create table if not exists public.public_csv_dialect_cache (
  id uuid primary key default gen_random_uuid(),
  -- SHA-256 of (header row lowercased, joined by |) — global key
  header_hash text not null unique,
  detected_platform text,
  alias_map jsonb not null,
  llm_model text not null,
  llm_at timestamptz not null default now(),
  scan_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists public_csv_dialect_cache_platform_idx
  on public.public_csv_dialect_cache (detected_platform);

alter table public.public_csv_dialect_cache enable row level security;

-- No anon reads — only service role. The mapper endpoint hits this server-side.
create policy "service role full access on public cache"
  on public.public_csv_dialect_cache for all
  to service_role using (true) with check (true);


create table if not exists public.csv_scanner_leads (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  detected_platform text,
  -- Free-form referral source ("DM from David", "Twitter", "direct", etc.)
  source text,
  -- Snapshot of the receipt the user saw — so the follow-up email is specific
  appointment_count int,
  date_range_start date,
  date_range_end date,
  noshow_count int,
  estimated_monthly_leak_usd numeric(12, 2),
  estimated_monthly_recovery_usd numeric(12, 2),
  -- Headers seen (for vendor catalog) — no PHI since rows stay in browser
  header_sample text[],
  -- Whether the LLM mapper was needed (catalog signal)
  was_ai_mapped boolean not null default false,
  ip_hash text,
  user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists csv_scanner_leads_email_idx
  on public.csv_scanner_leads (lower(email));
create index if not exists csv_scanner_leads_created_at_idx
  on public.csv_scanner_leads (created_at desc);

alter table public.csv_scanner_leads enable row level security;

-- Public can INSERT only (lead capture). No read, no update, no delete.
-- Service role has full access for admin / outreach.
create policy "anon insert scan leads"
  on public.csv_scanner_leads for insert
  to anon
  with check (true);

create policy "service role full access on scan leads"
  on public.csv_scanner_leads for all
  to service_role using (true) with check (true);


-- updated_at auto-touch for the cache table
create or replace function public.touch_public_csv_dialect_cache_updated_at()
returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_public_csv_dialect_cache_updated_at
  on public.public_csv_dialect_cache;
create trigger trg_public_csv_dialect_cache_updated_at
  before update on public.public_csv_dialect_cache
  for each row execute function public.touch_public_csv_dialect_cache_updated_at();
