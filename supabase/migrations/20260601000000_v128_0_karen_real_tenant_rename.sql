-- v1.28.0 — Karen real-tenant rename.
--
-- The v1.26.13 rename made dormantspaowner@test.com the "admin's data
-- bucket" stand-in. v1.27 proved the waitlist-invite code path end-to-end
-- on it (per session_story_2026-05-30_v127_keystone_shipped). Now we
-- close the Karen-go-live triangle leg 1: rename the auth identity to
-- Karen's REAL email so she logs in as herself with all 1,140 patients
-- + 5,754 appointments + the rescue policy + tonight's 5 emma_waitlist
-- rows instantly attached. Same user_id (ecf8bcee-...-381166ca57fc) —
-- zero data migration, every foreign-key reference stays intact.
--
-- Side effect: admin@refill.platform's default-fallback tenant flips
-- from "[Dormant] Rejuv Skin Spa" to "Rejuv Skin Spa" (still the same
-- user_id, just under Karen's real email + tag dropped). Admin still
-- sees the data when defaulted-landing.
--
-- Apply via Supabase dashboard SQL editor.

BEGIN;

-- 1. Rename the auth identity. email_confirmed_at preserved (or set to
--    NOW if NULL) so the magic-link path doesn't choke on unconfirmed.
UPDATE auth.users
SET email = 'karen.rejuv@gmail.com',
    email_confirmed_at = COALESCE(email_confirmed_at, NOW())
WHERE id = 'ecf8bcee-24a6-4a4d-a5f4-381166ca57fc'
  AND email = 'dormantspaowner@test.com';

-- 2. Drop the [Dormant] tag from the display name. Tenant resolution
--    joins through tenant_memberships (the tenants table has no
--    owner_user_id column).
UPDATE public.tenants
SET name = 'Rejuv Skin Spa'
WHERE id IN (
  SELECT tenant_id FROM tenant_memberships
  WHERE user_id = 'ecf8bcee-24a6-4a4d-a5f4-381166ca57fc'
    AND role = 'owner'
);

COMMIT;
