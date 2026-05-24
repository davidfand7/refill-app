-- Phase 4.0 W1 (Spa side) — claim-your-business onboarding session storage.
--
-- A spa owner lands on /claim-your-business, pastes their spa URL, FireCrawl
-- pulls their public site, we extract structured fields (spa name, services,
-- hours, scheduling link, policies, contact info) and stage them in a session
-- row. The owner can browse the preview anonymously; only on signup+claim do
-- we materialize knowledge_nodes stamped with their auth.users.id.
--
-- Why a separate table instead of pre-creating knowledge_nodes:
--   knowledge_nodes.user_id is NOT NULL with FK to auth.users — there is no
--   user yet at scrape time. Staging in JSON keeps the graph clean of orphan
--   pre-claim nodes and makes abandoned sessions trivially discardable.
--
-- The session id is a long random uuid; for v1 (pilot/alpha) anyone holding
-- the id can read the session. The data inside is public-website-derived
-- anyway. Hardening (per-session signed URLs, expiring tokens) lands when
-- the surface goes broader — not in v1.

create table if not exists public.spa_claim_sessions (
  id              uuid        primary key default gen_random_uuid(),
  spa_url         text        not null,
  spa_name        text,
  -- Lifecycle: queued → scraping → preview-ready → claimed (or failed at any step).
  scrape_status   text        not null default 'queued'
                    check (scrape_status in ('queued','scraping','preview-ready','claimed','failed')),
  scrape_error    text,
  -- Structured extract (SpaScrapeData shape — see src/server/spa-claim.functions.ts).
  scrape_data     jsonb,
  claimed_by      uuid        references auth.users(id) on delete set null,
  claimed_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.spa_claim_sessions enable row level security;

-- Read-only access for anyone (anon + authenticated) — session id IS the
-- bearer for pre-claim browsing. Writes go through server fns under
-- service-role; no anon INSERT/UPDATE allowed.
do $$ begin
  create policy "anon_read_spa_claim_sessions"
    on public.spa_claim_sessions for select
    using (true);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "service_role_spa_claim_sessions"
    on public.spa_claim_sessions for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

create index if not exists spa_claim_sessions_url_idx
  on public.spa_claim_sessions (spa_url, created_at desc);

create index if not exists spa_claim_sessions_claim_idx
  on public.spa_claim_sessions (claimed_by, claimed_at desc);
