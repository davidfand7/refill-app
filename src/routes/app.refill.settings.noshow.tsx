/**
 * /app/refill/settings/noshow → REDIRECTED to /app/refill/agents/preshow
 * (v1.34.3).
 *
 * Per the 2026-06-02 architecture reframe: feature flags + per-agent
 * settings move out of "Settings → Noshow" into the dedicated
 * "Agents & overrides" surface. Preshow gets its own first-class route
 * with profile mgmt + cadence + per-touchpoint messages. Old bookmarks
 * land on the new home.
 *
 * Pre-redirect the file held the unified noshow config UI (preshow +
 * rescue placeholder + deposit placeholder + opt-in footer + grace
 * credits). When rescue + attribution + footer ships their own surfaces
 * under /agents/*, the noshow concept dissolves entirely.
 */
import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/app/refill/settings/noshow")({
  component: NoShowRedirect,
});

function NoShowRedirect() {
  return <Navigate to="/app/refill/recovery/preshow" replace />;
}
