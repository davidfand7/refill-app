/**
 * /app/refill/billing — back-compat redirect shim (v1.4).
 *
 * Canonical billing surface is /app/billing (v1.4). This route exists only
 * to keep stale bookmarks and pre-v1.4 email links resolving cleanly.
 * Safe to delete after a release cycle has passed.
 */

import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/app/refill/billing")({
  component: () => <Navigate to="/app/billing" replace />,
});
