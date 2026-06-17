-- v2.75.0 — Retire the legacy "emma_" TABLE prefix (internal-only; no user-facing change).
--
-- Renames every emma_* TABLE to its bare name (emma_appointments -> appointments, ...),
-- plus all child objects whose names carry the prefix (constraints, indexes, sequences,
-- triggers), then leaves a security_invoker COMPATIBILITY VIEW under each old name so DB
-- trigger/cron/function bodies (which reference old names as text) and any not-yet-migrated
-- reference keep working. A FOLLOW-UP migration drops the views once code is verified green.
--
-- Renaming constraints matters: PostgREST relationship hints in app code reference FK
-- constraint names (e.g. "appointments_patient_node_id_fkey"), so they must track the rename.
--
-- NOT touched in this pass (tiny residue -> follow-up): the lone emma_appointment_id COLUMN,
-- the emma_sweep_cron job, and historical migration filenames/comments.
--
-- Atomic (the whole DO block rolls back on any error) and idempotent (skips already-renamed
-- objects; skips a table whose bare-name target already exists, surfacing the collision).

do $$
declare
  r record;
  newname text;
begin
  -- 1) Tables: emma_X -> X  (record each rename for the compat-view pass below)
  create temp table if not exists _emma_renamed(old_name text, new_name text) on commit drop;

  for r in
    select c.relname as nm
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'emma\_%'
    order by c.relname
  loop
    newname := regexp_replace(r.nm, '^emma_', '');
    if exists (
      select 1 from pg_class c2 join pg_namespace n2 on n2.oid = c2.relnamespace
      where n2.nspname = 'public' and c2.relname = newname
    ) then
      raise notice 'SKIP table % -> % (target already exists)', r.nm, newname;
      continue;
    end if;
    execute format('alter table public.%I rename to %I', r.nm, newname);
    insert into _emma_renamed(old_name, new_name) values (r.nm, newname);
  end loop;

  -- 2) Constraints: emma_X_... -> X_...  (keeps code FK-relationship hints valid)
  for r in
    select con.conname as nm, rel.relname as tbl
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace n on n.oid = rel.relnamespace
    where n.nspname = 'public' and con.conname like 'emma\_%'
  loop
    execute format('alter table public.%I rename constraint %I to %I',
                   r.tbl, r.nm, regexp_replace(r.nm, '^emma_', ''));
  end loop;

  -- 3) Indexes: emma_X -> X
  for r in
    select c.relname as nm
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'i' and c.relname like 'emma\_%'
  loop
    execute format('alter index public.%I rename to %I', r.nm, regexp_replace(r.nm, '^emma_', ''));
  end loop;

  -- 4) Sequences: emma_X -> X
  for r in
    select c.relname as nm
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'S' and c.relname like 'emma\_%'
  loop
    execute format('alter sequence public.%I rename to %I', r.nm, regexp_replace(r.nm, '^emma_', ''));
  end loop;

  -- 5) Triggers: emma_X -> X  (renamed on whatever table they now live on)
  for r in
    select tg.tgname as nm, rel.relname as tbl
    from pg_trigger tg
    join pg_class rel on rel.oid = tg.tgrelid
    join pg_namespace n on n.oid = rel.relnamespace
    where n.nspname = 'public' and not tg.tgisinternal and tg.tgname like 'emma\_%'
  loop
    execute format('alter trigger %I on public.%I rename to %I',
                   r.nm, r.tbl, regexp_replace(r.nm, '^emma_', ''));
  end loop;

  -- 6) Compatibility views: old emma_ name -> new bare table (RLS-preserving).
  for r in select old_name, new_name from _emma_renamed loop
    execute format(
      'create view public.%I with (security_invoker = true) as select * from public.%I',
      r.old_name, r.new_name
    );
  end loop;

  drop table if exists _emma_renamed;
end $$;
