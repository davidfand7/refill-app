-- v2.98.0 — Smart-A/B live loop: per-patient arm assignments.
--
-- For the bandit to learn from REAL bookings, a conversion has to credit the
-- arm the patient actually saw. So when an experiment is pushed, each patient
-- is assigned ONE arm (Thompson sampling) and that sticky assignment is stored
-- here. A later booking attributed to that patient + service credits the
-- assigned arm's conversion (recordExperimentConversion).
--
-- Sticky per (experiment, patient): a patient always sees the same variant, and
-- their impression is counted once at assignment. Idempotent + safe to re-run.

create table if not exists public.offer_experiment_assignments (
  id uuid primary key default gen_random_uuid(),
  experiment_id uuid not null,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  -- The patient node this assignment is for (the unit the booking attributes to).
  patient_node_id uuid not null,
  -- The arm (a row in manufacturer_promo_offers) this patient was assigned.
  arm_offer_id uuid not null,
  assigned_at timestamptz not null default now(),
  -- Stamped when this patient's booking credited the arm a conversion, so a
  -- second booking can't double-count the same patient's vote.
  converted_at timestamptz,
  unique (experiment_id, patient_node_id)
);

create index if not exists idx_ab_assign_patient
  on public.offer_experiment_assignments (tenant_id, patient_node_id);
create index if not exists idx_ab_assign_experiment
  on public.offer_experiment_assignments (experiment_id);

-- Separate atomic bumps for the sticky-assignment model: an impression is
-- counted at assign time, the conversion later when the patient books — so they
-- are distinct single-statement increments (vs v2.95's bump_ab_outcome which
-- counts an impression that converts in the same beat).
create or replace function public.bump_ab_impression(p_offer_id uuid, p_n integer)
returns void language sql as $$
  update public.manufacturer_promo_offers
     set ab_impressions = ab_impressions + greatest(0, p_n)
   where id = p_offer_id;
$$;

create or replace function public.bump_ab_conversion(p_offer_id uuid)
returns void language sql as $$
  update public.manufacturer_promo_offers
     set ab_conversions = ab_conversions + 1
   where id = p_offer_id;
$$;
