/**
 * Network health — circuit breaker + offline detection.
 *
 * Tracks two signals:
 *  1. `navigator.onLine` — browser reports no network at all.
 *  2. Consecutive Supabase failures — network is up but backend is unreachable
 *     or overloaded ("degraded"). After 3 consecutive failures within a 60s
 *     window the circuit "opens" for 30 s before allowing a retry.
 *
 * Consumers call `getNetworkStatus()` for a synchronous snapshot or
 * `subscribeNetworkStatus(cb)` to receive change events.
 */

import { supabase } from "@/integrations/supabase/client";

export type NetworkStatus = "online" | "degraded" | "offline";

// ── Internal state ─────────────────────────────────────────────────────────────

const isBrowser = typeof window !== "undefined";

let status: NetworkStatus = isBrowser && !navigator.onLine ? "offline" : "online";
let consecutiveFailures = 0;
let circuitOpenUntil = 0; // epoch ms
const listeners = new Set<(s: NetworkStatus) => void>();

function emit(next: NetworkStatus) {
  if (next === status) return;
  status = next;
  listeners.forEach((cb) => cb(next));
}

// ── Browser online/offline events ──────────────────────────────────────────────

if (isBrowser) {
  window.addEventListener("online", () => {
    consecutiveFailures = 0;
    circuitOpenUntil = 0;
    emit("online");
    scheduleHealthCheck(0); // immediate probe after coming back online
  });

  window.addEventListener("offline", () => emit("offline"));
}

// ── Periodic health check ──────────────────────────────────────────────────────

let healthTimer: ReturnType<typeof setTimeout> | null = null;
const HEALTH_INTERVAL_MS = 30_000; // 30 s
const CIRCUIT_OPEN_MS = 30_000;    // 30 s open before half-open retry
const FAILURE_THRESHOLD = 3;

function scheduleHealthCheck(delayMs = HEALTH_INTERVAL_MS) {
  if (healthTimer) clearTimeout(healthTimer);
  healthTimer = setTimeout(runHealthCheck, delayMs);
}

async function runHealthCheck() {
  // Skip if browser reports offline.
  if (isBrowser && !navigator.onLine) {
    emit("offline");
    scheduleHealthCheck();
    return;
  }

  // Circuit is open — don't probe yet.
  if (Date.now() < circuitOpenUntil) {
    scheduleHealthCheck(Math.max(0, circuitOpenUntil - Date.now()));
    return;
  }

  try {
    // Lightest possible read: single row, no joins. Refill cleave 2026-05-25:
    // was 'agents' (Agentiport-only, dropped during cleave); swapped to 'tenants'
    // which is load-bearing in refill-prod. RLS filters to the caller's rows so
    // even an empty result is a healthy probe.
    const { error } = await supabase.from("tenants").select("id").limit(1);
    if (error) throw error;
    consecutiveFailures = 0;
    emit("online");
  } catch {
    consecutiveFailures += 1;
    if (consecutiveFailures >= FAILURE_THRESHOLD) {
      circuitOpenUntil = Date.now() + CIRCUIT_OPEN_MS;
      emit("degraded");
    }
  }

  scheduleHealthCheck();
}

// Start the background loop (browser only).
if (isBrowser) scheduleHealthCheck(5_000); // first probe after 5 s

// ── Public API ─────────────────────────────────────────────────────────────────

export function getNetworkStatus(): NetworkStatus {
  return status;
}

export function recordSupabaseFailure() {
  consecutiveFailures += 1;
  if (consecutiveFailures >= FAILURE_THRESHOLD) {
    circuitOpenUntil = Date.now() + CIRCUIT_OPEN_MS;
    emit("degraded");
  }
}

export function recordSupabaseSuccess() {
  if (consecutiveFailures > 0) {
    consecutiveFailures = 0;
    circuitOpenUntil = 0;
    if (!isBrowser || navigator.onLine) emit("online");
  }
}

export function subscribeNetworkStatus(cb: (s: NetworkStatus) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
