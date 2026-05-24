/**
 * /app/rep — Lizzie(OS) layout shell (v331).
 *
 * Pure layout file. Renders only an <Outlet/> so child routes mount in place:
 *   - app.lizzie.index.tsx   → chat at /app/rep/
 *   - app.lizzie.today.tsx   → /app/rep/today
 *   - app.lizzie.sends.tsx   → /app/rep/sends
 *   - app.lizzie.accounts.tsx + app.lizzie.accounts.$accountId.tsx
 *   - app.lizzie.diag.tsx    → /app/rep/diag
 *
 * Why this exists: before v331, app.lizzie.tsx WAS the chat (full LizChat
 * component, no Outlet). TanStack's file-routing treats dot-separated names
 * as nested by default, so accounts/today/sends were all "children" of the
 * chat — they mounted invisibly while the chat kept occupying the screen.
 * Visible symptom: click Accounts → URL changed to /app/rep/accounts but
 * chat content kept rendering. v331 split the chat into app.lizzie.index.tsx
 * (route `/app/rep/`) and turned this file into a 3-line shell.
 *
 * The Lizzie(OS) top-nav (Liz · Accounts · Knowledge) lives in RepShell,
 * mounted by app.tsx — so no extra chrome belongs here.
 */
import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/app/rep")({
  component: LizzieLayout,
});

function LizzieLayout() {
  return <Outlet />;
}
