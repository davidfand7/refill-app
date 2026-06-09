/**
 * /app/refill/settings/boulevard-install — back-compat redirect (v2.3.18 IA reorg).
 * PMS install wizards now live inside the Calendar Solution. Forwards the OAuth
 * `application_id` + `state` params so a stale bookmark hit mid-connect doesn't
 * drop them (v2.3.24).
 */
import { createFileRoute, Navigate, useSearch } from "@tanstack/react-router";

function RedirectToCalendarInstall() {
  const search = useSearch({ strict: false }) as {
    application_id?: string;
    state?: string;
  };
  return (
    <Navigate
      to="/app/refill/calendar/boulevard-install"
      search={{
        application_id:
          typeof search.application_id === "string" ? search.application_id : undefined,
        state: typeof search.state === "string" ? search.state : undefined,
      }}
      replace
    />
  );
}

export const Route = createFileRoute("/app/refill/settings/boulevard-install")({
  component: RedirectToCalendarInstall,
});
