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
    version: "v1.2",
    date: "May 2026",
    items: [
      "<strong>v1.2 &mdash; /scan funnel sharpening (CSV-export polish + Acuity live-mode upgrade).</strong> Original Task #3 was framed as &lsquo;pivot /scan to OAuth-first&rsquo;, but a scout pass surfaced that OAuth-at-the-door conflicts with the trojan-horse stealth-widget posture (asking for OAuth before proving value is exactly what incumbent PMS partners fear). Split the two problems: (1) CSV-export friction &mdash; new inline guide picker beneath the drop zone lets a non-tech spa owner pick their scheduler and see verified export steps (5 platforms with confirmed paths, the other 19 fall through to a generic fallback per the no-fabrication rule); (2) post-receipt OAuth upgrade &mdash; when the parsed dialect resolves to Acuity (deterministic OR AI-mapped), the bottom CTA swaps from generic /start framing to &lsquo;Connect Acuity for live mode&rsquo; with explicit pass-through to /start?detected=acuity. Non-Acuity users get a heads-up line that live-mode for their platform is on the roadmap. Architecture memorialized in project_scan_trojan_horse_architecture.",
    ],
  },
  {
    version: "v1.1",
    date: "May 2026",
    items: [
      "<strong>v1.1 &mdash; RefillShell routing fixes (Karen dry-run prep).</strong> Pre-walk code-audit surfaced 4 hard 404s in the spa-owner shell: Billing nav chip, Billing quick-action card, header gear icon, and the active-chip derive all pointed at top-level routes that don&rsquo;t exist (the nested /app/refill/* convention is the established one). Rewired so a first-time owner click on Billing or Settings lands on the right page.",
    ],
  },
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
