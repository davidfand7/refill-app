-- v2.192.0 — Test-recipient allowlist: safe internal testing of the live queue lane.
--
-- THE NEED: once delivery_mode='queue' is on, ANY qualifying real booking/no-show
-- autonomously texts a REAL patient. To test the live autonomous loop without that
-- risk, a spa sets a small allowlist of its OWN test numbers. When the list is
-- NON-EMPTY, only those numbers take the zero-setup queue lane; every other
-- recipient falls back to the safe email-draft lane (owner review, no auto-text) —
-- or, in rescue, is held for review. Empty list (the default) = full live: queue
-- for everyone. Lives on local_agents beside delivery_mode/auto_send (relay config).
alter table local_agents
  add column if not exists test_recipients text[] not null default '{}';

notify pgrst, 'reload schema';
