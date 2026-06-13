-- v2.16.0 — Held rescue offers: the confidence gate for the only truly-autonomous send.
--
-- Rescue direct-mode auto-texts fit-patients the moment a slot frees, with no
-- human in the loop. This adds the trust-repair gate (project_trusted_onboarding,
-- step 7) to that send: a LOW-CONFIDENCE fit — one with no positive treatment
-- agreement between the patient and the freed slot (the patient is on the
-- waitlist with no treatment preference, OR the slot itself has no treatment
-- set) — is created as an offer but HELD instead of auto-texted. The owner then
-- releases it in one tap from the rescue page, or dismisses it.
--
-- held_at non-null + message_id null + send_error null = awaiting the owner's OK.
-- Releasing sets message_id (or send_error) and clears held_at; dismissing sets
-- declined_at and clears held_at. Nothing is lost: a held offer is a one-tap
-- send away, never a silent drop and never auto-blasted.

alter table public.emma_rescue_offers
  add column if not exists held_at     timestamptz,
  add column if not exists held_reason text;

-- Partial index for the "needs your eyes" queue read (held + not yet acted on).
create index if not exists emma_rescue_offers_held_idx
  on public.emma_rescue_offers (user_id, held_at)
  where held_at is not null;

notify pgrst, 'reload schema';

-- Verify:
--   select id, held_at, held_reason, message_id, send_error
--   from public.emma_rescue_offers where held_at is not null;
