-- v265 — Idempotent spa claim: safety net against duplicate spa-profile / services
-- nodes. Pre-v265 the claim flow used pure INSERT, so any repeat claim of the
-- same spa under the same user piled fresh nodes on top of the old ones
-- (Grasshopper saw 77 nodes accumulate on Rejuv during a dev cycle of repeat
-- test claims). v265 also rewrites the application code to do diff-based
-- upsert via materializeSpaNodes — this migration is the database-level
-- belt to that suspenders, so even a future bug or direct DB write can't
-- bring duplicates back.
--
-- Two steps:
--   1. Collapse any existing duplicates per (user_id, context, lookup_key),
--      keeping the most recently-updated row. Required before step 2 — the
--      unique index would otherwise refuse to apply.
--   2. Add a partial unique index covering only the contexts where lookup_key
--      acts as a stable identity ('spa-profile' scalars + 'services' by slug).
--      'policies' is excluded because it has no stable key (free-form text;
--      handled at the app layer by replace-all on save).

-- ── Step 1: dedupe ─────────────────────────────────────────────────────────
-- For each (user_id, context, lookup_key) where context is one of the two
-- targeted contexts and lookup_key is non-null, keep the row with the most
-- recent updated_at (tie-break by created_at desc, then id desc for total
-- determinism). Delete the rest.
with ranked as (
  select
    id,
    row_number() over (
      partition by user_id, context, lookup_key
      order by updated_at desc nulls last, created_at desc, id desc
    ) as rn
  from public.knowledge_nodes
  where context in ('spa-profile', 'services')
    and lookup_key is not null
)
delete from public.knowledge_nodes
where id in (
  select id from ranked where rn > 1
);

-- ── Step 2: partial unique index ───────────────────────────────────────────
-- Enforces "one row per (user, context, lookup_key)" for spa-profile scalars
-- and services. Partial so we don't index every knowledge_nodes row
-- unnecessarily, and so other contexts that legitimately allow duplicates
-- (or NULL lookup_keys) aren't constrained.
create unique index if not exists knowledge_nodes_spa_lookup_unique_idx
  on public.knowledge_nodes (user_id, context, lookup_key)
  where context in ('spa-profile', 'services')
    and lookup_key is not null;
