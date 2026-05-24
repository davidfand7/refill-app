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
 */

import { useEffect, useState } from "react";

import { useAuth } from "@/lib/auth";
import { getMyTenant, type MyTenant } from "@/server/refill-tenants";

export type TenantMembershipState =
  | { status: "loading"; tenant: null }
  | { status: "not-a-tenant"; tenant: null }
  | { status: "tenant"; tenant: MyTenant };

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
      .then((result) => {
        if (!cancelled) setState(result);
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
