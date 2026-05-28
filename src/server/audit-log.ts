/**
 * Admin audit log writer — P1 of the unified admin platform sequence
 * (v1.22.1).
 *
 * Writes to public.admin_audit_log (created by migration
 * 20260619010000_unified_admin_p1b_backfill_and_tables.sql). Used by
 * future P2+ consumers:
 *
 *   - P3 persona switcher: optional impersonate.start / impersonate.stop
 *     entries (deferrable; only write when compliance asks).
 *   - P4 admin user/role UI: role.grant / role.revoke / user.create /
 *     user.password_reset / user.delete on every mutation.
 *   - P5 feature-flag UI: flag.create / flag.toggle / flag.delete on
 *     every mutation.
 *
 * P1 SCOPE: this file ships the writer; no client code invokes it yet
 * (the v1.22.1 migration writes its own initial entry via SQL). P4+ will
 * invoke it from server-fn handlers after every privileged mutation.
 *
 * SECURITY: this fn does NOT verify the caller is admin. Callers are
 * responsible for gating their own admin checks BEFORE invoking this.
 * The audit log is append-only at the application layer; service-role
 * inserts bypass RLS by design (RLS only gates SELECT for non-service-
 * role contexts).
 */

import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";

export type AuditAction =
  // P1 backfill (written from SQL — not a runtime action)
  | "p1.role.backfill"
  // P3 persona switcher (optional; only when compliance asks)
  | "impersonate.start"
  | "impersonate.stop"
  // P4 admin user/role management
  | "role.grant"
  | "role.revoke"
  | "user.create"
  | "user.password_reset"
  | "user.delete"
  // P5 feature flags
  | "flag.create"
  | "flag.toggle"
  | "flag.delete"
  // Escape hatch for ad-hoc / future actions — keep the table flexible
  // but the union closed-ish so typos surface as type errors.
  | (string & Record<never, never>);

export type AuditEvent = {
  /** The user performing the action — usually the JWT-verified caller.
   * For service-only system actions, pass the admin@refill-demo.test (or
   * future admin@refill.platform) user_id. */
  actorUserId: string;
  /** Slug of what happened. Keep machine-readable; human-readable detail
   * goes in `payload`. */
  action: AuditAction;
  /** Optional: the user this action affected (e.g. role grant target). */
  targetUserId?: string;
  /** Optional: the tenant this action affected (e.g. feature flag
   * scope=tenant write). */
  targetTenantId?: string;
  /** Free-form structured detail. Keep small — this is an audit row, not
   * a logs surface. */
  payload?: Record<string, unknown>;
};

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

/**
 * Write one row to admin_audit_log. Returns the inserted row id (uuid)
 * or throws on failure. Callers should treat audit-log write failures as
 * non-fatal for the user-facing action but worth surfacing in server
 * logs — never block a user's role grant because the audit-row insert
 * blipped.
 */
export async function writeAuditEvent(event: AuditEvent): Promise<string> {
  const sb = admin();
  const { data, error } = await sb
    .from("admin_audit_log")
    .insert({
      actor_user_id: event.actorUserId,
      action: event.action,
      target_user_id: event.targetUserId ?? null,
      target_tenant_id: event.targetTenantId ?? null,
      payload: event.payload ?? {},
    })
    .select("id")
    .single();

  if (error) {
    throw new Error(`Couldn't write audit event: ${error.message}`);
  }
  return data.id;
}
