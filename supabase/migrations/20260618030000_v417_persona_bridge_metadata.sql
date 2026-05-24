-- v417.2 — Seed kelly@refill-demo.test + maria@refill-demo.test
-- user_metadata.refill_next so service-role-minted magic links bridge
-- through to app.getrefill.app/app/rep cleanly.
--
-- Mirrors the v417.1.2 admin pattern (20260618020000_v417_admin_refill_next.sql).
-- The v410.3 cross-host bridge reads user_metadata.refill_next on
-- agentiport.com SIGNED_IN events to know which Refill-host path to
-- redirect to. v417.2 extends the parser allowlist to include
-- /app/rep + /app/refill and extends the SYNC fast-path in
-- cross-host-bridge-trigger.tsx to fire on ANY non-onboard path —
-- which kicks in for these personas the next time they sign in via
-- magic link.
--
-- Karen (karen@rejuv-demo.test) intentionally NOT seeded here: she has
-- a tenant_memberships row, and the slow path's tenant-first branch
-- already routes her to BRIDGE_DEFAULT_NEXT (/app/refill). Adding a
-- refill_next metadata to her would still work (the SYNC path would
-- catch her), but we avoid disturbing return-visit semantics where
-- tenant should always win over any stale onboard metadata.
--
-- Schema matches parseRefillNextMetadata in src/lib/cross-host-bridge.ts:
--   { v: 1, path: "/app/rep", lead: null, ref: null, step: 1 }
-- (step is meaningless for non-onboard paths but required by the
-- validator; set to 1 satisfies it without semantic meaning.)

update auth.users
set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) ||
  jsonb_build_object(
    'refill_next',
    jsonb_build_object(
      'v', 1,
      'path', '/app/rep',
      'lead', null,
      'ref', null,
      'step', 1
    )
  )
where email in ('kelly@refill-demo.test', 'maria@refill-demo.test');

notify pgrst, 'reload schema';

-- Verify:
--   select email, raw_user_meta_data->>'refill_next' as refill_next
--   from auth.users
--   where email in ('kelly@refill-demo.test', 'maria@refill-demo.test')
--   order by email;
-- Expected (2 rows):
--   kelly@refill-demo.test | {"v":1,"path":"/app/rep","lead":null,"ref":null,"step":1}
--   maria@refill-demo.test | {"v":1,"path":"/app/rep","lead":null,"ref":null,"step":1}
