-- v2.120.0 — Within-category manual ordering for products (parity with services).
--
-- Services have had drag-to-reorder within a category since v1.81.0 via a
-- nullable sort_order. Products groups now order categories the same way
-- (v2.119.0); this adds the same per-row ordering so the owner can drag
-- products within a category too. Nullable → existing rows fall back to
-- brand-alpha until dragged (lower sort_order first, nulls last).

alter table public.products add column if not exists sort_order integer;
