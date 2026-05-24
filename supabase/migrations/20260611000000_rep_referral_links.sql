-- ─────────────────────────────────────────────────────────────────────────
-- v406 — Persisted referral links (short slug + history substrate)
-- ─────────────────────────────────────────────────────────────────────────
--
-- WHY
--   Two pinches from the 2026-05-22 Kelly Caffee dry-run, both blocked on
--   the same missing substrate:
--
--     Pinch #10: the outbound referral URL Kelly shares is a 200+ char
--       JWT-shaped string (getrefill.app/onboard?ref=eyJyZXAiOiJjMG&hellip;).
--       Looks broken in a text message; unmemorable; impossible to
--       say-aloud on a phone call. Want: getrefill.app/r/kelly-caffee.
--
--     Pinch #7: /app/lizzie/referral-links shows the most-recently-minted
--       link but no history. If the rep mints once, leaves the page, and
--       comes back, the page is empty &mdash; they can't tell what their
--       current link is or whether anyone has used it.
--
--   Both are fixed by the same move: persist every mint to a
--   rep_referral_links table with a short_slug column. The existing
--   HMAC-signed token (src/server/referral-tokens.ts) becomes the
--   INTERNAL artifact &mdash; resolved server-side by slug lookup &mdash; and the
--   SHARE artifact is the short slug URL.
--
-- DATA MODEL
--   - One persistent row per rep (idempotent mint; same rep_user_id gets
--     the same slug on every subsequent call). This matches the "lifetime
--     referral link" mental model already shipped in v395.
--   - short_slug is globally unique (partial unique index, lowercase, kebab).
--   - token is the HMAC-signed JWT-shaped string (still verifiable
--     stateless via validateReferralToken; the row just stores it for
--     resolution).
--   - use_count + last_used_at update every time /r/<slug> resolves; gives
--     the history view a "X people have joined via your link" metric.
--
-- RLS
--   Service-role only. All reads/writes go through admin-gated server fns
--   (mintMyReferralLink, listMyReferralLinks, resolveReferralSlug). The
--   /r/<slug> route is a public redirect endpoint &mdash; no auth required to
--   resolve, but the underlying lookup uses the service-role client.
--
-- KELLY DEMO SEED
--   One pre-populated row for Kelly (rep_user_id = c0ffee00-...-001) with
--   slug "kelly-caffee", a freshly-minted token, and use_count=5 (matches
--   her 5 seeded Tier-1 sub-reps from migration 20260608). This makes the
--   history view non-empty for the demo without requiring her to mint
--   anything first.
--
-- TO RUN
--   Paste into Supabase SQL editor. Per [[feedback-migrations-via-dashboard]].
-- ─────────────────────────────────────────────────────────────────────────

begin;

create table if not exists public.rep_referral_links (
  id            uuid        primary key default gen_random_uuid(),
  rep_user_id   uuid        not null references auth.users(id) on delete cascade,
  -- Lowercase kebab-case slug, e.g. 'kelly-caffee'. Enforced unique globally
  -- so /r/<slug> resolves to exactly one rep with no collision.
  short_slug    text        not null,
  -- HMAC-signed referral token (see src/server/referral-tokens.ts). The row
  -- stores it so /r/<slug> can resolve slug → token → /onboard?ref=<token>
  -- redirect without re-minting on every resolution.
  token         text        not null,
  -- Resolution audit: bumped on every /r/<slug> hit.
  use_count     integer     not null default 0,
  last_used_at  timestamptz,
  created_at    timestamptz not null default now()
);

-- Lookup hot path: /r/<slug> resolution.
create unique index if not exists rep_referral_links_short_slug_unique
  on public.rep_referral_links (short_slug);

-- Per-rep listing: history view sorted newest-first (rep_user_id, created_at desc).
create index if not exists rep_referral_links_rep_idx
  on public.rep_referral_links (rep_user_id, created_at desc);

comment on table public.rep_referral_links is
  'Persisted referral link record per rep. Idempotent mint (one row per rep_user_id in current implementation); /r/<short_slug> redirects to /onboard?ref=<token>.';

comment on column public.rep_referral_links.short_slug is
  'Lowercase kebab-case slug derived from rep display name. Globally unique.';

comment on column public.rep_referral_links.token is
  'HMAC-signed referral token (see src/server/referral-tokens.ts). Stored so /r/<slug> resolves without re-minting.';

-- ── RLS ─────────────────────────────────────────────────────────────────
-- Service-role only. The /r/<slug> redirect route uses the admin client to
-- look up the slug → token mapping; the rep-facing UI calls server fns
-- (mintMyReferralLink, listMyReferralLinks) that also use the admin client.

alter table public.rep_referral_links enable row level security;

do $$ begin
  create policy "service_role_rep_referral_links"
    on public.rep_referral_links for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

-- ── Kelly demo seed ─────────────────────────────────────────────────────
-- One row for Kelly with use_count=5 so the history view is non-empty for
-- the 5/29 demo without requiring her to mint anything first. The token
-- value here is a placeholder ('SEED_REPLACE_ON_FIRST_MINT'); the first
-- call to mintMyReferralLink for Kelly will overwrite it with a real
-- HMAC-signed token (server fn handles this). /r/kelly-caffee will resolve
-- correctly the moment the server fn fires (idempotency clause in the
-- updated mintMyReferralLink — see src/server/rep-platform.ts).

insert into public.rep_referral_links
       (rep_user_id, short_slug, token, use_count, created_at)
values ('c0ffee00-0000-0000-0000-000000000001'::uuid,
        'kelly-caffee',
        'SEED_REPLACE_ON_FIRST_MINT',
        5,
        now() - interval '21 days')
on conflict (short_slug) do nothing;

commit;

-- ── PostgREST schema reload ─────────────────────────────────────────────
notify pgrst, 'reload schema';

-- ── Verify (paste-friendly) ──────────────────────────────────────────────
-- Confirm the table + indexes landed and the Kelly seed row is present:
--
-- select column_name, data_type, is_nullable
--   from information_schema.columns
--  where table_schema='public' and table_name='rep_referral_links'
--  order by ordinal_position;
--
-- select indexname from pg_indexes
--  where schemaname='public' and tablename='rep_referral_links';
--
-- -- Kelly seed:
-- select short_slug, use_count, last_used_at, created_at
--   from public.rep_referral_links
--  where rep_user_id = 'c0ffee00-0000-0000-0000-000000000001'::uuid;
