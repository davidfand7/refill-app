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

import { useAuth } from "@/lib/auth";
import { getMyRepAccount, type RepAccountRow } from "@/server/rep-platform";

export type RepProfileState =
  | { status: "loading"; rep: null }
  | { status: "not-a-rep"; rep: null }
  | { status: "rep"; rep: RepAccountRow };

const LOADING: RepProfileState = { status: "loading", rep: null };
const NOT_A_REP: RepProfileState = { status: "not-a-rep", rep: null };

// Module-level in-flight cache. Keyed by access-token so a token rotation
// (refresh or sign-out / sign-in) invalidates without us having to wire
// invalidation manually. Tokens that never resolve get a chance to be
// re-tried because we cache the PROMISE, not the value — so a transient
// network error will reject and the next caller starts a fresh fetch.
const cache = new Map<string, Promise<RepProfileState>>();

function fetchRepProfile(accessToken: string): Promise<RepProfileState> {
  const cached = cache.get(accessToken);
  if (cached) return cached;
  const promise = getMyRepAccount({ data: { accessToken } })
    .then<RepProfileState>((r) =>
      r.rep ? { status: "rep", rep: r.rep } : NOT_A_REP,
    )
    .catch((err) => {
      // Drop the failed promise from the cache so the next call retries.
      cache.delete(accessToken);
      throw err;
    });
  cache.set(accessToken, promise);
  return promise;
}

/**
 * Eager-warm helper — call from `app.tsx` mount so the rep profile is
 * already resolving by the time any shell-selection useLayoutEffect runs.
 * Returns the same shared promise the hook uses.
 */
export function prefetchRepProfile(accessToken: string): Promise<RepProfileState> {
  return fetchRepProfile(accessToken);
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
    fetchRepProfile(accessToken)
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
  }, [accessToken, authLoading]);

  return state;
}
