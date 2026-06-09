/**
 * /app/billing — Billing layout shell (v2.1.0 IA reorg).
 *
 * Pure Outlet so child routes mount in place (campaigns pattern):
 *   - billing.index       → fee-rules config + live ledger + invoices (Ledger)
 *   - billing.attribution → recovery-credit rules (was /agents/attribution)
 */
import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/app/billing")({
  component: BillingLayout,
});

function BillingLayout() {
  return <Outlet />;
}
