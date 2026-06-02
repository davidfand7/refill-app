/**
 * Admin viewing-as localStorage helpers — v1.23.0 (P3 of unified admin
 * platform).
 *
 * Generalizes the v1.20.6 tenant-id-keyed switcher to a user-id-keyed
 * switcher. The persona switcher writes a target user_id to localStorage
 * and reloads; downstream:
 *
 *   - useEffectiveRoles reads the value, passes as viewAsUserId to
 *     getEffectiveRoles, which re-verifies admin role server-side before
 *     honoring the override and returns the IMPERSONATED user's role
 *     bundle (so shell dispatch can route to the impersonated user's
 *     shell — RefillShell for spa-owners, RepShell for reps, AdminShell
 *     for self/admin-revert).
 *
 *   - useTenantMembership reads the value, passes to
 *     getFirstTenantForAdmin which (when viewAsUserId is set) returns
 *     the tenant owned by that user, or null if the user isn't a
 *     tenant owner. Non-spa-owner impersonation → NOT_A_TENANT →
 *     RefillShell doesn't render, RepShell or AdminShell takes over.
 *
 *   - Every server fn opted into viewAsUserId (the v1.20-vintage 8 + the
 *     v1.23.0 long-tail 12) reads it via page-side plumbing.
 *
 * The legacy v1.20.6 key (ADMIN_VIEW_AS_TENANT_ID_KEY in
 * use-tenant-membership.ts) is now DEPRECATED. We always clear it when
 * the new user-id key is set, so the two never disagree. After v1.23.0
 * sticks for one release, we can drop the legacy key entirely.
 *
 * NOTE: The legacy ADMIN_VIEW_AS_TENANT_ID_KEY (string
 * "refill-admin-view-as-tenant-id") is hard-coded here rather than
 * imported from use-tenant-membership.ts to avoid a circular import.
 * Keep the string in sync with that file.
 */

export const ADMIN_VIEW_AS_USER_ID_KEY = "refill-admin-view-as-user-id";

/** Legacy v1.20.6 key. Cleared whenever the new user-id key is written
 *  so the two storage slots can't disagree. */
const LEGACY_TENANT_ID_KEY = "refill-admin-view-as-tenant-id";

/**
 * v1.24.3: clear impersonation localStorage WITHOUT a reload. Used by
 * auth.tsx signOut so the next sign-in starts clean instead of
 * continuing the previous user's impersonation context.
 */
export function clearAdminViewAsUserIdNoReload(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(ADMIN_VIEW_AS_USER_ID_KEY);
    window.localStorage.removeItem(LEGACY_TENANT_ID_KEY);
  } catch {
    /* localStorage disabled — fall through */
  }
}

type UrlShellKind = "admin" | "rep" | "spa-owner" | null;

/** Map a URL pathname to the shell-kind it serves. /app/admin → admin,
 *  /app/rep → rep, /app/refill + /app/billing → spa-owner, else null. */
function shellKindForPathname(pathname: string): UrlShellKind {
  if (pathname.startsWith("/app/admin")) return "admin";
  if (pathname.startsWith("/app/rep")) return "rep";
  if (
    pathname.startsWith("/app/refill") ||
    pathname.startsWith("/app/billing")
  )
    return "spa-owner";
  return null;
}

/**
 * v1.24.3: decide where to land after a persona switch.
 *
 *   - If the current URL serves a shell-kind that DIFFERS from the
 *     target persona's shell, redirect to /app so auto-dispatch routes
 *     them to that persona's home.
 *   - If they match (cross-rep, cross-spa-owner, OR reverting to admin
 *     while already on /app/admin/*, OR any non-shell URL like /scan)
 *     → undefined → reload in place so admin can compare the same
 *     surface across personas (or stay where they were on revert).
 *
 * v1.34.2.1: PersonaSwitcher now also calls this on revert-to-admin
 * (was pre-fix: revert stayed in place unconditionally, landing admin
 * on a spa-owner or rep URL they can't render). The function logic
 * already handled "admin" as a target shell — only the caller needed
 * to invoke it.
 */
export function pickRedirectForPersonaSwitch(
  pathname: string,
  targetShell: "admin" | "spa-owner" | "rep" | "developer" | null,
): string | undefined {
  const urlKind = shellKindForPathname(pathname);
  if (!urlKind || !targetShell) return undefined;
  // Treat "developer" target same as admin (admin landing).
  const target =
    targetShell === "developer" ? "admin" : (targetShell as UrlShellKind);
  if (urlKind === target) return undefined;
  return "/app";
}

export function getAdminViewAsUserId(): string | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const v = window.localStorage.getItem(ADMIN_VIEW_AS_USER_ID_KEY);
    return v && v.length > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write the admin's chosen impersonation target user_id and reload so
 * every component re-fetches with the new context. Reload is the simple,
 * correct choice — a SPA-style re-render would require invalidating
 * multiple module-level caches (useEffectiveRoles, useTenantMembership)
 * + every page-side viewAsUserId effect, which is complex and easy to
 * miss. Reload is one line and unambiguous.
 *
 * Pass null/empty to clear (revert to admin's own view).
 *
 * v1.24.2: optional `redirectTo` parameter — when set, navigates there
 * instead of reloading. Used by PersonaSwitcher when picking a non-admin
 * persona while on an /app/admin/* URL, so admin drops into that
 * persona's home rather than staying on an admin surface they're
 * impersonating-around.
 */
export function setAdminViewAsUserId(
  userId: string | null,
  redirectTo?: string,
): void {
  if (typeof window === "undefined") return;
  try {
    if (userId) {
      window.localStorage.setItem(ADMIN_VIEW_AS_USER_ID_KEY, userId);
    } else {
      window.localStorage.removeItem(ADMIN_VIEW_AS_USER_ID_KEY);
    }
    // Always clear the legacy v1.20.6 tenant-id key — the new user-id
    // key is canonical now; we don't want the two slots to disagree.
    window.localStorage.removeItem(LEGACY_TENANT_ID_KEY);
  } catch {
    /* localStorage disabled (private mode etc.) — fall through */
  }
  if (redirectTo) {
    window.location.href = redirectTo;
  } else {
    window.location.reload();
  }
}
