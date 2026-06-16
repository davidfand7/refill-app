-- v2.63.0 — Waitlist Slice 2: catalog-linked desired-service spine.
--
-- The waitlist's "desired service" has lived as free-text (`treatment_types`
-- text[]) since v361. Smart Slot-Fill needs to match a freed slot's
-- (provider, duration) against what a patient WANTS — which requires the
-- desire expressed as real catalog rows (so provider-qualification, via
-- scheduling_provider_services.service_id, and duration, via
-- services.duration_min, are checkable). This adds the catalog linkage
-- ALONGSIDE the free-text (which stays as display + the legacy loose matcher):
--
--   desired_service_ids uuid[]  — resolved services.id references.
--
-- Additive, nullable-with-default. No per-element FK (Postgres arrays can't
-- carry element FKs); the consumer joins to `services` and ignores dangling
-- ids the way the rest of the app tolerates renamed/deleted catalog rows.
-- `treatment_types` is untouched — every existing reader/writer keeps working.

ALTER TABLE public.emma_waitlist
  ADD COLUMN IF NOT EXISTS desired_service_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];

COMMENT ON COLUMN public.emma_waitlist.desired_service_ids IS
  'v2.63.0 — catalog-linked desired services (services.id refs), resolved from treatment_types. The Smart Slot-Fill matching spine. Free-text treatment_types stays for display + legacy matcher.';
