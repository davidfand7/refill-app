/**
 * Cleave stub — Step 3.5 placeholder (Step 3.17 deletes the whole module).
 *
 * In openagenticv4 this was a 242-line product-routing layer (agentiport
 * vs refill, surface splits, cookie-domain logic, reserved slug list).
 * Most of it is gone in refill-app:
 *
 *   - isReservedSlug → inlined into refill-tenants.ts
 *   - shell detection → src/lib/shell.ts (always returns 'refill')
 *   - product/surface stamping → DELETED (worker is single-product)
 *
 * cookieDomainFor() survives here because two callers still reference it
 * (route + Supabase client init). v2.89.0 (front-door cutover): made
 * host-aware — it previously returned .getrefill.app UNCONDITIONALLY, which
 * the browser silently rejects on smartspa.app (and on workers.dev/preview),
 * so onboarding/init cookies never set there. Now it scopes to whichever apex
 * it's actually on, and returns undefined (host-only) off our known domains.
 */

export function cookieDomainFor(hostname?: string): string | undefined {
  const h =
    typeof window !== "undefined" ? window.location.hostname : (hostname ?? "");
  if (!h || h === "localhost" || h === "127.0.0.1") return undefined;
  if (h === "smartspa.app" || h.endsWith(".smartspa.app")) return ".smartspa.app";
  if (h === "getrefill.app" || h.endsWith(".getrefill.app")) return ".getrefill.app";
  return undefined;
}
