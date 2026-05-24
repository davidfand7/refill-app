-- v339: Liz auto-drafts a reply when an inbound promo response lands.
--
-- The draft lives on the inbound promotion_outreach row itself (no separate
-- table) — drafts are transient artifacts that become a new outbound row
-- when the rep clicks Send. Storing them on the inbound row keeps the
-- 1:1 relationship simple and means listPromoInbox already returns the
-- draft alongside the inbound metadata without an extra join.
--
-- The verified-line is JSONB rather than free text so the prompt can return
-- structured math (promo, tier, qualifies, savings, etc.) that the UI can
-- render as a chip-style receipt instead of an opaque blob.

alter table public.promotion_outreach
  add column if not exists auto_draft_subject text,
  add column if not exists auto_draft_body text,
  add column if not exists auto_draft_verified jsonb,
  add column if not exists auto_draft_generated_at timestamptz;

comment on column public.promotion_outreach.auto_draft_subject
  is 'v339: Liz pre-drafted reply subject. NULL until generation runs. Only meaningful on direction=inbound rows.';
comment on column public.promotion_outreach.auto_draft_body
  is 'v339: Liz pre-drafted reply body (plain text). Rep can edit before sending.';
comment on column public.promotion_outreach.auto_draft_verified
  is 'v339: Structured [VERIFIED] math line — { promo, tier, qualifies, savings_usd, ... }. Rendered as a chip in the inbox UI above the editable body.';
comment on column public.promotion_outreach.auto_draft_generated_at
  is 'v339: When the auto-draft was generated. Null if generation failed or hasn''t run yet.';
