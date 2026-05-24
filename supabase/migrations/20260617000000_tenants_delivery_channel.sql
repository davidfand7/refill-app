-- v415.1 — tenants.delivery_channel column for onboard wizard Step 4.
--
-- Captures how rescue offers will be delivered to patients for this spa:
--   'proxy'  — Refill drafts on the spa's Mac, owner reviews and taps Send
--              (no carrier setup, no porting, no monthly fees). Recommended
--              default per [[project_trial_first_no_money_asks]] — trial
--              users should never have to commit money / phone porting
--              before they feel the win.
--   'direct' — Refill sends SMS from the spa's own ported number (requires
--              ~3 weeks porting + carrier coordination). Available
--              post-trial; the /onboard wizard surfaces it as disabled
--              with "Available after your first month" copy.
--
-- Lives on `tenants` (not on `emma_noshow_policies`) because the channel is
-- a spa-level operational mode, not a per-policy knob. Policies inherit
-- the channel via the tenant relation. The existing rescue_proxy_phone /
-- rescue_proxy_email columns on emma_noshow_policies are HOW proxy works
-- for that policy; tenants.delivery_channel is WHETHER. Both coexist.
--
-- Default 'proxy' so any pre-existing tenant gets the trial-safe setting
-- without an explicit choice. New tenants from the wizard write this
-- explicitly via the v415.1 claimSlug input addition.

alter table public.tenants
  add column if not exists delivery_channel text not null default 'proxy'
  check (delivery_channel in ('proxy', 'direct'));

notify pgrst, 'reload schema';

-- Verify after paste:
--   select slug, name, delivery_channel, created_at
--   from public.tenants
--   order by created_at desc
--   limit 5;
-- All existing rows should show 'proxy'. New onboard claims will show
-- the user's choice (defaulting to 'proxy' since direct is disabled
-- in the v415.1 wizard).
