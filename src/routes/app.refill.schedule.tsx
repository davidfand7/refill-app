/**
 * /app/refill/schedule — back-compat redirect (v2.1.0 IA reorg).
 * Schedule now lives inside the Calendar Solution.
 */
import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/app/refill/schedule")({
  component: () => <Navigate to="/app/refill/calendar/schedule" replace />,
});
