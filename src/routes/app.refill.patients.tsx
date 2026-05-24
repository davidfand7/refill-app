/**
 * /app/refill/patients — layout shell.
 *
 * Pure Outlet so child routes mount in place:
 *   - app.emma.patients.index.tsx    → list at /app/refill/patients/
 *   - app.emma.patients.import.tsx   → drag-drop at /app/refill/patients/import
 *
 * Same trap v341.3 caught for app.emma.tsx: TanStack's file-routing nests
 * dot-separated names by default, so without this Outlet the import route
 * mounts invisibly under a sibling component. Established 2026-05-15.
 */
import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/app/refill/patients")({
  component: PatientsLayout,
});

function PatientsLayout() {
  return <Outlet />;
}
