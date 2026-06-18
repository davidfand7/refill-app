/**
 * Role helpers — P1 of the unified admin platform sequence (v1.22.1).
 *
 * Per plan in ~/.claude/plans/frolicking-stargazing-church.md (D3 lock):
 * post-migration `public.user_roles` is the single source of truth for
 * "what kind of user is this." This file exposes the read API.
 *
 * P1 ships the helper but does NOT cut consumers over. P2 will replace
 * useAuth().primaryRole / useIsAdmin / useTenantMembership-role-derivation
 * / useRepProfile-role-derivation with `useEffectiveRoles()` (which wraps
 * the server fn here).
 *
 * Security: like resolveEffectiveUserId in auth-helpers.ts, this fn calls
 * resolveEffectiveUserId first to honor admin viewing-as. The role read
 * runs against the resolved effective user_id, so admin impersonating
 * Karen sees Karen's roles (spa_owner), not admin's roles. Non-admin
 * callers passing viewAsUserId get a hard 403 (enforced inside
 * resolveEffectiveUserId via user_roles service-role check).
 */

import { admin } from "./admin-client";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { resolveEffectiveUserId } from "@/server/auth-helpers";

// Mirrors the app_role enum after v1.22.1 migration 20260619000000_unified
// _admin_p1a_app_role_expansion.sql. `member` exists in the DB enum but
// has no consumer behavior — we ignore it here.
export type PlatformRole =
  | "admin"
  | "spa_owner"
  | "rep"
  | "sub_rep"
  | "developer";

// Shell rendered to the user — derived in priority order (admin > rep >
// spa_owner > developer). Mirrors the existing app.tsx dispatch order
// but reads from user_roles, not user_preferences.primary_role.
//
// Note the dash-vs-underscore: the existing shell-dispatch values use
// "spa-owner" (dash, per user_preferences.primary_role CHECK constraint).
// We preserve that string here so P2 consumer cutover is a one-line swap
// (no string-key churn through the codebase).
export type Shell = "admin" | "rep" | "spa-owner" | "developer";

export type EffectiveRoles = {
  /** The user_id whose roles are reflected. Equals callerUserId when not
   * viewing-as; equals the target when admin is viewing-as. */
  userId: string;
  /** Always the JWT-verified caller. Useful for audit logging. */
  callerUserId: string;
  /** True when caller is an admin operating in viewing-as mode. */
  isViewingAs: boolean;
  // Convenience boolean accessors for common gates.
  isAdmin: boolean;
  isSpaOwner: boolean;
  isRep: boolean;
  isSubRep: boolean;
  isDeveloper: boolean;
  /** The "primary" shell to render for this user. Null when the user has
   * no recognized role (typical for brand-new accounts mid-onboarding). */
  shell: Shell | null;
  /** Raw role labels, for debugging / audit. Excludes 'member'. */
  rawRoles: PlatformRole[];
};

const getEffectiveRolesInput = z.object({
  accessToken: z.string().min(1),
  /** Optional admin viewing-as override. Server re-verifies admin role
   * before honoring; non-admin callers passing this get a 403. */
  viewAsUserId: z.string().uuid().optional(),
});

function deriveShell(roles: ReadonlySet<PlatformRole>): Shell | null {
  // Priority: admin > spa-owner > rep > developer.
  //
  // v1.24.6: spa-owner now wins over rep when a user has BOTH. Rationale:
  // in Refill's model, a spa owner CAN also hold a rep_accounts row
  // (origin_type='spa_owner' attribution chain). Their PRIMARY identity
  // is the tenant they own — that's where their patients, recovery,
  // billing live. Rep attribution is supplementary. Pre-v1.24.6 priority
  // was admin > rep > spa-owner > developer, which routed karen.aslak
  // (1,140 patients + a rep account) into RepShell instead of RefillShell.
  // Kelly (pure rep, no spa_owner role) stays "rep" unchanged.
  if (roles.has("admin")) return "admin";
  if (roles.has("spa_owner")) return "spa-owner";
  if (roles.has("rep") || roles.has("sub_rep")) return "rep";
  if (roles.has("developer")) return "developer";
  return null;
}

// ─── listImpersonableUsers (v1.23.0 — P3 persona switcher dropdown) ──────
//
// Returns every user with a non-'member' role row (admin / spa_owner / rep
// / sub_rep / developer) plus their derived shell + display name (email
// fallback if no rep display name / spa name) + tenant_name where
// applicable. Admin-only; non-admin callers get a hard 403.
//
// The caller themselves is included in the list so the "My roles (Admin)"
// revert option is always reachable, but the persona switcher UI can
// special-case that entry to be the top-of-list revert affordance.
//
// Service-role read — RLS would block reading other users' rows.

export type ImpersonableUser = {
  userId: string;
  email: string;
  displayName: string;
  shell: Shell;
  tenantName?: string;
  /** True for the entry matching the caller themselves (the "revert"
   *  option). */
  isCaller: boolean;
};

const listImpersonableUsersInput = z.object({
  accessToken: z.string().min(1),
});

export const listImpersonableUsers = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => listImpersonableUsersInput.parse(raw))
  .handler(
    async ({ data }): Promise<{ users: ImpersonableUser[] }> => {
      const { resolveEffectiveUserId } = await import("@/server/auth-helpers");
      // Use plain verifyAuth path (no viewAsUserId) — listImpersonableUsers
      // ALWAYS gates on caller's admin status, never the impersonated
      // user's.
      const { callerUserId } = await resolveEffectiveUserId({
        accessToken: data.accessToken,
      });

      const sb = admin();

      // Gate: caller must be admin.
      const { data: roleRow, error: roleErr } = await sb
        .from("user_roles")
        .select("role")
        .eq("user_id", callerUserId)
        .eq("role", "admin")
        .maybeSingle();
      if (roleErr) {
        throw new Error(`Couldn't verify admin: ${roleErr.message}`);
      }
      if (!roleRow) {
        throw new Error("Admin only.");
      }

      // Pull every user_roles row (excluding 'member' which is the
      // default no-real-role marker).
      const { data: roleRows, error: rolesErr } = await sb
        .from("user_roles")
        .select("user_id, role")
        .neq("role", "member");
      if (rolesErr) {
        throw new Error(`Couldn't load roles: ${rolesErr.message}`);
      }
      const rolesByUser = new Map<string, Set<PlatformRole>>();
      for (const r of roleRows ?? []) {
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
        let set = rolesByUser.get(r.user_id);
        if (!set) {
          set = new Set();
          rolesByUser.set(r.user_id, set);
        }
        set.add(role);
      }
      const userIds = Array.from(rolesByUser.keys());
      if (userIds.length === 0) {
        return { users: [] };
      }

      // Fan-out joins: auth.users (email), rep_accounts (display_name),
      // tenant_memberships→tenants (tenant_name).
      const [authRes, repRes, tmRes] = await Promise.all([
        sb.auth.admin.listUsers({ perPage: 1000 }),
        sb
          .from("rep_accounts")
          .select("rep_user_id, display_name")
          .in("rep_user_id", userIds),
        sb
          .from("tenant_memberships")
          .select("user_id, tenant_id, role, created_at, tenants(name)")
          .in("user_id", userIds)
          .order("created_at", { ascending: true }),
      ]);
      if (authRes.error) {
        throw new Error(`Couldn't load auth users: ${authRes.error.message}`);
      }
      if (repRes.error) {
        throw new Error(`Couldn't load rep accounts: ${repRes.error.message}`);
      }
      if (tmRes.error) {
        throw new Error(
          `Couldn't load tenant memberships: ${tmRes.error.message}`,
        );
      }

      const emailByUser = new Map<string, string>();
      for (const u of authRes.data?.users ?? []) {
        if (u.email) emailByUser.set(u.id, u.email);
      }

      const repNameByUser = new Map<string, string>();
      for (const r of repRes.data ?? []) {
        if (r.display_name) repNameByUser.set(r.rep_user_id, r.display_name);
      }

      // Pick one tenant per user — prefer role='owner', then earliest.
      const tenantNameByUser = new Map<string, string>();
      for (const m of tmRes.data ?? []) {
        const existing = tenantNameByUser.get(m.user_id);
        // tenants is joined as an object (single relation) or array depending
        // on the supabase-js return shape; coerce defensively.
        const tenantsRel = (m as { tenants?: { name: string } | { name: string }[] | null })
          .tenants;
        const tenantName = Array.isArray(tenantsRel)
          ? tenantsRel[0]?.name
          : tenantsRel?.name;
        if (!tenantName) continue;
        if (!existing || m.role === "owner") {
          tenantNameByUser.set(m.user_id, tenantName);
        }
      }

      const users: ImpersonableUser[] = userIds.map((uid) => {
        const rolesSet = rolesByUser.get(uid)!;
        const shell = deriveShell(rolesSet) ?? "spa-owner";
        const email = emailByUser.get(uid) ?? "(unknown email)";
        const tenantName = tenantNameByUser.get(uid);
        const repName = repNameByUser.get(uid);
        let displayName: string;
        if (rolesSet.has("admin")) {
          displayName = email;
        } else if (rolesSet.has("rep") || rolesSet.has("sub_rep")) {
          displayName = repName ?? email;
        } else if (rolesSet.has("spa_owner") && tenantName) {
          displayName = tenantName;
        } else {
          displayName = email;
        }
        return {
          userId: uid,
          email,
          displayName,
          shell,
          tenantName,
          isCaller: uid === callerUserId,
        };
      });

      // Sort: admin (caller first within admin group) → spa_owners by name
      // → reps by name → others. Matches deriveShell priority order.
      const shellOrder: Record<Shell, number> = {
        admin: 0,
        "spa-owner": 1,
        rep: 2,
        developer: 3,
      };
      users.sort((a, b) => {
        const o = shellOrder[a.shell] - shellOrder[b.shell];
        if (o !== 0) return o;
        if (a.isCaller && !b.isCaller) return -1;
        if (b.isCaller && !a.isCaller) return 1;
        return a.displayName.localeCompare(b.displayName);
      });

      return { users };
    },
  );

export const getEffectiveRoles = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => getEffectiveRolesInput.parse(raw))
  .handler(async ({ data }): Promise<EffectiveRoles> => {
    const { effectiveUserId, callerUserId, isViewingAs } =
      await resolveEffectiveUserId({
        accessToken: data.accessToken,
        viewAsUserId: data.viewAsUserId,
      });

    const sb = admin();
    const { data: rows, error } = await sb
      .from("user_roles")
      .select("role")
      .eq("user_id", effectiveUserId);

    if (error) {
      throw new Error(`Couldn't load roles: ${error.message}`);
    }

    const recognized = new Set<PlatformRole>();
    for (const r of rows ?? []) {
      const role = r.role as string;
      if (
        role === "admin" ||
        role === "spa_owner" ||
        role === "rep" ||
        role === "sub_rep" ||
        role === "developer"
      ) {
        recognized.add(role);
      }
      // 'member' silently dropped — no consumer behavior tied to it.
    }

    return {
      userId: effectiveUserId,
      callerUserId,
      isViewingAs,
      isAdmin: recognized.has("admin"),
      isSpaOwner: recognized.has("spa_owner"),
      isRep: recognized.has("rep"),
      isSubRep: recognized.has("sub_rep"),
      isDeveloper: recognized.has("developer"),
      shell: deriveShell(recognized),
      rawRoles: Array.from(recognized).sort(),
    };
  });
