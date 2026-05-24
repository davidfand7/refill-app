-- ─────────────────────────────────────────────────────────────────────────
-- v405 — Pinch #4 seed re-stitch: ledger notes get realistic spa names
-- ─────────────────────────────────────────────────────────────────────────
--
-- WHY
--   The 2026-05-22 Kelly Caffee dry-run flagged Pinch #4: the rep's
--   commission ledger showed every Tier-1 row as "DEMO_KELLY Tier-1 spa
--   #01" through "#08" and every Tier-2 cascade row as the bare string
--   "DEMO_KELLY Tier-2 cascade". The rep mental model expects spa NAMES
--   tied to the network ("Anderson Aesthetics — Kelly direct" / "Coast
--   Aesthetics — via Maria Chen"), not anonymous indices. Sub-rep names
--   on the network page should reconcile with the ledger's spa
--   attributions. v405 rewrites the seeded notes so they do.
--
-- WHAT
--   Re-points the `notes` column on existing rep_commission_ledger demo
--   rows (rep_id = c0ffee00-...-001 = Kelly) to descriptive names:
--     - Tier 1: 8 fictional spa names paired with " (Kelly direct)"
--     - Tier 2: 20 fictional spa names paired with " (via <sub-rep>)"
--   "DEMO_KELLY · " prefix is preserved so the existing wipe function
--   (notes LIKE 'DEMO_KELLY%') still matches and cleans up cleanly.
--
--   The ledger UI in v405 strips the "DEMO_KELLY · " prefix at render
--   time (app.lizzie.ledger.tsx) so the rep sees "Anderson Aesthetics
--   (Kelly direct)" with no leakage of the demo tag — but the DB row
--   keeps the tag for wipe.
--
-- IDEMPOTENCY
--   Each UPDATE narrowly matches the prior literal ("DEMO_KELLY Tier-1
--   spa #NN" / "DEMO_KELLY Tier-2 cascade") so re-running the migration
--   after it's already been applied is a no-op (zero rows match).
--
-- TO RUN
--   Paste into Supabase SQL editor on production. Per
--   [[feedback-migrations-via-dashboard]] — never `db push --linked`.
-- ─────────────────────────────────────────────────────────────────────────

begin;

-- ── Tier 1: 8 Kelly-direct spas across 3 months (24 rows) ────────────────
-- Extract spa_idx (1..8) from the existing notes literal and map it to
-- the spa name pool. Original literal example: "DEMO_KELLY Tier-1 spa #03"

update public.rep_commission_ledger
   set notes = 'DEMO_KELLY · ' || spa.name || ' (Kelly direct)',
       updated_at = now()
  from (values
    (1, 'Anderson Aesthetics'),
    (2, 'Lakeside Med Spa'),
    (3, 'Riverbend Wellness'),
    (4, 'Cedar Bluff Skin'),
    (5, 'Northwoods Beauty'),
    (6, 'Olympia Aesthetics'),
    (7, 'Crestview Rejuv'),
    (8, 'Stonebrook Med')
  ) as spa(idx, name)
 where rep_id = 'c0ffee00-0000-0000-0000-000000000001'::uuid
   and tier_level = 1
   and notes like 'DEMO_KELLY Tier-1 spa #%'
   and spa.idx = (substring(notes from 'spa #(\d+)'))::int;

-- ── Tier 2: 20 cascade spas across 5 sub-reps, distributed by period ─────
-- The seed inserts 6/14/20 Tier-2 rows per period (current/-1mo/-2mo) all
-- with identical notes. We use row_number() partitioned by period_month
-- to assign a spa-pool index 0..19 deterministically. Modulo 20 keeps it
-- in range even if the per-period count exceeds 20 (it doesn't today).
--
-- The 20-spa pool: 4 spas per sub-rep × 5 sub-reps. Names anchor each spa
-- to a specific sub-rep so the rep's mental model "Maria's 4 spas, Tony's
-- 4 spas, ..." matches the network tree.

with tier2_rows as (
  select id,
         (row_number() over (partition by period_month order by id) - 1)::int as row_idx
    from public.rep_commission_ledger
   where rep_id = 'c0ffee00-0000-0000-0000-000000000001'::uuid
     and tier_level = 2
     and notes = 'DEMO_KELLY Tier-2 cascade'
),
spa_pool as (
  select * from (values
    (0,  'Coast Aesthetics',       'Maria Chen'),
    (1,  'Pacific Skin',           'Maria Chen'),
    (2,  'Tidewater Med Spa',      'Maria Chen'),
    (3,  'Marina Beauty',          'Maria Chen'),
    (4,  'Highland Aesthetics',    'Tony Reyes'),
    (5,  'Mesa Med Spa',           'Tony Reyes'),
    (6,  'Foothills Skin',         'Tony Reyes'),
    (7,  'Canyon Wellness',        'Tony Reyes'),
    (8,  'Birch Beauty',           'Sarah Kim'),
    (9,  'Glasshouse Aesthetics',  'Sarah Kim'),
    (10, 'Linden Med Spa',         'Sarah Kim'),
    (11, 'Maple Lane Skin',        'Sarah Kim'),
    (12, 'Vista Aesthetics',       'Jasmine Patel'),
    (13, 'Sunridge Beauty',        'Jasmine Patel'),
    (14, 'Goldenrod Med',          'Jasmine Patel'),
    (15, 'Sage Wellness',          'Jasmine Patel'),
    (16, 'Brickline Med Spa',      'Marcus Williams'),
    (17, 'Ironwood Aesthetics',    'Marcus Williams'),
    (18, 'Foundry Beauty',         'Marcus Williams'),
    (19, 'Studio M Skin',          'Marcus Williams')
  ) as p(idx, spa_name, sub_rep)
)
update public.rep_commission_ledger l
   set notes = 'DEMO_KELLY · ' || p.spa_name || ' (via ' || p.sub_rep || ')',
       updated_at = now()
  from tier2_rows t
  join spa_pool p on p.idx = (t.row_idx % 20)
 where l.id = t.id;

commit;

-- ── PostgREST reload (defensive; no schema change but harmless) ──────────
notify pgrst, 'reload schema';

-- ── Verify (paste-friendly) ──────────────────────────────────────────────
-- Tier-1 distinct names — should return 8 distinct rows:
--
-- select distinct notes
--   from public.rep_commission_ledger
--  where rep_id = 'c0ffee00-0000-0000-0000-000000000001'::uuid
--    and tier_level = 1
--  order by notes;
--
-- Tier-2 distinct names — should return 20 distinct rows (Coast..Studio M):
--
-- select distinct notes
--   from public.rep_commission_ledger
--  where rep_id = 'c0ffee00-0000-0000-0000-000000000001'::uuid
--    and tier_level = 2
--  order by notes;
--
-- Verify wipe fn still matches via prefix:
--
-- select count(*) from public.rep_commission_ledger
--  where notes like 'DEMO_KELLY%';
