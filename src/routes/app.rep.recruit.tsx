/**
 * /app/rep/recruit — retired in v1.47.0 P3a.
 *
 * Rep-to-rep recruiting moved into the unified outreach page as the
 * "Recruits" tab (audience='rep'), side-by-side with "Prospects" (spa).
 * Everything that lived here — recruit template library, live-stat chips,
 * share-link affordance, rep-voice From line, purpose='rep_recruit' tracking
 * — is now the Recruits tab on /app/rep/outreach. This route redirects there
 * so existing links / nav chips / bookmarks keep working.
 */

import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/app/rep/recruit")({
  beforeLoad: () => {
    throw redirect({
      to: "/app/rep/outreach",
      search: { tab: "recruits" },
    });
  },
});
