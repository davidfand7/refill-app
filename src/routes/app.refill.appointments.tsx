/**
 * /app/refill/appointments — back-compat redirect (v2.1.0 IA reorg).
 * Appointments now lives inside the Calendar Solution.
 */
import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/app/refill/appointments")({
  component: () => <Navigate to="/app/refill/calendar/appointments" replace />,
});
