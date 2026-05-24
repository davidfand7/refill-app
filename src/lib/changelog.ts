/**
 * Rolling product changelog for the version pill (rendered by PageHeader).
 *
 * Fresh start for the cleaved Refill app — openagenticv4's 3,691-line
 * history is not load-bearing here. Append a new entry to the top of
 * CHANGELOG for each Refill ship.
 */

export interface ChangelogEntry {
  version: string;
  date: string;
  items: string[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "v1.0",
    date: "May 2026",
    items: [
      "<strong>v1.0 &mdash; Refill cleave landed.</strong> Standalone repo + standalone Supabase + standalone CF Worker on getrefill.app. The 2-week cleave from openagenticv4 collapsed the cross-host auth bridge stack (set Site URL = getrefill.app, single cookie domain, zero shell stamping). 74 migrations ported, 90+ source files lifted, ~50 KLOC of bridge/product-context entanglement deleted by simplification.",
    ],
  },
];

export function currentVersion(): string {
  return CHANGELOG[0]?.version ?? "v1.0";
}
