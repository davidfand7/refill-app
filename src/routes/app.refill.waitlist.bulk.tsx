/**
 * /app/refill/waitlist/bulk — v374 bulk admin tool for Karen/David.
 *
 * The single-patient seed page (/app/refill/waitlist/seed) is great for
 * one-off Type B seeds — "Sarah is booked Jun 15 for Tox, wants earlier
 * slot." But the alpha pilot needs 100-200 patients seeded in one pass.
 * This page is that pass.
 *
 * Flow:
 *   1. Pick patients — search + sort + multi-select OR quick-select top-N
 *      by lifetime spend
 *   2. Pre-fill treatments — defaults from emma_noshow_policies
 *      .rescue_eligible_treatments (the spa's already-configured list).
 *      Karen can edit before generating.
 *   3. Pick intent — catchall (default for bulk) or earlier_appointment.
 *   4. Generate → batch insert paused waitlist rows + mint tokens.
 *   5. Result table: name, phone, email, opt-in URL, status pill, per-row
 *      copy. Bulk actions: Copy all URLs / Export CSV / Open mailto.
 *
 * SMS-decoupled by design — the URLs work regardless of phone provider
 * state. Karen distributes via email blast / patient-comm channel TODAY;
 * rescue dispatcher picks up active waitlist rows automatically once
 * SMS goes live (Bandwidth porting in progress).
 */

import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Search,
  CheckCircle2,
  ClipboardCopy,
  ClipboardCheck,
  Loader2,
  Users,
  Sparkles,
  Download,
  Mail,
  AlertCircle,
  ArrowRight,
} from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/PageHeader";
import { supabase } from "@/integrations/supabase/client";
import {
  listSeedablePatients,
  bulkSeedWaitlistIntents,
  type AdminPatientCandidate,
  type BulkSeedRowResult,
} from "@/server/emma-waitlist-seed.functions";
import { getNoShowPolicy } from "@/server/emma-appointments.functions";

export const Route = createFileRoute("/app/refill/waitlist/bulk")({
  component: WaitlistBulkPage,
});

type SortMode = "spend_desc" | "name_asc";
type ContactFilter = "all" | "has_phone" | "has_email";

function WaitlistBulkPage() {
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [patients, setPatients] = useState<AdminPatientCandidate[]>([]);
  const [loadingPatients, setLoadingPatients] = useState(true);
  const [query, setQuery] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("spend_desc");
  const [contactFilter, setContactFilter] = useState<ContactFilter>("all");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const [treatmentsInput, setTreatmentsInput] = useState("");
  const [intentType, setIntentType] = useState<
    "catchall" | "earlier_appointment"
  >("catchall");

  const [generating, setGenerating] = useState(false);
  const [results, setResults] = useState<BulkSeedRowResult[] | null>(null);
  const [resultSummary, setResultSummary] = useState<{
    seeded: number;
    alreadyActive: number;
    errored: number;
  } | null>(null);
  const [copiedAll, setCopiedAll] = useState(false);
  const [copiedRow, setCopiedRow] = useState<string | null>(null);

  // Bootstrap
  useEffect(() => {
    supabase.auth.getSession().then((r) => {
      setAccessToken(r.data.session?.access_token ?? null);
    });
  }, []);

  // Load full patient list once + load default treatments from policy
  useEffect(() => {
    if (!accessToken) return;
    setLoadingPatients(true);
    Promise.all([
      listSeedablePatients({ data: { accessToken } }),
      getNoShowPolicy({ data: { accessToken } }).catch(() => null),
    ])
      .then(([pp, policy]) => {
        setPatients(pp);
        const defaults = (policy as any)?.rescue_eligible_treatments ?? [];
        if (Array.isArray(defaults) && defaults.length > 0) {
          setTreatmentsInput(defaults.join(", "));
        }
      })
      .catch((e) => toast.error(`Couldn't load: ${e.message}`))
      .finally(() => setLoadingPatients(false));
  }, [accessToken]);

  // Derived: filtered + sorted view
  const visiblePatients = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = patients.filter((p) => {
      if (contactFilter === "has_phone" && !p.phone) return false;
      if (contactFilter === "has_email" && !p.email) return false;
      if (!q) return true;
      const hay = `${p.name ?? ""} ${p.phone ?? ""} ${p.email ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
    if (sortMode === "spend_desc") {
      filtered.sort((a, b) => b.lifetimeSpend - a.lifetimeSpend);
    } else {
      filtered.sort((a, b) =>
        (a.name ?? "").localeCompare(b.name ?? ""),
      );
    }
    return filtered;
  }, [patients, query, contactFilter, sortMode]);

  const allVisibleSelected =
    visiblePatients.length > 0 &&
    visiblePatients.every((p) => selectedIds.has(p.patientNodeId));

  const toggleOne = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAllVisible = useCallback(() => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const p of visiblePatients) next.delete(p.patientNodeId);
      } else {
        for (const p of visiblePatients) next.add(p.patientNodeId);
      }
      return next;
    });
  }, [visiblePatients, allVisibleSelected]);

  const quickSelectTopN = useCallback(
    (n: number) => {
      const top = [...patients]
        .filter((p) =>
          contactFilter === "has_phone"
            ? !!p.phone
            : contactFilter === "has_email"
              ? !!p.email
              : true,
        )
        .sort((a, b) => b.lifetimeSpend - a.lifetimeSpend)
        .slice(0, n);
      setSelectedIds(new Set(top.map((p) => p.patientNodeId)));
      toast.success(
        `Selected top ${top.length} ${
          contactFilter === "has_phone"
            ? "with phone"
            : contactFilter === "has_email"
              ? "with email"
              : ""
        } by lifetime spend`,
      );
    },
    [patients, contactFilter],
  );

  const clearAll = useCallback(() => setSelectedIds(new Set()), []);

  const generate = useCallback(async () => {
    if (!accessToken || selectedIds.size === 0) return;
    const treatments = treatmentsInput
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (intentType === "earlier_appointment" && treatments.length === 0) {
      toast.error(
        "Earlier-appointment intent needs at least one treatment.",
      );
      return;
    }
    setGenerating(true);
    try {
      const r = await bulkSeedWaitlistIntents({
        data: {
          accessToken,
          patientNodeIds: Array.from(selectedIds),
          intentType,
          treatmentTypes: treatments,
          brand: "refill",
        },
      });
      setResults(r.rows);
      setResultSummary({
        seeded: r.seeded,
        alreadyActive: r.alreadyActive,
        errored: r.errored,
      });
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Bulk seed failed.",
      );
    } finally {
      setGenerating(false);
    }
  }, [accessToken, selectedIds, treatmentsInput, intentType]);

  const reset = useCallback(() => {
    setResults(null);
    setResultSummary(null);
    setSelectedIds(new Set());
    setCopiedAll(false);
    setCopiedRow(null);
  }, []);

  const copyAllUrls = useCallback(async () => {
    if (!results) return;
    const lines = results
      .filter((r) => r.optInUrl)
      .map((r) => r.optInUrl)
      .join("\n");
    await navigator.clipboard.writeText(lines);
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 2500);
  }, [results]);

  const copyRow = useCallback(async (id: string, url: string) => {
    await navigator.clipboard.writeText(url);
    setCopiedRow(id);
    setTimeout(() => setCopiedRow(null), 2000);
  }, []);

  const exportCsv = useCallback(() => {
    if (!results) return;
    const header = "Name,Phone,Email,OptInUrl,Status\n";
    const rows = results
      .map((r) => {
        const cells = [
          r.name ?? "",
          r.phone ?? "",
          r.email ?? "",
          r.optInUrl ?? "",
          r.status,
        ].map((c) => `"${String(c).replace(/"/g, '""')}"`);
        return cells.join(",");
      })
      .join("\n");
    const blob = new Blob([header + rows], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const stamp = new Date().toISOString().slice(0, 10);
    a.download = `refill-waitlist-bulk-${stamp}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [results]);

  return (
    <div className="px-6 py-6 max-w-[960px] mx-auto">
      <PageHeader
        title="Bulk Waitlist Seed"
        description="Generate opt-in links for many patients in one pass. URLs work today regardless of SMS provider state — distribute via email blast or any channel; the rescue engine picks up active opt-ins automatically."
      />

      {/* Results view */}
      {results && resultSummary && (
        <>
          <section className="mt-6 rounded-2xl border-2 border-emerald-200 bg-emerald-50 p-6">
            <div className="flex items-start gap-3">
              <div className="h-10 w-10 rounded-full bg-emerald-500 text-white flex items-center justify-center shrink-0">
                <CheckCircle2 className="h-5 w-5" />
              </div>
              <div className="flex-1">
                <div className="text-sm font-semibold text-emerald-900">
                  {resultSummary.seeded + resultSummary.alreadyActive} opt-in
                  links ready
                </div>
                <div className="text-xs text-emerald-800 mt-0.5 leading-relaxed">
                  {resultSummary.seeded} newly seeded
                  {resultSummary.alreadyActive > 0 &&
                    ` · ${resultSummary.alreadyActive} already active (preferences updated)`}
                  {resultSummary.errored > 0 &&
                    ` · ${resultSummary.errored} errored — see table`}
                  . Send via email blast, paste into Mailchimp, or hand off
                  to your existing patient-comm channel. URLs are live now;
                  patient tap → waitlist row flips paused → active → eligible
                  for treatment-matched rescue SMS the moment phone porting
                  completes.
                </div>
              </div>
            </div>

            <div className="flex flex-wrap gap-2 mt-5">
              <button
                type="button"
                onClick={copyAllUrls}
                className="inline-flex items-center gap-2 rounded-lg bg-slate-900 text-white px-4 py-2 text-sm font-medium hover:bg-slate-800 transition"
              >
                {copiedAll ? (
                  <>
                    <ClipboardCheck className="h-4 w-4" />
                    Copied {results.filter((r) => r.optInUrl).length} URLs
                  </>
                ) : (
                  <>
                    <ClipboardCopy className="h-4 w-4" />
                    Copy all URLs (one per line)
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={exportCsv}
                className="inline-flex items-center gap-2 rounded-lg bg-white border border-slate-300 text-slate-900 px-4 py-2 text-sm font-medium hover:bg-slate-50 transition"
              >
                <Download className="h-4 w-4" />
                Export CSV
              </button>
              <button
                type="button"
                onClick={reset}
                className="inline-flex items-center gap-2 rounded-lg text-emerald-700 hover:text-emerald-900 px-4 py-2 text-sm font-medium ml-auto"
              >
                Seed another batch
                <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          </section>

          <section className="mt-6 rounded-2xl border border-border bg-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-muted/40">
                  <tr>
                    <th className="text-left px-4 py-2.5 text-xs uppercase tracking-wider text-muted-foreground font-semibold">
                      Patient
                    </th>
                    <th className="text-left px-4 py-2.5 text-xs uppercase tracking-wider text-muted-foreground font-semibold">
                      Contact
                    </th>
                    <th className="text-left px-4 py-2.5 text-xs uppercase tracking-wider text-muted-foreground font-semibold">
                      Status
                    </th>
                    <th className="text-left px-4 py-2.5 text-xs uppercase tracking-wider text-muted-foreground font-semibold">
                      Opt-in URL
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {results.map((r) => (
                    <tr key={r.patientNodeId} className="hover:bg-muted/20">
                      <td className="px-4 py-3">
                        <div className="font-medium text-foreground">
                          {r.name || "(no name)"}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        <div>{r.phone || "—"}</div>
                        <div>{r.email || "—"}</div>
                      </td>
                      <td className="px-4 py-3">
                        {r.status === "seeded" && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 text-emerald-800 px-2 py-0.5 text-xs font-medium">
                            seeded
                          </span>
                        )}
                        {r.status === "already_active" && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 text-blue-800 px-2 py-0.5 text-xs font-medium">
                            active
                          </span>
                        )}
                        {r.status === "error" && (
                          <span
                            className="inline-flex items-center gap-1 rounded-full bg-red-100 text-red-800 px-2 py-0.5 text-xs font-medium"
                            title={r.errorMessage ?? undefined}
                          >
                            <AlertCircle className="h-3 w-3" />
                            error
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {r.optInUrl ? (
                          <div className="flex items-center gap-2">
                            <code className="text-xs text-slate-700 truncate max-w-[280px]">
                              {r.optInUrl}
                            </code>
                            <button
                              type="button"
                              onClick={() =>
                                copyRow(r.patientNodeId, r.optInUrl!)
                              }
                              className="text-xs text-slate-500 hover:text-slate-900"
                            >
                              {copiedRow === r.patientNodeId ? (
                                <ClipboardCheck className="h-4 w-4 text-emerald-600" />
                              ) : (
                                <ClipboardCopy className="h-4 w-4" />
                              )}
                            </button>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground italic">
                            {r.errorMessage ?? "—"}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {/* Picker view */}
      {!results && (
        <>
          {/* Top stats + quick actions */}
          <section className="mt-6 rounded-2xl border border-border bg-card p-5">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-4">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center">
                  <Users className="h-5 w-5" />
                </div>
                <div>
                  <div className="text-sm font-semibold text-foreground">
                    {selectedIds.size} of {patients.length} patients selected
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Showing {visiblePatients.length} matching filters
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => quickSelectTopN(50)}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 px-3 py-1.5 text-xs font-medium hover:bg-emerald-100 transition"
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  Top 50 VIP
                </button>
                <button
                  type="button"
                  onClick={() => quickSelectTopN(100)}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 px-3 py-1.5 text-xs font-medium hover:bg-emerald-100 transition"
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  Top 100
                </button>
                <button
                  type="button"
                  onClick={() => quickSelectTopN(200)}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 px-3 py-1.5 text-xs font-medium hover:bg-emerald-100 transition"
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  Top 200
                </button>
                {selectedIds.size > 0 && (
                  <button
                    type="button"
                    onClick={clearAll}
                    className="text-xs text-muted-foreground hover:text-foreground px-2"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>

            {/* Search + filters */}
            <div className="flex flex-col sm:flex-row gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                <input
                  type="text"
                  placeholder="Search by name, phone, or email…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="w-full rounded-lg border border-border bg-background pl-10 pr-3 py-2 text-sm"
                />
              </div>
              <select
                value={sortMode}
                onChange={(e) => setSortMode(e.target.value as SortMode)}
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
              >
                <option value="spend_desc">Sort by lifetime spend ↓</option>
                <option value="name_asc">Sort by name A-Z</option>
              </select>
              <select
                value={contactFilter}
                onChange={(e) =>
                  setContactFilter(e.target.value as ContactFilter)
                }
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
              >
                <option value="all">All patients</option>
                <option value="has_phone">Has phone</option>
                <option value="has_email">Has email</option>
              </select>
            </div>
          </section>

          {/* Patient list */}
          <section className="mt-4 rounded-2xl border border-border bg-card overflow-hidden">
            <div className="px-4 py-2.5 border-b border-border bg-muted/30 flex items-center gap-3">
              <input
                type="checkbox"
                checked={allVisibleSelected}
                onChange={toggleAllVisible}
                className="rounded border-slate-300"
                id="select-all-visible"
              />
              <label
                htmlFor="select-all-visible"
                className="text-xs uppercase tracking-wider text-muted-foreground font-semibold cursor-pointer"
              >
                {allVisibleSelected ? "Deselect" : "Select"} all{" "}
                {visiblePatients.length} visible
              </label>
            </div>
            {loadingPatients ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-12 justify-center">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading patients…
              </div>
            ) : visiblePatients.length === 0 ? (
              <div className="text-sm text-muted-foreground py-12 text-center">
                No patients match the current filters.
              </div>
            ) : (
              <ul className="divide-y divide-border max-h-[480px] overflow-y-auto">
                {visiblePatients.map((p) => {
                  const isSelected = selectedIds.has(p.patientNodeId);
                  return (
                    <li key={p.patientNodeId}>
                      <label className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/20 cursor-pointer transition">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleOne(p.patientNodeId)}
                          className="rounded border-slate-300 shrink-0"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-foreground truncate">
                            {p.name || "(no name)"}
                          </div>
                          <div className="text-xs text-muted-foreground truncate">
                            {[p.phone, p.email].filter(Boolean).join(" · ") ||
                              "(no contact info)"}
                          </div>
                        </div>
                        {p.lifetimeSpend > 0 && (
                          <div className="text-xs text-muted-foreground tabular-nums shrink-0">
                            ${p.lifetimeSpend.toLocaleString()}
                          </div>
                        )}
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* Intent + treatments + generate */}
          <section className="mt-6 rounded-2xl border border-border bg-card p-6 space-y-5">
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">
                Intent for all selected
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setIntentType("catchall")}
                  className={`text-left p-3 rounded-lg border-2 transition ${
                    intentType === "catchall"
                      ? "border-emerald-500 bg-emerald-50"
                      : "border-border hover:border-muted-foreground"
                  }`}
                >
                  <div className="text-sm font-medium">
                    Catchall <span className="text-xs text-muted-foreground">(recommended for bulk)</span>
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    Patient gets notified anytime a matching-treatment slot
                    opens. Best for the first 100-200 alpha seed.
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => setIntentType("earlier_appointment")}
                  className={`text-left p-3 rounded-lg border-2 transition ${
                    intentType === "earlier_appointment"
                      ? "border-emerald-500 bg-emerald-50"
                      : "border-border hover:border-muted-foreground"
                  }`}
                >
                  <div className="text-sm font-medium">Earlier appointment</div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    All selected patients are already booked + want earlier
                    slot. Use the single-seed page for true Type B precision.
                  </div>
                </button>
              </div>
            </div>

            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2 flex items-center justify-between">
                <span>
                  Treatment types{" "}
                  {intentType === "earlier_appointment"
                    ? "(required)"
                    : "(optional but recommended)"}
                </span>
                <span className="text-muted-foreground/70 normal-case tracking-normal">
                  pre-filled from your no-show policy
                </span>
              </div>
              <input
                type="text"
                value={treatmentsInput}
                onChange={(e) => setTreatmentsInput(e.target.value)}
                placeholder="e.g. Tox w/ Karen, Filler w/ Karen — comma-separated"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono"
              />
              <div className="text-xs text-muted-foreground mt-1.5">
                Each selected patient will be opted in for these treatments.
                Rescue dispatcher only fires when a cancellation matches one
                of them (exact-string match, case-insensitive).
              </div>
            </div>

            <div className="flex flex-col sm:flex-row gap-3 pt-2 border-t border-border">
              <button
                type="button"
                onClick={generate}
                disabled={
                  generating ||
                  selectedIds.size === 0 ||
                  (intentType === "earlier_appointment" &&
                    !treatmentsInput.trim())
                }
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-emerald text-paper px-5 py-2.5 text-sm font-medium hover:opacity-90 transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {generating ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Generating {selectedIds.size} URLs…
                  </>
                ) : (
                  <>
                    <Mail className="h-4 w-4" />
                    Generate {selectedIds.size > 0
                      ? `${selectedIds.size} opt-in URLs`
                      : "opt-in URLs"}
                  </>
                )}
              </button>
              <span className="text-xs text-muted-foreground self-center max-w-md">
                Creates paused waitlist rows + mints tokens. Patients flip
                paused → active when they tap. URLs work the moment they
                land in someone's inbox — no SMS dependency.
              </span>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
