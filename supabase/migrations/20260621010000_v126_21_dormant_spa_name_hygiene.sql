-- v1.26.21 — rename the dormant tenant's spa-name so it can't be
-- mistaken for an active tenant in the v1.26.20 admin-banner.
--
-- v1.26.20 made the admin defaulted-vs-explicit banner branch visible:
-- when admin lands on getrefill.app with no PersonaSwitcher pick, the
-- amber-bright banner reads "Defaulted to <tenant.name>". For the
-- dormant tenant (auth `dormantspaowner@test.com`, holds 5754 historical
-- Acuity appointments + 1140 QB-uploaded patients but engine has never
-- fired here) `tenants.name` is the bare string "Rejuv" — visually
-- indistinguishable from an active spa. The v1.26.16 changelog flagged
-- this as a data hygiene fix; v1.26.20 made it customer-visible.
--
-- Pick: "[Dormant] Rejuv Skin Spa" — preserves the historical "Rejuv"
-- string so the connection to Karen Aslakson's original spa is still
-- readable, but the leading "[Dormant]" tag is unmistakable to an
-- admin glancing at the banner. Better than "dormantspaowner-stub"
-- which is robot-y and discards the human history.
--
-- Tenant resolution: join through tenant_memberships (the tenants
-- table has no owner_user_id; ownership lives in memberships with
-- role='owner'). The dormant tenant has exactly one owner, this user.

update public.tenants
set name = '[Dormant] Rejuv Skin Spa'
where id in (
  select tenant_id
    from public.tenant_memberships
   where user_id = 'ecf8bcee-24a6-4a4d-a5f4-381166ca57fc'
     and role = 'owner'
);

-- Verify (paste-friendly — should return one row, name updated):
-- select t.id, t.name, t.slug, t.plan
--   from public.tenants t
--   join public.tenant_memberships m on m.tenant_id = t.id
--  where m.user_id = 'ecf8bcee-24a6-4a4d-a5f4-381166ca57fc'
--    and m.role = 'owner';
