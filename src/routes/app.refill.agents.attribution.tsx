/**
 * /app/refill/agents/attribution — back-compat redirect (v2.1.0 IA reorg).
 * The Agents section dissolved; attribution now lives under Billing.
 */
import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/app/refill/agents/attribution")({
  component: () => <Navigate to="/app/billing/attribution" replace />,
});
