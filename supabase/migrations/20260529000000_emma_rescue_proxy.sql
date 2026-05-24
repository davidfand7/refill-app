-- v379: rescue proxy mode (Karen-in-the-loop, trial-mode pilot).
--
-- Adds two nullable TEXT columns to emma_noshow_policies. When EITHER is
-- non-null, the rescue dispatcher routes the entire batch of offer URLs
-- to the proxy address(es) in a single aggregated message INSTEAD of
-- firing one SMS per waitlist patient. The spa owner (Karen, for Rejuv
-- Skin Spa) then hand-forwards individual URLs to actual patients — or
-- pastes the proxy email into a Claude Desktop session that drafts them
-- in iMessage automatically.
--
-- Use cases:
--   1. Bandwidth porting in flight — engine PROVEN end-to-end on real
--      Rejuv data without depending on carrier delivery to patients.
--      Twilio outbound to Karen's personal number works today; Bandwidth
--      porting only gates patient-facing delivery.
--   2. New-pilot onboarding — any future spa can opt into "Karen-in-the-
--      loop trial mode" for the first month before they invest in 10DLC
--      brand registration + carrier porting. Lowers onboarding friction
--      massively without compromising the engine architecture.
--
-- When both columns are null, behavior is byte-identical to v378 — the
-- per-patient send loop runs unchanged.

alter table public.emma_noshow_policies
  add column if not exists rescue_proxy_phone text,
  add column if not exists rescue_proxy_email text;

comment on column public.emma_noshow_policies.rescue_proxy_phone is
  'v379 trial-mode: when set, rescue dispatch sends ONE aggregated SMS to this number instead of per-patient SMSes. Karen forwards URLs to patients manually.';
comment on column public.emma_noshow_policies.rescue_proxy_email is
  'v379 trial-mode: when set, rescue dispatch sends ONE aggregated email to this address with formatted draft messages per offer.';

-- Reload PostgREST schema cache so the new columns are immediately
-- queryable by the server. Per the project convention.
notify pgrst, 'reload schema';

-- Verify: confirm both columns landed on the policies table.
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'emma_noshow_policies'
  and column_name in ('rescue_proxy_phone', 'rescue_proxy_email')
order by column_name;
