-- v417.1.1 — Dedicated admin testing identity.
--
-- Grasshopper's real account (davidfand303@gmail.com) stays Google-OAuth-
-- only. This adds a separate testing identity (admin@refill-demo.test)
-- with admin role so he can sign in at getrefill.app/login with straight
-- email/password and reach /app/admin/personas without needing Google.
--
-- Password gets set by the v417.1 bootstrap server fn after this
-- migration applies (extended to include admin@refill-demo.test in
-- the persona list).

-- ─── (1) auth.users ──────────────────────────────────────────────────────
-- v417.1.1: encrypted_password set DIRECTLY via pgcrypto bcrypt so admin
-- can sign in at getrefill.app/login with email + password the moment
-- this migration runs — no bootstrap UI dependency. Per
-- [[feedback-google-oauth-not-hooked-up]], Google OAuth is not configured;
-- email/password is the ONLY working admin login. Hardcoded password
-- "RefillTest2026!" matches V417_TEST_PASSWORD in src/server/v417-personas.ts.
-- *.test TLD = no real-money data; acceptable to embed in migration.
insert into auth.users (
  id, instance_id, aud, role,
  email, encrypted_password, email_confirmed_at,
  raw_user_meta_data, raw_app_meta_data,
  created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change
) values
  ('addf1110-0000-0000-0000-000000000001'::uuid,
   '00000000-0000-0000-0000-000000000000'::uuid,
   'authenticated', 'authenticated',
   'admin@refill-demo.test',
   crypt('RefillTest2026!', gen_salt('bf')),
   now(),
   jsonb_build_object('display_name','Refill Admin (test)','demo',true),
   jsonb_build_object('provider','email','providers',jsonb_build_array('email')),
   now(), now(), '', '', '', '')
on conflict (id) do update set
  encrypted_password = excluded.encrypted_password,
  email_confirmed_at = coalesce(auth.users.email_confirmed_at, now());

-- ─── (2) auth.identities ─────────────────────────────────────────────────
insert into auth.identities (
  id, user_id, provider, provider_id, identity_data,
  last_sign_in_at, created_at, updated_at
)
select
  gen_random_uuid(),
  u.id,
  'email',
  u.id::text,
  jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
  null,
  u.created_at,
  now()
from auth.users u
where u.email = 'admin@refill-demo.test'
  and not exists (
    select 1 from auth.identities i
    where i.user_id = u.id and i.provider = 'email'
  );

-- ─── (3) Grant admin role ────────────────────────────────────────────────
insert into public.user_roles (user_id, role)
values ('addf1110-0000-0000-0000-000000000001'::uuid, 'admin')
on conflict (user_id, role) do nothing;

-- ─── (4) primary_role ────────────────────────────────────────────────────
insert into public.user_preferences (user_id, primary_role)
values ('addf1110-0000-0000-0000-000000000001'::uuid, 'developer')
on conflict (user_id) do update set primary_role = excluded.primary_role;

-- ─── (5) Set passwords on Kelly / Maria / Karen ─────────────────────────
-- v417.1.1: Same pgcrypto approach so the personas the v417.1 dropdown
-- signs you in as are testable WITHOUT clicking the bootstrap UI button
-- first. The bootstrap server fn still works (idempotent re-application
-- of the same password) but it's no longer a prerequisite.
update auth.users
set encrypted_password = crypt('RefillTest2026!', gen_salt('bf')),
    email_confirmed_at = coalesce(email_confirmed_at, now())
where email in (
  'kelly@refill-demo.test',
  'maria@refill-demo.test',
  'karen@rejuv-demo.test'
);

notify pgrst, 'reload schema';

-- Verify:
--   select u.email, ur.role, up.primary_role
--   from auth.users u
--   left join public.user_roles ur on ur.user_id = u.id and ur.role = 'admin'
--   left join public.user_preferences up on up.user_id = u.id
--   where u.email = 'admin@refill-demo.test';
-- Expected: admin@refill-demo.test | admin | developer
