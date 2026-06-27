-- v2.185.0 — Slice 1: the AT-BOOKING ask ("VIP early-access").
--
-- When a new Acuity booking lands and the spa has opted in, SmartSpa texts the
-- patient once asking if they want first dibs on earlier openings. A "yes" tap
-- joins the existing waitlist with intent_type='earlier_appointment' pointing at
-- the just-made booking — so the freed-slot rescue matcher inherits their
-- service + "earlier-than" ceiling for free. This migration only adds the
-- per-spa gate + the new opt_in_source attribution value; all engine logic and
-- the downstream cancellation→rescue→claim→writeback chain already exist.

-- (1) Per-spa gate. Co-located with rescue_enabled / sending_paused on
--     noshow_policies (the row dispatchAtBookingAsk already loads). Default OFF
--     — every spa opts in deliberately.
alter table public.noshow_policies
  add column if not exists at_booking_ask_enabled boolean not null default false;

-- (2) Allow 'at-booking-ask' as a waitlist opt_in_source so the pre-seeded
--     paused row attributes correctly (TCPA wants to know how each patient got
--     on the list). The original CHECK was an unnamed inline constraint created
--     on emma_waitlist (pre prefix-retirement), so its name didn't follow the
--     table rename. Find + drop it by definition (bulletproof against whatever
--     auto-name it carries), then re-add an explicitly-named, extended one.
do $$
declare c record;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.waitlist'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%footer-link%'
  loop
    execute format('alter table public.waitlist drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.waitlist
  add constraint waitlist_opt_in_source_check
  check (opt_in_source in (
    'footer-link',
    'spa-manual',
    'patient-detail-toggle',
    'at-booking-ask'
  ));
