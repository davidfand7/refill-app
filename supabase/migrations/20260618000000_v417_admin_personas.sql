-- v417.1 — Admin persona switcher prerequisites.
--
-- The personas themselves already exist from prior demo seeds:
--   kelly@refill-demo.test     (rep, anchor)        — 20260608000000_rep_platform_demo_seed
--   maria@refill-demo.test     (T1 sub-rep)         — same file
--   karen@rejuv-demo.test      (spa owner, Rejuv)   — 20260615010000_karen_demo_seed
--
-- This migration just wires the prerequisites for the v417.1 admin
-- persona switcher at /app/admin/personas:
--   (1) Grant admin role to Grasshopper so he can hit the switcher route
--   (2) Ensure user_preferences.primary_role is set for each persona so
--       post-login dispatch routes Kelly + Maria → /app/rep, Karen →
--       /app/refill
--
-- Passwords get set by the v417.1 bootstrapPersonas server fn (Supabase
-- auth.users.encrypted_password is bcrypt — can't be safely seeded via
-- raw SQL). One-shot button click from /app/admin/personas after this
-- migration applies sets the shared test password on each persona.

-- ─── (1) Grant admin to Grasshopper ──────────────────────────────────────
-- Idempotent — re-running is a no-op if the row already exists.
insert into public.user_roles (user_id, role)
select id, 'admin'
from auth.users
where email = 'davidfand303@gmail.com'
on conflict (user_id, role) do nothing;

-- ─── (2) primary_role on each persona ────────────────────────────────────
-- Without these, post-login dispatch can't route the persona to the
-- right dashboard (rep → /app/rep, spa-owner → /app/refill).
insert into public.user_preferences (user_id, primary_role)
select id, 'rep'
from auth.users
where email in ('kelly@refill-demo.test', 'maria@refill-demo.test')
on conflict (user_id) do update set primary_role = excluded.primary_role;

insert into public.user_preferences (user_id, primary_role)
select id, 'spa-owner'
from auth.users
where email = 'karen@rejuv-demo.test'
on conflict (user_id) do update set primary_role = excluded.primary_role;

notify pgrst, 'reload schema';

-- Verify after paste:
--   select u.email, ur.role, up.primary_role
--   from auth.users u
--   left join public.user_roles ur on ur.user_id = u.id and ur.role = 'admin'
--   left join public.user_preferences up on up.user_id = u.id
--   where u.email in (
--     'davidfand303@gmail.com',
--     'kelly@refill-demo.test',
--     'maria@refill-demo.test',
--     'karen@rejuv-demo.test'
--   )
--   order by u.email;
--
-- Expected rows:
--   davidfand303@gmail.com  | admin | (null or whatever it was)
--   karen@rejuv-demo.test   | (null)| spa-owner
--   kelly@refill-demo.test  | (null)| rep
--   maria@refill-demo.test  | (null)| rep
