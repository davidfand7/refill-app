-- v417.1.2 — Seed admin@refill-demo.test user_metadata.refill_next.
--
-- The v410.3 cross-host bridge reads user.user_metadata.refill_next on
-- agentiport.com SIGNED_IN events to know which Refill-host path to
-- redirect to (via /auth/cross-host-bridge). v417.1.2 extends the
-- parser allowlist to include /app/admin/personas. This migration sets
-- that metadata on the admin testing identity so the next admin magic
-- link minted via service-role admin.generateLink lands on
-- app.getrefill.app/app/admin/personas signed in — bypassing both the
-- agentiport.com Site URL Supabase forces AND the user-endpoint
-- signInWithPassword rate limit.
--
-- Schema matches parseRefillNextMetadata in src/lib/cross-host-bridge.ts:
--   { v: 1, path: "/app/admin/personas", lead: null, ref: null, step: 1 }
-- (step is meaningless for admin path but required by the schema; set
-- to 1 satisfies the validator without semantic meaning.)

update auth.users
set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) ||
  jsonb_build_object(
    'refill_next',
    jsonb_build_object(
      'v', 1,
      'path', '/app/admin/personas',
      'lead', null,
      'ref', null,
      'step', 1
    )
  )
where email = 'admin@refill-demo.test';

-- Verify:
--   select email, raw_user_meta_data->>'refill_next' as refill_next
--   from auth.users
--   where email = 'admin@refill-demo.test';
-- Expected: a JSON string starting with {"v":1,"path":"/app/admin/personas",...}
