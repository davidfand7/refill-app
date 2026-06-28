/**
 * WhatYouReallyPayCard — promotional-pricing / switch-math (v2.203.0, Phase 3).
 *
 * The "official tier price is a lie of omission" surface. Reuses the existing
 * brand-economics engine (getBrandEconomics) and the pure switch-math lib to
 * show, per substitutable group, the real EFFECTIVE cost + margin side-by-side,
 * which brand wins, and what incentive would close the gap (break-even on free
 * units) — and whether that edge is sustained or one-time. Lives on Buying →
 * Tiers; links to the full Brand Economics table for the deep dive.
 */

import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Loader2, Scale, ArrowRight, AlertTriangle } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { useTenantMembership } from "@/lib/use-tenant-membership";
import { getBrandEconomics } from "@/server/refill-brand-economics.functions";
import {
  groupBrandEconomics,
  computeSwitchMath,
  type SwitchVerdict,
} from "@/lib/switch-math";
import { cn } from "@/lib/utils";

function usd(n: number): string {
  return `$${Math.round(n).toLocaleString()}`;
}

export function WhatYouReallyPayCard() {
  const membership = useTenantMembership();
  const viewAsUserId =
    membership.status === "tenant" ? membership.viewAsUserId : undefined;
  const [verdicts, setVerdicts] = useState<SwitchVerdict[] | null>(null);

  const load = useCallback(async () => {
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) return;
      const bundle = await getBrandEconomics({
        data: { accessToken: token, viewAsUserId },
      });
      const groups = groupBrandEconomics(bundle.economics);
      const vs = groups
        .map(computeSwitchMath)
        // only groups with at least two priced brands are a real switch decision
        .filter((v) => v.brands.filter((b) => b.priced).length >= 2);
      setVerdicts(vs);
    } catch {
      setVerdicts([]); // best-effort; never break the page
    }
  }, [viewAsUserId]);

  useEffect(() => {
    if (membership.status === "loading") return;
    void load();
  }, [membership.status, load]);

  // Stay quiet until there's something worth saying.
  if (verdicts !== null && verdicts.length === 0) return null;

  return (
    <section className="rounded-2xl border border-rule bg-white">
      <header className="px-5 py-3 border-b border-rule bg-rule-soft/60 flex items-center gap-2">
        <Scale className="h-3.5 w-3.5 text-ink-soft" />
        <div className="text-xs font-semibold uppercase tracking-wider text-ink-soft">
          What you really pay
        </div>
        <div className="ml-auto text-[10px] text-ink-faint italic">
          effective cost = tier − incentive
        </div>
      </header>

      {verdicts === null ? (
        <div className="flex items-center justify-center py-10 text-sm text-ink-soft">
          <Loader2 className="h-4 w-4 animate-spin mr-2" />
          Loading…
        </div>
      ) : (
        <div className="divide-y divide-rule">
          {verdicts.map((v) => (
            <VerdictBlock key={v.key} v={v} />
          ))}
          <div className="px-5 py-3">
            <Link
              to="/app/refill/catalog/brand-economics"
              className="inline-flex items-center gap-1 text-[12px] font-medium text-emerald-ink hover:underline"
            >
              Open full Brand economics <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>
      )}
    </section>
  );
}

function VerdictBlock({ v }: { v: SwitchVerdict }) {
  return (
    <div className="px-5 py-4">
      <div className="text-[12px] font-semibold text-ink mb-2">{v.label}</div>
      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px] min-w-[520px]">
          <thead>
            <tr className="text-left text-ink-faint">
              <Th>Brand</Th>
              <Th right>Official</Th>
              <Th right>Incentive</Th>
              <Th right>Effective</Th>
              <Th right>Retail</Th>
              <Th right>Margin now</Th>
            </tr>
          </thead>
          <tbody>
            {v.brands.map((b) => (
              <tr key={b.brand} className="border-t border-rule/60">
                <td className="py-1.5 pr-2">
                  <span className="font-medium text-ink">{b.brand}</span>
                  {b.isBest && (
                    <span className="ml-1.5 inline-flex items-center rounded-full bg-emerald-soft px-1.5 py-0.5 text-[9px] font-bold text-emerald-ink">
                      BEST
                    </span>
                  )}
                  {b.costSource !== "portal" && b.costSource !== "manual" && (
                    <span className="ml-1 text-[10px] text-ink-faint">est</span>
                  )}
                </td>
                {b.priced ? (
                  <>
                    <Td right>{usd(b.officialCostPerUnit)}</Td>
                    <Td right>
                      {b.spaIncentivePerUnit > 0 ? (
                        <span className="text-amber">
                          −{usd(b.spaIncentivePerUnit)}
                          {b.reliesOnOneTime && (
                            <span className="ml-1 text-[9px] font-semibold">1×</span>
                          )}
                        </span>
                      ) : (
                        <span className="text-ink-faint">—</span>
                      )}
                    </Td>
                    <Td right>
                      <span className="font-semibold">{usd(b.effectiveCostPerUnit)}</span>
                    </Td>
                    <Td right>{usd(b.retailPerUnit)}</Td>
                    <Td right>
                      <span className={cn("font-semibold", b.isBest && "text-emerald-ink")}>
                        {usd(b.marginNowPerUnit)}
                      </span>
                      {b.marginNowPct != null && (
                        <span className="text-ink-faint">
                          {" "}
                          ({Math.round(b.marginNowPct * 100)}%)
                        </span>
                      )}
                    </Td>
                  </>
                ) : (
                  <td colSpan={5} className="py-1.5 text-right text-[11px] text-ink-faint italic">
                    pricing incomplete — set a retail price in Catalog
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* switch verdict */}
      {v.matchups.length > 0 && v.best && (
        <div className="mt-2 space-y-1">
          {v.matchups.map((m) => (
            <p key={m.brand} className="text-[12px] text-ink-soft leading-snug">
              <span className="font-semibold text-ink">{m.brand}</span> needs{" "}
              {m.rationalized ? (
                <>
                  <span className="font-semibold">
                    ~{m.rationalized.free} free per {m.rationalized.paid} bought
                  </span>{" "}
                </>
              ) : (
                <>${Math.round(m.gapPerUnit)}/unit of incentive </>
              )}
              to match <span className="font-semibold text-emerald-ink">{v.best!.brand}</span>
              {m.rationalized && (
                <span className="text-ink-faint"> · must be standing, not one-time</span>
              )}
            </p>
          ))}
          {v.bestReliesOnOneTime && (
            <p className="text-[11px] text-amber flex items-center gap-1">
              <AlertTriangle className="h-3 w-3 shrink-0" />
              {v.best.brand}'s edge rides a one-time incentive — it reverts when
              that stops.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th
      className={cn(
        "py-1 text-[10px] font-semibold uppercase tracking-wider",
        right ? "text-right pl-2" : "pr-2",
      )}
    >
      {children}
    </th>
  );
}
function Td({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <td className={cn("py-1.5 tabular-nums", right ? "text-right pl-2" : "pr-2")}>
      {children}
    </td>
  );
}
