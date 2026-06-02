/**
 * /app/admin/flags → REDIRECTED to /app/admin/agents (v1.34.3).
 *
 * Per the 2026-06-02 architecture reframe: feature flags + per-agent
 * settings move from "Flags" (engineer-shaped meta-control) to
 * "Agents & overrides" (operator-shaped). The page logic moved as-is
 * to app.admin.agents.tsx; this file keeps the old URL working for
 * any stale bookmarks while the chip + new URL take over.
 */
import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/app/admin/flags")({
  component: AdminFlagsRedirect,
});

function AdminFlagsRedirect() {
  return <Navigate to="/app/admin/agents" replace />;
}
