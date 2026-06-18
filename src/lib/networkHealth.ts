/**
 * Network health — periodic Supabase reachability probe.
 *
 * Keeps the circuit breaker (src/lib/circuit-breaker.ts) current EVEN WHILE THE
 * USER IS IDLE. Real query traffic feeds the breaker via the `global.fetch`
 * hook in src/integrations/supabase/client.ts; that hook is the single place
 * that classifies a response as success/failure. This probe simply issues a
 * cheap synthetic query every 30 s so the hook has something to observe when
 * the app is otherwise quiet — it does NOT classify the result itself (doing so
 * would double-count the very request the hook already saw).
 *
 * The public network-status API lives in circuit-breaker.ts and is re-exported
 * here so existing consumers (`@/lib/networkHealth`) keep working unchanged.
 * Importing this module is what starts the probe loop.
 */

import { supabase } from "@/integrations/supabase/client";

export {
  getNetworkStatus,
  subscribeNetworkStatus,
  recordSupabaseFailure,
  recordSupabaseSuccess,
  isCircuitOpen,
  type NetworkStatus,
} from "@/lib/circuit-breaker";

const isBrowser = typeof window !== "undefined";
const HEALTH_INTERVAL_MS = 30_000; // 30 s between idle probes

let healthTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleHealthCheck(delayMs = HEALTH_INTERVAL_MS) {
  if (healthTimer) clearTimeout(healthTimer);
  healthTimer = setTimeout(runHealthCheck, delayMs);
}

async function runHealthCheck() {
  // The online/offline listeners in circuit-breaker.ts already own the
  // browser-offline state; no point probing when there's no network.
  if (isBrowser && !navigator.onLine) {
    scheduleHealthCheck();
    return;
  }

  try {
    // Lightest possible read: single row, no joins. We don't inspect the
    // result — the fetch hook in client.ts classifies this request's
    // reachability (network error / 5xx / 429 → failure, any real response →
    // success). The probe exists only to generate that observation while idle.
    await supabase.from("tenants").select("id").limit(1);
  } catch {
    // A network-level throw is already recorded by the fetch hook; swallow
    // here so the loop keeps running.
  }

  scheduleHealthCheck();
}

// Start the background loop (browser only).
if (isBrowser) {
  // Re-probe immediately when the browser says we're back online.
  window.addEventListener("online", () => scheduleHealthCheck(0));
  scheduleHealthCheck(5_000); // first probe after 5 s
}
