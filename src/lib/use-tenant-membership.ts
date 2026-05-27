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
 *   Why this is admin-only and not e.g. rep-viewing-tenant: admins are
 *   the platform operators who legitimately need cross-tenant chrome
 *   access for support/walkthroughs/debugging. Reps and spa-owners don't.
 */

import { useEffect, useState } from "react";

import { useAuth } from "@/lib/auth";
import { getFirstTenantForAdmin, getMyTenant, type MyTenant } from "@/server/refill-tenants";

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
  const { session, loading: authLoading, primaryRole } = useAuth();
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
        // v1.19 admin fallback. If user has no membership BUT is admin,
        // try the system-first-tenant route. On failure (not admin
        // server-side, or no tenants exist) we cleanly fall back to
        // NOT_A_TENANT — no infinite loop, no thrown error to caller.
        if (primaryRole === "admin") {
          try {
            const { tenant, ownerUserId } = await getFirstTenantForAdmin({
              data: { accessToken },
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
            // fall through to NOT_A_TENANT
          }
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
  }, [accessToken, authLoading, primaryRole]);

  return state;
}
