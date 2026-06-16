/**
 * /app/refill — SmartSpa layout shell (v341.3).
 *
 * Pure layout file. Renders only an <Outlet/> so child routes mount in place:
 *   - app.emma.index.tsx   → dashboard at /app/refill/
 *   - app.emma.promos.tsx  → eligible promos at /app/refill/promos
 *
 * Why this exists: before v341.3, app.emma.tsx WAS the dashboard (full
 * KarenDashboard component, no Outlet). TanStack's file-routing treats
 * dot-separated names as nested by default, so /app/refill/promos mounted
 * invisibly while the dashboard kept occupying the screen. Visible
 * symptom (caught during v341 verification 2026-05-14): clicking Promos
 * in SpaOwnerShell nav → URL changed to /app/refill/promos but dashboard
 * content kept rendering. Same bug v331 caught for app.lizzie.tsx; same
 * fix — split the dashboard into app.emma.index.tsx (route `/app/refill/`)
 * and turn this file into a 3-line shell.
 *
 * The SmartSpa top-nav (Dashboard · Promos · Knowledge) lives in
 * SpaOwnerShell, mounted by app.tsx — so no extra chrome belongs here.
 */
import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/app/refill")({
  component: EmmaLayout,
});

function EmmaLayout() {
  return <Outlet />;
}
