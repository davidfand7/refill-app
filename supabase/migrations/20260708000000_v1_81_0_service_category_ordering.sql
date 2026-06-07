-- v1.81.0 — Custom ordering for services + categories.
-- ─────────────────────────────────────────────────────────────────────────────
-- The big Acuity-killer: operators control the ORDER services appear in, not an
-- alphabetizer. Two pieces:
--   1. services.sort_order — a per-service position WITHIN its category. Lower
--      sorts first; ties fall back to name. NULL = unordered (sorts after
--      explicitly-ordered, then by name) so existing rows behave sensibly until
--      first drag.
--   2. scheduling_settings.category_order — a per-tenant ordered list of category
--      names. Categories present in this list lead, in this order; any not listed
--      fall back to the built-in canonical order, then alphabetical.

alter table public.services
  add column if not exists sort_order integer;

alter table public.scheduling_settings
  add column if not exists category_order text[] not null default '{}';

-- Order services within a category fast (category, then position, then name).
create index if not exists services_category_sort_idx
  on public.services (tenant_id, category, sort_order, name);

notify pgrst, 'reload schema';

-- Verify (run after applying):
-- select name, category, sort_order from public.services order by category, sort_order nulls last, name limit 20;
-- select tenant_id, category_order from public.scheduling_settings;
