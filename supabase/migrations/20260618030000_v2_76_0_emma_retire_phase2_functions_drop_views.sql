-- v2.76.0 — emma_ retirement, PHASE 2 (completes v2.75.0).
--
-- Phase 1 (20260618020000) renamed the emma_* TABLES to bare names and left a
-- security_invoker COMPAT VIEW under each old name so DB function/trigger bodies
-- (which reference table names as TEXT and don't auto-update on rename) kept
-- working. This phase rewrites those function bodies to the bare names, then
-- drops the compat views.
--
-- SAFETY:
--   • Atomic — the whole DO block rolls back on any error (a malformed rewrite
--     just aborts, no partial damage).
--   • Idempotent — re-running finds nothing left to rewrite/drop.
--   • Order — functions are rewritten BEFORE views are dropped.
--   • WHOLE-WORD replacement (\m...\M) so the deliberately-kept emma_appointment_id
--     COLUMN and the emma_sweep_cron job name are NEVER touched (they aren't in
--     the table list below).

do $$
declare
  emma_tables text[] := array[
    'emma_appointments','emma_scheduler_connections','emma_scheduler_webhook_events',
    'emma_noshow_policies','emma_recovery_events','emma_waitlist','emma_waitlist_tokens',
    'emma_rescue_offers','emma_rescue_attempts','emma_preshow_profiles',
    'emma_preshow_message_templates','emma_light_mode_connections',
    'emma_appointment_status_events','emma_reliability_status','emma_reliability_runs',
    'emma_sender_domains','emma_setting_recommendations','emma_setting_benchmarks',
    'emma_email_quarantine','emma_csv_dialect_cache','emma_pattern_alerts',
    'emma_deposit_holds','emma_pricing_plans','emma_invoices'
  ];
  fn record;
  newdef text;
  t text;
  rewritten int := 0;
  v record;
  dropped int := 0;
begin
  -- 1) Rewrite every public function whose body references an emma_ table name.
  -- prokind in ('f','p') = normal functions + procedures only. pg_get_functiondef
  -- THROWS on aggregate ('a') / window ('w') functions, and the CASE guard ensures
  -- it's never even called for them (regardless of planner evaluation order).
  for fn in
    select p.oid, p.proname, pg_get_functiondef(p.oid) as def
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind in ('f', 'p')
      and case when p.prokind in ('f', 'p') then pg_get_functiondef(p.oid) else '' end ~ 'emma_'
  loop
    newdef := fn.def;
    foreach t in array emma_tables loop
      -- whole-word replace; emma_appointment_id (column) is not in the list, so it survives
      newdef := regexp_replace(newdef, '\m' || t || '\M', regexp_replace(t, '^emma_', ''), 'g');
    end loop;
    if newdef <> fn.def then
      execute newdef;  -- CREATE OR REPLACE FUNCTION with the rewritten body
      rewritten := rewritten + 1;
      raise notice 'rewrote function %()', fn.proname;
    end if;
  end loop;
  raise notice 'functions rewritten: %', rewritten;

  -- 2) Drop the v2.75.0 compatibility views (now that no body references them).
  for v in
    select table_name from information_schema.views
    where table_schema = 'public' and table_name ~ '^emma_'
  loop
    execute format('drop view public.%I', v.table_name);
    dropped := dropped + 1;
    raise notice 'dropped view %', v.table_name;
  end loop;
  raise notice 'compat views dropped: %', dropped;
end $$;
