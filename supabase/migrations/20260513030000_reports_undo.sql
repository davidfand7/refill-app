-- Reports v1 — 24-hour undo support.
--
-- Adds two columns to report_uploads so the v309 upload UI can offer an
-- "undo within 24h" affordance after a re-upload. The snapshot captures
-- the rows that were inserted / updated / removed in the most recent
-- upsertReport call so undoReportUpload can replay the prior state
-- without needing a row-history table.
--
-- prior_snapshot shape:
--   {
--     insertedIds:  uuid[],            // rows we inserted (delete on undo)
--     updatedPrior: [                   // rows we updated (restore on undo)
--       { lookupKey, data, contentHash, sourceRow }
--     ],
--     removedRows:  [                   // rows we deleted as orphans (restore on undo)
--       { lookupKey, data, contentHash, sourceRow }
--     ],
--     priorMetadata: {                  // pre-upload report_uploads fields (restore on undo)
--       reportLabel, reportType, columnMapping, sourceFilename, rowCount, lastDiffSummary
--     }
--   }
--
-- Established 2026-05-12 (Reports v1 upload UI, v309).

alter table public.report_uploads
  add column if not exists prior_snapshot jsonb,
  add column if not exists undo_expires_at timestamptz;

create index if not exists report_uploads_undoable_idx
  on public.report_uploads (user_id, undo_expires_at)
  where undo_expires_at is not null;

comment on column public.report_uploads.prior_snapshot is
  'Pre-upsert snapshot captured by upsertReport so undoReportUpload can replay the prior state within 24h. See migration header for shape.';

comment on column public.report_uploads.undo_expires_at is
  'When the prior_snapshot expires (24h after the upsert that captured it). NULL means no undoable upload outstanding.';
