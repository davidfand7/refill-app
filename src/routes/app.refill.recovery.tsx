/**
 * /app/refill/recovery — Refill Solution layout shell (v2.1.0 IA reorg).
 *
 * Pure Outlet so child routes mount in place (campaigns pattern):
 *   - recovery.index   → recovery receipt dashboard (Overview)
 *   - recovery.preshow → pre-appointment reminders (was /agents/preshow)
 *   - recovery.rescue  → no-show waitlist rescue (was /agents/rescue)
 *
 * "Refill" is the no-show-recovery Solution under the SmartSpa umbrella:
 * prevent (Reminders) + recover (Renew), with the dashboard as Overview.
 */
import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/app/refill/recovery")({
  component: RecoveryLayout,
});

function RecoveryLayout() {
  return <Outlet />;
}
