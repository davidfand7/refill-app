/**
 * Stage 2 vertical breakout — post-login redirect by primary_role.
 *
 *   spa-owner → emma.agentiport.com/app/refill
 *   rep       → lizzie.agentiport.com/app/rep
 *   developer → agentiport.com/app/repos
 *   null      → agentiport.com/app/repos (treated as developer)
 *
 * URL slugs renamed /app/karen → /app/refill + /app/liz → /app/rep in v283.
 * Legacy /app/karen + /app/liz routes still exist as redirect-only stubs
 * (src/routes/app.karen.tsx + src/routes/app.liz.tsx) so any old bookmark
 * still works. Legacy karen.agentiport.com / liz.agentiport.com hostnames
 * are also still bound to the Worker, so the cross-host check below
 * "currentHostname === emma.agentiport.com" only short-circuits when the
 * user is already on the canonical host; landing on a legacy alias still
 * dispatches them to the canonical one (cheap no-op redirect).
 *
 * Session-storage gate ensures we only fire once per sign-in: a user who
 * navigates back to /app/repos manually shouldn't keep getting bounced.
 *
 * In dev (localhost / non-agentiport hosts) we don't cross hosts — we just
 * navigate within the current origin via SPA navigate. Cross-host redirect
 * uses a hard window.location.href so the new subdomain mints its own
 * Worker request and gets the right shell stamp.
 */
import type { PrimaryRole } from "@/server/user-prefs.functions";

const DISPATCH_FLAG = "oa:post-login-dispatched";

interface RedirectTarget {
  /** Absolute URL when crossing hosts; pathname when staying on origin. */
  href: string;
  crossHost: boolean;
}

export function postLoginTarget(
  primaryRole: PrimaryRole | null,
  currentHostname: string,
): RedirectTarget | null {
  const isAgentiportHost =
    currentHostname === "agentiport.com" ||
    currentHostname.endsWith(".agentiport.com");

  // Dev: stay on the current origin. Pathname-only.
  if (!isAgentiportHost) {
    if (primaryRole === "spa-owner") return { href: "/app/refill", crossHost: false };
    if (primaryRole === "rep") return { href: "/app/rep", crossHost: false };
    // v417.1.2: 'developer' is the primary_role we set on admin testing
    // identities. On Refill hosts, send them to the persona switcher
    // (their entry point) instead of /app/repos (which is Agentiport
    // territory and shouldn't exist on the consolidated Refill site).
    if (primaryRole === "developer") return { href: "/app/admin/personas", crossHost: false };
    // Unknown role on a non-Agentiport host → conservative default to
    // /app/admin/personas (admin testing tool — if they don't have admin
    // role the page itself gates them).
    return { href: "/app/admin/personas", crossHost: false };
  }

  // Prod: respect explicit URL intent FIRST. If the user is already on a
  // vertical subdomain (emma/lizzie + legacy karen/liz aliases), keep them
  // there regardless of primary_role. They typed that hostname for a
  // reason — don't cross-host them away based on a role assigned at signup.
  // Fixed v306 after Grasshopper hit it as a developer landing on
  // lizzie.agentiport.com and getting bounced to agentiport.com/app/repos.
  if (
    currentHostname === "emma.agentiport.com" ||
    currentHostname === "karen.agentiport.com"
  ) {
    return { href: "/app/refill", crossHost: false };
  }
  if (
    currentHostname === "lizzie.agentiport.com" ||
    currentHostname === "liz.agentiport.com"
  ) {
    return { href: "/app/rep", crossHost: false };
  }

  // Apex (agentiport.com) — dispatch by role. OAuth bounce-back lands here
  // for accounts whose login origin was the apex.
  if (primaryRole === "spa-owner") {
    return { href: "https://emma.agentiport.com/app/refill", crossHost: true };
  }
  if (primaryRole === "rep") {
    return { href: "https://lizzie.agentiport.com/app/rep", crossHost: true };
  }
  // developer / null
  return { href: "/app/repos", crossHost: false };
}

/** True if we've already dispatched this browser session — caller should no-op. */
export function hasDispatched(): boolean {
  if (typeof sessionStorage === "undefined") return false;
  try {
    return sessionStorage.getItem(DISPATCH_FLAG) === "1";
  } catch {
    return false;
  }
}

export function markDispatched(): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(DISPATCH_FLAG, "1");
  } catch {
    /* ignore */
  }
}

export function clearDispatchFlag(): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.removeItem(DISPATCH_FLAG);
  } catch {
    /* ignore */
  }
}
