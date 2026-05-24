/**
 * Cookie-backed Supabase auth storage.
 *
 * Why cookies (not localStorage): Refill serves from <code>getrefill.app</code> apex AND
 * <code>app.getrefill.app</code> subdomain. localStorage is origin-scoped — a session set
 * on the apex wouldn't be visible on the app subdomain. A cookie scoped to
 * <code>.getrefill.app</code> (with the leading dot) is shared across all subdomains.
 *
 * Note: this is a DRAMATIC simplification of openagenticv4's cookie-storage,
 * which had to detect host (.agentiport.com vs .getrefill.app) at runtime
 * because the same code served both apexes. Refill on its own = one cookie
 * domain, always.
 */

const COOKIE_DOMAIN_PROD = ".getrefill.app";

function isLocalhost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function cookieDomain(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const host = window.location.hostname;
  if (isLocalhost(host)) return undefined; // browser sets cookie on localhost without explicit domain
  // Only force the .getrefill.app domain when actually on getrefill.app.
  // On workers.dev / preview URLs, forcing Domain=.getrefill.app makes the
  // browser silently REJECT the cookie → session never persists across page
  // loads → useIsAdmin & friends see no auth on /app/admin hard-refresh.
  if (host === "getrefill.app" || host.endsWith(".getrefill.app")) {
    return COOKIE_DOMAIN_PROD;
  }
  return undefined;
}

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const prefix = name + "=";
  for (const part of document.cookie.split("; ")) {
    if (part.startsWith(prefix)) {
      try {
        return decodeURIComponent(part.slice(prefix.length));
      } catch {
        return part.slice(prefix.length);
      }
    }
  }
  return null;
}

function writeCookie(name: string, value: string): void {
  if (typeof document === "undefined") return;
  const domain = cookieDomain();
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "Max-Age=31536000", // 1 year — supabase-js manages session lifetime separately
    "SameSite=Lax",
    typeof window !== "undefined" && window.location.protocol === "https:" ? "Secure" : "",
    domain ? `Domain=${domain}` : "",
  ].filter(Boolean);
  document.cookie = parts.join("; ");
}

function deleteCookie(name: string): void {
  if (typeof document === "undefined") return;
  const domain = cookieDomain();
  const parts = [
    `${name}=`,
    "Path=/",
    "Max-Age=0",
    domain ? `Domain=${domain}` : "",
  ].filter(Boolean);
  document.cookie = parts.join("; ");
}

export const cookieStorage = {
  getItem: (key: string): string | null => readCookie(key),
  setItem: (key: string, value: string): void => writeCookie(key, value),
  removeItem: (key: string): void => deleteCookie(key),
};

/**
 * Cross-tab sync: when one tab writes a new auth cookie, fire a custom event
 * so the supabase client in OTHER tabs can re-read storage and refresh its
 * in-memory session. Without this, a backgrounded tab keeps using the old
 * access_token until its own poll interval — which presents as a spurious
 * SIGNED_OUT when the stale token hits a 401.
 */
type StorageChangeListener = (event: { key: string }) => void;
const listeners = new Set<StorageChangeListener>();

export function subscribeCookieStorageChanges(fn: StorageChangeListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

if (typeof window !== "undefined") {
  // BroadcastChannel is supported in all modern browsers we ship to.
  // Single-channel broadcast: cookie writers post; subscribers react.
  try {
    const channel = new BroadcastChannel("refill-cookie-storage");
    const _origSet = cookieStorage.setItem;
    cookieStorage.setItem = (key, value) => {
      _origSet(key, value);
      try {
        channel.postMessage({ key });
      } catch {
        /* non-fatal */
      }
    };
    channel.onmessage = (ev) => {
      const key = ev?.data?.key;
      if (typeof key !== "string") return;
      for (const fn of listeners) fn({ key });
    };
  } catch {
    /* BroadcastChannel unavailable — single-tab fallback, no cross-tab sync */
  }
}
