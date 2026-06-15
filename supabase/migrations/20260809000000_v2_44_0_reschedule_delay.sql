-- v2.44.0 — Reschedule Reminders: the grace-window timing knob.
--
-- project_flexible_pricing_and_timing (Idea 2): let the operator set how long
-- to WAIT after a cancel / no-show before a rebook nudge becomes eligible — a
-- grace window that gives the patient a chance to self-reschedule first.
-- Combined with the v2.36.0 "already-returned" filter, it structurally kills
-- the "they'd have rebooked anyway" objection: you gave them the window THEY
-- chose, they didn't take it, THEN SmartSpa acted.
--
-- Day-scale to pair with reschedule_lookback_days (the two ends of the same
-- window: delay = the recent floor, lookback = the old ceiling). The scope
-- doc sketched this as "_hours"; days matches lookback_days and needs no
-- conversion in the engine.
--
-- Default 0 = OFF (no grace) → ZERO behavior change for every spa already on
-- Reschedule Reminders. Opt-in, progressive disclosure (the pricing/timing
-- discipline: configurable under the hood, default stays zero-decision).
--
-- Idempotent: safe to re-apply the whole file.

alter table public.emma_noshow_policies
  add column if not exists reschedule_delay_days integer not null default 0;

comment on column public.emma_noshow_policies.reschedule_delay_days is
  'Grace window (days): wait this long after a cancel/no-show before a reschedule nudge is eligible, giving the patient time to self-rebook first. 0 = off (no grace). Pairs with reschedule_lookback_days as the recent floor of the sweep window.';
