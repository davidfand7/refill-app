/**
 * Programs & Tiers — Phase 2 of "ships fully loaded" (v2.132.0).
 *
 * The select-your-tier surface. Per-manufacturer loyalty programs: pick your
 * Portfolio Level + Brand Tiers and the catalog cost layer snaps to YOUR
 * economics (applyTenantTierSelection re-resolves tier_estimate rows only —
 * real portal/manual costs are never touched). Stub manufacturers render a
 * "coming soon — forward your price list" growth prompt. Plus "Load starter
 * catalog" (seedTenantCatalogFromMaster) so a spa boots fully loaded instead
 * of from a blank slate. Costs shown here are ESTIMATES until verified against
 * the spa's real portal "Your Price."
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, PackagePlus, Sparkles } from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { supabase } from "@/integrations/supabase/client";
import { useTenantMembership } from "@/lib/use-tenant-membership";
import {
  getManufacturerProgramsFn,
  getTenantTierSelectionsFn,
  applyTenantTierSelectionFn,
  seedTenantCatalogFromMasterFn,
  type VerifiedLadder,
} from "@/server/refill-catalog-seed";
import type { ManufacturerProgramTiers } from "@/lib/manufacturer-tier-resolver";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/refill/catalog/programs")({
  component: ProgramsPage,
});

type Program = {
  manufacturer: string;
  programName: string;
  status: string;
  tiers: ManufacturerProgramTiers;
};

type Draft = { portfolioLevel: string | null; brandTiers: Record<string, number> };

const MANUFACTURER_LABEL: Record<string, string> = {
  abbvie: "Allergan / AbbVie",
  galderma: "Galderma",
  merz: "Merz",
  evolus: "Evolus",
  revance: "Revance",
  rha: "RHA / Revance",
};

function mfrLabel(m: string): string {
  return MANUFACTURER_LABEL[m] ?? m.charAt(0).toUpperCase() + m.slice(1);
}

const inputCls =
  "w-full rounded-md border border-rule bg-white px-3 py-2 text-[14px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30";

/** Preferred display order for brand-family tier selectors (jsonb doesn't
 *  preserve key order; the two filler families a spa uses most go first). */
const FAMILY_ORDER = ["Hylacross", "Vycross", "Skincare", "Surgery"];
function orderedFamilies(families: Record<string, number[]>): Array<[string, number[]]> {
  return Object.entries(families).sort(
    ([a], [b]) => (FAMILY_ORDER.indexOf(a) + 1 || 99) - (FAMILY_ORDER.indexOf(b) + 1 || 99),
  );
}

function ProgramsPage() {
  const membership = useTenantMembership();
  const viewAsUserId =
    membership.status === "tenant" ? membership.viewAsUserId : undefined;

  const [loading, setLoading] = useState(true);
  const [seeding, setSeeding] = useState(false);
  const [applyingMfr, setApplyingMfr] = useState<string | null>(null);
  const [programs, setPrograms] = useState<Program[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  // manufacturer → { brand_family → verified ladder } (real portal prices).
  const [verifiedByMfr, setVerifiedByMfr] = useState<
    Record<string, Record<string, VerifiedLadder>>
  >({});

  async function token(): Promise<string> {
    const { data: sess } = await supabase.auth.getSession();
    const t = sess.session?.access_token;
    if (!t) throw new Error("Not signed in.");
    return t;
  }

  async function load() {
    setLoading(true);
    try {
      const t = await token();
      const [progs, sels] = await Promise.all([
        getManufacturerProgramsFn({ data: { accessToken: t, viewAsUserId } }),
        getTenantTierSelectionsFn({ data: { accessToken: t, viewAsUserId } }),
      ]);
      const selByMfr = new Map(sels.map((s) => [s.manufacturer, s.selection]));
      const verByMfr: Record<string, Record<string, VerifiedLadder>> = {};
      for (const s of sels) verByMfr[s.manufacturer] = s.verifiedLadders ?? {};
      const nextDrafts: Record<string, Draft> = {};
      for (const p of progs) {
        const sel = selByMfr.get(p.manufacturer);
        const brandTiers: Record<string, number> = {};
        if (sel?.brandTiers) {
          for (const [fam, tier] of Object.entries(sel.brandTiers)) {
            if (typeof tier === "number" && tier >= 1) brandTiers[fam] = tier;
          }
        }
        nextDrafts[p.manufacturer] = {
          portfolioLevel: sel?.portfolioLevel ?? null,
          brandTiers,
        };
      }
      setPrograms(progs as Program[]);
      setDrafts(nextDrafts);
      setVerifiedByMfr(verByMfr);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't load programs.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (membership.status !== "tenant") return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [membership.status, viewAsUserId]);

  async function onSeed() {
    if (seeding) return;
    setSeeding(true);
    try {
      const t = await token();
      const res = await seedTenantCatalogFromMasterFn({
        data: { accessToken: t, viewAsUserId },
      });
      toast.success(
        res.inserted > 0
          ? `Loaded ${res.inserted} products into your catalog.`
          : `Catalog already loaded (${res.skipped} products in place).`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't load catalog.");
    } finally {
      setSeeding(false);
    }
  }

  async function onApply(mfr: string) {
    if (applyingMfr) return;
    setApplyingMfr(mfr);
    try {
      const t = await token();
      const d = drafts[mfr] ?? { portfolioLevel: null, brandTiers: {} };
      const res = await applyTenantTierSelectionFn({
        data: {
          accessToken: t,
          viewAsUserId,
          manufacturer: mfr,
          selection: { portfolioLevel: d.portfolioLevel, brandTiers: d.brandTiers },
        },
      });
      toast.success(
        res.updated > 0
          ? `Tier applied — ${res.updated} product cost(s) updated.`
          : "Tier saved. (No estimate-priced products to update yet — load the catalog first.)",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't apply tier.");
    } finally {
      setApplyingMfr(null);
    }
  }

  function setPortfolio(mfr: string, level: string) {
    setDrafts((d) => ({
      ...d,
      [mfr]: { ...(d[mfr] ?? { portfolioLevel: null, brandTiers: {} }), portfolioLevel: level || null },
    }));
  }

  function setBrandTier(mfr: string, family: string, tier: number) {
    setDrafts((d) => {
      const cur = d[mfr] ?? { portfolioLevel: null, brandTiers: {} };
      const brandTiers = { ...cur.brandTiers };
      if (tier >= 1) brandTiers[family] = tier;
      else delete brandTiers[family];
      return { ...d, [mfr]: { ...cur, brandTiers } };
    });
  }

  const active = programs.filter((p) => p.status === "active");
  const stubs = programs.filter((p) => p.status !== "active");

  return (
    <div>
      <PageHeader
        title="Programs & tiers"
        description="Pick your loyalty tier with each manufacturer and the catalog cost layer snaps to your economics. These are estimates — once we pull your real portal 'Your Price,' that overrides them. Your real verified costs are never overwritten by a tier change."
      />

      <div className="border-b border-rule bg-paper/50">
        <div className="max-w-[960px] mx-auto px-4 lg:px-10 flex items-center gap-1">
          <Link
            to="/app/refill/catalog/services"
            className="inline-flex items-center gap-1.5 px-3 py-2 text-[12px] font-medium border-b-2 -mb-px border-transparent text-ink-soft hover:text-ink transition"
          >
            Services
          </Link>
          <Link
            to="/app/refill/catalog/products"
            className="inline-flex items-center gap-1.5 px-3 py-2 text-[12px] font-medium border-b-2 -mb-px border-transparent text-ink-soft hover:text-ink transition"
          >
            Products
          </Link>
          <Link
            to="/app/refill/catalog/brand-economics"
            className="inline-flex items-center gap-1.5 px-3 py-2 text-[12px] font-medium border-b-2 -mb-px border-transparent text-ink-soft hover:text-ink transition"
          >
            Brand economics
          </Link>
          <Link
            to="/app/refill/catalog/programs"
            className="inline-flex items-center gap-1.5 px-3 py-2 text-[12px] font-medium border-b-2 -mb-px border-emerald text-emerald-ink transition"
          >
            Programs &amp; tiers
          </Link>
          <Link
            to="/app/refill/catalog/verified-pricing"
            className="inline-flex items-center gap-1.5 px-3 py-2 text-[12px] font-medium border-b-2 -mb-px border-transparent text-ink-soft hover:text-ink transition"
          >
            Verified pricing
          </Link>
        </div>
      </div>

      <div className="px-6 lg:px-10 py-6 max-w-[960px] mx-auto space-y-6">
        {/* Starter catalog */}
        <div className="rounded-xl border border-rule bg-white px-5 py-4 flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <PackagePlus className="h-4 w-4 text-emerald-ink" />
              <h3 className="text-[15px] font-semibold text-ink">Starter catalog</h3>
            </div>
            <p className="mt-1 text-[13px] text-ink-soft leading-snug max-w-[560px]">
              Boot your catalog fully loaded with the manufacturer product book — real products,
              real list prices, packaging and treatment areas already filled in. Pick your tier
              below and costs resolve. Safe to re-run; it never duplicates or overwrites a verified cost.
            </p>
          </div>
          <button
            type="button"
            onClick={onSeed}
            disabled={seeding}
            className={cn(
              "shrink-0 inline-flex items-center gap-1.5 rounded-md bg-emerald px-4 py-2 text-[14px] font-semibold text-paper shadow-sm transition",
              seeding ? "opacity-60 cursor-wait" : "hover:opacity-95",
            )}
          >
            {seeding ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackagePlus className="h-4 w-4" />}
            {seeding ? "Loading…" : "Load starter catalog"}
          </button>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-ink-soft text-[13px] py-8 justify-center">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading programs…
          </div>
        ) : (
          <>
            {active.map((p) => {
              const d = drafts[p.manufacturer] ?? { portfolioLevel: null, brandTiers: {} };
              const levels = p.tiers.portfolioLevels ?? [];
              const families = p.tiers.brandFamilies ?? {};
              const isVolume = p.tiers.programType === "volume_tier";
              const ladders = Object.entries(p.tiers.productLadders ?? {});
              return (
                <div key={p.manufacturer} className="rounded-xl border border-rule bg-white overflow-hidden">
                  <div className="px-5 py-3 border-b border-rule bg-rule-soft/60 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <h3 className="text-[15px] font-semibold text-ink">{mfrLabel(p.manufacturer)}</h3>
                      <span className="text-[12px] text-ink-faint">{p.programName}</span>
                    </div>
                    <span className="inline-flex items-center rounded-full bg-emerald/10 text-emerald-ink px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider">
                      Active
                    </span>
                  </div>
                  <div className="px-5 py-4 space-y-4">
                    {isVolume && ladders.length > 0 && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {ladders.map(([family, ladder]) => {
                          const unit = ladder.unitType ?? "unit";
                          return (
                            <div key={family}>
                              <label className="text-[11px] uppercase tracking-wider font-semibold text-ink-faint mb-1.5 block">
                                {family} volume tier
                              </label>
                              <select
                                className={inputCls}
                                value={d.brandTiers[family] ?? 0}
                                onChange={(e) => setBrandTier(p.manufacturer, family, Number(e.target.value))}
                              >
                                <option value={0}>— select your tier —</option>
                                {ladder.tiers.map((step) => (
                                  <option key={step.tier} value={step.tier}>
                                    Tier {step.tier} — ${step.price}/{unit}
                                    {step.minUnits ? ` (${step.minUnits}+ ${unit}s)` : ""}
                                  </option>
                                ))}
                              </select>
                              {(() => {
                                const vl = verifiedByMfr[p.manufacturer]?.[family];
                                if (!vl || !vl.tiers?.length) return null;
                                return (
                                  <div className="mt-2 rounded-lg border border-emerald/30 bg-emerald-soft/30 px-3 py-2">
                                    <div className="flex items-center gap-1.5 mb-1">
                                      <span className="inline-flex items-center rounded-full bg-emerald/10 text-emerald-ink px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider">
                                        Verified
                                      </span>
                                      <span className="text-[11px] text-ink-soft">
                                        your real portal ladder
                                      </span>
                                    </div>
                                    <ul className="space-y-0.5">
                                      {vl.tiers.map((t, ti) => {
                                        const isCurrent =
                                          vl.currentPrice != null &&
                                          Math.abs(t.price - vl.currentPrice) < 0.005;
                                        return (
                                          <li
                                            key={ti}
                                            className={cn(
                                              "text-[11px] tabular-nums flex items-center justify-between gap-3",
                                              isCurrent
                                                ? "text-emerald-ink font-semibold"
                                                : "text-ink-soft",
                                            )}
                                          >
                                            <span>
                                              {t.qty ??
                                                (t.minUnits ? `${t.minUnits}+ ${unit}s` : "—")}
                                            </span>
                                            <span>
                                              ${t.price}/{unit}
                                              {isCurrent && <span className="ml-1">← yours</span>}
                                            </span>
                                          </li>
                                        );
                                      })}
                                    </ul>
                                  </div>
                                );
                              })()}
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {!isVolume && levels.length > 0 && (
                      <div>
                        <label className="text-[11px] uppercase tracking-wider font-semibold text-ink-faint mb-1.5 block">
                          Portfolio level
                        </label>
                        <select
                          className={inputCls}
                          value={d.portfolioLevel ?? ""}
                          onChange={(e) => setPortfolio(p.manufacturer, e.target.value)}
                        >
                          <option value="">— select —</option>
                          {levels.map((lv) => (
                            <option key={lv.key} value={lv.key}>
                              {lv.key} ({lv.discountPct}% off)
                            </option>
                          ))}
                        </select>
                      </div>
                    )}

                    {!isVolume && Object.keys(families).length > 0 && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {orderedFamilies(families).map(([family, schedule]) => (
                          <div key={family}>
                            <label className="text-[11px] uppercase tracking-wider font-semibold text-ink-faint mb-1.5 block">
                              {family} tier
                            </label>
                            <select
                              className={inputCls}
                              value={d.brandTiers[family] ?? 0}
                              onChange={(e) => setBrandTier(p.manufacturer, family, Number(e.target.value))}
                            >
                              <option value={0}>— none —</option>
                              {schedule.map((pct, i) => (
                                <option key={i} value={i + 1}>
                                  Tier {i + 1} ({pct}% off)
                                </option>
                              ))}
                            </select>
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="flex items-center justify-between pt-1">
                      <p className="text-[12px] text-ink-faint leading-snug max-w-[420px]">
                        {isVolume
                          ? "Your tier sets the per-unit price directly. Updates estimate-priced products only — your verified portal costs stay put."
                          : "Brand tier applied first, then portfolio. Updates estimate-priced products only — your verified portal costs stay put."}
                      </p>
                      <button
                        type="button"
                        onClick={() => onApply(p.manufacturer)}
                        disabled={applyingMfr === p.manufacturer}
                        className={cn(
                          "shrink-0 inline-flex items-center gap-1.5 rounded-md bg-emerald px-4 py-2 text-[14px] font-semibold text-paper shadow-sm transition",
                          applyingMfr === p.manufacturer ? "opacity-60 cursor-wait" : "hover:opacity-95",
                        )}
                      >
                        {applyingMfr === p.manufacturer ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Sparkles className="h-4 w-4" />
                        )}
                        {applyingMfr === p.manufacturer ? "Applying…" : "Apply tier"}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}

            {stubs.length > 0 && (
              <div className="rounded-xl border border-dashed border-rule bg-rule-soft/30 px-5 py-4">
                <h3 className="text-[13px] font-semibold text-ink-soft uppercase tracking-wider mb-3">
                  Coming soon
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {stubs.map((p) => (
                    <div key={p.manufacturer} className="rounded-lg border border-rule bg-white px-4 py-3">
                      <div className="text-[14px] font-semibold text-ink">{mfrLabel(p.manufacturer)}</div>
                      <div className="text-[12px] text-ink-faint">{p.programName}</div>
                      <p className="mt-1.5 text-[12px] text-ink-soft leading-snug">
                        Forward us a photo of your {mfrLabel(p.manufacturer)} price list and we'll load it —
                        products, pricing and tiers.
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
