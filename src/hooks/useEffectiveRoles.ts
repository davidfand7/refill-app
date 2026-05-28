/**
 * useEffectiveRoles — client hook around getEffectiveRoles server fn.
 *
 * P1 of the unified admin platform sequence (v1.22.1). Reads from the
 * post-migration public.user_roles via getEffectiveRoles. Honors admin
 * viewing-as: when an admin is impersonating Karen, the hook returns
 * Karen's roles (spa_owner), not the admin's roles. Server-side
 * resolveEffectiveUserId enforces the security boundary; non-admin
 * callers passing viewAsUserId get 403.
 *
 * P1 SCOPE: This file ships but no consumers call it yet. P2 will cut
 * useAuth().primaryRole / useIsAdmin / useTenantMembership-role-derivation
 * over to this hook. Available for early opt-in if useful, but not the
 * source of truth for shell selection until P2 ships.
 *
 * Pattern mirrors use-tenant-membership.ts: useAuth-driven, module-level
 * in-flight cache keyed by access token, three-state result.
 */

import { useEffect, useState } from "react";

import { useAuth } from "@/lib/auth";
import {
  getEffectiveRoles,
  type EffectiveRoles,
} from "@/server/role-helpers";

export type EffectiveRolesState =
  | { status: "loading"; roles: null }
  | { status: "anonymous"; roles: null }
  | { status: "resolved"; roles: EffectiveRoles }
  | { status: "error"; roles: null; error: string };

const LOADING: EffectiveRolesState = { status: "loading", roles: null };
const ANONYMOUS: EffectiveRolesState = { status: "anonymous", roles: null };

// In-flight cache keyed by `${accessToken}|${viewAsUserId ?? ""}`. Token
// rotation invalidates naturally; admin switching personas changes the
// viewAsUserId portion of the key. Failed promises drop themselves so
// next call retries.
const cache = new Map<string, Promise<EffectiveRoles>>();

function cacheKey(accessToken: string, viewAsUserId?: string): string {
  return `${accessToken}|${viewAsUserId ?? ""}`;
}

function fetchEffectiveRoles(
  accessToken: string,
  viewAsUserId?: string,
): Promise<EffectiveRoles> {
  const key = cacheKey(accessToken, viewAsUserId);
  const cached = cache.get(key);
  if (cached) return cached;
  const promise = getEffectiveRoles({
    data: { accessToken, viewAsUserId },
  }).catch((err) => {
    cache.delete(key);
    throw err;
  });
  cache.set(key, promise);
  return promise;
}

/**
 * Eager-warm helper — call from app.tsx mount so the role lookup is
 * resolving by the time the persona dispatch effect runs (P2+).
 */
export function prefetchEffectiveRoles(
  accessToken: string,
  viewAsUserId?: string,
): Promise<EffectiveRoles> {
  return fetchEffectiveRoles(accessToken, viewAsUserId);
}

/**
 * Subscribe hook. Pass viewAsUserId to honor admin impersonation —
 * typically read from localStorage by the caller (P3 will generalize the
 * v1.20.6 tenant switcher pattern from tenant-id to user-id).
 */
export function useEffectiveRoles(
  viewAsUserId?: string,
): EffectiveRolesState {
  const { session, loading: authLoading } = useAuth();
  const accessToken = session?.access_token;
  const [state, setState] = useState<EffectiveRolesState>(LOADING);

  useEffect(() => {
    if (authLoading) {
      setState(LOADING);
      return;
    }
    if (!accessToken) {
      setState(ANONYMOUS);
      return;
    }
    let cancelled = false;
    setState(LOADING);
    fetchEffectiveRoles(accessToken, viewAsUserId)
      .then((roles) => {
        if (!cancelled) setState({ status: "resolved", roles });
      })
      .catch((err) => {
        if (!cancelled) {
          setState({
            status: "error",
            roles: null,
            error: err?.message ?? String(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, authLoading, viewAsUserId]);

  return state;
}
