/**
 * CostSourceBadge — estimate-vs-verified provenance pill (v2.135.0, Phase 2.2).
 *
 * Surfaces where a product's cost actually came from, so the owner trusts the
 * margin math: 'portal' (real "Your Price" pulled via vision) reads Verified,
 * 'tier_estimate' (computed from the loyalty tier) reads Estimate — a nudge to
 * verify against the real portal — and 'unset' (seed placeholder) reads Set
 * cost. 'manual' (owner-entered) is the silent baseline: no badge, no clutter.
 * Ties the catalog into the vision-ingestion-moat trust layer.
 */

import { cn } from "@/lib/utils";

const CONFIG: Record<string, { label: string; cls: string; title: string } | null> = {
  portal: {
    label: "Verified",
    cls: "bg-emerald/10 text-emerald-ink",
    title: "Verified — your real cost from the manufacturer portal (“Your Price”).",
  },
  tier_estimate: {
    label: "Estimate",
    cls: "bg-amber-soft text-amber-ink",
    title: "Estimate — computed from your selected loyalty tier. Verify against your portal “Your Price.”",
  },
  unset: {
    label: "Set cost",
    cls: "bg-rule-soft text-ink-soft",
    title: "Placeholder cost — set your real cost (or pick your tier on Programs & tiers).",
  },
  // Owner-entered = the trusted baseline; no badge keeps the list calm.
  manual: null,
};

export function CostSourceBadge({
  source,
  className,
}: {
  /** 'portal' | 'tier_estimate' | 'manual' | 'unset' (ProductCostSource);
   *  plain string so both the catalog Product and BrandEconomics can pass it.
   *  Unknown / 'manual' → no badge. */
  source: string;
  className?: string;
}) {
  const c = CONFIG[source];
  if (!c) return null;
  return (
    <span
      title={c.title}
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider",
        c.cls,
        className,
      )}
    >
      {c.label}
    </span>
  );
}
