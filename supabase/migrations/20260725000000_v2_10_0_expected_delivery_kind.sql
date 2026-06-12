-- v2.10.0 — Third feed kind for the expect-gate: 'delivery' (outbound messaging).
--
-- The whole point of generalizing expected_portal_sources → expected_sources in
-- v2.9.0 (project_trusted_onboarding) was the claim: a NEW feed kind should be a
-- registry row + a connector, NOT a new system. This migration is the test of
-- that claim, and it's deliberately tiny — ONE widened CHECK constraint. No new
-- table, no new column, no new index. Everything else (the gate table, the fn
-- pair, the shared WatchSourcesSection UI, the verdict rule) is reused verbatim.
--
-- THE GAP this opens the door to closing: Connection Health watches the feeds
-- coming IN (reward portals, the calendar). It has been blind to the feed going
-- OUT — the recall / rescue messages SmartSpa sends patients. If that silently
-- stops (the local messaging agent isn't running, texts stop being delivered, an
-- opt-out cascade), nothing errors and the recovery engine just goes dark. That
-- is the exact silent failure (feedback_connection_health_doctrine) the surface
-- exists to catch, on the outbound side. Freshness source = patient_outreach
-- (direction='outbound', max(sent_at)); no schema needed for the signal itself.
--
-- Deploy ordering: new app code (which reads/writes kind='delivery') ships AFTER
-- this lands so the widened constraint already accepts the value. A delivery
-- upsert against the old constraint would be rejected loudly, not silently — so
-- migrate-then-deploy is the safe order here.

alter table public.expected_sources
  drop constraint if exists expected_sources_kind_check;

alter table public.expected_sources
  add constraint expected_sources_kind_check
  check (kind in ('portal', 'scheduler', 'delivery'));

notify pgrst, 'reload schema';

-- Verify: constraint now admits all three kinds; existing rows unaffected.
select kind, count(*) as n from public.expected_sources group by kind;
