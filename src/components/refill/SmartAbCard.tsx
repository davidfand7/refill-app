/**
 * SmartAbCard — "Let SmartSpa find your best version" (v2.96, crown-jewel UI).
 *
 * Create an A/B test on one of your services (2–4 variants that differ only in
 * the offer terms), then watch the impartial bandit shift reach toward whatever
 * books best and call the winner. The verdict view IS the magic: real bookings
 * decide, an AI measures, SmartSpa just reports — the impartiality that makes
 * the data sellable to manufacturers (project_manufacturer_ab_arbiter).
 *
 * Bookings populate the bandit via the push/booking path (next slice). Until
 * that's wired, the "Simulate bookings" button (owner-safe, clearly synthetic)
 * lets you see the whole loop work end-to-end without touching live data.
 *
 * Self-contained (accessToken prop) so it mounts as a Rewards card.
 */

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ChevronDown, FlaskConical, Loader2, Plus, Send, Sparkles, Trophy, X } from "lucide-react";

import {
  createAbExperiment,
  getAbVerdict,
  listAbExperiments,
  simulateAbRound,
  draftExperimentPush,
  type AbExperimentSummary,
  type AbVerdictResult,
} from "@/server/smart-ab.functions";
import { listServicesFn, type Service } from "@/server/refill-catalog";
import { groupServicesByCategory } from "@/lib/service-categories";
import { liftPhrase } from "@/lib/smart-ab";
import type { OfferType, OfferCohort } from "@/lib/promo-calendar";
import { cn } from "@/lib/utils";

/** The variant types the A/B composer offers (subset of OfferType). */
type OfferTypeForAb = "dollars_off" | "percent_off" | "free_addon";

type VariantDraft = { offerType: OfferTypeForAb; value: string; addon: string; label: string };

const TYPE_OPTIONS: Array<{ value: OfferTypeForAb; label: string }> = [
  { value: "dollars_off", label: "$ off" },
  { value: "percent_off", label: "% off" },
  { value: "free_addon", label: "Free add-on" },
];

const COHORTS: Array<{ value: OfferCohort; label: string }> = [
  { value: "all", label: "Everyone" },
  { value: "lapsed", label: "Lapsed" },
  { value: "new", label: "New" },
  { value: "expiring", label: "Expiring reward" },
];

function newVariant(): VariantDraft {
  return { offerType: "dollars_off", value: "", addon: "", label: "" };
}

export function SmartAbCard({
  accessToken,
  viewAsUserId,
  hideCreate = false,
  refreshKey,
}: {
  accessToken: string | null;
  viewAsUserId?: string;
  /** v2.100: create moved to the unified OfferComposer — this card then shows
   *  only the running tests + their verdicts (simulate / push / results). */
  hideCreate?: boolean;
  /** Bump to force a re-fetch (e.g. after the composer creates a test). */
  refreshKey?: number;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [open, setOpen] = useState(false);
  const [services, setServices] = useState<Service[]>([]);
  const [serviceName, setServiceName] = useState("");
  const [cohort, setCohort] = useState<OfferCohort>("all");
  const [variants, setVariants] = useState<VariantDraft[]>([newVariant(), newVariant()]);
  const [busy, setBusy] = useState(false);

  const [experiments, setExperiments] = useState<AbExperimentSummary[]>([]);
  const [verdicts, setVerdicts] = useState<Record<string, AbVerdictResult>>({});
  const [workingId, setWorkingId] = useState<string | null>(null);

  const loadVerdicts = useCallback(
    async (exps: AbExperimentSummary[]) => {
      if (!accessToken) return;
      const entries = await Promise.all(
        exps.map(async (e) => {
          try {
            const v = await getAbVerdict({
              data: { accessToken, viewAsUserId, experimentId: e.experimentId },
            });
            return [e.experimentId, v] as const;
          } catch {
            return null;
          }
        }),
      );
      setVerdicts((prev) => {
        const next = { ...prev };
        for (const en of entries) if (en) next[en[0]] = en[1];
        return next;
      });
    },
    [accessToken, viewAsUserId],
  );

  const load = useCallback(async () => {
    if (!accessToken) return;
    try {
      const [svc, exps] = await Promise.all([
        listServicesFn({ data: { accessToken, viewAsUserId } }).catch(() => [] as Service[]),
        listAbExperiments({ data: { accessToken, viewAsUserId } }),
      ]);
      setServices(svc.filter((s) => s.onlineBookable));
      setExperiments(exps);
      void loadVerdicts(exps);
    } catch {
      /* leave empty on error */
    }
  }, [accessToken, viewAsUserId, loadVerdicts]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  function setVariant(i: number, patch: Partial<VariantDraft>) {
    setVariants((prev) => prev.map((v, k) => (k === i ? { ...v, ...patch } : v)));
  }

  async function create() {
    if (!accessToken || !serviceName) {
      toast.error("Pick a service to test.");
      return;
    }
    const built = variants.map((v) => {
      const num = v.value.trim() ? Number(v.value.trim()) : null;
      return {
        offerType: v.offerType as OfferType,
        discountUsd: v.offerType === "dollars_off" ? num : null,
        valuePct: v.offerType === "percent_off" ? num : null,
        addonLabel: v.offerType === "free_addon" ? v.addon.trim() || null : null,
        label: v.label.trim() || undefined,
      };
    });
    // Friendly validation.
    for (const b of built) {
      if (b.offerType === "dollars_off" && (!b.discountUsd || b.discountUsd <= 0))
        return toast.error("Each $-off version needs a dollar amount.");
      if (b.offerType === "percent_off" && (!b.valuePct || b.valuePct <= 0 || b.valuePct > 100))
        return toast.error("Each %-off version needs a percentage (1–100).");
      if (b.offerType === "free_addon" && !b.addonLabel)
        return toast.error("Each free-add-on version needs an add-on name.");
    }
    setBusy(true);
    try {
      await createAbExperiment({
        data: { accessToken, viewAsUserId, serviceName, targetCohort: cohort, variants: built },
      });
      toast.success("Test created — SmartSpa will keep whichever version books best.");
      setOpen(false);
      setVariants([newVariant(), newVariant()]);
      setServiceName("");
      setCohort("all");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't create the test.");
    } finally {
      setBusy(false);
    }
  }

  async function simulate(experimentId: string) {
    if (!accessToken) return;
    setWorkingId(experimentId);
    try {
      await simulateAbRound({ data: { accessToken, viewAsUserId, experimentId, rounds: 40 } });
      const v = await getAbVerdict({ data: { accessToken, viewAsUserId, experimentId } });
      setVerdicts((prev) => ({ ...prev, [experimentId]: v }));
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't simulate.");
    } finally {
      setWorkingId(null);
    }
  }

  async function push(experimentId: string) {
    if (!accessToken) return;
    setWorkingId(experimentId);
    try {
      const res = await draftExperimentPush({ data: { accessToken, viewAsUserId, experimentId } });
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success(
        `Staged ${res.drafted} draft${res.drafted === 1 ? "" : "s"} to ${res.sentTo} — review & send in Messages. ${res.assignedNew} newly assigned a version.${res.skippedNoPhone ? ` (${res.skippedNoPhone} had no phone)` : ""}`,
      );
      const v = await getAbVerdict({ data: { accessToken, viewAsUserId, experimentId } });
      setVerdicts((prev) => ({ ...prev, [experimentId]: v }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't push the test.");
    } finally {
      setWorkingId(null);
    }
  }

  return (
    <div className="rounded-2xl border border-emerald/30 bg-emerald-soft/30 p-5">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="flex w-full items-center gap-2 text-sm font-semibold text-ink"
      >
        <FlaskConical className="h-4 w-4 text-emerald" />
        {hideCreate ? "Your tests" : "Let SmartSpa find your best version"}
        {experiments.length > 0 && (
          <span className="rounded-full bg-emerald-soft px-2 py-0.5 text-[10.5px] font-semibold text-emerald">
            {experiments.length}
          </span>
        )}
        <ChevronDown
          className={cn("ml-auto h-4 w-4 text-ink-faint transition-transform", collapsed && "-rotate-90")}
        />
      </button>

      {!collapsed && (
        <>
          {!hideCreate && (
          <p className="mt-2 text-[11px] text-ink-faint leading-relaxed">
            Test a few versions of an offer on the same patients. Real bookings
            decide the winner — an impartial AI bandit shifts toward whatever
            books best and keeps it. No math, no &ldquo;declare a winner.&rdquo;
          </p>
          )}

          {!hideCreate && (
          <div className="mt-3">
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              className="inline-flex items-center gap-1 text-[12px] font-semibold text-emerald hover:opacity-80"
            >
              <Plus className="h-3.5 w-3.5" />
              {open ? "Close" : "New test"}
            </button>
          </div>
          )}

          {!hideCreate && open && (
            <div className="mt-3 space-y-3 rounded-xl border border-rule bg-white p-3">
              <div>
                <Lbl>Service to test</Lbl>
                <select
                  value={serviceName}
                  onChange={(e) => setServiceName(e.target.value)}
                  disabled={services.length === 0}
                  className="w-full rounded border border-rule bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald/30 disabled:opacity-60"
                >
                  <option value="">Choose a service…</option>
                  {groupServicesByCategory(services).map((g) => (
                    <optgroup key={g.value} label={g.label}>
                      {g.items.map((s) => (
                        <option key={s.id} value={s.name}>
                          {s.displayName}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>

              <div>
                <Lbl>Who's it for?</Lbl>
                <div className="flex flex-wrap gap-1.5">
                  {COHORTS.map((c) => (
                    <button
                      key={c.value}
                      type="button"
                      onClick={() => setCohort(c.value)}
                      className={cn(
                        "rounded-full px-3 py-1 text-[12px] font-semibold border transition",
                        cohort === c.value
                          ? "bg-emerald text-paper border-emerald"
                          : "bg-white text-ink-soft border-rule hover:text-ink",
                      )}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <Lbl>Versions to test ({variants.length})</Lbl>
                <div className="space-y-2">
                  {variants.map((v, i) => (
                    <div key={i} className="flex flex-wrap items-center gap-1.5">
                      <select
                        value={v.offerType}
                        onChange={(e) => setVariant(i, { offerType: e.target.value as OfferTypeForAb })}
                        className="rounded border border-rule bg-white px-2 py-1.5 text-[12px] focus:outline-none focus:ring-2 focus:ring-emerald/30"
                      >
                        {TYPE_OPTIONS.map((t) => (
                          <option key={t.value} value={t.value}>
                            {t.label}
                          </option>
                        ))}
                      </select>
                      {v.offerType === "free_addon" ? (
                        <input
                          type="text"
                          value={v.addon}
                          onChange={(e) => setVariant(i, { addon: e.target.value })}
                          placeholder="brow wax"
                          className="w-28 rounded border border-rule bg-white px-2 py-1.5 text-[12px] focus:outline-none focus:ring-2 focus:ring-emerald/30"
                        />
                      ) : (
                        <input
                          type="number"
                          inputMode="decimal"
                          min="1"
                          value={v.value}
                          onChange={(e) => setVariant(i, { value: e.target.value })}
                          placeholder={v.offerType === "percent_off" ? "20" : "50"}
                          className="w-20 rounded border border-rule bg-white px-2 py-1.5 text-[12px] focus:outline-none focus:ring-2 focus:ring-emerald/30"
                        />
                      )}
                      <span className="text-[11px] text-ink-faint">
                        {v.offerType === "percent_off" ? "% off" : v.offerType === "free_addon" ? "free" : "$ off"}
                      </span>
                      {variants.length > 2 && (
                        <button
                          type="button"
                          onClick={() => setVariants((prev) => prev.filter((_, k) => k !== i))}
                          className="text-ink-faint hover:text-rose"
                          aria-label="Remove version"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                {variants.length < 4 && (
                  <button
                    type="button"
                    onClick={() => setVariants((prev) => [...prev, newVariant()])}
                    className="mt-2 inline-flex items-center gap-1 text-[12px] font-semibold text-emerald hover:opacity-80"
                  >
                    <Plus className="h-3.5 w-3.5" /> Add a version
                  </button>
                )}
              </div>

              <button
                type="button"
                onClick={() => void create()}
                disabled={busy || !serviceName}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald px-4 py-2 text-sm font-semibold text-paper shadow-sm hover:opacity-95 transition disabled:opacity-50"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                Start testing
              </button>
            </div>
          )}

          {experiments.length > 0 && (
            <div className="mt-4 space-y-3">
              {experiments.map((e) => (
                <VerdictView
                  key={e.experimentId}
                  exp={e}
                  result={verdicts[e.experimentId]}
                  working={workingId === e.experimentId}
                  onSimulate={() => void simulate(e.experimentId)}
                  onPush={() => void push(e.experimentId)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function VerdictView({
  exp,
  result,
  working,
  onSimulate,
  onPush,
}: {
  exp: AbExperimentSummary;
  result: AbVerdictResult | undefined;
  working: boolean;
  onSimulate: () => void;
  onPush: () => void;
}) {
  const v = result?.verdict;
  const decided = result?.status === "decided";
  const maxRate = v ? Math.max(0.001, ...v.arms.map((a) => a.rate)) : 1;
  const winnerId = result?.winnerOfferId ?? v?.best?.id ?? null;
  // Pushable = still running AND targeted to a cohort (an 'all' test runs on the
  // public booking page, where versions can't be split per patient).
  const pushable = (result?.status ?? exp.status) === "running" && exp.targetCohort !== "all";

  return (
    <div className="rounded-xl border border-rule bg-white px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-semibold text-ink truncate">
          {exp.baseLabel ?? "A/B test"}
        </span>
        {decided ? (
          <span className="rounded-full bg-emerald-soft px-2 py-0.5 text-[10px] font-semibold text-emerald">
            decided
          </span>
        ) : (
          <span className="rounded-full bg-amber-soft px-2 py-0.5 text-[10px] font-semibold text-amber">
            running
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {pushable && (
            <button
              type="button"
              onClick={onPush}
              disabled={working}
              title="Draft this test to your cohort — each patient gets one version; their booking is the vote"
              className="inline-flex items-center gap-1 rounded-md border border-emerald-ink/30 bg-emerald-soft px-2 py-0.5 text-[11px] font-semibold text-emerald hover:opacity-90 transition disabled:opacity-50"
            >
              {working ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
              Push test
            </button>
          )}
          <button
            type="button"
            onClick={onSimulate}
            disabled={working}
            title="Simulate bookings to see the bandit work (synthetic — no live data)"
            className="inline-flex items-center gap-1 rounded-md border border-rule px-2 py-0.5 text-[11px] font-semibold text-ink-soft hover:text-ink transition disabled:opacity-50"
          >
            {working ? <Loader2 className="h-3 w-3 animate-spin" /> : <FlaskConical className="h-3 w-3" />}
            Simulate
          </button>
        </div>
      </div>

      {v && v.best && (
        <div className="mt-2 flex items-start gap-2 text-[12.5px] text-ink-soft">
          <Trophy className="h-4 w-4 text-amber shrink-0 mt-0.5" />
          <span>
            <b className="text-emerald-ink">{v.best.label}</b>{" "}
            {decided ? "won" : "is ahead"} — it {liftPhrase(v.lift)}.{" "}
            <span className="text-ink-faint">
              {(v.confidence * 100).toFixed(0)}% likely the best
              {decided ? " — switched everyone to it." : `, ${v.totalConversions} bookings so far.`}
            </span>
          </span>
        </div>
      )}

      {v && (
        <div className="mt-3 space-y-1.5">
          {v.arms.map((a) => {
            const isWin = a.id === winnerId;
            return (
              <div key={a.id} className="grid grid-cols-[88px_1fr_84px] items-center gap-2">
                <span className={cn("text-[11.5px] font-semibold truncate", isWin ? "text-emerald-ink" : "text-ink-soft")}>
                  {a.label}
                </span>
                <div className="h-2.5 rounded-full bg-rule overflow-hidden">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.round((a.rate / maxRate) * 100)}%`,
                      background: isWin ? "#056048" : "#cdd0cb",
                    }}
                  />
                </div>
                <span className="text-[11px] text-ink-faint text-right tabular-nums">
                  {a.conversions}/{a.impressions} · {(a.winProb * 100).toFixed(0)}%
                </span>
              </div>
            );
          })}
          {v.totalImpressions === 0 && (
            <p className="text-[11px] text-ink-faint pt-1">
              No bookings yet. Once this offer is pushed, real bookings will fill these bars — or hit
              &ldquo;Simulate bookings&rdquo; to preview how the bandit calls it.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Lbl({ children }: { children: React.ReactNode }) {
  return (
    <label className="block text-[10px] font-semibold uppercase tracking-wider text-ink-soft mb-1">
      {children}
    </label>
  );
}
