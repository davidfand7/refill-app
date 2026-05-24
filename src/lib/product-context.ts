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
 * (route + Supabase client init). Returns the .getrefill.app apex always.
 */

export function cookieDomainFor(_hostname?: string): string | undefined {
  if (typeof window !== "undefined") {
    const h = window.location.hostname;
    if (h === "localhost" || h === "127.0.0.1") return undefined;
  }
  return ".getrefill.app";
}
