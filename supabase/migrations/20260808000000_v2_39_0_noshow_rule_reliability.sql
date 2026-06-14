-- v2.39.0 — Reschedule Reminders · Slice 4: apply the no-show rule spa-wide.
--
-- The canonical no-show rule (noshow_notice_hours) already drives Reschedule
-- Reminders. This adds an EXPLICIT opt-in to also apply it to RELIABILITY
-- SCORING: when on, a late cancel (a cancellation given inside the spa's notice
-- window) counts as a no-show toward the reliability tier — so a chronic
-- late-canceller can reach the `in_recovery` tier (which can gate deposits),
-- not just a chronic no-shower.
--
-- Opt-in by design: this changes how a patient is JUDGED, so we never turn it
-- on silently — default false; the operator flips it on the No-show definition
-- card. Off = exactly today's behavior (raw status='no_show' only). The
-- reclassification is ADDITIVE for the tier count; the raw cancellation/grace
-- display is left untouched (grace's own semantics are a separate question).

alter table public.emma_noshow_policies
  add column if not exists noshow_rule_applies_reliability boolean not null default false;

comment on column public.emma_noshow_policies.noshow_rule_applies_reliability is
  'Opt-in: when true, the reliability engine reclassifies a late cancel (cancelled '
  'inside noshow_notice_hours) as a no-show for the in-recovery tier count. '
  'Default false = legacy status-only counting.';

notify pgrst, 'reload schema';

-- Verify — expect the column present, default false.
select column_name, data_type, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'emma_noshow_policies'
  and column_name = 'noshow_rule_applies_reliability';
