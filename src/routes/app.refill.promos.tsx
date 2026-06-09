/**
 * /app/refill/promos — back-compat redirect (v2.1.1 IA reorg).
 * Manufacturer promos folded into the Promos (Recognition) Solution as the
 * "Brand Promos" tab.
 */
import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/app/refill/promos")({
  component: () => <Navigate to="/app/refill/recognition/brand-promos" replace />,
});
