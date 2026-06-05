/**
 * DemoNav — guided walkthrough controller for the PUBLIC marketing surfaces.
 *
 * v1.46.6: Grasshopper wanted a bottom-right "Next" arrow so the public pages
 * can be presented as a linear demo instead of standalone screens. Mounted
 * ONCE in __root.tsx (the public pages share no layout, so per-page mounting
 * would be six copies). Renders ONLY when the current path is in WALKTHROUGH
 * below — invisible on the app shell, login, unsubscribe, and everywhere else,
 * because findIndex returns -1 and the component bails to null.
 *
 * To reorder / add / remove a stop: edit the WALKTHROUGH array. That's the
 * single source of truth for the demo sequence.
 *
 * Beyond the bare Next arrow Grasshopper asked for, this adds a subtle Back
 * chevron + an "N / total" step counter so a live demo is bidirectional and
 * the audience can see where they are in the flow.
 */

import { Link, useLocation } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight } from "lucide-react";

// v1.46.7: the arrow mirrors the real conversion funnel so it never fights a
// page's own primary CTA. The landing's big button already goes / → /scan, so
// the arrow does too. /story is NOT a funnel step — it's the why-narrative
// branch, reachable via the "Our Story →" header link on the landing, and it
// flows back into /scan via its own header CTA. Keeping it out of this array
// means no two-different-next-steps-on-one-screen confusion in a demo.
const WALKTHROUGH = [
  { path: "/", label: "Home" },
  { path: "/scan", label: "Scan" },
  { path: "/start", label: "Start" },
  { path: "/claim-your-business", label: "Claim" },
] as const;

export function DemoNav() {
  const location = useLocation();
  const idx = WALKTHROUGH.findIndex((s) => s.path === location.pathname);

  // Not a walkthrough page → render nothing (keeps it off /app, /login, etc.)
  if (idx === -1) return null;

  const prev = idx > 0 ? WALKTHROUGH[idx - 1] : null;
  const next = idx < WALKTHROUGH.length - 1 ? WALKTHROUGH[idx + 1] : null;

  return (
    <div className="fixed bottom-6 right-6 z-40 flex items-center gap-2">
      {prev && (
        <Link
          to={prev.path}
          aria-label={`Back: ${prev.label}`}
          title={`Back: ${prev.label}`}
          className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-border-soft bg-paper text-emerald shadow-md transition hover:bg-emerald-soft"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
      )}

      <span className="select-none rounded-full border border-border-soft bg-paper/90 px-2.5 py-1 text-xs font-medium text-ink-soft shadow-sm backdrop-blur">
        {idx + 1} / {WALKTHROUGH.length}
      </span>

      {next ? (
        <Link
          to={next.path}
          aria-label={`Next: ${next.label}`}
          title={`Next: ${next.label}`}
          className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-emerald px-5 text-paper shadow-lg transition hover:bg-emerald/90"
        >
          <span className="text-sm font-semibold">Next</span>
          <ArrowRight className="h-5 w-5" />
        </Link>
      ) : (
        <span className="inline-flex h-12 select-none items-center justify-center rounded-full bg-emerald-soft px-5 text-sm font-semibold text-emerald shadow-sm">
          End of tour
        </span>
      )}
    </div>
  );
}
