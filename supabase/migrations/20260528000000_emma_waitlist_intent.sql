-- v373: extend emma_waitlist for Type B (treatment-matched-already-scheduled)
-- waitlist intent. v361 shipped the catchall variant + per-patient
-- treatment_types filter; v373 adds the semantic distinction between
-- "patient opted into a general catchall waitlist" and "patient is
-- already scheduled for a Tox and wants an earlier Tox slot if one opens."
--
-- The rescue dispatcher already filters by treatment_types (existing,
-- since v361). v373 adds intent context for analytics + display:
--   - intent_type: 'catchall' | 'earlier_appointment'
--   - scheduled_appointment_id: nullable FK to emma_appointments,
--     used when Type B patient is waiting for an earlier-than-X slot
--
-- "Stay" rule (v373): when a Type B patient claims an earlier slot,
-- their original scheduled_appointment_id appointment STAYS — the
-- system does NOT auto-cancel. That second appointment becomes its own
-- opportunity for the rescue agent on its own day. Karen + David
-- decide manually whether to cancel the redundant appointment.

alter table public.emma_waitlist
  add column if not exists intent_type text not null default 'catchall'
    check (intent_type in ('catchall', 'earlier_appointment')),
  add column if not exists scheduled_appointment_id uuid
    references public.emma_appointments(id) on delete set null;

-- Partial index for the "earlier-than-this-appointment" lookup path —
-- when a Type B patient's scheduled appointment day comes around, the
-- preshow agent may want to clean up the redundant waitlist entry.
create index if not exists emma_waitlist_scheduled_appointment_idx
  on public.emma_waitlist (scheduled_appointment_id)
  where scheduled_appointment_id is not null;

-- v362 reliability tier integration (forward-prep, no behavior change
-- yet in v373) — when v374 ships tiered blast waves, the rescue
-- dispatcher will join emma_waitlist → knowledge_nodes →
-- emma_reliability_status and order by tier (vip → trusted → regular →
-- in_recovery). The data is already there; v373 leaves the existing
-- lifetime-spend sort in place until v374 actively replaces it.
