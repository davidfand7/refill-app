/**
 * refill-app Worker entry.
 *
 * Serves the app on smartspa.app (primary front door since the v2.89.0 cutover)
 * + getrefill.app + app.getrefill.app + *.getrefill.app. The TanStack Start
 * server entry handles SSR + asset serving directly.
 *
 * v2.90.0 — front-door redirect. getrefill.app is being retired as the public
 * face: browser page-loads on the getrefill.app APEX (and www) now redirect to
 * smartspa.app, path + query preserved. SCOPED ON PURPOSE so live non-browser
 * traffic on getrefill.app keeps working:
 *   - GET/HEAD only (POSTs — server fns, webhook deliveries — pass through).
 *   - Top-level NAVIGATIONS only (Sec-Fetch-Mode: navigate / Accept: text/html),
 *     so asset + data fetches that carry the page origin aren't bounced.
 *   - /api/* excluded — the local-agent heartbeat, Resend/Twilio webhooks, and
 *     any API client still targeting getrefill.app must NOT be redirected
 *     (those clients don't follow redirects).
 *   - app.getrefill.app and other subdomains NOT touched — the cross-host app
 *     session bridge is deferred; only the bare apex + www redirect.
 * Uses 302 (temporary) during the transition for reversibility; upgrade to 301
 * once smartspa.app has fully settled as the front door.
 */
import baseHandler from "@tanstack/react-start/server-entry";

const REDIRECT_HOSTS = new Set(["getrefill.app", "www.getrefill.app"]);

function cutoverRedirect(request: Request): Response | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const url = new URL(request.url);
  if (!REDIRECT_HOSTS.has(url.hostname)) return null;
  // Never bounce API / webhook / heartbeat traffic — those clients don't follow
  // redirects and must keep hitting getrefill.app until separately migrated.
  if (url.pathname.startsWith("/api/")) return null;
  // Only redirect top-level browser navigations. Asset/data/server-fn fetches
  // carry the page's own origin and resolve fine on whichever host they're on.
  const isNavigation =
    request.headers.get("sec-fetch-mode") === "navigate" ||
    (request.headers.get("accept") ?? "").includes("text/html");
  if (!isNavigation) return null;
  return new Response(null, {
    status: 302,
    headers: {
      Location: `https://smartspa.app${url.pathname}${url.search}`,
      "Cache-Control": "no-store",
    },
  });
}

export default {
  fetch(...args: Parameters<typeof baseHandler.fetch>) {
    return cutoverRedirect(args[0]) ?? baseHandler.fetch(...args);
  },
};
