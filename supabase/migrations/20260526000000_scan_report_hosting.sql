-- v371.1: host the scan follow-up HTML report at a tokenized URL
-- instead of attaching it to the email.
--
-- Why: Gmail web (and most other email clients) renders .html attachments
-- as raw source code for XSS-safety reasons. Sending the report as an
-- attachment looks like a bug to the recipient. Hosting it behind a
-- token-gated URL — same pattern as /rescue/claim/<token> — gives us
-- in-browser rendering, mobile compatibility, no attachment friction.
--
-- The token is the capability (no auth required). It is opaque and
-- random; the lead owner is the one who controls who else sees the URL.

alter table public.csv_scanner_leads
  add column if not exists followup_report_html text,
  add column if not exists followup_report_token text;

-- Unique index so /report/<token> lookups are O(1) AND tokens never collide.
create unique index if not exists csv_scanner_leads_followup_report_token_idx
  on public.csv_scanner_leads (followup_report_token)
  where followup_report_token is not null;
