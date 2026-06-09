/**
 * /app/refill/settings/booking — back-compat redirect (v2.1.0 IA reorg).
 * Online-booking settings now live inside the Calendar Solution.
 */
import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/app/refill/settings/booking")({
  component: () => <Navigate to="/app/refill/calendar/booking" replace />,
});
