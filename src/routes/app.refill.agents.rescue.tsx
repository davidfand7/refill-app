/**
 * /app/refill/agents/rescue — back-compat redirect (v2.1.0 IA reorg).
 * The Agents section dissolved; rescue now lives in the Refill Solution.
 */
import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/app/refill/agents/rescue")({
  component: () => <Navigate to="/app/refill/recovery/rescue" replace />,
});
