-- v2.31.0 — Monthly Patient-Book Export gate + dedup, on emma_noshow_policies.
--
-- Mirrors the recall-digest pattern (recall_digest_enabled / _last_sent_at).
-- The "Monthly Patient-Book Export" Skill (a `routine` materializer) flips
-- patient_export_enabled via POLICY_GATE; the monthly pg_cron job
-- (api.cron.patient-export) emails the owner a CSV of their patient book and
-- stamps patient_export_last_sent_at for its dedup guard.
--
-- emma_noshow_policies is the de-facto per-tenant settings/gate table (it already
-- holds recall_digest_*), so the export flags live here too.

alter table public.emma_noshow_policies
  add column if not exists patient_export_enabled boolean not null default false,
  add column if not exists patient_export_last_sent_at timestamptz;

comment on column public.emma_noshow_policies.patient_export_enabled is
  'Monthly Patient-Book Export Skill on/off (flipped by adopt + On/Pause via POLICY_GATE). When true, the monthly cron emails the owner their patient-book CSV.';
