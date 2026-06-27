-- v2.199.0 — Rescue per-gate operator toggles (B-server.2b.2).
--
-- evaluateRescueGate already accepts holdBlindMatches + applyFrequencyCap, but
-- BOTH call sites (direct lane + zero-setup queue lane) hard-coded them to
-- `true`. These two columns make them real per-spa policy.
--
-- DEFAULT TRUE preserves today's exact behavior — the engine has always held
-- blind matches (a freed slot with no treatment set waits for the owner's OK)
-- and applied the cross-agent frequency cap (don't re-text someone contacted
-- recently). Nothing changes until an operator deliberately turns a safeguard
-- off. The gate reads default true even before this lands (loose-cast `!== false`).
alter table noshow_policies
  add column if not exists hold_blind_matches boolean not null default true;
alter table noshow_policies
  add column if not exists apply_frequency_cap boolean not null default true;

notify pgrst, 'reload schema';
