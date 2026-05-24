-- v372: thin manual-onboarding intake — captures spa owners who clicked
-- "Set up Refill for my spa" from /scan, /story, the report, or the
-- follow-up email. Adds columns to csv_scanner_leads so we keep ONE
-- leads pipeline (a scan + an intent can live on the same row if email
-- matches; otherwise an intent-only row gets inserted with no scan data).
--
-- The intake is intentionally tiny: practice name, current scheduler,
-- estimated cancels/mo, optional phone + notes. Karen + David receive an
-- email per intent and manually onboard within 24hrs. When the in-app
-- self-serve flow ships (v37x.x), this intake becomes a pre-fill source.

alter table public.csv_scanner_leads
  add column if not exists setup_intent_at timestamptz,
  add column if not exists setup_intent_practice_name text,
  add column if not exists setup_intent_scheduler text,
  add column if not exists setup_intent_phone text,
  add column if not exists setup_intent_estimated_monthly_cancels int,
  add column if not exists setup_intent_notes text,
  add column if not exists setup_intent_notified_at timestamptz,
  add column if not exists setup_intent_notified_error text;

create index if not exists csv_scanner_leads_setup_intent_at_idx
  on public.csv_scanner_leads (setup_intent_at desc)
  where setup_intent_at is not null;
