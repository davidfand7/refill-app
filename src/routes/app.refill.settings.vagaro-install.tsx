/**
 * /app/refill/settings/vagaro-install — back-compat redirect (v2.3.18 IA reorg).
 * PMS install wizards now live inside the Calendar Solution.
 */
import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/app/refill/settings/vagaro-install")({
  component: () => <Navigate to="/app/refill/calendar/vagaro-install" replace />,
});
