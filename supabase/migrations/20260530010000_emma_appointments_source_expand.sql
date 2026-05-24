-- v381.3: Expand emma_appointments.source check constraint.
--
-- The original constraint (from v360, file 20260517000000_emma_appointments.sql)
-- allowed 9 source values: manual, pms-api, and 7 csv-* dialects. Two
-- expansions never landed in a constraint migration and are now blocking
-- writes:
--
--   1. v367 added 17 more csv-* dialects via the universal CSV importer
--      (Calendly, GlossGenius, Zenoti, Square, SimplePractice, Pabau,
--      JaneApp, WellnessLiving, Fresha, Mindbody, Symplast, Nextech,
--      PatientNow, RepeatMD, Booker, Moxie, Schedulicity, Meevo).
--      Today Rejuv only has csv-acuity rows so the gap never surfaced;
--      any new spa uploading a non-Acuity CSV would have hit it.
--
--   2. v381 introduced live-API ingestion (source='acuity', etc) for the
--      real-time scheduler connector. First click-through caught the
--      constraint here.
--
-- This migration drops the old constraint and re-adds it with the full
-- current vocabulary. The list is the union of every dialect string the
-- code currently writes plus the five live-API platform names matching
-- emma_scheduler_connections.platform.

alter table public.emma_appointments
  drop constraint if exists emma_appointments_source_check;

alter table public.emma_appointments
  add constraint emma_appointments_source_check
  check (source in (
    'manual',
    'pms-api',
    -- v381 live-API sources (one per scheduling platform)
    'acuity', 'mindbody', 'jane', 'square', 'boulevard',
    -- v367 CSV dialects
    'csv-acuity', 'csv-boulevard', 'csv-mangomint', 'csv-vagaro',
    'csv-aestheticspro', 'csv-aestheticrecord', 'csv-generic',
    'csv-calendly', 'csv-glossgenius', 'csv-zenoti', 'csv-square',
    'csv-simplepractice', 'csv-pabau', 'csv-janeapp', 'csv-wellnessliving',
    'csv-fresha', 'csv-mindbody', 'csv-symplast', 'csv-nextech',
    'csv-patientnow', 'csv-repeatmd', 'csv-booker', 'csv-moxie',
    'csv-schedulicity', 'csv-meevo'
  ));

notify pgrst, 'reload schema';

-- Verify: the new constraint should accept 'acuity' as a valid source.
-- The query returns the count of distinct source values currently in
-- use so we can confirm nothing existing was blocked.
select source, count(*)
from public.emma_appointments
group by source
order by count(*) desc;
