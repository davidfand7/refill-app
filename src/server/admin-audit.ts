/**
 * Admin audit-log read server fns — v1.24.0 (P5 of unified admin platform).
 *
 * The /app/admin/audit surface lives on these fns. Read-only — write
 * helper lives in audit-log.ts. RLS on admin_audit_log already permits
 * admin SELECT, but we use service-role here for resilience + uniform
 * pattern with the other admin server fns.
 */

import { admin } from "./admin-client";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { verifyAuth } from "@/server/auth-helpers";

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

export type AuditLogEntry = {
  id: string;
  actorUserId: string | null;
  actorEmail: string | null;
  actedAt: string;
  action: string;
  targetUserId: string | null;
  targetEmail: string | null;
  targetTenantId: string | null;
  payload: Record<string, unknown>;
};

const listAuditEventsInput = z.object({
  accessToken: z.string().min(1),
  actionFilter: z.string().optional(),
  actorUserId: z.string().uuid().optional(),
  targetUserId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

export const listAuditEvents = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => listAuditEventsInput.parse(raw))
  .handler(
    async ({ data }): Promise<{ events: AuditLogEntry[] }> => {
      await assertAdmin(data.accessToken);
      const sb = admin();

      let q = sb
        .from("admin_audit_log")
        .select(
          "id, actor_user_id, acted_at, action, target_user_id, target_tenant_id, payload",
        )
        .order("acted_at", { ascending: false })
        .limit(data.limit ?? 200);
      if (data.actionFilter) {
        q = q.eq("action", data.actionFilter);
      }
      if (data.actorUserId) {
        q = q.eq("actor_user_id", data.actorUserId);
      }
      if (data.targetUserId) {
        q = q.eq("target_user_id", data.targetUserId);
      }
      const { data: rows, error } = await q;
      if (error) throw new Error(`Couldn't load audit log: ${error.message}`);

      // Bulk-fetch actor + target emails so the UI can render them.
      const userIds = new Set<string>();
      for (const r of rows ?? []) {
        if (r.actor_user_id) userIds.add(r.actor_user_id);
        if (r.target_user_id) userIds.add(r.target_user_id);
      }
      const emailByUser = new Map<string, string>();
      if (userIds.size > 0) {
        const authRes = await sb.auth.admin.listUsers({ perPage: 1000 });
        for (const u of authRes.data?.users ?? []) {
          if (u.email && userIds.has(u.id)) emailByUser.set(u.id, u.email);
        }
      }

      const events: AuditLogEntry[] = (rows ?? []).map((r) => ({
        id: r.id,
        actorUserId: r.actor_user_id,
        actorEmail: r.actor_user_id
          ? emailByUser.get(r.actor_user_id) ?? null
          : null,
        actedAt: r.acted_at,
        action: r.action,
        targetUserId: r.target_user_id,
        targetEmail: r.target_user_id
          ? emailByUser.get(r.target_user_id) ?? null
          : null,
        targetTenantId: r.target_tenant_id,
        payload: (r.payload as Record<string, unknown> | null) ?? {},
      }));

      return { events };
    },
  );
