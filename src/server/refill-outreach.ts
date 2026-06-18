/**
 * Refill outreach template server fns (v393).
 *
 * DB-backed outreach copy. Replaces the would-be TypeScript-hardcoded
 * templates with a `outreach_templates` table that Grasshopper edits via
 * /app/admin/outreach (inline subject/body textareas) OR bulk-imports by
 * uploading the polished Refill-Outreach-Pack-v1.html doc.
 *
 * Versioning model: every write creates a NEW row (version+1) and
 * deactivates the prior active row for the same (icp, channel). The
 * partial unique index on (icp, channel) WHERE is_active enforces exactly
 * one active version per slot — but historical versions stay queryable
 * for audit + rollback.
 *
 * Auth gate: requireAdmin (user_roles.role='admin'). Outreach copy is
 * admin-only — no tenant surface ever reads or writes this table.
 *
 * Send-time contract (for the future sending ship): call getActiveTemplate
 * with the target (icp, channel) and use the returned subject + body
 * AS-IS, after placeholder substitution ({first_name}, {spa_name},
 * {rejuv_recovered_amount}, etc.). Placeholder substitution lives in the
 * sending code, not here — this module is pure CRUD.
 *
 * Established 2026-05-20 (v393, post-v392 wrap session).
 */

import { admin } from "./admin-client";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { requireAdmin, requireRepOrAdmin } from "@/server/auth-helpers";

// ─── Public types ────────────────────────────────────────────────────────

export type OutreachIcp = 1 | 2 | 3;
export type OutreachAudience = "spa" | "rep";

export interface OutreachTemplate {
  id: string;
  icp: OutreachIcp;
  channel: string;
  audience: OutreachAudience;
  subject: string | null;
  body: string;
  loomUrl: string | null;
  notes: string | null;
  // v1.47.8: rep-private templates. name = display name the rep gave it;
  // ownerRepUserId = the rep who owns it (null for the global library).
  name: string | null;
  ownerRepUserId: string | null;
  version: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OutreachTemplateInput {
  icp: OutreachIcp;
  channel: string;
  subject?: string | null;
  body: string;
  loomUrl?: string | null;
  notes?: string | null;
}

// ─── Zod ─────────────────────────────────────────────────────────────────

const tokenOnly = z.object({
  accessToken: z.string().min(1),
});

// v408: audience filter on the rep-facing template list. Defaults to 'spa'
// so callers that haven't been updated keep the original library scope.
const listTemplatesInput = z.object({
  accessToken: z.string().min(1),
  audience: z.enum(["spa", "rep"]).optional(),
});

const getActiveInput = z.object({
  accessToken: z.string().min(1),
  icp: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  channel: z.string().min(1).max(80),
});

const updateInput = z.object({
  accessToken: z.string().min(1),
  id: z.string().uuid(),
  subject: z.string().nullable().optional(),
  body: z.string().min(1),
  loomUrl: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

const templateInputSchema = z.object({
  icp: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  channel: z.string().min(1).max(80),
  // v1.45.0: audience optional for back-compat with the HTML-marker importer
  // which only ever produced 'spa'-audience templates. New paste/upload flow
  // passes 'spa' or 'rep' explicitly so admin can seed the recruit library.
  audience: z.enum(["spa", "rep"]).optional(),
  subject: z.string().nullable().optional(),
  body: z.string().min(1),
  loomUrl: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

const bulkInput = z.object({
  accessToken: z.string().min(1),
  templates: z.array(templateInputSchema).min(1).max(50),
});

// ─── Row → public type ───────────────────────────────────────────────────

type Row = Database["public"]["Tables"]["outreach_templates"]["Row"];

function rowToTemplate(r: Row): OutreachTemplate {
  return {
    id: r.id,
    icp: r.icp as OutreachIcp,
    channel: r.channel,
    audience: (r.audience as OutreachAudience) ?? "spa",
    subject: r.subject,
    body: r.body,
    loomUrl: r.loom_url,
    notes: r.notes,
    name: r.name,
    ownerRepUserId: r.owner_rep_user_id,
    version: r.version,
    isActive: r.is_active,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ─── listOutreachTemplates — admin board read ────────────────────────────

export const listOutreachTemplates = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => listTemplatesInput.parse(raw))
  .handler(
    async ({ data }): Promise<{ templates: OutreachTemplate[] }> => {
      const sb = admin();
      // v397 Phase 2E: reps + admins can read the shared template library.
      const principal = await requireRepOrAdmin(sb, data.accessToken);

      // v408: filter by audience. Defaults to 'spa' for back-compat with
      // existing rep outreach page callers that don't pass the param.
      const audience = data.audience ?? "spa";

      // v1.47.8: return the global library (owner NULL) PLUS this principal's
      // own saved templates (owner = them). The UI groups the rep-owned ones
      // under "My templates". Rep templates have generated-unique channels, so
      // they never collide with the shared library.
      const { data: rows, error } = await sb
        .from("outreach_templates")
        .select("*")
        .eq("is_active", true)
        .eq("audience", audience)
        .or(`owner_rep_user_id.is.null,owner_rep_user_id.eq.${principal.userId}`)
        .order("icp", { ascending: true })
        .order("channel", { ascending: true });
      if (error) {
        throw new Error(`Couldn't list templates: ${error.message}`);
      }

      return { templates: (rows ?? []).map(rowToTemplate) };
    },
  );

// ─── saveAsRepTemplate — promote an edited message to a rep-private template ─
// v1.47.8: the rep edited a template's body and wants to keep it. We insert a
// new rep-OWNED row (owner_rep_user_id = them) with a generated-unique channel
// so it never collides with the global library, and a display name they chose.
// It then shows up in their picker under "My templates" via listOutreachTemplates.

const saveRepTemplateInput = z.object({
  accessToken: z.string().min(1),
  icp: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  audience: z.enum(["spa", "rep"]).optional(),
  name: z.string().min(1).max(120),
  subject: z.string().max(300).nullable().optional(),
  body: z.string().min(1).max(20000),
});

function repTemplateChannel(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24);
  return `my_${slug || "tpl"}_${crypto.randomUUID().slice(0, 8)}`;
}

export const saveAsRepTemplate = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => saveRepTemplateInput.parse(raw))
  .handler(async ({ data }): Promise<OutreachTemplate> => {
    const sb = admin();
    const principal = await requireRepOrAdmin(sb, data.accessToken);
    const audience = data.audience ?? "spa";

    const { data: row, error } = await sb
      .from("outreach_templates")
      .insert({
        icp: data.icp,
        channel: repTemplateChannel(data.name),
        audience,
        subject: data.subject ?? null,
        body: data.body,
        name: data.name.trim(),
        owner_rep_user_id: principal.userId,
        created_by: principal.userId,
        is_active: true,
        version: 1,
      })
      .select("*")
      .single();
    if (error || !row) {
      throw new Error(`Couldn't save template: ${error?.message ?? "no row"}`);
    }
    return rowToTemplate(row);
  });

// ─── getActiveTemplate — send-time hot path ──────────────────────────────

export const getActiveTemplate = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => getActiveInput.parse(raw))
  .handler(
    async ({ data }): Promise<OutreachTemplate | null> => {
      const sb = admin();
      // v397 Phase 2E: reps need send-time template lookup.
      await requireRepOrAdmin(sb, data.accessToken);

      const { data: row, error } = await sb
        .from("outreach_templates")
        .select("*")
        .eq("icp", data.icp)
        .eq("channel", data.channel)
        .eq("is_active", true)
        .maybeSingle();
      if (error) {
        throw new Error(`Couldn't load template: ${error.message}`);
      }
      return row ? rowToTemplate(row) : null;
    },
  );

// ─── updateOutreachTemplate — inline edit, creates a new version ─────────

export const updateOutreachTemplate = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => updateInput.parse(raw))
  .handler(
    async ({ data }): Promise<OutreachTemplate> => {
      const sb = admin();
      const userId = await requireAdmin(data.accessToken);

      // Fetch the row being edited (must be active — we don't allow editing
      // historical rows via this surface).
      const { data: existing, error: lookupErr } = await sb
        .from("outreach_templates")
        .select("id, icp, channel, version, is_active")
        .eq("id", data.id)
        .maybeSingle();
      if (lookupErr) {
        throw new Error(`Couldn't load template: ${lookupErr.message}`);
      }
      if (!existing) {
        throw new Error("Template not found.");
      }
      if (!existing.is_active) {
        throw new Error(
          "This template is no longer active. Refresh and edit the current version.",
        );
      }

      // Deactivate the prior version (DB will then accept the new INSERT
      // because the partial unique index is on is_active rows only).
      const nowIso = new Date().toISOString();
      const { error: deactErr } = await sb
        .from("outreach_templates")
        .update({ is_active: false, updated_at: nowIso })
        .eq("id", existing.id);
      if (deactErr) {
        throw new Error(`Couldn't deactivate prior: ${deactErr.message}`);
      }

      // Insert the new active row.
      const { data: inserted, error: insErr } = await sb
        .from("outreach_templates")
        .insert({
          icp: existing.icp,
          channel: existing.channel,
          subject: data.subject ?? null,
          body: data.body,
          loom_url: data.loomUrl ?? null,
          notes: data.notes ?? null,
          version: existing.version + 1,
          is_active: true,
          created_by: userId,
          updated_at: nowIso,
        })
        .select("*")
        .single();
      if (insErr || !inserted) {
        throw new Error(`Couldn't insert new version: ${insErr?.message}`);
      }
      return rowToTemplate(inserted);
    },
  );

// ─── bulkUpsertOutreachTemplates — import from polished doc ──────────────

export const bulkUpsertOutreachTemplates = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => bulkInput.parse(raw))
  .handler(
    async ({
      data,
    }): Promise<{
      upserted: number;
      errors: string[];
    }> => {
      const sb = admin();
      const userId = await requireAdmin(data.accessToken);

      let upserted = 0;
      const errors: string[] = [];
      const nowIso = new Date().toISOString();

      for (const tpl of data.templates) {
        try {
          // v1.45.0: scope the existing-active lookup by audience too so a new
          // 'rep' template doesn't accidentally deactivate the matching 'spa'
          // template with the same (icp, channel) tuple.
          const audience = tpl.audience ?? "spa";
          const { data: existing } = await sb
            .from("outreach_templates")
            .select("id, version")
            .eq("icp", tpl.icp)
            .eq("channel", tpl.channel)
            .eq("audience", audience)
            .eq("is_active", true)
            .maybeSingle();

          const newVersion = (existing?.version ?? 0) + 1;

          if (existing) {
            const { error: deactErr } = await sb
              .from("outreach_templates")
              .update({ is_active: false, updated_at: nowIso })
              .eq("id", existing.id);
            if (deactErr) {
              throw new Error(`deactivate prior: ${deactErr.message}`);
            }
          }

          const { error: insErr } = await sb
            .from("outreach_templates")
            .insert({
              icp: tpl.icp,
              channel: tpl.channel,
              audience,
              subject: tpl.subject ?? null,
              body: tpl.body,
              loom_url: tpl.loomUrl ?? null,
              notes: tpl.notes ?? null,
              version: newVersion,
              is_active: true,
              created_by: userId,
              updated_at: nowIso,
            });
          if (insErr) {
            throw new Error(`insert: ${insErr.message}`);
          }
          upserted += 1;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`${tpl.icp}/${tpl.channel}: ${msg}`);
        }
      }

      return { upserted, errors };
    },
  );

// ─── listMyOutreachSends — past-sends history for the rep UI (v405.3) ────
// Pinch #13 from the 2026-05-22 dry-run: the /app/rep/outreach page had
// the template library + a fresh send form but no record of what the rep
// had already sent. Every click felt like first-touch — no proof of work,
// no way to spot duplicates, no recipient state visible.
//
// Returns the rep's own engagement events (filtered by sent_by = me),
// newest-first, capped at 25 rows. Admins see only their own admin-fired
// sends here (same sent_by filter); the global admin board lives elsewhere.

export type OutreachPurpose = "spa_outreach" | "rep_recruit";

export interface OutreachSendRow {
  id: string;
  recipientEmail: string;
  recipientFirstName: string | null;
  icp: number;
  channel: string;
  sendMode: string;
  purpose: OutreachPurpose;
  renderedSubject: string | null;
  sentAt: string;
  openedAt: string | null;
  responseReceivedAt: string | null;
  convertedAt: string | null;
  convertedRepUserId: string | null;
}

const listSendsInput = z.object({
  accessToken: z.string().min(1),
  limit: z.number().int().min(1).max(100).optional(),
  // v408: filter by purpose so the recruit page only shows recruit sends
  // and the spa-outreach page only shows spa sends. Defaults to 'spa_outreach'
  // for back-compat with existing callers.
  purpose: z.enum(["spa_outreach", "rep_recruit"]).optional(),
});

export const listMyOutreachSends = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => listSendsInput.parse(raw))
  .handler(
    async ({ data }): Promise<{ sends: OutreachSendRow[] }> => {
      const sb = admin();
      const principal = await requireRepOrAdmin(sb, data.accessToken);
      const cap = data.limit ?? 25;
      const purpose = data.purpose ?? "spa_outreach";

      const { data: rows, error } = await sb
        .from("outreach_engagement_events")
        .select(
          "id, recipient_email, recipient_first_name, icp, channel, send_mode, purpose, rendered_subject, sent_at, opened_at, response_received_at, converted_at, converted_rep_user_id",
        )
        .eq("sent_by", principal.userId)
        .eq("purpose", purpose)
        .order("sent_at", { ascending: false })
        .limit(cap);
      if (error) {
        throw new Error(`Couldn't load your outreach history: ${error.message}`);
      }

      const sends: OutreachSendRow[] = (rows ?? []).map((r) => ({
        id: r.id,
        recipientEmail: r.recipient_email,
        recipientFirstName: r.recipient_first_name,
        icp: r.icp,
        channel: r.channel,
        sendMode: r.send_mode,
        purpose: (r.purpose as OutreachPurpose) ?? "spa_outreach",
        renderedSubject: r.rendered_subject,
        sentAt: r.sent_at,
        openedAt: r.opened_at,
        responseReceivedAt: r.response_received_at,
        convertedAt: r.converted_at,
        convertedRepUserId: r.converted_rep_user_id,
      }));
      return { sends };
    },
  );
