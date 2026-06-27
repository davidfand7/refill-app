-- v2.187.0 — Agent run-report: making the Desktop-side drafting leg visible.
--
-- THE DARK LINK (Next-Build-Spec, Build 1): the heartbeat (v2.58.0) tells us the
-- relay Mac is ALIVE, but it can't see INSIDE Claude Desktop — whether the daily
-- "Refill rescue drafter" routine actually staged drafts into Messages, or died on
-- a stale Gmail filter / a disconnected Gmail connector. SmartSpa sends the proxy
-- emails (so it knows drafts were OWED), but the routine that turns those emails
-- into staged iMessage drafts runs in a place we're blind to. The 9-hour debug
-- that closed the loop was entirely in that blind leg.
--
-- THE UNLOCK: a callback. The routine already self-diagnoses ("no Gmail
-- connector") in its run-log — so we extend it (one line) to POST that summary to
-- /api/agent/run-report after each run, authed by the SAME per-spa secret the
-- heartbeat uses. We stamp the latest run onto the existing local_agents row, and
-- Connection Health ages it into a "Drafting in Messages" verdict that shows the
-- routine's OWN diagnosis verbatim. Health goes from inferred to observed.
--
-- We keep only the LATEST run (a snapshot, not a history table) — the health
-- surface needs "is drafting working right now," not an audit trail. One row per
-- spa already (local_agents.user_id is unique); these columns hang off it so the
-- run-report reuses the heartbeat's identity, RLS, and provisioning untouched.

alter table local_agents
  -- When the drafting routine last reported a run (NULL = provisioned + maybe
  -- heartbeating, but the run-report callback step was never added → the surface
  -- nudges the owner to add it). This is the freshness anchor for the drafting
  -- verdict, distinct from last_seen_at (which ages the liveness heartbeat).
  add column if not exists last_run_at        timestamptz,
  -- Candidates the run found owed a draft (rescue + at-booking).
  add column if not exists last_run_found     integer,
  -- Drafts the run actually staged into Messages. found > 0 && drafted = 0 is the
  -- tell that the Desktop chain broke (it had work but couldn't stage it).
  add column if not exists last_run_drafted   integer,
  -- Items the run intentionally skipped (already drafted, opted out, etc.).
  add column if not exists last_run_skipped   integer,
  -- Errors the run hit, as a JSON array of short strings. Non-empty → broken.
  add column if not exists last_run_errors    jsonb not null default '[]'::jsonb,
  -- The routine's OWN one-line self-diagnosis, shown VERBATIM on the health card
  -- ("Gmail connector not connected"). This is the line that collapses a 9-hour
  -- debug into a 9-second glance.
  add column if not exists last_run_diagnosis text;

notify pgrst, 'reload schema';
