/**
 * Connection-health circuit breaker — the dependency-free core.
 *
 * Tracks two signals:
 *  1. `navigator.onLine` — browser reports no network at all → "offline".
 *  2. Consecutive Supabase failures — network is up but the backend is
 *     unreachable or overloaded → "degraded". After 3 consecutive failures
 *     the circuit "opens" for 30 s before a half-open retry is allowed.
 *
 * This module imports NOTHING from the app (in particular, NOT the Supabase
 * client). That is deliberate: the Supabase client itself feeds this breaker
 * (see src/integrations/supabase/client.ts), so the breaker must not depend on
 * the client or we'd create an import cycle in init-critical code. The periodic
 * idle probe that DOES need the client lives in src/lib/networkHealth.ts.
 *
 * Consumers call `getNetworkStatus()` for a synchronous snapshot or
 * `subscribeNetworkStatus(cb)` to receive change events.
 */

export type NetworkStatus = "online" | "degraded" | "offline";

const isBrowser = typeof window !== "undefined";

let status: NetworkStatus =
  isBrowser && !navigator.onLine ? "offline" : "online";
let consecutiveFailures = 0;
let circuitOpenUntil = 0; // epoch ms

export const FAILURE_THRESHOLD = 3;
export const CIRCUIT_OPEN_MS = 30_000; // 30 s open before half-open retry

const listeners = new Set<(s: NetworkStatus) => void>();

function emit(next: NetworkStatus) {
  if (next === status) return;
  status = next;
  listeners.forEach((cb) => cb(next));
}

// ── Browser online/offline events ──────────────────────────────────────────
if (isBrowser) {
  window.addEventListener("online", () => {
    consecutiveFailures = 0;
    circuitOpenUntil = 0;
    emit("online");
  });
  window.addEventListener("offline", () => emit("offline"));
}

// ── Public API ──────────────────────────────────────────────────────────────

export function getNetworkStatus(): NetworkStatus {
  return status;
}

/** True while the breaker is "open" (backing off after repeated failures). */
export function isCircuitOpen(): boolean {
  return Date.now() < circuitOpenUntil;
}

/**
 * Record a real Supabase failure (network error / 5xx / 429). Three in a row
 * opens the circuit and flips the app to "degraded".
 */
export function recordSupabaseFailure() {
  consecutiveFailures += 1;
  if (consecutiveFailures >= FAILURE_THRESHOLD) {
    circuitOpenUntil = Date.now() + CIRCUIT_OPEN_MS;
    emit("degraded");
  }
}

/**
 * Record a reachable Supabase response (2xx/3xx — and 4xx, which still proves
 * the backend is up and answering). Clears a degraded state on recovery.
 */
export function recordSupabaseSuccess() {
  if (consecutiveFailures > 0) {
    consecutiveFailures = 0;
    circuitOpenUntil = 0;
    if (!isBrowser || navigator.onLine) emit("online");
  }
}

export function subscribeNetworkStatus(
  cb: (s: NetworkStatus) => void,
): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
