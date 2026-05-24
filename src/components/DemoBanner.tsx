/**
 * DemoBanner — fixed top banner shown across every page while in demo mode.
 *
 * Visible by design: the rep must always know whether they're looking at
 * their own data or the showcase tenant's. Color picked to be unmissable
 * without being alarming (amber, not red).
 *
 * The banner is the canonical exit affordance — one click returns the rep
 * to their territory. There is no "are you sure" gate; demo mode is purely
 * client-side state and switching back is instant.
 */
import { useDemoMode } from "@/lib/demo-mode";
import { Sparkles, X } from "lucide-react";

export function DemoBanner() {
  const { isDemo, disableDemo } = useDemoMode();
  if (!isDemo) return null;
  return (
    <div className="sticky top-0 z-50 w-full bg-amber-500/95 backdrop-blur text-amber-950 border-b border-amber-600">
      <div className="max-w-screen-2xl mx-auto px-4 py-2 flex items-center gap-3">
        <Sparkles className="h-4 w-4 flex-shrink-0" />
        <div className="flex-1 min-w-0 text-[13px] leading-tight">
          <span className="font-semibold">Viewing demo data.</span>{" "}
          <span className="opacity-90">
            This is what your territory will look like with real data loaded.
            Notes &amp; sends are disabled.
          </span>
        </div>
        <button
          type="button"
          onClick={disableDemo}
          className="inline-flex items-center gap-1 text-[12px] font-medium px-2.5 py-1 rounded-full bg-amber-950/10 hover:bg-amber-950/20 transition"
          aria-label="Exit demo mode"
        >
          <X className="h-3 w-3" />
          Exit demo
        </button>
      </div>
    </div>
  );
}
