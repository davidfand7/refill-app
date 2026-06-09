/**
 * /app/refill/calendar/ — Calendar Solution default → Schedule.
 */
import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/app/refill/calendar/")({
  component: () => <Navigate to="/app/refill/calendar/schedule" replace />,
});
