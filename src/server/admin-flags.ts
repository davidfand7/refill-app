/**
 * Admin feature-flag server fns — v1.24.0 (P5 of unified admin platform).
 *
 * The /app/admin/flags surface lives on these fns. Reads + writes
 * public.feature_flags (the table the v1.22.1 P1 migration created).
 *
 * Per D8 lock: the same rows back BOTH the admin UI (where global /
 * tenant / user / rep flags are managed centrally) AND any future
 * power-user spa-owner Advanced surface (which would only write
 * scope=tenant rows for the spa's own tenant). The server fns here are
 * admin-only; tenant-side fns would have their own narrower gates.
 *
 * Every mutation writes to admin_audit_log.
 */

import { createClient } from "@supabase/supabase-js";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { verifyAuth } from "@/server/auth-helpers";
import { writeAuditEvent } from "@/server/audit-log";

function admin() {
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

async function assertAdmin(accessToken: string): Promise<string> {
  const callerUserId = await verifyAuth(accessToken);
  const sb = admin();
  const { data, error } = await sb
    .from("user_roles")
    .select("role")
    .eq("user_id", callerUserId)
    .eq("role", "admin")
    .maybeSingle();
  if (error) throw new Error(`Couldn't verify admin: ${error.message}`);
  if (!data) throw new Error("Admin only.");
  return callerUserId;
}

export type FeatureFlagRow = {
  id: string;
  flagKey: string;
  scope: "global" | "tenant" | "user" | "rep";
  scopeId: string | null;
  enabled: boolean;
  metadata: Record<string, unknown>;
  updatedAt: string;
  updatedBy: string | null;
};

const listFlagsInput = z.object({
  accessToken: z.string().min(1),
});

export const listFlags = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => listFlagsInput.parse(raw))
  .handler(async ({ data }): Promise<{ flags: FeatureFlagRow[] }> => {
    await assertAdmin(data.accessToken);
    const sb = admin();
    const { data: rows, error } = await sb
      .from("feature_flags")
      .select(
        "id, flag_key, scope, scope_id, enabled, metadata, updated_at, updated_by",
      )
      .order("flag_key", { ascending: true })
      .order("scope", { ascending: true });
    if (error) throw new Error(`Couldn't load flags: ${error.message}`);
    const flags: FeatureFlagRow[] = (rows ?? []).map((r) => ({
      id: r.id,
      flagKey: r.flag_key,
      scope: r.scope as FeatureFlagRow["scope"],
      scopeId: r.scope_id,
      enabled: r.enabled,
      metadata: (r.metadata as Record<string, unknown> | null) ?? {},
      updatedAt: r.updated_at,
      updatedBy: r.updated_by,
    }));
    return { flags };
  });

const upsertFlagInput = z.object({
  accessToken: z.string().min(1),
  flagKey: z.string().min(1).max(100),
  scope: z.enum(["global", "tenant", "user", "rep"]),
  scopeId: z.string().uuid().nullable().optional(),
  enabled: z.boolean(),
  metadata: z.record(z.unknown()).optional(),
});

export const upsertFlag = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => upsertFlagInput.parse(raw))
  .handler(async ({ data }): Promise<{ id: string }> => {
    const callerUserId = await assertAdmin(data.accessToken);
    const sb = admin();

    // Sanity: scope=global requires scopeId=null; other scopes require scopeId set.
    const normalizedScopeId =
      data.scope === "global" ? null : data.scopeId ?? null;
    if (data.scope !== "global" && !normalizedScopeId) {
      throw new Error(`scope=${data.scope} requires a scopeId`);
    }

    const { data: row, error } = await sb
      .from("feature_flags")
      .upsert(
        {
          flag_key: data.flagKey,
          scope: data.scope,
          scope_id: normalizedScopeId,
          enabled: data.enabled,
          metadata: data.metadata ?? {},
          updated_at: new Date().toISOString(),
          updated_by: callerUserId,
        },
        { onConflict: "flag_key,scope,scope_id" },
      )
      .select("id")
      .single();
    if (error) throw new Error(`Couldn't save flag: ${error.message}`);

    await writeAuditEvent({
      actorUserId: callerUserId,
      action: "flag.toggle",
      payload: {
        id: row.id,
        flagKey: data.flagKey,
        scope: data.scope,
        scopeId: normalizedScopeId,
        enabled: data.enabled,
      },
    });

    return { id: row.id };
  });

const deleteFlagInput = z.object({
  accessToken: z.string().min(1),
  id: z.string().uuid(),
});

export const deleteFlag = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => deleteFlagInput.parse(raw))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const callerUserId = await assertAdmin(data.accessToken);
    const sb = admin();

    // Fetch row for audit-log payload pre-delete.
    const { data: pre } = await sb
      .from("feature_flags")
      .select("flag_key, scope, scope_id, enabled")
      .eq("id", data.id)
      .maybeSingle();

    const { error } = await sb.from("feature_flags").delete().eq("id", data.id);
    if (error) throw new Error(`Couldn't delete flag: ${error.message}`);

    await writeAuditEvent({
      actorUserId: callerUserId,
      action: "flag.delete",
      payload: { id: data.id, ...(pre ?? {}) },
    });

    return { ok: true };
  });
