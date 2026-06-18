/**
 * Admin user/role management server fns — v1.24.0 (P4 of unified admin
 * platform).
 *
 * The /app/admin/users CRUD surface lives on these fns. Every mutation
 * gates on caller admin role (server-side re-verification) and writes a
 * row to public.admin_audit_log via writeAuditEvent — same audit trail
 * the v1.22.1 schema laid out for P4+.
 *
 * Surface:
 *   listUsers           — read every auth.users + roles + tenant attribution
 *   createUser          — auth.admin.createUser + optional role grant
 *   sendPasswordReset   — Supabase recovery email
 *   grantRole           — insert user_roles row
 *   revokeRole          — delete user_roles row
 *   deleteUser          — auth.admin.deleteUser (cascades user_roles via FK)
 *
 * SECURITY: every fn calls a server-side admin gate (verifyAuth +
 * user_roles lookup) before any state change. Client-side gating is
 * informative only — never trusted.
 */

import { admin } from "./admin-client";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { verifyAuth } from "@/server/auth-helpers";
import { writeAuditEvent } from "@/server/audit-log";
import type { PlatformRole } from "@/server/role-helpers";

async function assertAdmin(accessToken: string): Promise<string> {
  const callerUserId = await verifyAuth(accessToken);
  const sb = admin();
  const { data, error } = await sb
    .from("user_roles")
    .select("role")
    .eq("user_id", callerUserId)
    .eq("role", "admin")
    .maybeSingle();
  if (error) {
    throw new Error(`Couldn't verify admin: ${error.message}`);
  }
  if (!data) {
    throw new Error("Admin only.");
  }
  return callerUserId;
}

// ─── listUsers ───────────────────────────────────────────────────────────

export type AdminUserRow = {
  userId: string;
  email: string;
  createdAt: string;
  emailConfirmedAt: string | null;
  roles: PlatformRole[];
  tenantName: string | null;
  repDisplayName: string | null;
};

const listUsersInput = z.object({
  accessToken: z.string().min(1),
});

export const listUsers = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => listUsersInput.parse(raw))
  .handler(async ({ data }): Promise<{ users: AdminUserRow[] }> => {
    await assertAdmin(data.accessToken);
    const sb = admin();

    const [authRes, rolesRes, repsRes, tmRes] = await Promise.all([
      sb.auth.admin.listUsers({ perPage: 1000 }),
      sb.from("user_roles").select("user_id, role"),
      sb.from("rep_accounts").select("rep_user_id, display_name, status"),
      sb
        .from("tenant_memberships")
        .select("user_id, tenant_id, role, created_at, tenants(name)")
        .order("created_at", { ascending: true }),
    ]);
    if (authRes.error) {
      throw new Error(`Couldn't load users: ${authRes.error.message}`);
    }

    const rolesByUser = new Map<string, Set<PlatformRole>>();
    for (const r of rolesRes.data ?? []) {
      const role = r.role as string;
      if (
        role !== "admin" &&
        role !== "spa_owner" &&
        role !== "rep" &&
        role !== "sub_rep" &&
        role !== "developer"
      ) {
        continue;
      }
      let s = rolesByUser.get(r.user_id);
      if (!s) {
        s = new Set();
        rolesByUser.set(r.user_id, s);
      }
      s.add(role);
    }

    const repByUser = new Map<string, string>();
    for (const r of repsRes.data ?? []) {
      if (r.display_name) repByUser.set(r.rep_user_id, r.display_name);
    }

    const tenantNameByUser = new Map<string, string>();
    for (const m of tmRes.data ?? []) {
      const existing = tenantNameByUser.get(m.user_id);
      const tenantsRel = (m as { tenants?: { name: string } | { name: string }[] | null }).tenants;
      const tenantName = Array.isArray(tenantsRel)
        ? tenantsRel[0]?.name
        : tenantsRel?.name;
      if (!tenantName) continue;
      if (!existing || m.role === "owner") {
        tenantNameByUser.set(m.user_id, tenantName);
      }
    }

    const users: AdminUserRow[] = (authRes.data?.users ?? []).map((u) => ({
      userId: u.id,
      email: u.email ?? "(no email)",
      createdAt: u.created_at,
      emailConfirmedAt: u.email_confirmed_at ?? null,
      roles: Array.from(rolesByUser.get(u.id) ?? []).sort(),
      tenantName: tenantNameByUser.get(u.id) ?? null,
      repDisplayName: repByUser.get(u.id) ?? null,
    }));

    // Sort: admins first → users with roles → unrolled members.
    users.sort((a, b) => {
      const aHasAdmin = a.roles.includes("admin") ? 0 : 1;
      const bHasAdmin = b.roles.includes("admin") ? 0 : 1;
      if (aHasAdmin !== bHasAdmin) return aHasAdmin - bHasAdmin;
      const aHasRoles = a.roles.length > 0 ? 0 : 1;
      const bHasRoles = b.roles.length > 0 ? 0 : 1;
      if (aHasRoles !== bHasRoles) return aHasRoles - bHasRoles;
      return a.email.localeCompare(b.email);
    });

    return { users };
  });

// ─── createUser ──────────────────────────────────────────────────────────

const createUserInput = z.object({
  accessToken: z.string().min(1),
  email: z.string().email(),
  /** When provided, the new user's password is set directly (bypassing
   *  email confirmation). Useful for testing personas. When omitted,
   *  Supabase sends an invite email. */
  password: z.string().min(8).optional(),
  initialRole: z
    .enum(["admin", "spa_owner", "rep", "sub_rep", "developer", "member"])
    .optional(),
});

export const createUser = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => createUserInput.parse(raw))
  .handler(
    async ({ data }): Promise<{ userId: string }> => {
      const callerUserId = await assertAdmin(data.accessToken);
      const sb = admin();

      const createRes = await sb.auth.admin.createUser({
        email: data.email,
        password: data.password,
        email_confirm: !!data.password, // skip confirmation when password set
      });
      if (createRes.error) {
        throw new Error(`Couldn't create user: ${createRes.error.message}`);
      }
      const newUserId = createRes.data.user?.id;
      if (!newUserId) {
        throw new Error("Couldn't create user: missing user id");
      }

      if (data.initialRole) {
        const roleRes = await sb
          .from("user_roles")
          .insert({ user_id: newUserId, role: data.initialRole });
        if (roleRes.error) {
          throw new Error(
            `User created but role grant failed: ${roleRes.error.message}`,
          );
        }
      }

      await writeAuditEvent({
        actorUserId: callerUserId,
        action: "user.create",
        targetUserId: newUserId,
        payload: { email: data.email, initialRole: data.initialRole ?? null },
      });

      return { userId: newUserId };
    },
  );

// ─── sendPasswordReset ───────────────────────────────────────────────────

const sendPasswordResetInput = z.object({
  accessToken: z.string().min(1),
  targetUserId: z.string().uuid(),
});

export const sendPasswordReset = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => sendPasswordResetInput.parse(raw))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const callerUserId = await assertAdmin(data.accessToken);
    const sb = admin();

    const { data: userRes, error: userErr } = await sb.auth.admin.getUserById(
      data.targetUserId,
    );
    if (userErr) {
      throw new Error(`Couldn't load target user: ${userErr.message}`);
    }
    const targetEmail = userRes?.user?.email;
    if (!targetEmail) {
      throw new Error("Target user has no email.");
    }

    // Route through the origin env so the smartspa.app cutover flips this with
    // everything else (identical today — env is still getrefill.app).
    const origin = (process.env.REFILL_PUBLIC_ORIGIN ?? "https://getrefill.app").replace(/\/+$/, "");
    const resetRes = await sb.auth.resetPasswordForEmail(targetEmail, {
      redirectTo: `${origin}/reset-password`,
    });
    if (resetRes.error) {
      throw new Error(`Couldn't send reset: ${resetRes.error.message}`);
    }

    await writeAuditEvent({
      actorUserId: callerUserId,
      action: "user.password_reset",
      targetUserId: data.targetUserId,
      payload: { email: targetEmail },
    });

    return { ok: true };
  });

// ─── grantRole / revokeRole ──────────────────────────────────────────────

const roleMutationInput = z.object({
  accessToken: z.string().min(1),
  targetUserId: z.string().uuid(),
  role: z.enum(["admin", "spa_owner", "rep", "sub_rep", "developer", "member"]),
});

export const grantRole = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => roleMutationInput.parse(raw))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const callerUserId = await assertAdmin(data.accessToken);
    const sb = admin();

    const { error } = await sb
      .from("user_roles")
      .upsert(
        { user_id: data.targetUserId, role: data.role },
        { onConflict: "user_id,role", ignoreDuplicates: true },
      );
    if (error) {
      throw new Error(`Couldn't grant role: ${error.message}`);
    }

    await writeAuditEvent({
      actorUserId: callerUserId,
      action: "role.grant",
      targetUserId: data.targetUserId,
      payload: { role: data.role },
    });

    return { ok: true };
  });

export const revokeRole = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => roleMutationInput.parse(raw))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const callerUserId = await assertAdmin(data.accessToken);
    const sb = admin();

    const { error } = await sb
      .from("user_roles")
      .delete()
      .eq("user_id", data.targetUserId)
      .eq("role", data.role);
    if (error) {
      throw new Error(`Couldn't revoke role: ${error.message}`);
    }

    await writeAuditEvent({
      actorUserId: callerUserId,
      action: "role.revoke",
      targetUserId: data.targetUserId,
      payload: { role: data.role },
    });

    return { ok: true };
  });

// ─── deleteUser ──────────────────────────────────────────────────────────

const deleteUserInput = z.object({
  accessToken: z.string().min(1),
  targetUserId: z.string().uuid(),
});

export const deleteUser = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => deleteUserInput.parse(raw))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const callerUserId = await assertAdmin(data.accessToken);
    if (callerUserId === data.targetUserId) {
      throw new Error("Can't delete yourself — sign in as another admin first.");
    }
    const sb = admin();

    // Fetch email for audit-log payload before delete drops it.
    const { data: userRes } = await sb.auth.admin.getUserById(
      data.targetUserId,
    );
    const targetEmail = userRes?.user?.email ?? null;

    const delRes = await sb.auth.admin.deleteUser(data.targetUserId);
    if (delRes.error) {
      throw new Error(`Couldn't delete user: ${delRes.error.message}`);
    }

    await writeAuditEvent({
      actorUserId: callerUserId,
      action: "user.delete",
      targetUserId: data.targetUserId,
      payload: { email: targetEmail },
    });

    return { ok: true };
  });
