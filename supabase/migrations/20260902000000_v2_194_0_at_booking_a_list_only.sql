-- v2.194.0 — At-booking ask: restrict the VIP invite to the A-list.
--
-- The at-booking "VIP early-access" ask currently invites EVERY matched patient to
-- join the waitlist. This adds a per-spa switch to invite only the spa's A-list —
-- its hand-selected / rules-qualified best clients — so the "VIP" framing is real.
--
-- Membership is the existing A-list flag (knowledge_nodes.attachments.vip), which
-- the Patients-page star AND the "A-list rules" Apply both write — so the gate
-- reads exactly what the owner sees, no drift, no new data model. Default false =
-- today's behavior (invite everyone) until a spa flips it on.
alter table noshow_policies
  add column if not exists at_booking_a_list_only boolean not null default false;

notify pgrst, 'reload schema';
