/**
 * /app/refill/agents/recognition — Recognition Allocation Engine operator
 * surface (v1.34.5).
 *
 * The 4th Refill agent. Per project_recognition_allocation_engine_spec:
 *   - Reads rebate inventory + manufacturer profiles + patient summaries
 *   - Splits available units across three cohorts (Loyal Vintage 40% /
 *     Top-Decile Current 40% / At-Risk 20%) — Karen-adjustable
 *   - Outputs allocation suggestions Karen confirms one-by-one
 *
 * v1.34.5 ships the engine + scoring + UI; v1.34.8 wires iMessage MCP
 * dispatch. Two-step flow: Confirm a suggestion to lock in the allocation
 * (decrements rebate inventory), then Dispatch via iMessage in the header
 * to send the batch as iMessage drafts to the spa's proxy email. The
 * Karen-Mac MCP picks up the email + drafts each in Messages.app; Karen
 * reviews + taps Send. Status: Pending → Confirmed → Dispatched.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  Award,
  CheckCircle2,
  Heart,
  Loader2,
  MessageSquareText,
  Play,
  Save,
  Send,
  Sparkles,
  TrendingDown,
  X,
} from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { AgentsTabStrip } from "@/components/refill/AgentsTabStrip";
import { supabase } from "@/integrations/supabase/client";
import { useTenantMembership } from "@/lib/use-tenant-membership";
import {
  confirmAllocationSuggestion,
  dismissAllocationSuggestion,
  dispatchAllocationBatch,
  getAllocationSettings,
  listAllocationSuggestions,
  runAllocation,
  updateAllocationSettings,
  type AllocationSettings,
  type AllocationSuggestion,
  type Cohort,
} from "@/server/refill-recognition-allocation.functions";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/refill/agents/recognition")({
  component: RecognitionAgentPage,
});

const COHORT_LABELS: Record<Cohort, string> = {
  loyal_vintage: "Loyal Vintage",
  top_decile_current: "Top-Decile Current",
  at_risk: "At-Risk",
};

const COHORT_DESCRIPTIONS: Record<Cohort, string> = {
  loyal_vintage: "Long-tenure clients still active. Celebration of relationship.",
  top_decile_current: "Top 10% YTD spenders. Celebration of impact.",
  at_risk: "Slipping engagement. Personal check-in with reason to come back.",
};

const COHORT_ICONS: Record<Cohort, typeof Heart> = {
  loyal_vintage: Heart,
  top_decile_current: Sparkles,
  at_risk: TrendingDown,
};

function RecognitionAgentPage() {
  const membership = useTenantMembership();
  const viewAsUserId =
    membership.status === "tenant" ? membership.viewAsUserId : undefined;

  const [settings, setSettings] = useState<AllocationSettings | null>(null);
  const [suggestions, setSuggestions] = useState<AllocationSuggestion[]>([]);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [savingSplit, setSavingSplit] = useState(false);

  const [draftLoyal, setDraftLoyal] = useState("");
  const [draftTopDecile, setDraftTopDecile] = useState("");
  const [draftAtRisk, setDraftAtRisk] = useState("");
  const [draftCooldown, setDraftCooldown] = useState("");
  const [draftTpls, setDraftTpls] = useState({
    loyal_vintage: "",
    top_decile_current: "",
    at_risk: "",
  });
  const [savingTemplates, setSavingTemplates] = useState(false);
  const [dispatching, setDispatching] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        setLoadError("Please sign in.");
        return;
      }
      const [s, list] = await Promise.all([
        getAllocationSettings({ data: { accessToken: token, viewAsUserId } }),
        listAllocationSuggestions({
          data: { accessToken: token, viewAsUserId },
        }),
      ]);
      setSettings(s);
      setSuggestions(list);
      setAccessToken(token);
      setDraftLoyal(String(s.splitLoyalVintagePct));
      setDraftTopDecile(String(s.splitTopDecileCurrentPct));
      setDraftAtRisk(String(s.splitAtRiskPct));
      setDraftCooldown(String(s.cooldownMonths));
      setDraftTpls({
        loyal_vintage: s.templates.loyal_vintage,
        top_decile_current: s.templates.top_decile_current,
        at_risk: s.templates.at_risk,
      });
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Couldn't load.");
    }
  }, [viewAsUserId]);

  useEffect(() => {
    if (membership.status === "loading") return;
    void load();
  }, [membership.status, load]);

  const pendingSuggestions = useMemo(
    () => suggestions.filter((s) => s.status === "pending"),
    [suggestions],
  );

  const perCohortCounts = useMemo(() => {
    const out: Record<Cohort, number> = {
      loyal_vintage: 0,
      top_decile_current: 0,
      at_risk: 0,
    };
    for (const s of pendingSuggestions) out[s.cohort] += 1;
    return out;
  }, [pendingSuggestions]);

  async function saveSplit() {
    const l = parseInt(draftLoyal, 10);
    const t = parseInt(draftTopDecile, 10);
    const a = parseInt(draftAtRisk, 10);
    const c = parseInt(draftCooldown, 10);
    if (
      !Number.isFinite(l) ||
      !Number.isFinite(t) ||
      !Number.isFinite(a) ||
      !Number.isFinite(c)
    ) {
      toast.error("Splits + cooldown must be numbers.");
      return;
    }
    if (l + t + a !== 100) {
      toast.error(`Splits must sum to 100 (got ${l + t + a}).`);
      return;
    }
    if (c < 0 || c > 36) {
      toast.error("Cooldown must be 0-36 months.");
      return;
    }
    setSavingSplit(true);
    try {
      const updated = await updateAllocationSettings({
        data: {
          accessToken: accessToken!,
          viewAsUserId,
          splitLoyalVintagePct: l,
          splitTopDecileCurrentPct: t,
          splitAtRiskPct: a,
          cooldownMonths: c,
        },
      });
      setSettings(updated);
      toast.success("Split saved.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setSavingSplit(false);
    }
  }

  async function handleRunAllocation() {
    if (!accessToken) return;
    setRunning(true);
    try {
      const result = await runAllocation({
        data: { accessToken, viewAsUserId },
      });
      if (result.generated === 0) {
        toast.warning(result.noOpReason ?? "Nothing to allocate.");
      } else {
        toast.success(
          `${result.generated} suggestion${result.generated === 1 ? "" : "s"} generated (${result.inventoryUsed} units).`,
        );
        // Reload suggestions
        const list = await listAllocationSuggestions({
          data: { accessToken, viewAsUserId },
        });
        setSuggestions(list);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Allocation failed.");
    } finally {
      setRunning(false);
    }
  }

  async function handleConfirm(s: AllocationSuggestion) {
    if (!accessToken) return;
    try {
      const updated = await confirmAllocationSuggestion({
        data: { accessToken, viewAsUserId, id: s.id },
      });
      setSuggestions((prev) => prev.map((x) => (x.id === s.id ? updated : x)));
      toast.success(`${s.brand} → ${s.patientDisplayName} confirmed.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Confirm failed.");
    }
  }

  async function handleDismiss(s: AllocationSuggestion) {
    if (!accessToken) return;
    try {
      const updated = await dismissAllocationSuggestion({
        data: { accessToken, viewAsUserId, id: s.id },
      });
      setSuggestions((prev) => prev.map((x) => (x.id === s.id ? updated : x)));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Dismiss failed.");
    }
  }

  async function saveTemplates() {
    if (!accessToken) return;
    setSavingTemplates(true);
    try {
      const updated = await updateAllocationSettings({
        data: {
          accessToken,
          viewAsUserId,
          templates: draftTpls,
        },
      });
      setSettings(updated);
      toast.success("Templates saved.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setSavingTemplates(false);
    }
  }

  async function dispatchConfirmed() {
    if (!accessToken) return;
    const confirmedIds = suggestions
      .filter((s) => s.status === "confirmed")
      .map((s) => s.id);
    if (confirmedIds.length === 0) {
      toast.warning("Confirm at least one suggestion to dispatch.");
      return;
    }
    setDispatching(true);
    try {
      const result = await dispatchAllocationBatch({
        data: {
          accessToken,
          viewAsUserId,
          suggestionIds: confirmedIds.slice(0, 50),
        },
      });
      if (result.sendError) {
        toast.error(`Dispatch failed: ${result.sendError}`);
      } else {
        toast.success(
          `${result.drafted} iMessage draft${result.drafted === 1 ? "" : "s"} sent to your proxy email${result.skipped > 0 ? ` (${result.skipped} skipped — no phone)` : ""}.`,
        );
        const list = await listAllocationSuggestions({
          data: { accessToken, viewAsUserId },
        });
        setSuggestions(list);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Dispatch failed.");
    } finally {
      setDispatching(false);
    }
  }

  const confirmedCount = useMemo(
    () => suggestions.filter((s) => s.status === "confirmed").length,
    [suggestions],
  );

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <PageHeader
        title="Recognition Agent"
        eyebrow="Agents"
        description="Selectively allocates manufacturer rebate units to the patients who'll recognize being chosen."
        breadcrumbs={[
          { label: "Refill", to: "/app/refill" },
          { label: "Agents", to: "/app/refill/agents/preshow" },
          { label: "Recognition" },
        ]}
        actions={
          <div className="flex items-center gap-2">
            {confirmedCount > 0 && (
              <button
                type="button"
                onClick={() => void dispatchConfirmed()}
                disabled={dispatching || !accessToken}
                className="inline-flex items-center gap-1.5 rounded-lg border border-emerald/30 bg-emerald-soft text-emerald-ink px-3 py-1.5 text-xs font-semibold hover:bg-emerald hover:text-paper transition disabled:opacity-50"
              >
                {dispatching ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Send className="h-3.5 w-3.5" />
                )}
                Dispatch {confirmedCount} via iMessage
              </button>
            )}
            <button
              type="button"
              onClick={() => void handleRunAllocation()}
              disabled={running || !accessToken}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald px-3 py-1.5 text-xs font-semibold text-paper shadow-sm hover:opacity-95 transition disabled:opacity-50"
            >
              {running ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
              {running ? "Allocating…" : "Run allocation"}
            </button>
          </div>
        }
      />
      <AgentsTabStrip active="recognition" />

      <div className="flex-1 px-4 py-6 lg:px-10 max-w-[960px] w-full mx-auto space-y-5">
        {loadError ? (
          <div className="rounded-2xl border border-rose/30 bg-rose-soft p-5 text-sm">
            <div className="font-semibold text-rose">Couldn't load Recognition</div>
            <p className="text-xs text-ink-soft mt-1">{loadError}</p>
          </div>
        ) : !settings ? (
          <div className="flex items-center justify-center text-sm text-ink-soft py-16">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            Loading…
          </div>
        ) : (
          <>
            {/* Top-level explainer */}
            <section className="rounded-2xl border border-emerald/30 bg-emerald-soft/40 px-5 py-4 flex gap-3">
              <Award className="h-5 w-5 text-emerald-ink shrink-0 mt-0.5" />
              <div className="text-[12px] text-ink">
                <strong>Recognition, not discounts.</strong> Recognition mechanics
                <em> select silently</em> → patients discover they were chosen
                → spas reinforce existing good behavior. Public specials pages,
                loyalty points, and refer-a-friend cash incentives are{" "}
                <strong>not</strong> this engine — those would turn it into a
                discount mechanic. See{" "}
                <Link
                  to="/app/refill/recognition/inventory"
                  className="underline hover:text-emerald-ink"
                >
                  Inventory
                </Link>{" "}
                +{" "}
                <Link
                  to="/app/refill/recognition/manufacturers"
                  className="underline hover:text-emerald-ink"
                >
                  Manufacturer profiles
                </Link>
                .
              </div>
            </section>

            {/* Pending suggestions overview */}
            <section className="rounded-2xl border border-rule bg-white">
              <header className="px-5 py-3 border-b border-rule bg-rule-soft/60 flex items-center gap-2">
                <Sparkles className="h-3.5 w-3.5 text-ink-soft" />
                <div className="text-xs font-semibold uppercase tracking-wider text-ink-soft">
                  Pending allocations
                </div>
                <div className="ml-auto text-[11px] text-ink-soft">
                  {pendingSuggestions.length} pending
                </div>
              </header>
              <div className="grid grid-cols-3 divide-x divide-rule">
                {(Object.keys(COHORT_LABELS) as Cohort[]).map((c) => {
                  const Icon = COHORT_ICONS[c];
                  return (
                    <div key={c} className="px-4 py-3">
                      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
                        <Icon className="h-3 w-3" />
                        {COHORT_LABELS[c]}
                      </div>
                      <div className="text-2xl font-semibold text-ink mt-0.5">
                        {perCohortCounts[c]}
                      </div>
                      <p className="text-[10px] text-ink-faint mt-0.5 leading-tight">
                        {COHORT_DESCRIPTIONS[c]}
                      </p>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* Cohort split */}
            <section className="rounded-2xl border border-rule bg-white">
              <header className="px-5 py-3 border-b border-rule bg-rule-soft/60 flex items-center gap-2">
                <Award className="h-3.5 w-3.5 text-ink-soft" />
                <div className="text-xs font-semibold uppercase tracking-wider text-ink-soft">
                  Cohort split + cooldown
                </div>
                <div className="ml-auto text-[10px] text-ink-faint italic">
                  Must sum to 100
                </div>
              </header>
              <div className="px-5 py-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
                <SplitInput
                  label="Loyal Vintage %"
                  value={draftLoyal}
                  onChange={setDraftLoyal}
                />
                <SplitInput
                  label="Top-Decile %"
                  value={draftTopDecile}
                  onChange={setDraftTopDecile}
                />
                <SplitInput
                  label="At-Risk %"
                  value={draftAtRisk}
                  onChange={setDraftAtRisk}
                />
                <SplitInput
                  label="Cooldown (months)"
                  value={draftCooldown}
                  onChange={setDraftCooldown}
                />
                <div className="col-span-2 sm:col-span-4">
                  <button
                    type="button"
                    onClick={() => void saveSplit()}
                    disabled={savingSplit}
                    className="inline-flex items-center gap-1.5 rounded-md bg-emerald px-3 py-1.5 text-[12px] font-semibold text-paper shadow-sm hover:opacity-95 transition disabled:opacity-50"
                  >
                    {savingSplit ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Save className="h-3 w-3" />
                    )}
                    Save split
                  </button>
                </div>
              </div>
            </section>

            {/* v1.34.x: Per-cohort iMessage templates */}
            <section className="rounded-2xl border border-rule bg-white">
              <header className="px-5 py-3 border-b border-rule bg-rule-soft/60 flex items-center gap-2">
                <MessageSquareText className="h-3.5 w-3.5 text-ink-soft" />
                <div className="text-xs font-semibold uppercase tracking-wider text-ink-soft">
                  iMessage templates per cohort
                </div>
                <div className="ml-auto text-[10px] text-ink-faint italic">
                  Karen-voice; variable substitution
                </div>
              </header>
              <div className="px-5 py-4 space-y-3">
                {(Object.keys(COHORT_LABELS) as Cohort[]).map((c) => (
                  <div key={c}>
                    <label className="block text-[10px] font-semibold uppercase tracking-wider text-ink-soft mb-1">
                      {COHORT_LABELS[c]}
                    </label>
                    <textarea
                      value={draftTpls[c]}
                      onChange={(e) =>
                        setDraftTpls((prev) => ({ ...prev, [c]: e.target.value }))
                      }
                      className="w-full h-20 rounded border border-rule bg-white px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-emerald/30"
                    />
                  </div>
                ))}
                <p className="text-[10px] text-ink-faint">
                  Variables: <code>{"{{firstName}}"}</code> /{" "}
                  <code>{"{{brand}}"}</code> / <code>{"{{units}}"}</code> /{" "}
                  <code>{"{{spaName}}"}</code> / <code>{"{{manufacturer}}"}</code>.
                  Templates compose into iMessage drafts that route via your
                  proxy email → Claude Desktop iMessage MCP → Messages.app.
                </p>
                <button
                  type="button"
                  onClick={() => void saveTemplates()}
                  disabled={savingTemplates}
                  className="inline-flex items-center gap-1.5 rounded-md bg-emerald px-3 py-1.5 text-[12px] font-semibold text-paper shadow-sm hover:opacity-95 transition disabled:opacity-50"
                >
                  {savingTemplates ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Save className="h-3 w-3" />
                  )}
                  Save templates
                </button>
              </div>
            </section>

            {/* Suggestions list */}
            <section className="rounded-2xl border border-rule bg-white">
              <header className="px-5 py-3 border-b border-rule bg-rule-soft/60 flex items-center gap-2">
                <Sparkles className="h-3.5 w-3.5 text-ink-soft" />
                <div className="text-xs font-semibold uppercase tracking-wider text-ink-soft">
                  Allocation queue
                </div>
                <div className="ml-auto text-[10px] text-ink-faint">
                  Showing latest {Math.min(suggestions.length, 100)} of {suggestions.length}
                </div>
              </header>
              {suggestions.length === 0 ? (
                <div className="px-5 py-10 text-center text-sm text-ink-soft">
                  No allocations yet. Tap{" "}
                  <strong className="text-ink">Run allocation</strong> to score
                  patients + split available rebate inventory.
                </div>
              ) : (
                <ul className="divide-y divide-rule max-h-[600px] overflow-y-auto">
                  {suggestions.slice(0, 100).map((s) => (
                    <SuggestionRow
                      key={s.id}
                      suggestion={s}
                      onConfirm={() => void handleConfirm(s)}
                      onDismiss={() => void handleDismiss(s)}
                    />
                  ))}
                </ul>
              )}
            </section>

            <section className="rounded-xl border border-dashed border-rule bg-paper/50 px-5 py-4 text-[12px] text-ink-soft flex gap-3">
              <Sparkles className="h-4 w-4 text-emerald shrink-0 mt-0.5" />
              <div>
                <strong className="text-ink">Three-step flow.</strong>{" "}
                <strong className="text-ink">Confirm</strong> a suggestion to
                lock in the allocation (decrements rebate inventory locally),
                then tap <strong className="text-ink">Dispatch via iMessage</strong>{" "}
                in the header to send the batch as iMessage drafts to your
                proxy email. Paste into Claude Desktop with the iMessage MCP
                installed; the MCP drafts each Messages.app conversation +
                hits a per-draft callback URL that flips the suggestion to{" "}
                <strong className="text-ink">Sent</strong>. Status moves
                Pending → Confirmed → Dispatched → Sent as each step
                completes. (Dispatched = batch emailed to your proxy; Sent =
                Claude confirmed the iMessage draft was created &mdash; you
                still tap Send in Messages.app to actually transmit, which
                stays out of Refill&rsquo;s observability by design.)
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function SplitInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="block text-[10px] font-semibold uppercase tracking-wider text-ink-soft mb-1.5">
        {label}
      </label>
      <input
        type="number"
        min={0}
        max={100}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded border border-rule bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald/30"
      />
    </div>
  );
}

function SuggestionRow({
  suggestion,
  onConfirm,
  onDismiss,
}: {
  suggestion: AllocationSuggestion;
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  const Icon = COHORT_ICONS[suggestion.cohort];
  const cohortColor =
    suggestion.cohort === "at_risk"
      ? "text-amber-ink bg-amber-soft"
      : suggestion.cohort === "loyal_vintage"
        ? "text-emerald-ink bg-emerald-soft"
        : "text-emerald-ink bg-emerald-soft";

  return (
    <li className="px-5 py-3 flex items-start gap-3">
      <div
        className={cn(
          "h-8 w-8 rounded-lg flex items-center justify-center shrink-0",
          cohortColor,
        )}
      >
        <Icon className="h-4 w-4" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <Link
            to="/app/refill/patients/$patientId"
            params={{ patientId: suggestion.patientNodeId }}
            className="text-sm font-semibold text-ink hover:text-emerald transition"
          >
            {suggestion.patientDisplayName}
          </Link>
          <span className="inline-flex items-center rounded-full bg-rule-soft text-ink-soft px-2 py-0.5 text-[10px] font-medium">
            {COHORT_LABELS[suggestion.cohort]}
          </span>
          <span className="inline-flex items-center rounded-full border border-emerald/30 text-emerald-ink px-2 py-0.5 text-[10px] font-semibold">
            {suggestion.units} × {suggestion.brand}
            {suggestion.manufacturer && (
              <span className="text-ink-faint font-normal">
                {" "}
                · {suggestion.manufacturer}
              </span>
            )}
          </span>
          <span className="text-[10px] text-ink-faint">
            score {suggestion.score}
          </span>
        </div>
        <p className="text-[11px] text-ink-soft mt-0.5">{suggestion.rationale}</p>
      </div>
      {suggestion.status === "pending" ? (
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={onConfirm}
            className="inline-flex items-center gap-1 rounded border border-emerald/30 bg-emerald-soft text-emerald-ink px-2 py-1 text-[11px] font-semibold hover:bg-emerald hover:text-paper transition"
            title="Confirm allocation"
          >
            <CheckCircle2 className="h-3 w-3" />
            Confirm
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="inline-flex items-center gap-1 rounded border border-rule bg-white px-2 py-1 text-[11px] font-medium text-ink-soft hover:text-rose transition"
            title="Dismiss"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ) : suggestion.status === "confirmed" ? (
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-soft text-emerald-ink px-2 py-1 text-[10px] font-semibold shrink-0">
          <CheckCircle2 className="h-3 w-3" />
          Confirmed
        </span>
      ) : suggestion.status === "dispatched" ? (
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-soft text-emerald-ink border border-emerald px-2 py-1 text-[10px] font-semibold shrink-0">
          Dispatched
        </span>
      ) : suggestion.status === "sent" ? (
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald text-paper px-2 py-1 text-[10px] font-semibold shrink-0">
          <CheckCircle2 className="h-3 w-3" />
          Sent
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 rounded-full bg-rule-soft text-ink-soft px-2 py-1 text-[10px] font-semibold shrink-0">
          Dismissed
        </span>
      )}
    </li>
  );
}
