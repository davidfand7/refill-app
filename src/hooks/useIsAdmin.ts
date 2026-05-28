/**
 * Single source of truth for "is the current user an admin?".
 *
 * v1.22.2 (P2 of unified admin platform) — REWRITTEN as a thin wrapper
 * over useEffectiveRoles().isAdmin. Pre-P2 this hook ran its own direct
 * supabase query against public.user_roles, duplicating the same check
 * that the new server-side getEffectiveRoles already performs (and that
 * resolveEffectiveUserId enforces as the security boundary). One source
 * of truth — eliminates the cache-divergence footgun where a future
 * persona-switch could have left this hook returning stale `isAdmin`
 * because its module-level cache key was uid-only, not session-aware.
 *
 * Returns `false` (never `null`) when no user / not yet loaded so callers
 * can gate UI without juggling tri-state booleans.
 */
import { useEffectiveRoles } from "@/hooks/useEffectiveRoles";

export function useIsAdmin(): boolean {
  const state = useEffectiveRoles();
  return state.status === "resolved" && state.roles.isAdmin;
}
