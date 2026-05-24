-- v369.1: Scan follow-up email send audit trail.
--
-- captureScanLead inserts the lead row, then fires the follow-up email
-- (Draft A — the "we did your homework" send) fire-and-forget. The send
-- result is written back here so we can: (a) avoid duplicate sends on
-- retry, (b) surface failures in an admin view, (c) measure reply rates
-- per platform / per dollar bucket later.
--
-- All three columns are nullable — null on followup_sent_at means the
-- send was never attempted (e.g. lead with no usable math, or send pre-
-- flight bailed). Errors land in followup_error as plain-text reason.

alter table public.csv_scanner_leads
  add column if not exists followup_sent_at timestamptz,
  add column if not exists followup_message_id text,
  add column if not exists followup_error text;

create index if not exists csv_scanner_leads_followup_sent_at_idx
  on public.csv_scanner_leads (followup_sent_at);
