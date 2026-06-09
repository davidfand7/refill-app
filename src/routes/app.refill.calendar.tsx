/**
 * /app/refill/calendar — Calendar Solution layout shell (v2.1.0 IA reorg).
 *
 * Pure Outlet so child routes mount in place (campaigns pattern):
 *   - calendar.index    → redirects to /calendar/schedule
 *   - calendar.schedule → owner day/week/month calendar (was /app/refill/schedule)
 *   - calendar.appointments → appts table + CSV import (was /app/refill/appointments)
 *   - calendar.booking  → online-booking settings (was /settings/booking)
 *   - calendar.connections → PMS connectors (was /settings/scheduler)
 *
 * Merges the old Appointments + Schedule tabs and co-locates their settings
 * so the whole scheduling surface is one removable Solution.
 */
import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/app/refill/calendar")({
  component: CalendarLayout,
});

function CalendarLayout() {
  return <Outlet />;
}
