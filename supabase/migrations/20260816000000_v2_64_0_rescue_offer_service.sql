-- v2.64.0 — Smart Slot-Fill P1: record the service a rescue offer was framed around.
--
-- Until now a rescue offer always represented the SAME service as the freed
-- slot (selectFitPatients matched the freed slot's free-text treatment_type).
-- Smart Slot-Fill lets a freed (provider, duration) slot surface a patient who
-- wants a DIFFERENT service the provider is qualified for and that fits the
-- duration (e.g. a freed 30-min Tox-w/-Karen slot offered to a patient on the
-- waitlist for Filler). When that happens the offer is no longer "for Tox" —
-- it's "for your Filler, in the opening that just freed up."
--
-- This column records, per offer, the catalog service that offer was framed
-- around, so every honesty surface (the patient claim page, the proxy email
-- drafts, and the note that tells the owner to set the right type in their
-- PMS) names the RIGHT service rather than the freed slot's original.
--
--   offer_service_id uuid NULL
--     NULL      = legacy same-service offer (use the freed slot's treatment_type,
--                 byte-identical to pre-v2.64.0 behavior).
--     non-NULL  = this offer was framed around services.id (exact freed-service
--                 match OR a cross-service qualified fill).
--
-- Additive, nullable, no default. No FK (matches the app's tolerate-dangling
-- pattern for catalog refs — see emma_waitlist.desired_service_ids); the
-- reader joins to `services` and resolves a name, falling back to the freed
-- slot's treatment when the service row is gone.

ALTER TABLE public.emma_rescue_offers
  ADD COLUMN IF NOT EXISTS offer_service_id uuid;

COMMENT ON COLUMN public.emma_rescue_offers.offer_service_id IS
  'v2.64.0 — the catalog service (services.id) this rescue offer was framed around. NULL = legacy same-service (use the freed slot treatment_type). Set for exact freed-service matches and cross-service qualified fills (Smart Slot-Fill).';
