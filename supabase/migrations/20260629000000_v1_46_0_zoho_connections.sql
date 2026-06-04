-- v1.46.0 — Zoho CRM direct-OAuth connection storage.
--
-- Per-rep Zoho OAuth tokens + region-aware API base + status. Replaces the
-- never-shipped Composio broker path (composio-zoho.ts orphan removed in
-- this same ship).
--
-- Region handling: Zoho OAuth callback returns an `accounts-server` query
-- param (https://accounts.zoho.com, .eu, .in, .com.au, .jp, etc.) that
-- tells us which datacenter the user's data lives in. We store both the
-- accounts_server (for token refresh) and api_domain (for CRM calls) so
-- a US-region client doesn't accidentally hit EU endpoints.
--
-- Token storage: plaintext in this v1 migration. Production should move to
-- Supabase Vault — flagged in code with a TODO. The rows are RLS-guarded
-- so even direct DB read requires service-role; the actual leakage vector
-- is the Worker env compromise which would expose service-role anyway.
--
-- One row per (user_id) — a rep connects ONE Zoho org at a time. If they
-- want to switch orgs, they disconnect first (status='revoked') and reconnect.

create table if not exists public.zoho_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  tenant_id uuid references public.tenants(id) on delete set null,
  -- OAuth tokens. Plaintext in v1; Supabase Vault candidate.
  access_token text not null,
  refresh_token text not null,
  access_token_expires_at timestamptz not null,
  scopes text not null,
  -- Region-aware endpoints (US/EU/IN/AU/JP/CA — derived from callback's
  -- accounts-server param).
  accounts_server text not null default 'https://accounts.zoho.com',
  api_domain text not null default 'https://www.zohoapis.com',
  -- Identity hints (display only — what the rep sees in the UI).
  zoho_user_email text,
  zoho_org_name text,
  zoho_org_id text,
  -- Lifecycle.
  status text not null default 'connected' check (status in ('connected', 'expired', 'revoked', 'error')),
  last_error text,
  connected_at timestamptz not null default now(),
  last_sync_at timestamptz,
  last_synced_contact_count integer,
  -- Bookkeeping.
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id)
);

create index if not exists zoho_connections_user_id_idx
  on public.zoho_connections (user_id);
create index if not exists zoho_connections_tenant_id_idx
  on public.zoho_connections (tenant_id);
create index if not exists zoho_connections_status_idx
  on public.zoho_connections (status);

-- RLS: rep reads own row only. Writes via service role.
alter table public.zoho_connections enable row level security;

drop policy if exists zoho_connections_select_own on public.zoho_connections;
create policy zoho_connections_select_own
  on public.zoho_connections
  for select
  to authenticated
  using (user_id = auth.uid());

-- No insert/update/delete policies — all writes go through the OAuth
-- callback handler + sync server fn using the service-role client.

notify pgrst, 'reload schema';

-- Verify (run after apply):
-- select table_name, column_name, data_type
-- from information_schema.columns
-- where table_name = 'zoho_connections'
-- order by ordinal_position;
-- Expected: 19 columns matching the create table above.
