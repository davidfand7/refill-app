/**
 * /app/refill/settings/scheduler — back-compat redirect (v2.1.0 IA reorg).
 * PMS connectors now live inside the Calendar Solution as "Connections".
 */
import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/app/refill/settings/scheduler")({
  component: () => <Navigate to="/app/refill/calendar/connections" replace />,
});
