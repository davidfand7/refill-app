/**
 * refill-app Worker entry.
 *
 * Single-purpose: serve Refill on getrefill.app + app.getrefill.app +
 * *.getrefill.app. No product-context, no shell stamps, no cross-host
 * bridge, no legacy redirects. Single apex, single shell, single product.
 *
 * Everything that USED to live in openagenticv4/src/worker.ts (Agentiport
 * vs Refill routing, shell injection, REFILL_ALLOWED_PREFIXES gates,
 * /app/emma → /app/refill 301s, x-agentiport-shell stamp, HTMLRewriter
 * head injection) DELETED — none of it applies when Refill is on its
 * own infrastructure.
 *
 * The TanStack Start server entry handles SSR + asset serving directly.
 */
import baseHandler from "@tanstack/react-start/server-entry";

export default {
  fetch: baseHandler.fetch,
};
