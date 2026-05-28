/**
 * Post-login redirect by shell.
 *
 * Cleave rewrite 2026-05-24: collapsed from a 117-line cross-host dispatcher
 * (emma.agentiport.com / lizzie.agentiport.com / agentiport.com apex) to a
 * 50-line single-apex mapping. No more cross-host hard navigations, no more
 * legacy karen/liz alias handling, no more apex fallback.
 *
 * v1.22.2 (P2 of unified admin platform): signature changed from
 * `postLoginTarget(primaryRole)` to `postLoginTarget(shell)`. Reason: the
 * pre-P2 input came from user_preferences.primary_role (valid values:
 * "spa-owner" / "rep" / "developer" / null — never "admin"), which meant
 * the `=== "admin"` branch below was the same dead gate the v1.20.4
 * blank-page outage came from. Now the input is the unified Shell derived
 * from user_roles, so "admin" IS a valid value and the branch goes live.
 *
 * Mapping:
 *   spa-owner / null → /app/refill (default, lets RefillShell gate further
 *                                   on tenant membership)
 *   rep              → /app/rep
 *   developer        → /app/admin (admin testing entry)
 *   admin            → /app/admin
 *
 * Session-storage gate fires once per sign-in so a user who navigates back
 * to an explicit URL doesn't keep getting bounced.
 */
import type { Shell } from "@/server/role-helpers";

const DISPATCH_FLAG = "oa:post-login-dispatched";

interface RedirectTarget {
  href: string;
  crossHost: false;
}

export function postLoginTarget(
  shell: Shell | null,
  _currentHostname?: string, // signature kept for callers; ignored
): RedirectTarget {
  if (shell === "rep") return { href: "/app/rep", crossHost: false };
  if (shell === "admin" || shell === "developer") {
    return { href: "/app/admin", crossHost: false };
  }
  // spa-owner + null fall here. RefillShell's own non-tenant gate decides
  // whether to render or bounce to /onboard.
  return { href: "/app/refill", crossHost: false };
}

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
