-- v1.23.0 (P3 of unified admin platform) — admin identity rename.
--
-- Per plan in ~/.claude/plans/frolicking-stargazing-church.md (D9 lock):
-- the dedicated admin identity created by v417_admin_testing_identity
-- (email: admin@refill-demo.test, user_id: addf1110-0000-0000-0000-000000000001)
-- gets renamed to admin@refill.platform to match Grasshopper's pre-lock
-- preference. UUID stays the same — all FK references in user_roles,
-- admin_audit_log, tenant_memberships (none today), etc. are preserved.
--
-- IDEMPOTENT: the UPDATE is no-op when the rename already applied.
--
-- ─── (1) Rename admin@refill-demo.test → admin@refill.platform ──────────
update auth.users
   set email = 'admin@refill.platform'
 where email = 'admin@refill-demo.test'
   and id = 'addf1110-0000-0000-0000-000000000001';

-- ─── (2) (OPTIONAL) Revoke admin role from davidfand303@gmail.com ──────
-- Per the D9 lock, davidfand303 stays as a regular spa-owner / member
-- account; the platform admin identity is now exclusively
-- admin@refill.platform. This DELETE removes the legacy admin role row;
-- davidfand303 keeps every other data they own.
--
-- COMMENTED OUT BY DEFAULT — uncomment ONLY if you want to revoke
-- Grasshopper's personal account's admin privileges this session.
-- Keep it commented to preserve a backup admin path while the new
-- identity gets a few sessions of trust.
--
-- delete from public.user_roles
--  where user_id = (select id from auth.users where email = 'davidfand303@gmail.com')
--    and role = 'admin';

-- ─── (3) Audit trail ─────────────────────────────────────────────────────
insert into public.admin_audit_log (actor_user_id, action, target_user_id, payload)
  select 'addf1110-0000-0000-0000-000000000001'::uuid,
         'admin.rename',
         'addf1110-0000-0000-0000-000000000001'::uuid,
         jsonb_build_object(
           'migration','20260620000000_v123_admin_rename',
           'from_email','admin@refill-demo.test',
           'to_email','admin@refill.platform'
         )
  -- Only log when the rename actually applied (idempotent paste-rerun is a no-op).
  where exists (
    select 1 from auth.users
    where email = 'admin@refill.platform'
      and id = 'addf1110-0000-0000-0000-000000000001'
  )
  and not exists (
    select 1 from public.admin_audit_log
    where action = 'admin.rename'
      and target_user_id = 'addf1110-0000-0000-0000-000000000001'::uuid
  );

notify pgrst, 'reload schema';

-- Verify (paste after running):
--   select email from auth.users where id = 'addf1110-0000-0000-0000-000000000001';
-- Expected: admin@refill.platform
--
--   select action, payload->>'from_email' as from, payload->>'to_email' as to
--   from public.admin_audit_log where action = 'admin.rename';
-- Expected: admin.rename | admin@refill-demo.test | admin@refill.platform
