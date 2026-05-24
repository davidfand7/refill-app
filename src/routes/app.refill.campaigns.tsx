/**
 * /app/refill/campaigns — layout shell.
 *
 * Pure Outlet so child routes mount in place:
 *   - app.emma.campaigns.index.tsx     → list at /app/refill/campaigns/
 *   - app.emma.campaigns.new.tsx       → template gallery at /new
 *   - app.emma.campaigns.$campaignId.tsx → detail
 *
 * Same nesting pattern as v341.3 / v342 — TanStack dot-routes mount
 * children as siblings of the parent's component if there's no Outlet.
 * Established 2026-05-15 (Promotions Engine Phase 1).
 */
import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/app/refill/campaigns")({
  component: CampaignsLayout,
});

function CampaignsLayout() {
  return <Outlet />;
}
