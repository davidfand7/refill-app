/**
 * /app/refill/agents/preshow — back-compat redirect (v2.1.0 IA reorg).
 * The Agents section dissolved; reminders now live in the Refill Solution.
 */
import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/app/refill/agents/preshow")({
  component: () => <Navigate to="/app/refill/recovery/preshow" replace />,
});
