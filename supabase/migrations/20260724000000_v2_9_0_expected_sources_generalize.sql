-- v2.9.0 — Generalize the expect-gate: expected_portal_sources → expected_sources.
--
-- The trusted-onboarding insight (project_trusted_onboarding): trust is a ladder
-- of GATES that all reduce to ONE primitive — "build the gate once and the whole
-- trust system falls out." v2.8.0 shipped the first concrete instance for reward
-- portals. The second surface — PMS / scheduler connections — has the identical
-- silent-failure shape (a calendar whose token is revoked or that's never been
-- connected simply VANISHES from Connection Health), so the right move is not a
-- second parallel table but to GENERALIZE the one we have. One mechanism, two
-- (and eventually N) feed kinds: the primitive proving itself by reuse.
--
-- Renames in place (the table is one day old with only test rows), so existing
-- portal expectations are preserved and simply gain kind='portal'.
--
-- Deploy ordering: the new app code (reading expected_sources) ships BEFORE this
-- runs. In the gap the expected-overlay read fails and degrades gracefully to
-- import/connection-only (it never breaks the trust page); once this lands, both
-- portals and schedulers light up.

alter table public.expected_portal_sources rename to expected_sources;

-- manufacturer → source_key: a portal's canonical brand, or a scheduler's
-- platform key ('acuity' / 'vagaro'). Generic name for a generic gate.
alter table public.expected_sources rename column manufacturer to source_key;

-- kind tags the feed family. Existing rows backfill to 'portal'.
alter table public.expected_sources
  add column if not exists kind text not null default 'portal'
  check (kind in ('portal', 'scheduler'));

-- Uniqueness now spans kind (a portal source and a scheduler source could share
-- a key without colliding). Replaces the (user_id, manufacturer) unique index.
drop index if exists expected_portal_sources_user_mfr;
create unique index if not exists expected_sources_user_kind_key
  on public.expected_sources (user_id, kind, source_key);

-- Fast per-tenant read for the health dashboard (enabled rows only).
drop index if exists expected_portal_sources_user_idx;
create index if not exists expected_sources_user_enabled_idx
  on public.expected_sources (user_id)
  where enabled;

-- RLS policies follow the table through the rename (they bind by table OID, not
-- name); their labels still say "...expected_portal_sources" but apply correctly.
-- Re-stating them defensively in case the table was created fresh elsewhere.
alter table public.expected_sources enable row level security;

do $$ begin
  create policy "service_role_expected_sources"
    on public.expected_sources for all
    using  (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "users_read_own_expected_sources"
    on public.expected_sources for select
    using (auth.uid() = user_id);
exception when duplicate_object then null;
end $$;

notify pgrst, 'reload schema';

-- Verify: existing rows preserved, all tagged kind='portal'.
select kind, count(*) as n from public.expected_sources group by kind;
