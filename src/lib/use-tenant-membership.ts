/**
 * useTenantMembership — shared hook + module cache for the current user's
 * tenant_memberships → tenants row.
 *
 * Mirror of [[useRepProfile]] for the Refill spa-owner shell. Phase 0 of
 * v410 (the standalone-Refill shell ship). Every spa-owner route previously
 * had to fetch its own tenant via `getMyTenant` independently; this hook
 * collapses callers onto a single in-flight promise per access-token and
 * exposes a three-state result the app.tsx persona dispatch can branch on.
 *
 * Result drives `if (shell === "refill" && useTenantMembership().status === "tenant")`
 * → RefillShell. Non-tenant users on getrefill.app fall through to the
 * default branch (which today is AppSidebar — eventually a marketing-shell
 * fallback when we want one).
 *
 * v1.19 — admin fallback path:
 *   When the authed user has NO tenant_memberships row BUT has the admin
 *   role (per public.user_roles), we fall back to viewing the first tenant
 *   in the system (via getFirstTenantForAdmin). The returned state still
 *   reads as `status: "tenant"` so RefillShell renders normally, but
 *   carries `viewAs: "admin"` so chrome can show a "Viewing as X" banner
 *   and consumers can know the membership isn't real.
 *
 *   v1.20.4 fix: the original gate `primaryRole === "admin"` was wrong —
 *   useAuth().primaryRole read user_preferences.primary_role, the
 *   shell-selection signal ("spa-owner" / "rep" / "developer"), and
 *   NEVER returned "admin". So the gate was dead and the admin-bypass
 *   path never fired. v1.20.4 removed the gate; getFirstTenantForAdmin
 *   server-side admin check is the authoritative gate.
 *
 *   v1.22.2 (P2 of unified admin platform): useAuth().primaryRole no
 *   longer exists — the consumer cutover landed it on getEffectiveRoles
 *   instead. The admin-fallback below stays purely server-gated; client
 *   never decides "you're admin" anywhere in this hook.
 *
 *   Why this is admin-only and not e.g. rep-viewing-tenant: admins are
 *   the platform operators who legitimately need cross-tenant chrome
 *   access for support/walkthroughs/debugging. Reps and spa-owners don't.
 */

import { useEffect, useState } from "react";

import { getAdminViewAsUserId } from "@/lib/admin-view-as";
import { useAuth } from "@/lib/auth";
import { getFirstTenantForAdmin, getMyTenant, type MyTenant } from "@/server/refill-tenants";

// v1.20.6: localStorage key for the admin tenant switcher choice.
// v1.23.0 (DEPRECATED): superseded by ADMIN_VIEW_AS_USER_ID_KEY in
// admin-view-as.ts. Still readable here for back-compat with any stale
// pre-v1.23.0 localStorage; new writes go to the user-id key. Remove the
// legacy key entirely in v1.24.
export const ADMIN_VIEW_AS_TENANT_ID_KEY = "refill-admin-view-as-tenant-id";

function readPreferredTenantId(): string | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage.getItem(ADMIN_VIEW_AS_TENANT_ID_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * v1.20.6 (DEPRECATED v1.23.0) — write the admin's chosen view-as tenant
 * id and reload. The v1.23.0 PersonaSwitcher writes a user_id instead
 * (via setAdminViewAsUserId in admin-view-as.ts), which is the canonical
 * mechanism now. This export stays for back-compat / external callers
 * that haven't migrated; no in-repo callers remain after the v1.23.0
 * RefillShellChrome cleanup.
 */
export function setAdminViewAsTenantId(tenantId: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (tenantId) {
      window.localStorage.setItem(ADMIN_VIEW_AS_TENANT_ID_KEY, tenantId);
    } else {
      window.localStorage.removeItem(ADMIN_VIEW_AS_TENANT_ID_KEY);
    }
  } catch {
    /* localStorage disabled (private mode etc.) — fall through */
  }
  window.location.reload();
}

export type TenantMembershipState =
  | { status: "loading"; tenant: null; viewAs?: never; viewAsUserId?: never }
  | { status: "not-a-tenant"; tenant: null; viewAs?: never; viewAsUserId?: never }
  | {
      status: "tenant";
      tenant: MyTenant;
      viewAs?: "admin";
      /**
       * v1.20: when viewAs === "admin", this carries the impersonated
       * tenant-owner's user_id. Pages plumb this through to server fns as
       * the optional `viewAsUserId` parameter so spa-owner data fetchers
       * filter the target tenant's rows instead of the admin's empty set.
       * Undefined when viewAs is not set (the membership is real).
       */
      viewAsUserId?: string;
    };

const LOADING: TenantMembershipState = { status: "loading", tenant: null };
const NOT_A_TENANT: TenantMembershipState = {
  status: "not-a-tenant",
  tenant: null,
};

// Module-level in-flight cache keyed by access-token (mirror of
// use-rep-profile.ts). Token rotation invalidates naturally; failed promises
// drop themselves from the cache so the next call retries.
const cache = new Map<string, Promise<TenantMembershipState>>();

function fetchTenantMembership(
  accessToken: string,
): Promise<TenantMembershipState> {
  const cached = cache.get(accessToken);
  if (cached) return cached;
  const promise = getMyTenant({ data: { accessToken } })
    .then<TenantMembershipState>((r) =>
      r.tenant ? { status: "tenant", tenant: r.tenant } : NOT_A_TENANT,
    )
    .catch((err) => {
      cache.delete(accessToken);
      throw err;
    });
  cache.set(accessToken, promise);
  return promise;
}

/**
 * Eager-warm helper — call from app.tsx mount so the tenant lookup is
 * resolving by the time the persona dispatch effect runs.
 */
export function prefetchTenantMembership(
  accessToken: string,
): Promise<TenantMembershipState> {
  return fetchTenantMembership(accessToken);
}

/**
 * Subscribe hook. Returns LOADING until auth + tenant lookup resolves.
 * Sign-out returns NOT_A_TENANT immediately. Token rotation refetches.
 *
 * v1.19: when the lookup returns NOT_A_TENANT and the user is admin,
 * fall back to getFirstTenantForAdmin so RefillShell can render in
 * "viewing as" mode.
 */
export function useTenantMembership(): TenantMembershipState {
  const { session, loading: authLoading } = useAuth();
  const accessToken = session?.access_token;
  const [state, setState] = useState<TenantMembershipState>(LOADING);

  useEffect(() => {
    if (authLoading) {
      setState(LOADING);
      return;
    }
    if (!accessToken) {
      setState(NOT_A_TENANT);
      return;
    }
    let cancelled = false;
    setState(LOADING);
    fetchTenantMembership(accessToken)
      .then(async (result) => {
        if (cancelled) return;
        // Real membership wins.
        if (result.status === "tenant") {
          setState(result);
          return;
        }
        // v1.19 + v1.20.4 admin fallback. If the user has no
        // tenant_memberships row, try the admin-fallback route. The
        // server fn (getFirstTenantForAdmin) re-verifies admin role
        // against public.user_roles and throws "Admin only." for
        // non-admins — we catch that and treat it identically to
        // "not a tenant," which is the correct end state for a
        // non-admin without a membership.
        //
        // Pre-v1.20.4 this was gated client-side on
        // `primaryRole === "admin"`, but useAuth().primaryRole read
        // user_preferences.primary_role (shell-selection signal —
        // "spa-owner" / "rep" / "developer"). It NEVER returned
        // "admin", so the gate was dead. v1.20.4 removed the gate;
        // v1.22.2 (P2) removed useAuth().primaryRole entirely. Cost
        // of the un-gated version: one extra POST per non-tenant
        // non-admin sign-in, returning a 401. Non-tenant users are
        // rare (typically mid-onboarding) so the bandwidth is
        // negligible.
        try {
          // v1.23.0 (P3): honor the PersonaSwitcher's user-id choice
          // (localStorage). When set, the server returns the tenant
          // owned by THAT user (null if the user isn't a tenant owner
          // — e.g. impersonating a rep — which short-circuits to
          // NOT_A_TENANT here, so RepShell can take over via app.tsx's
          // shell dispatch).
          //
          // preferredTenantId remains for back-compat with stale
          // pre-v1.23.0 localStorage (where the inline tenant-select
          // wrote tenant-id). When both keys are present, the server
          // prefers viewAsUserId.
          const viewAsUserId = getAdminViewAsUserId();
          const preferredTenantId = readPreferredTenantId();
          const { tenant, ownerUserId } = await getFirstTenantForAdmin({
            data: { accessToken, viewAsUserId, preferredTenantId },
          });
          if (cancelled) return;
          if (tenant) {
            setState({
              status: "tenant",
              tenant,
              viewAs: "admin",
              viewAsUserId: ownerUserId ?? undefined,
            });
            return;
          }
        } catch {
          // Non-admin → server threw "Admin only." Expected.
          // Or admin but no tenants exist (rare).
          // Or admin impersonating a non-owner (rep) → tenant=null.
        }
        setState(NOT_A_TENANT);
      })
      .catch(() => {
        // Fail-closed: a transient DB error shouldn't leave the user
        // in a permanent loading spinner. The cache.delete in
        // fetchTenantMembership means the next paint retries.
        if (!cancelled) setState(NOT_A_TENANT);
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, authLoading]);

  return state;
}
