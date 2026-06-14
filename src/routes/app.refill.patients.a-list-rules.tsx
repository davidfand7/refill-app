/**
 * /app/refill/patients/a-list-rules — A-list automation dashboard (v1.25.1).
 *
 * Spa-owner-facing power surface. Lets the owner define WHO counts as VIP
 * via numeric thresholds (lifetime spend, recency, visit count), preview
 * the count live, and bulk-apply vip=true in a single round trip.
 *
 * Design rules carried in:
 *   - Apply is ADDITIVE-ONLY. Manual stars set via the per-row VIP toggle
 *     on /app/refill/patients are never silently unstarred by Apply.
 *   - Clear is a separate destructive action with typed-confirm gate.
 *   - Per the steering-wheel rule (project_three_agent_architecture) this
 *     is power-user surface, NOT a Refill platform default — it lives off
 *     the patients page header, not the main chip nav.
 *
 * Established 2026-05-28.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Eye,
  Loader2,
  Star,
  Wand2,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { supabase } from "@/integrations/supabase/client";
import { useTenantMembership } from "@/lib/use-tenant-membership";
import {
  listPatients,
  setPatientVipBulk,
  type PatientListRow,
} from "@/server/patient-ingest.functions";
import {
  DEFAULT_A_LIST_RULES,
  getMyAListRules,
  saveAListRulesAndMarkApplied,
  type AListRules,
} from "@/server/user-prefs.functions";
import {
  getReliabilityFreshness,
  listReliabilityFlags,
  recomputeReliabilityNow,
  type ReliabilityFlag,
  type ReliabilityFreshness,
} from "@/server/emma-reliability.functions";
import { matchesAListRules } from "@/lib/a-list-rules";

export const Route = createFileRoute("/app/refill/patients/a-list-rules")({
  component: AListRulesPage,
});

// ─── Pure helpers ──────────────────────────────────────────────────────────

function formatCurrency(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

// ─── Component ─────────────────────────────────────────────────────────────

function AListRulesPage() {
  const [patients, setPatients] = useState<PatientListRow[] | null>(null);
  const [reliabilityFlags, setReliabilityFlags] = useState<ReliabilityFlag[]>(
    [],
  );
  const [rules, setRules] = useState<AListRules>(DEFAULT_A_LIST_RULES);
  const [savedRules, setSavedRules] = useState<AListRules | null>(null);
  const [lastAppliedAt, setLastAppliedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [applyOpen, setApplyOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearText, setClearText] = useState("");
  const [busy, setBusy] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [flaggedOpen, setFlaggedOpen] = useState(false);
  const [freshness, setFreshness] = useState<ReliabilityFreshness | null>(null);
  const [recomputing, setRecomputing] = useState(false);

  const membership = useTenantMembership();
  const viewAsUserId =
    membership.status === "tenant" ? membership.viewAsUserId : undefined;

  const loadAll = useCallback(async () => {
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        setErrorMessage("Please sign in to manage A-list rules.");
        setLoading(false);
        return;
      }
      const [patientsRes, rulesRes, flagsRes, freshnessRes] = await Promise.all(
        [
          listPatients({
            data: { accessToken: token, viewAsUserId, limit: 5000 },
          }),
          getMyAListRules({ data: { accessToken: token, viewAsUserId } }),
          listReliabilityFlags({
            data: { accessToken: token, viewAsUserId },
          }),
          getReliabilityFreshness({
            data: { accessToken: token, viewAsUserId },
          }),
        ],
      );
      setPatients(patientsRes);
      setRules(rulesRes.rules);
      setSavedRules(rulesRes.rules);
      setLastAppliedAt(rulesRes.lastAppliedAt);
      setReliabilityFlags(flagsRes);
      setFreshness(freshnessRes);
    } catch (e) {
      setErrorMessage(
        e instanceof Error ? e.message : "Couldn't load A-list dashboard.",
      );
    } finally {
      setLoading(false);
    }
  }, [viewAsUserId]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // ─── Derived state ───────────────────────────────────────────────────────

  // v1.26.5 hotfix: filter to 6mo-only here. v1.26.4 widened the server
  // WHERE to include lifetime-only patients (so the toggle could surface
  // lifetime totals), but the same widened set was being collapsed into
  // unreliableIds and fed into the rule, silently flipping rule semantics
  // from 6mo-strict to lifetime-inclusive. The rule has been 6mo-strict
  // since v1.25.4 — changing it requires conscious opt-in, not a side
  // effect of a data ship. Lifetime totals stay informational below.
  const unreliableIds = useMemo(
    () =>
      new Set(
        reliabilityFlags
          .filter((f) => f.cancellations6mo > 0 || f.noShows6mo > 0)
          .map((f) => f.patientNodeId),
      ),
    [reliabilityFlags],
  );

  const lifetimeOnlyCount = useMemo(
    () =>
      reliabilityFlags.filter(
        (f) =>
          f.cancellations6mo === 0 &&
          f.noShows6mo === 0 &&
          (f.cancellationsLifetime > 0 || f.noShowsLifetime > 0),
      ).length,
    [reliabilityFlags],
  );

  // v1.26.2 + v1.26.4: surface both the rolling 6mo split AND the lifetime
  // totals. The rule itself still filters on the 6mo window (in_recovery
  // semantics need recovery), but the lifetime number answers Karen's
  // original "have they ever cancelled?" question without changing rule
  // behavior. Real Karen Acuity data, last refresh: 6mo = 172 cancels / 2
  // no-shows; lifetime is whatever the latest backfill / sweep computed.
  const reliabilityTotals = useMemo(
    () =>
      reliabilityFlags.reduce(
        (acc, f) => ({
          cancellations: acc.cancellations + f.cancellations6mo,
          noShows: acc.noShows + f.noShows6mo,
          cancellationsLifetime:
            acc.cancellationsLifetime + f.cancellationsLifetime,
          noShowsLifetime: acc.noShowsLifetime + f.noShowsLifetime,
        }),
        {
          cancellations: 0,
          noShows: 0,
          cancellationsLifetime: 0,
          noShowsLifetime: 0,
        },
      ),
    [reliabilityFlags],
  );

  // The flagged patients, by name, for the drill-in list — so the operator can
  // eyeball it and recognize their problem clients (the trust-by-recognition
  // check). Joins the 6mo-flagged reliability rows to patient names, worst
  // first (cancels + no-shows).
  const flaggedList = useMemo(() => {
    if (!patients) return [];
    const byId = new Map(patients.map((p) => [p.id, p]));
    return reliabilityFlags
      .filter((f) => f.cancellations6mo > 0 || f.noShows6mo > 0)
      .map((f) => ({
        id: f.patientNodeId,
        name: byId.get(f.patientNodeId)?.displayName ?? "(unknown patient)",
        cancels: f.cancellations6mo,
        noShows: f.noShows6mo,
      }))
      .sort((a, b) => b.cancels + b.noShows - (a.cancels + a.noShows));
  }, [reliabilityFlags, patients]);

  const matchingIds = useMemo(() => {
    if (!patients) return new Set<string>();
    // Date.now() inside the memo body — stable across slider drags, refreshes
    // only when patients reload (after Apply/Clear).
    const todayMs = Date.now();
    return new Set(
      patients
        .filter((p) => matchesAListRules(p, rules, todayMs, unreliableIds))
        .map((p) => p.id),
    );
  }, [patients, rules, unreliableIds]);

  const currentVipIds = useMemo(() => {
    if (!patients) return new Set<string>();
    return new Set(patients.filter((p) => p.vip).map((p) => p.id));
  }, [patients]);

  const addIds = useMemo(
    () => [...matchingIds].filter((id) => !currentVipIds.has(id)),
    [matchingIds, currentVipIds],
  );

  const alreadyMatchingCount = useMemo(
    () => [...matchingIds].filter((id) => currentVipIds.has(id)).length,
    [matchingIds, currentVipIds],
  );

  const manualOnlyVipIds = useMemo(
    () => [...currentVipIds].filter((id) => !matchingIds.has(id)),
    [matchingIds, currentVipIds],
  );

  // v1.25.3: the prospective post-Apply A-list — everyone who would be vip
  // after clicking Apply (currently-vip preserved by additive design + new
  // additions from rules). Sorted by lifetime spend desc so highest-value
  // first matches how Karen thinks about her book.
  const previewRows = useMemo(() => {
    if (!patients) return [];
    return patients
      .filter((p) => matchingIds.has(p.id) || currentVipIds.has(p.id))
      .map((p) => {
        const matches = matchingIds.has(p.id);
        const wasVip = currentVipIds.has(p.id);
        const status: "kept-by-rule" | "would-add" | "manual-kept" = matches
          ? wasVip
            ? "kept-by-rule"
            : "would-add"
          : "manual-kept";
        return { patient: p, status };
      })
      .sort(
        (a, b) => b.patient.lifetimeSpendUsd - a.patient.lifetimeSpendUsd,
      );
  }, [patients, matchingIds, currentVipIds]);

  const totalPatients = patients?.length ?? 0;
  const totalMatching = matchingIds.size;
  const totalCurrentVip = currentVipIds.size;
  const isDirty =
    savedRules !== null && JSON.stringify(rules) !== JSON.stringify(savedRules);

  // ─── Handlers ────────────────────────────────────────────────────────────

  const handleApply = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Session expired — please sign in again.");

      const [bulkRes, saveRes] = await Promise.all([
        setPatientVipBulk({
          data: {
            accessToken: token,
            viewAsUserId,
            addIds,
            removeIds: [],
          },
        }),
        saveAListRulesAndMarkApplied({
          data: { accessToken: token, viewAsUserId, rules },
        }),
      ]);

      setSavedRules(saveRes.rules);
      setLastAppliedAt(saveRes.lastAppliedAt);
      setApplyOpen(false);
      toast.success(
        bulkRes.touched > 0
          ? `Added ${bulkRes.touched.toLocaleString()} patient${bulkRes.touched === 1 ? "" : "s"} to A-list.`
          : "Rules saved. No new patients matched.",
      );
      await loadAll();
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Couldn't apply A-list rules.",
      );
    } finally {
      setBusy(false);
    }
  }, [busy, addIds, rules, viewAsUserId, loadAll]);

  const handleClear = useCallback(async () => {
    if (busy || clearText !== "CLEAR") return;
    setBusy(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Session expired — please sign in again.");

      const removeIds = [...currentVipIds];
      const res = await setPatientVipBulk({
        data: {
          accessToken: token,
          viewAsUserId,
          addIds: [],
          removeIds,
        },
      });
      setClearOpen(false);
      setClearText("");
      toast.success(
        `Cleared ${res.touched.toLocaleString()} A-list flag${res.touched === 1 ? "" : "s"}.`,
      );
      await loadAll();
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Couldn't clear A-list flags.",
      );
    } finally {
      setBusy(false);
    }
  }, [busy, clearText, currentVipIds, viewAsUserId, loadAll]);

  // v1.26.9 — manual tier recompute. The daily cron at 02:00 UTC normally
  // refreshes tiers, but after a bulk Acuity ingest the counts are fresh
  // while tier stays stale until the next cron run. This button forces a
  // bulk sweep immediately (single RPC + bulk in-memory tier compute, no
  // per-patient round-trip).
  const handleRecompute = useCallback(async () => {
    if (recomputing) return;
    setRecomputing(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Session expired — please sign in again.");

      const res = await recomputeReliabilityNow({
        data: { accessToken: token, viewAsUserId },
      });

      // v1.26.10 — also stash the run result into freshness.lastRun so the
      // freshness card updates immediately to "X patients · N transitions"
      // without waiting for loadAll(). loadAll() runs anyway below and will
      // reconcile from emma_reliability_runs.
      setFreshness({
        latestRecomputedAt: res.completedAt,
        patientsTracked: res.patientsRecomputed,
        lastRun: {
          completedAt: res.completedAt,
          patientsRecomputed: res.patientsRecomputed,
          transitions: res.transitions,
          trigger: "manual",
        },
      });

      toast.success(
        res.transitions > 0
          ? `Recomputed ${res.patientsRecomputed.toLocaleString()} patient${res.patientsRecomputed === 1 ? "" : "s"} · ${res.transitions} tier transition${res.transitions === 1 ? "" : "s"}.`
          : `Recomputed ${res.patientsRecomputed.toLocaleString()} patient${res.patientsRecomputed === 1 ? "" : "s"} · no tier changes.`,
      );

      // Reload so the flagged counts pick up any new in_recovery patients.
      await loadAll();
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Couldn't recompute reliability.",
      );
    } finally {
      setRecomputing(false);
    }
  }, [recomputing, viewAsUserId, loadAll]);

  // ─── Render ──────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-5 w-5 animate-spin text-ink-faint" />
      </div>
    );
  }

  if (errorMessage) {
    return (
      <div className="px-6 lg:px-10 py-12 max-w-3xl mx-auto">
        <div className="rounded-xl border border-amber/40 bg-amber/5 px-5 py-4 text-sm text-ink">
          {errorMessage}
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="A-list rules"
        description={
          patients
            ? `Define who counts as VIP. ${totalPatients.toLocaleString()} patients in your book.`
            : undefined
        }
        actions={
          <Link
            to="/app/refill/patients"
            className="inline-flex items-center gap-1.5 rounded-lg border border-rule bg-white px-3 py-1.5 text-xs font-medium hover:bg-rule-soft transition"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to patients
          </Link>
        }
      />

      <div className="px-6 lg:px-10 py-6 space-y-6 max-w-[960px] mx-auto">
        {/* Rules form */}
        <section className="rounded-2xl border border-rule bg-white p-6 space-y-5">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-base font-semibold text-ink">Rules</h2>
            {isDirty && (
              <span className="text-[11px] font-medium text-amber inline-flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" />
                Unsaved changes
              </span>
            )}
          </div>

          <RuleRow
            label="Lifetime spend"
            comparator="≥"
            valueDisplay={
              rules.lifetimeSpendMinUsd === null
                ? "any"
                : formatCurrency(rules.lifetimeSpendMinUsd)
            }
            enabled={rules.lifetimeSpendMinUsd !== null}
            onToggle={(on) =>
              setRules((r) => ({ ...r, lifetimeSpendMinUsd: on ? 1000 : null }))
            }
            sliderMin={0}
            sliderMax={10000}
            sliderStep={100}
            sliderValue={rules.lifetimeSpendMinUsd ?? 1000}
            onSliderChange={(n) =>
              setRules((r) => ({ ...r, lifetimeSpendMinUsd: n }))
            }
          />

          <RuleRow
            label="Last visit within"
            comparator=""
            valueDisplay={
              rules.lastVisitWithinDays === null
                ? "any time"
                : `${rules.lastVisitWithinDays} day${rules.lastVisitWithinDays === 1 ? "" : "s"}`
            }
            enabled={rules.lastVisitWithinDays !== null}
            onToggle={(on) =>
              setRules((r) => ({ ...r, lastVisitWithinDays: on ? 365 : null }))
            }
            sliderMin={30}
            sliderMax={1095}
            sliderStep={30}
            sliderValue={rules.lastVisitWithinDays ?? 365}
            onSliderChange={(n) =>
              setRules((r) => ({ ...r, lastVisitWithinDays: n }))
            }
          />

          <RuleRow
            label="Total visits"
            comparator="≥"
            valueDisplay={
              rules.totalVisitsMin === null
                ? "any"
                : `${rules.totalVisitsMin}`
            }
            enabled={rules.totalVisitsMin !== null}
            onToggle={(on) =>
              setRules((r) => ({ ...r, totalVisitsMin: on ? 3 : null }))
            }
            sliderMin={1}
            sliderMax={50}
            sliderStep={1}
            sliderValue={rules.totalVisitsMin ?? 3}
            onSliderChange={(n) =>
              setRules((r) => ({ ...r, totalVisitsMin: n }))
            }
          />

          <div className="pt-2 border-t border-rule/60 space-y-2.5">
            <label className="flex items-center gap-2.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={rules.excludeBanned}
                onChange={(e) =>
                  setRules((r) => ({ ...r, excludeBanned: e.target.checked }))
                }
                className="h-4 w-4 rounded border-rule"
              />
              <span className="text-sm text-ink">
                Exclude banned patients
              </span>
            </label>

            <label className="flex items-start gap-2.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={rules.excludeUnreliable}
                onChange={(e) =>
                  setRules((r) => ({
                    ...r,
                    excludeUnreliable: e.target.checked,
                  }))
                }
                className="h-4 w-4 rounded border-rule mt-0.5"
              />
              <span className="text-sm text-ink leading-tight">
                Exclude cancellation history{" "}
                <span className="text-ink-faint text-[12px]">
                  (last 6 months &middot;{" "}
                  {unreliableIds.size.toLocaleString()} flagged &middot;{" "}
                  {reliabilityTotals.cancellations.toLocaleString()} cancel
                  {reliabilityTotals.cancellations === 1 ? "" : "s"} /{" "}
                  {reliabilityTotals.noShows.toLocaleString()} no-show
                  {reliabilityTotals.noShows === 1 ? "" : "s"})
                </span>
                <span className="block text-ink-faint text-[12px] mt-0.5">
                  Lifetime across all patients:{" "}
                  {reliabilityTotals.cancellationsLifetime.toLocaleString()}{" "}
                  cancel
                  {reliabilityTotals.cancellationsLifetime === 1 ? "" : "s"} /{" "}
                  {reliabilityTotals.noShowsLifetime.toLocaleString()} no-show
                  {reliabilityTotals.noShowsLifetime === 1 ? "" : "s"}
                  {lifetimeOnlyCount > 0 && (
                    <>
                      {" "}&middot; {lifetimeOnlyCount.toLocaleString()} more
                      patient{lifetimeOnlyCount === 1 ? "" : "s"} with older
                      history outside the 6mo window (not excluded by this
                      rule)
                    </>
                  )}
                </span>
              </span>
            </label>

            {/* Drill-in: see exactly WHO is flagged (trust by recognition —
                operators know their problem clients by name). Outside the label
                so it never toggles the rule. */}
            {flaggedList.length > 0 && (
              <div className="pl-6">
                <button
                  type="button"
                  onClick={() => setFlaggedOpen((o) => !o)}
                  className="inline-flex items-center gap-1 text-[12px] font-semibold text-emerald hover:opacity-80"
                >
                  <Eye className="h-3.5 w-3.5" />
                  {flaggedOpen ? "Hide" : "View"} the {flaggedList.length.toLocaleString()} flagged
                  patient{flaggedList.length === 1 ? "" : "s"}
                  {flaggedOpen ? (
                    <ChevronUp className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5" />
                  )}
                </button>
                {flaggedOpen && (
                  <ul className="mt-2 max-h-72 overflow-y-auto rounded-lg border border-rule bg-white divide-y divide-rule">
                    {flaggedList.map((f) => (
                      <li
                        key={f.id}
                        className="flex items-center gap-2 px-3 py-1.5 text-[12.5px]"
                      >
                        <span className="font-medium text-ink">{f.name}</span>
                        <span className="ml-auto text-ink-faint">
                          {f.cancels > 0 && (
                            <>
                              {f.cancels} cancel{f.cancels === 1 ? "" : "s"}
                            </>
                          )}
                          {f.cancels > 0 && f.noShows > 0 && " · "}
                          {f.noShows > 0 && (
                            <span className="text-rose">
                              {f.noShows} no-show{f.noShows === 1 ? "" : "s"}
                            </span>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </section>

        {/* Preview card */}
        <section className="rounded-2xl border border-rule bg-paper p-6">
          <div className="flex items-baseline justify-between gap-3 mb-4">
            <h2 className="text-base font-semibold text-ink">Preview</h2>
            {lastAppliedAt && (
              <span className="text-[11px] text-ink-faint">
                Last applied{" "}
                {new Date(lastAppliedAt).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </span>
            )}
          </div>

          <div className="text-[28px] leading-tight font-semibold text-ink mb-1 tabular-nums">
            {totalMatching.toLocaleString()}{" "}
            <span className="text-ink-faint font-normal">
              of {totalPatients.toLocaleString()}
            </span>
          </div>
          <p className="text-sm text-ink-soft mb-5">
            patients match your rules.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
            <StatChip
              icon={<CheckCircle2 className="h-3.5 w-3.5" />}
              tone="green"
              label="Already A-list"
              value={alreadyMatchingCount}
            />
            <StatChip
              icon={<Wand2 className="h-3.5 w-3.5" />}
              tone="blue"
              label="Would be added"
              value={addIds.length}
            />
            <StatChip
              icon={<Star className="h-3.5 w-3.5" />}
              tone="amber"
              label="Manual stars preserved"
              value={manualOnlyVipIds.length}
              hint={
                manualOnlyVipIds.length > 0
                  ? "Manually starred patients who don't match these rules — kept as A-list."
                  : undefined
              }
            />
          </div>
        </section>

        {/* Action row */}
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={busy || addIds.length === 0}
            onClick={() => setApplyOpen(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-paper hover:opacity-90 transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Wand2 className="h-4 w-4" />
            {addIds.length === 0
              ? "Nothing to add"
              : `Apply rules (${addIds.length.toLocaleString()})`}
          </button>

          <button
            type="button"
            disabled={busy || previewRows.length === 0}
            onClick={() => setPreviewOpen((o) => !o)}
            className="inline-flex items-center gap-2 rounded-lg border border-rule bg-white px-4 py-2.5 text-sm font-medium text-ink-soft hover:bg-rule-soft hover:text-ink transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Eye className="h-4 w-4" />
            {previewOpen ? "Hide preview" : "Preview list"}
            {previewOpen ? (
              <ChevronUp className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
          </button>

          <button
            type="button"
            disabled={busy || totalCurrentVip === 0}
            onClick={() => {
              setClearText("");
              setClearOpen(true);
            }}
            className="inline-flex items-center gap-2 rounded-lg border border-rule bg-white px-4 py-2.5 text-sm font-medium text-ink-soft hover:bg-rule-soft hover:text-ink transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Clear all A-list flags
          </button>
        </div>

        {/* Preview list (toggled) */}
        {previewOpen && (
          <section className="rounded-2xl border border-rule bg-white overflow-hidden">
            <div className="px-5 py-3.5 border-b border-rule flex items-baseline justify-between gap-3 bg-rule/30">
              <div>
                <h2 className="text-sm font-semibold text-ink">
                  A-list after apply
                </h2>
                <p className="text-[11px] text-ink-soft mt-0.5">
                  Sorted by lifetime spend. Manual stars stay even when they
                  don&rsquo;t match the rules.
                </p>
              </div>
              <span className="text-[11px] tabular-nums text-ink-soft">
                {previewRows.length.toLocaleString()} patient
                {previewRows.length === 1 ? "" : "s"}
              </span>
            </div>
            {previewRows.length === 0 ? (
              <div className="px-5 py-8 text-center text-sm text-ink-soft">
                No patients would be A-list under these rules.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-rule/20">
                    <tr className="text-left text-[10px] uppercase tracking-wider text-ink-soft">
                      <th className="px-4 py-2.5 font-semibold">Patient</th>
                      <th className="px-4 py-2.5 font-semibold">Last visit</th>
                      <th className="px-4 py-2.5 font-semibold text-right">
                        Visits
                      </th>
                      <th className="px-4 py-2.5 font-semibold text-right">
                        Lifetime spend
                      </th>
                      <th className="px-4 py-2.5 font-semibold text-center">
                        Status
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-rule">
                    {previewRows.map(({ patient, status }) => (
                      <PreviewRow
                        key={patient.id}
                        patient={patient}
                        status={status}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {/* v1.26.9 — Reliability data freshness + manual recompute.
            v1.26.10 — last-sweep result (patients + transitions + trigger)
            now persists via emma_reliability_runs and survives reload. */}
        <section className="rounded-2xl border border-rule bg-paper p-5">
          <div className="flex items-baseline justify-between gap-3 mb-2">
            <h2 className="text-sm font-semibold text-ink">
              Reliability data
            </h2>
            <button
              type="button"
              disabled={recomputing}
              onClick={() => void handleRecompute()}
              className="inline-flex items-center gap-1.5 rounded-md border border-rule bg-white px-2.5 py-1 text-[12px] font-medium text-ink-soft hover:bg-rule-soft hover:text-ink transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {recomputing ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Recomputing&hellip;
                </>
              ) : (
                "Recompute now"
              )}
            </button>
          </div>
          <p className="text-[12px] text-ink-soft leading-relaxed">
            Tiers (trusted / regular / vip / in-recovery) recompute nightly at
            2&thinsp;AM&nbsp;UTC. The flagged-count above already reflects the
            latest counts; this button forces a tier sweep too &mdash; useful
            after a bulk Acuity import.
          </p>
          <FreshnessLastRun freshness={freshness} />
        </section>
      </div>

      {/* Apply confirm */}
      <Dialog open={applyOpen} onOpenChange={(o) => !busy && setApplyOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Apply A-list rules</DialogTitle>
            <DialogDescription>
              This will mark{" "}
              <strong className="text-ink">
                {addIds.length.toLocaleString()} patient
                {addIds.length === 1 ? "" : "s"}
              </strong>{" "}
              as A-list.{" "}
              {alreadyMatchingCount > 0 && (
                <>
                  {alreadyMatchingCount.toLocaleString()} already are.
                </>
              )}{" "}
              {manualOnlyVipIds.length > 0 && (
                <>
                  Your {manualOnlyVipIds.length.toLocaleString()} manually
                  starred patient{manualOnlyVipIds.length === 1 ? "" : "s"} will
                  stay A-list.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              type="button"
              disabled={busy}
              onClick={() => setApplyOpen(false)}
              className="inline-flex items-center rounded-lg border border-rule bg-white px-4 py-2 text-sm text-ink-soft hover:bg-rule-soft transition disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={handleApply}
              className="inline-flex items-center gap-1.5 rounded-lg bg-ink px-4 py-2 text-sm font-medium text-paper hover:opacity-90 transition disabled:opacity-40"
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Apply
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Clear confirm */}
      <Dialog open={clearOpen} onOpenChange={(o) => !busy && setClearOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clear all A-list flags?</DialogTitle>
            <DialogDescription>
              This removes the A-list flag from{" "}
              <strong className="text-ink">
                {totalCurrentVip.toLocaleString()} patient
                {totalCurrentVip === 1 ? "" : "s"}
              </strong>
              , including any you manually starred. Your rules stay saved — you
              can re-apply anytime.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 pt-1">
            <label className="text-xs font-medium text-ink-soft">
              Type CLEAR to confirm
            </label>
            <input
              type="text"
              value={clearText}
              onChange={(e) => setClearText(e.target.value)}
              autoFocus
              className="w-full rounded-lg border border-input bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="CLEAR"
            />
          </div>
          <DialogFooter>
            <button
              type="button"
              disabled={busy}
              onClick={() => setClearOpen(false)}
              className="inline-flex items-center rounded-lg border border-rule bg-white px-4 py-2 text-sm text-ink-soft hover:bg-rule-soft transition disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy || clearText !== "CLEAR"}
              onClick={handleClear}
              className="inline-flex items-center gap-1.5 rounded-lg bg-amber px-4 py-2 text-sm font-medium text-paper hover:opacity-90 transition disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Clear all flags
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Subcomponents ─────────────────────────────────────────────────────────

function RuleRow({
  label,
  comparator,
  valueDisplay,
  enabled,
  onToggle,
  sliderMin,
  sliderMax,
  sliderStep,
  sliderValue,
  onSliderChange,
}: {
  label: string;
  comparator: string;
  valueDisplay: string;
  enabled: boolean;
  onToggle: (on: boolean) => void;
  sliderMin: number;
  sliderMax: number;
  sliderStep: number;
  sliderValue: number;
  onSliderChange: (n: number) => void;
}) {
  return (
    <div className={enabled ? "" : "opacity-50"}>
      <div className="flex items-center justify-between gap-3 mb-2">
        <label className="inline-flex items-center gap-2.5 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onToggle(e.target.checked)}
            className="h-4 w-4 rounded border-rule"
          />
          <span className="text-sm text-ink font-medium">
            {label}{" "}
            {comparator && (
              <span className="text-ink-faint">{comparator}</span>
            )}
          </span>
        </label>
        <span className="text-sm tabular-nums text-ink-soft">
          {valueDisplay}
        </span>
      </div>
      <input
        type="range"
        min={sliderMin}
        max={sliderMax}
        step={sliderStep}
        value={sliderValue}
        disabled={!enabled}
        onChange={(e) => onSliderChange(Number(e.target.value))}
        className="w-full accent-ink disabled:cursor-not-allowed"
      />
    </div>
  );
}

function PreviewRow({
  patient,
  status,
}: {
  patient: PatientListRow;
  status: "kept-by-rule" | "would-add" | "manual-kept";
}) {
  const lastVisitLabel = patient.lastVisit
    ? new Date(patient.lastVisit).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "—";
  const statusMeta =
    status === "kept-by-rule"
      ? {
          label: "Already A-list",
          chip: "bg-emerald-50 text-emerald-700 border-emerald-200",
          icon: <CheckCircle2 className="h-3 w-3" />,
        }
      : status === "would-add"
        ? {
            label: "Would be added",
            chip: "bg-sky-50 text-sky-700 border-sky-200",
            icon: <Wand2 className="h-3 w-3" />,
          }
        : {
            label: "Manual star",
            chip: "bg-amber/10 text-amber border-amber/30",
            icon: <Star className="h-3 w-3" />,
          };
  return (
    <tr className="hover:bg-rule-soft/40 transition">
      <td className="px-4 py-2.5">
        <Link
          to="/app/refill/patients/$patientId"
          params={{ patientId: patient.id }}
          className="font-medium text-ink hover:text-emerald-700 transition"
        >
          {patient.displayName}
        </Link>
      </td>
      <td className="px-4 py-2.5 text-ink-soft">{lastVisitLabel}</td>
      <td className="px-4 py-2.5 text-right tabular-nums text-ink-soft">
        {patient.totalVisits.toLocaleString()}
      </td>
      <td className="px-4 py-2.5 text-right tabular-nums font-medium text-ink">
        {formatCurrency(patient.lifetimeSpendUsd)}
      </td>
      <td className="px-4 py-2.5 text-center">
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium border ${statusMeta.chip}`}
        >
          {statusMeta.icon}
          {statusMeta.label}
        </span>
      </td>
    </tr>
  );
}

// v1.26.10 — persistent last-sweep surface. Replaces the toast-only window
// after a Recompute now click. Reads from emma_reliability_runs via
// getReliabilityFreshness; falls back to a "never" line on a fresh tenant
// that hasn't been swept since the v1.26.10 deploy. The "no tier changes"
// case is explicit so a successful sweep that found nothing to flip doesn't
// look like the card is broken.
function FreshnessLastRun({
  freshness,
}: {
  freshness: ReliabilityFreshness | null;
}) {
  if (!freshness) return null;

  const whenLabel = freshness.latestRecomputedAt
    ? new Date(freshness.latestRecomputedAt).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "never";
  const trackedLabel =
    freshness.patientsTracked > 0
      ? `${freshness.patientsTracked.toLocaleString()} patient${freshness.patientsTracked === 1 ? "" : "s"} tracked`
      : null;

  const run = freshness.lastRun;

  return (
    <div className="mt-3 space-y-1.5">
      <p className="text-[12px] text-ink-faint tabular-nums">
        Last computed: {whenLabel}
        {trackedLabel && <> &middot; {trackedLabel}</>}
      </p>
      {run && (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="inline-flex items-center gap-1 rounded-md border border-rule bg-white px-2 py-0.5 tabular-nums text-ink-soft">
            <span className="font-semibold text-ink">
              {run.patientsRecomputed.toLocaleString()}
            </span>
            <span>patient{run.patientsRecomputed === 1 ? "" : "s"} swept</span>
          </span>
          <span
            className={
              "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 tabular-nums " +
              (run.transitions > 0
                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                : "border-rule bg-white text-ink-soft")
            }
          >
            <span className="font-semibold">
              {run.transitions.toLocaleString()}
            </span>
            <span>
              tier transition{run.transitions === 1 ? "" : "s"}
              {run.transitions === 0 && " (no tier changes)"}
            </span>
          </span>
          <span
            className={
              "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide " +
              (run.trigger === "manual"
                ? "border-sky-200 bg-sky-50 text-sky-700"
                : "border-rule bg-rule/30 text-ink-soft")
            }
          >
            {run.trigger === "manual" ? "Manual" : "Nightly cron"}
          </span>
        </div>
      )}
    </div>
  );
}

function StatChip({
  icon,
  tone,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  tone: "green" | "blue" | "amber";
  label: string;
  value: number;
  hint?: string;
}) {
  const toneClasses =
    tone === "green"
      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
      : tone === "blue"
        ? "bg-sky-50 text-sky-700 border-sky-200"
        : "bg-amber/10 text-amber border-amber/30";
  return (
    <div
      className={`rounded-xl border px-3.5 py-3 ${toneClasses}`}
      title={hint}
    >
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide opacity-80">
        {icon}
        {label}
      </div>
      <div className="text-xl font-semibold mt-1 tabular-nums">
        {value.toLocaleString()}
      </div>
    </div>
  );
}
