/**
 * /app/refill/settings/booker-install — back-compat redirect (v2.3.18 IA reorg).
 * PMS install wizards now live inside the Calendar Solution. Forwards the OAuth
 * `state` param so a stale bookmark hit mid-connect doesn't drop it (v2.3.24).
 */
import { createFileRoute, Navigate, useSearch } from "@tanstack/react-router";

function RedirectToCalendarInstall() {
  const search = useSearch({ strict: false }) as { state?: string };
  return (
    <Navigate
      to="/app/refill/calendar/booker-install"
      search={{ state: typeof search.state === "string" ? search.state : undefined }}
      replace
    />
  );
}

export const Route = createFileRoute("/app/refill/settings/booker-install")({
  component: RedirectToCalendarInstall,
});
