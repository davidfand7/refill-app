-- ════════════════════════════════════════════════════════════════════════════
-- v1.58.0 — Services can require a room/resource type
-- ════════════════════════════════════════════════════════════════════════════
--
-- A service may need a treatment room, chair, or device. This column says which
-- TYPE it needs (or NULL = needs none). Booking then assigns any FREE active
-- resource of that type and stamps emma_appointments.resource_id, at which point
-- the existing no_resource_overlap EXCLUDE constraint (shipped dormant in the
-- v1.48.0 spine) enforces that two appointments can't hold the same resource.
--
-- Type-based (not a specific resource) keeps it simple and supports pooling: N
-- rooms of the same type are interchangeable; 1 device behaves as specific.
--
-- Additive + reversible. NULL default = every existing service needs no resource
-- (unchanged behavior).
-- ════════════════════════════════════════════════════════════════════════════

alter table public.services
  add column if not exists required_resource_type text
    check (required_resource_type is null
           or required_resource_type in ('room', 'chair', 'device'));

notify pgrst, 'reload schema';

-- ── Verify (run after applying) ──────────────────────────────────────────────
-- select column_name, data_type, is_nullable
--   from information_schema.columns
--  where table_schema = 'public' and table_name = 'services'
--    and column_name = 'required_resource_type';
--   → is_nullable = 'YES'.
