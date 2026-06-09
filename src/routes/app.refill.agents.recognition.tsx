/**
 * /app/refill/agents/recognition — back-compat redirect (v2.1.0 IA reorg).
 * The Agents section dissolved; the allocation engine now lives under
 * Recognition as the "Allocation" tab.
 */
import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/app/refill/agents/recognition")({
  component: () => <Navigate to="/app/refill/recognition/allocation" replace />,
});
