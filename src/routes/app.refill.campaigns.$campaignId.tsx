/**
 * /app/refill/campaigns/$campaignId — layout shell.
 *
 * Pure Outlet so children mount in place:
 *   - app.emma.campaigns.$campaignId.index.tsx → detail at /campaigns/$id/
 *   - app.emma.campaigns.$campaignId.blast.tsx → composer at /campaigns/$id/blast
 *
 * Same trap that bit v331 (lizzie) and v341.3 (emma index). Caught at v349
 * verification 2026-05-15: URL changes to /blast but detail page kept
 * rendering. TanStack file-routing treats dot-separated child names as
 * nested by default, so without this Outlet shell the child mounts
 * invisibly under the parent component.
 *
 * Established 2026-05-15.
 */
import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/app/refill/campaigns/$campaignId")({
  component: CampaignDetailLayout,
});

function CampaignDetailLayout() {
  return <Outlet />;
}
