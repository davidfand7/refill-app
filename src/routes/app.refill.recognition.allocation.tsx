/**
 * /app/refill/recognition/allocation — FOLDED into the Deal Desk v2.202.0.
 *
 * The Recognition Allocation Engine's operator surface (run → confirm → dispatch
 * + cohort-split/template settings) was the over-built "ledger" Grasshopper
 * called out (project_buying_rewards_taxonomy): no spa accounts for free margin
 * unit-by-unit. Its capability now lives in the Buying → Deal Desk:
 *   • Deploy = a deal's Promo corner runs the cohort allocation + dispatches via
 *     the zero-setup iMessage queue (the click IS the confirm).
 *   • Settings = the "Deploy settings" panel (cohort split, cooldown, per-cohort
 *     templates) on the Deal Desk.
 * The engine + attribution (runAllocation, dispatchAllocationBatch,
 * recordAllocationWinIfBooked, refill_increment_units_deployed) are unchanged —
 * only this operator route folded. Redirect old bookmarks so nothing dead-ends.
 */

import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/app/refill/recognition/allocation")({
  beforeLoad: () => {
    throw redirect({ to: "/app/refill/recognition/deal", replace: true });
  },
});
