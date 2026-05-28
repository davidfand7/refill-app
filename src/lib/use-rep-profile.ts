/**
 * useRepProfile — shared hook + module cache for the current user's
 * rep_accounts row.
 *
 * Phase 3.1.1 foundation. Every rep route previously called
 * getMyRepAccount() independently — that meant 6x duplicate DB roundtrips
 * per session AND prevented shell-layer dispatch (each route had to fetch
 * the rep before deciding whether to render anything rep-aware). This
 * hook collapses all callers onto a single in-flight promise per
 * access-token, and exposes a three-state result the shell can branch on.
 *
 * Once this lands, the shell selection in app.tsx can branch on
 * `useRepProfile().status === 'rep'` to choose RepShell vs LizDevShell,
 * and per-route DemoBanner / RepNav mounts can be dropped (the chrome
 * lives in the shell once 3.1.4+ ship).
 */

import { useEffect, useState } from "react";

import { getAdminViewAsUserId } from "@/lib/admin-view-as";
import { useAuth } from "@/lib/auth";
import { getMyRepAccount, type RepAccountRow } from "@/server/rep-platform";

export type RepProfileState =
  | { status: "loading"; rep: null }
  | { status: "not-a-rep"; rep: null }
  | { status: "rep"; rep: RepAccountRow };

const LOADING: RepProfileState = { status: "loading", rep: null };
const NOT_A_REP: RepProfileState = { status: "not-a-rep", rep: null };

// Module-level in-flight cache. Keyed by (access-token, viewAsUserId)
// so admin switching personas re-fetches; sign-in/out invalidates naturally
// because the token rotates. v1.24.0: keyed by access-token+viewAsUserId
// so admin impersonating a rep returns the IMPERSONATED rep's profile
// (server-side resolveEffectiveUserId enforces the admin gate).
const cache = new Map<string, Promise<RepProfileState>>();

function cacheKey(accessToken: string, viewAsUserId?: string): string {
  return `${accessToken}|${viewAsUserId ?? ""}`;
}

function fetchRepProfile(
  accessToken: string,
  viewAsUserId?: string,
): Promise<RepProfileState> {
  const key = cacheKey(accessToken, viewAsUserId);
  const cached = cache.get(key);
  if (cached) return cached;
  const promise = getMyRepAccount({ data: { accessToken, viewAsUserId } })
    .then<RepProfileState>((r) =>
      r.rep ? { status: "rep", rep: r.rep } : NOT_A_REP,
    )
    .catch((err) => {
      cache.delete(key);
      throw err;
    });
  cache.set(key, promise);
  return promise;
}

/**
 * Eager-warm helper — call from `app.tsx` mount so the rep profile is
 * already resolving by the time any shell-selection useLayoutEffect runs.
 * Returns the same shared promise the hook uses.
 */
export function prefetchRepProfile(
  accessToken: string,
  viewAsUserId?: string,
): Promise<RepProfileState> {
  return fetchRepProfile(accessToken, viewAsUserId);
}

/**
 * Subscribe-style hook. Returns LOADING until the auth session resolves
 * AND the rep query completes. On sign-out, returns NOT_A_REP immediately
 * (no roundtrip — no token, can't be a rep). On token rotation, refetches
 * (the new token misses the cache).
 */
export function useRepProfile(): RepProfileState {
  const { session, loading: authLoading } = useAuth();
  const accessToken = session?.access_token;
  // v1.24.0: read admin-impersonation localStorage so admin viewing-as a
  // rep gets the rep's profile, not their own.
  const viewAsUserId =
    typeof window !== "undefined" ? getAdminViewAsUserId() : undefined;
  const [state, setState] = useState<RepProfileState>(LOADING);

  useEffect(() => {
    if (authLoading) {
      setState(LOADING);
      return;
    }
    if (!accessToken) {
      // No session = no rep. Skip the fetch.
      setState(NOT_A_REP);
      return;
    }
    let cancelled = false;
    setState(LOADING);
    fetchRepProfile(accessToken, viewAsUserId)
      .then((result) => {
        if (!cancelled) setState(result);
      })
      .catch(() => {
        // Treat fetch failure as "not a rep" — fail-closed for the shell
        // so a transient DB error doesn't leave the user in a permanent
        // loading spinner. The cache.delete in fetchRepProfile means the
        // next paint retries.
        if (!cancelled) setState(NOT_A_REP);
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, authLoading, viewAsUserId]);

  return state;
}
