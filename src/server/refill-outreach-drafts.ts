/**
 * Refill outreach drafts — per-account-draft composer substrate (v1.47.0).
 *
 * Pure CRUD over the `outreach_drafts` table. The composer (rep Outreach +
 * Recruit) uses these to persist a per-recipient edit WITHOUT sending, stack
 * recipients, and bulk-load. Edit model A: one shared composed body applies to
 * the whole batch; per-account `subject_override` / `body_override` (NULL = use
 * the shared body) capture only the recipients the rep hand-tweaks.
 *
 * Auth gate: requireRepOrAdmin — same posture as sendOutreachEmail. Ownership
 * is enforced in every WHERE (`rep_user_id = principal.userId`); RLS on the
 * table is service-role-only, so the only reader/writer is this module.
 *
 * recipient_email is stored LOWERCASED so the unique
 * (rep_user_id, recipient_email, template_id) index doubles as the dedup guard
 * and the upsert `onConflict` target stays simple.
 *
 * Phase map (Refill-v1.47.0-Outreach-Composer-Plan.html):
 *   P1 (this ship): saveOutreachDraft · listOutreachDrafts · deleteOutreachDraft
 *   P2: sendOutreachBatch (loops the shared dispatchOneOutreachEmail helper)
 *   P4: saveOutreachDraftsBulk (paste/CSV, on-conflict-do-nothing no-clobber)
 *
 * Established 2026-06-05 (v1.47.0 P1).
 */

import { createClient } from "@supabase/supabase-js";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { requireRepOrAdmin } from "@/server/auth-helpers";
import {
  buildOutreachSendContext,
  dispatchOneOutreachEmail,
  type SendMode,
} from "@/server/refill-outreach-send";

// ─── service-role admin client (module-private) ──────────────────────────

type SbClient = ReturnType<typeof createClient<Database>>;

function admin(): SbClient {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ─── Public types ────────────────────────────────────────────────────────

export type OutreachIcp = 1 | 2 | 3;
export type OutreachAudience = "spa" | "rep";

export interface OutreachDraft {
  id: string;
  templateId: string;
  icp: OutreachIcp;
  channel: string;
  audience: OutreachAudience;
  recipientEmail: string;
  recipientFirstName: string | null;
  spaName: string | null;
  contactId: string | null;
  subjectOverride: string | null;
  bodyOverride: string | null;
  batchLabel: string | null;
  sentEventId: string | null;
  sentAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Zod ─────────────────────────────────────────────────────────────────

const icpSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);

const saveDraftInput = z.object({
  accessToken: z.string().min(1),
  templateId: z.string().uuid(),
  icp: icpSchema,
  channel: z.string().min(1).max(80),
  audience: z.enum(["spa", "rep"]).optional(),
  recipientEmail: z.string().email().max(254),
  recipientFirstName: z.string().max(120).nullable().optional(),
  spaName: z.string().max(200).nullable().optional(),
  // Tri-state per field: omitted/undefined coerced to null here = "use shared
  // batch body". A string = persist this per-account override.
  subjectOverride: z.string().nullable().optional(),
  bodyOverride: z.string().nullable().optional(),
  batchLabel: z.string().max(120).nullable().optional(),
});

const bulkDraftsInput = z.object({
  accessToken: z.string().min(1),
  templateId: z.string().uuid(),
  icp: icpSchema,
  channel: z.string().min(1).max(80),
  audience: z.enum(["spa", "rep"]).optional(),
  recipients: z
    .array(
      z.object({
        email: z.string().email().max(254),
        firstName: z.string().max(120).nullable().optional(),
        spaName: z.string().max(200).nullable().optional(),
      }),
    )
    .min(1)
    .max(1000),
  batchLabel: z.string().max(120).nullable().optional(),
});

const listDraftsInput = z.object({
  accessToken: z.string().min(1),
  templateId: z.string().uuid().optional(),
  audience: z.enum(["spa", "rep"]).optional(),
});

const deleteDraftInput = z.object({
  accessToken: z.string().min(1),
  id: z.string().uuid(),
});

const sendBatchInput = z.object({
  accessToken: z.string().min(1),
  templateId: z.string().uuid(),
  icp: icpSchema,
  channel: z.string().min(1).max(80),
  audience: z.enum(["spa", "rep"]).optional(),
  // The shared composed body the batch applies wherever a draft has NO
  // per-account override. NULL subject = explicit no-subject; undefined =
  // fall through to the template default inside the dispatch helper.
  sharedSubject: z.string().max(300).nullable().optional(),
  sharedBody: z.string().min(1).max(20000).optional(),
  // Shared placeholder context (Rejuv figures etc.). Per-recipient first name +
  // spa name come from the draft row and win over these.
  context: z
    .object({
      firstName: z.string().optional(),
      spaName: z.string().optional(),
      acuityUrl: z.string().optional(),
      rejuvRecoveredAmount: z.string().optional(),
      rejuvRecoveredWeeks: z.string().optional(),
      rejuvRecentRecoveredAmount: z.string().optional(),
      recipient: z.string().optional(),
    })
    .optional(),
  sourceContext: z.string().optional(),
  dryRun: z.boolean().optional(),
});

// ─── Row → public type ───────────────────────────────────────────────────

type Row = Database["public"]["Tables"]["outreach_drafts"]["Row"];

function rowToDraft(r: Row): OutreachDraft {
  return {
    id: r.id,
    templateId: r.template_id,
    icp: r.icp as OutreachIcp,
    channel: r.channel,
    audience: (r.audience as OutreachAudience) ?? "spa",
    recipientEmail: r.recipient_email,
    recipientFirstName: r.recipient_first_name,
    spaName: r.spa_name,
    contactId: r.contact_id,
    subjectOverride: r.subject_override,
    bodyOverride: r.body_override,
    batchLabel: r.batch_label,
    sentEventId: r.sent_event_id,
    sentAt: r.sent_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ─── saveOutreachDraft — upsert one row (Save draft, no send) ─────────────

export const saveOutreachDraft = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => saveDraftInput.parse(raw))
  .handler(async ({ data }): Promise<{ draft: OutreachDraft }> => {
    const sb = admin();
    const principal = await requireRepOrAdmin(sb, data.accessToken);

    // Lowercase so the unique index doubles as the dedup guard.
    const email = data.recipientEmail.trim().toLowerCase();
    const now = new Date().toISOString();

    // Upsert on (rep_user_id, recipient_email, template_id). On conflict only
    // the supplied columns update — sent_at / sent_event_id / contact_id (not
    // in the payload) are preserved on an existing row.
    const { data: row, error } = await sb
      .from("outreach_drafts")
      .upsert(
        {
          rep_user_id: principal.userId,
          template_id: data.templateId,
          icp: data.icp,
          channel: data.channel,
          audience: data.audience ?? "spa",
          recipient_email: email,
          recipient_first_name: data.recipientFirstName ?? null,
          spa_name: data.spaName ?? null,
          subject_override: data.subjectOverride ?? null,
          body_override: data.bodyOverride ?? null,
          batch_label: data.batchLabel ?? null,
          updated_at: now,
        },
        { onConflict: "rep_user_id,recipient_email,template_id" },
      )
      .select("*")
      .single();

    if (error || !row) {
      throw new Error(`Couldn't save draft: ${error?.message ?? "no row"}`);
    }
    return { draft: rowToDraft(row) };
  });

// ─── saveOutreachDraftsBulk — paste / CSV bulk add (no-clobber) ───────────

export const saveOutreachDraftsBulk = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => bulkDraftsInput.parse(raw))
  .handler(
    async ({
      data,
    }): Promise<{
      inserted: number;
      requested: number;
      skipped: number;
      drafts: OutreachDraft[];
    }> => {
      const sb = admin();
      const principal = await requireRepOrAdmin(sb, data.accessToken);

      // Dedup within the paste by lowercased email (keep first occurrence).
      const seen = new Set<string>();
      const deduped = data.recipients
        .map((r) => ({ ...r, email: r.email.trim().toLowerCase() }))
        .filter((r) => {
          if (seen.has(r.email)) return false;
          seen.add(r.email);
          return true;
        });

      const rows = deduped.map((r) => ({
        rep_user_id: principal.userId,
        template_id: data.templateId,
        icp: data.icp,
        channel: data.channel,
        audience: data.audience ?? "spa",
        recipient_email: r.email,
        recipient_first_name: r.firstName ?? null,
        spa_name: r.spaName ?? null,
        subject_override: null,
        body_override: null,
        batch_label: data.batchLabel ?? null,
      }));

      // ON CONFLICT DO NOTHING — a re-pasted CSV never clobbers an existing
      // row (which may carry a hand-tweaked override). Returns only the
      // newly-inserted rows, so requested - inserted = already-existing.
      const { data: inserted, error } = await sb
        .from("outreach_drafts")
        .upsert(rows, {
          onConflict: "rep_user_id,recipient_email,template_id",
          ignoreDuplicates: true,
        })
        .select("*");
      if (error) {
        throw new Error(`Couldn't bulk-save drafts: ${error.message}`);
      }
      const insertedRows = inserted ?? [];
      return {
        inserted: insertedRows.length,
        requested: deduped.length,
        skipped: deduped.length - insertedRows.length,
        drafts: insertedRows.map(rowToDraft),
      };
    },
  );

// ─── listOutreachDrafts — this rep's drafts (optionally per template) ─────

export const listOutreachDrafts = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => listDraftsInput.parse(raw))
  .handler(async ({ data }): Promise<{ drafts: OutreachDraft[] }> => {
    const sb = admin();
    const principal = await requireRepOrAdmin(sb, data.accessToken);

    let q = sb
      .from("outreach_drafts")
      .select("*")
      .eq("rep_user_id", principal.userId)
      .order("created_at", { ascending: false })
      .limit(500);
    if (data.templateId) q = q.eq("template_id", data.templateId);
    if (data.audience) q = q.eq("audience", data.audience);

    const { data: rows, error } = await q;
    if (error) {
      throw new Error(`Couldn't load drafts: ${error.message}`);
    }
    return { drafts: (rows ?? []).map(rowToDraft) };
  });

// ─── deleteOutreachDraft — remove one recipient (ownership in WHERE) ──────

export const deleteOutreachDraft = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => deleteDraftInput.parse(raw))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const sb = admin();
    const principal = await requireRepOrAdmin(sb, data.accessToken);

    const { error } = await sb
      .from("outreach_drafts")
      .delete()
      .eq("id", data.id)
      .eq("rep_user_id", principal.userId);
    if (error) {
      throw new Error(`Couldn't delete draft: ${error.message}`);
    }
    return { ok: true };
  });

// ─── sendOutreachBatch — multi-send (server-batch, concurrency-3) ─────────
// Loads this rep's UNSENT drafts for the template, resolves the send context
// ONCE, then dispatches each recipient through the shared
// dispatchOneOutreachEmail in a 3-wide worker pool. Per-account override wins;
// otherwise the shared batch body. Each success stamps sent_event_id + sent_at
// so a re-click skips already-sent rows (idempotent). Awaits the whole pool —
// no fire-and-forget (a Worker isolate dies at response and would drop sends).

export interface BatchSendResult {
  draftId: string;
  recipientEmail: string;
  ok: boolean;
  mode?: SendMode;
  eventId?: string;
  error?: string;
}

export const sendOutreachBatch = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => sendBatchInput.parse(raw))
  .handler(
    async ({
      data,
    }): Promise<{
      results: BatchSendResult[];
      sent: number;
      failed: number;
      total: number;
    }> => {
      const sb = admin();
      const principal = await requireRepOrAdmin(sb, data.accessToken);

      // Unsent drafts for this rep + template, oldest-first (stable send order).
      const { data: rows, error: loadErr } = await sb
        .from("outreach_drafts")
        .select("*")
        .eq("rep_user_id", principal.userId)
        .eq("template_id", data.templateId)
        .is("sent_at", null)
        .order("created_at", { ascending: true })
        .limit(500);
      if (loadErr) {
        throw new Error(`Couldn't load drafts to send: ${loadErr.message}`);
      }
      const drafts = rows ?? [];
      if (drafts.length === 0) {
        return { results: [], sent: 0, failed: 0, total: 0 };
      }

      // Resolve the shared send context ONCE (auth-derived persona, mode,
      // template, From: line, rep stats).
      const ctx = await buildOutreachSendContext(sb, principal, {
        icp: data.icp,
        channel: data.channel,
        audience: data.audience,
        dryRun: data.dryRun,
      });

      const results: BatchSendResult[] = new Array(drafts.length);
      let next = 0;
      const worker = async (): Promise<void> => {
        for (;;) {
          const idx = next++;
          if (idx >= drafts.length) return;
          const draft = drafts[idx];
          try {
            const res = await dispatchOneOutreachEmail(ctx, {
              recipientEmail: draft.recipient_email,
              recipientFirstName: draft.recipient_first_name,
              sourceContext: data.sourceContext,
              // Per-account override wins; else the shared batch subject/body;
              // else (undefined) the dispatch helper falls to the template.
              subjectOverride:
                draft.subject_override !== null
                  ? draft.subject_override
                  : data.sharedSubject,
              bodyOverride: draft.body_override ?? data.sharedBody,
              context: {
                ...data.context,
                firstName: draft.recipient_first_name ?? data.context?.firstName,
                spaName: draft.spa_name ?? data.context?.spaName,
              },
            });
            // Stamp sent — the is(sent_at,null) load filter makes re-runs skip.
            await sb
              .from("outreach_drafts")
              .update({
                sent_event_id: res.eventId,
                sent_at: new Date().toISOString(),
              })
              .eq("id", draft.id);
            results[idx] = {
              draftId: draft.id,
              recipientEmail: draft.recipient_email,
              ok: true,
              mode: res.mode,
              eventId: res.eventId,
            };
          } catch (err) {
            results[idx] = {
              draftId: draft.id,
              recipientEmail: draft.recipient_email,
              ok: false,
              error: err instanceof Error ? err.message : "send failed",
            };
          }
        }
      };

      const poolSize = Math.min(3, drafts.length);
      await Promise.all(Array.from({ length: poolSize }, () => worker()));

      const sent = results.filter((r) => r.ok).length;
      return {
        results,
        sent,
        failed: results.length - sent,
        total: drafts.length,
      };
    },
  );
