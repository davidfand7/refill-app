/**
 * /app/rep/accounts — Liz's accounts surface.
 *
 * Three states in one route:
 *   list   → shows existing imported accounts with tier chips per family
 *   import → drop a CSV / paste / download template → preview parsed rows →
 *            confirm "Import N rows"
 *   result → per-row created/updated/skipped summary with back-to-list
 *
 * Wrapper-aware: stays inside Liz's universe (no /app/knowledge-base detour),
 * mobile-first, no platform-deep affordances. Designed to lift cleanly into
 * the eventual standalone Liz app per project_separate_app_plan memory.
 *
 * Established v252 (2026-05-09). URL slug renamed /app/liz/accounts →
 * /app/rep/accounts in v283; legacy /app/liz/accounts redirects via the
 * stub at src/routes/app.liz.accounts.tsx.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  ArrowLeft,
  Download,
  Loader2,
  MessageSquare,
  Sparkles,
  Upload,
  CheckCircle2,
  XCircle,
  RefreshCw,
  ChevronRight,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import {
  accountsCsvTemplate,
  familyLabel,
  parseLizAccountsCsv,
  type ParsedAccountRow,
} from "@/lib/liz-csv";
import {
  importLizAccounts,
  listLizAccounts,
  type ImportLizAccountsResult,
  type LizAccount,
} from "@/server/liz-accounts.functions";
import { useViewAs } from "@/lib/demo-mode";
import type { AccountTier, RepAssignment } from "@/server/agent-schema";

export const Route = createFileRoute("/app/rep/accounts")({
  component: LizAccountsPage,
});

type Mode = "list" | "import" | "result";

type PersonaFilter = "all" | RepAssignment;

const PERSONA_OPTIONS: { value: PersonaFilter; label: string }[] = [
  { value: "all", label: "All territories" },
  { value: "allergan-rep", label: "Allergan rep" },
  { value: "galderma-rep", label: "Galderma rep" },
  { value: "evolus-rep", label: "Evolus rep" },
  { value: "merz-rep", label: "Merz rep" },
];

function LizAccountsPage() {
  const viewAs = useViewAs();
  const [mode, setMode] = useState<Mode>("list");
  const [accounts, setAccounts] = useState<LizAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [importResult, setImportResult] =
    useState<ImportLizAccountsResult | null>(null);
  const [personaFilter, setPersonaFilter] = useState<PersonaFilter>("all");

  async function refresh() {
    try {
      const { data: session } = await supabase.auth.getSession();
      const accessToken = session.session?.access_token;
      if (!accessToken) {
        setLoading(false);
        toast.error("Please sign in to view accounts.");
        return;
      }
      const list = await listLizAccounts({ data: { accessToken, viewAs } });
      setAccounts(list);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't load accounts.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewAs]);

  const existingLookupKeys = useMemo(
    () =>
      new Set(
        accounts.map((a) => a.lookupKey).filter((k): k is string => !!k),
      ),
    [accounts],
  );

  const filteredAccounts = useMemo(() => {
    if (personaFilter === "all") return accounts;
    return accounts.filter((a) => a.repAssignment === personaFilter);
  }, [accounts, personaFilter]);

  // Only show the persona filter when there's at least one rep-tagged account
  // in the user's roster — keeps the UI quiet for organic CSV-only users.
  const hasRepTaggedAccounts = useMemo(
    () => accounts.some((a) => a.repAssignment),
    [accounts],
  );

  return (
    <div className="flex flex-col min-h-screen bg-background">
      <PageHeader
        eyebrow="Lizzie(OS) · Accounts"
        title={
          mode === "import"
            ? "Import accounts"
            : mode === "result"
              ? "Import results"
              : "Accounts"
        }
        description={
          mode === "import"
            ? "Drop a CSV — Liz learns every account, tier, and contact."
            : mode === "result"
              ? "Here's what changed in your account list."
              : "Spas in your territory that Liz knows about."
        }
        breadcrumbs={[
          { label: "Liz", to: "/app/liz" },
          { label: "Accounts" },
        ]}
        actions={
          mode === "list" ? (
            <div className="flex items-center gap-2">
              <Link
                to="/app/liz"
                className="inline-flex items-center gap-1.5 text-xs text-ink-soft hover:text-foreground rounded-full border border-border px-3 py-1.5"
              >
                <MessageSquare className="h-3.5 w-3.5" />
                Back to chat
              </Link>
              <button
                type="button"
                onClick={() => setMode("import")}
                className="inline-flex items-center gap-1.5 text-xs font-medium rounded-full bg-primary text-white px-3 py-1.5 hover:opacity-90"
              >
                <Upload className="h-3.5 w-3.5" />
                Import CSV
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setMode("list");
                setImportResult(null);
              }}
              className="inline-flex items-center gap-1.5 text-xs text-ink-soft hover:text-foreground rounded-full border border-border px-3 py-1.5"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back to accounts
            </button>
          )
        }
      />

      <div className="flex-1 px-4 py-6 lg:px-10">
        {mode === "list" && (
          <ListPane
            accounts={filteredAccounts}
            totalAccounts={accounts.length}
            loading={loading}
            onImportClick={() => setMode("import")}
            personaFilter={personaFilter}
            onPersonaFilterChange={setPersonaFilter}
            showPersonaFilter={hasRepTaggedAccounts}
          />
        )}
        {mode === "import" && (
          <ImportPane
            existingLookupKeys={existingLookupKeys}
            onCancel={() => setMode("list")}
            onComplete={(result) => {
              setImportResult(result);
              setMode("result");
              void refresh();
            }}
          />
        )}
        {mode === "result" && importResult && (
          <ResultPane
            result={importResult}
            onDone={() => {
              setMode("list");
              setImportResult(null);
            }}
            onImportMore={() => {
              setMode("import");
              setImportResult(null);
            }}
          />
        )}
      </div>
    </div>
  );
}

// ── List pane ─────────────────────────────────────────────────────────────

function ListPane({
  accounts,
  totalAccounts,
  loading,
  onImportClick,
  personaFilter,
  onPersonaFilterChange,
  showPersonaFilter,
}: {
  accounts: LizAccount[];
  totalAccounts: number;
  loading: boolean;
  onImportClick: () => void;
  personaFilter: PersonaFilter;
  onPersonaFilterChange: (v: PersonaFilter) => void;
  showPersonaFilter: boolean;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center text-sm text-ink-soft py-12">
        <Loader2 className="h-4 w-4 animate-spin mr-2" />
        Loading accounts…
      </div>
    );
  }

  if (totalAccounts === 0) {
    return (
      <div className="max-w-xl mx-auto py-12 px-4 text-center">
        <div className="inline-flex items-center justify-center h-12 w-12 rounded-full bg-primary/10 mb-4">
          <Sparkles className="h-6 w-6 text-primary" />
        </div>
        <h2 className="text-xl font-semibold text-foreground mb-2">
          No accounts yet
        </h2>
        <p className="text-sm text-ink-soft leading-relaxed mb-6 max-w-md mx-auto">
          Import your accounts from a spreadsheet — Liz learns names, contacts,
          and per-product-family tier history in one shot.
        </p>
        <button
          type="button"
          onClick={onImportClick}
          className="inline-flex items-center gap-1.5 text-sm font-medium rounded-full bg-primary text-white px-4 py-2 hover:opacity-90"
        >
          <Upload className="h-4 w-4" />
          Import accounts
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto space-y-3">
      <div className="flex items-center justify-between gap-3 px-1 flex-wrap">
        <div className="text-xs text-ink-soft">
          {accounts.length} of {totalAccounts} account
          {totalAccounts === 1 ? "" : "s"} in Liz's memory.
        </div>
        {showPersonaFilter && (
          <label className="inline-flex items-center gap-2 text-xs text-ink-soft">
            <span>Territory</span>
            <select
              value={personaFilter}
              onChange={(e) =>
                onPersonaFilterChange(e.target.value as PersonaFilter)
              }
              className="rounded-full border border-border bg-card px-3 py-1 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              {PERSONA_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {accounts.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card/30 px-4 py-8 text-center text-xs text-ink-soft">
          No accounts in this territory yet. Switch to "All territories" or
          import accounts for this rep.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {accounts.map((a) => (
            <AccountCard key={a.id} account={a} />
          ))}
        </div>
      )}
    </div>
  );
}

function AccountCard({ account }: { account: LizAccount }) {
  // v327: cards click into the detail page.
  // v328: route by account UUID instead of lookup_key so colon-bearing
  // keys from the v316 report projector don't have to survive URL encoding,
  // and so duplicate-named accounts (e.g. Rejuv Med Spa vs Rejuv Skin Spa)
  // resolve unambiguously by id.
  const inner = (
    <>
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-foreground truncate">
            {account.accountName}
          </div>
          {account.address && (
            <div className="text-[11px] text-ink-soft truncate">
              {account.address}
            </div>
          )}
        </div>
        <ChevronRight className="h-4 w-4 text-ink-soft/60 flex-shrink-0" />
      </div>
      {(account.contactName || account.contactEmail || account.contactPhone) && (
        <div className="text-[11px] text-ink-soft mb-2 truncate">
          {[account.contactName, account.contactEmail, account.contactPhone]
            .filter(Boolean)
            .join(" · ")}
        </div>
      )}
      {account.tiers.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {account.tiers.map((t, idx) => (
            <TierChip key={idx} tier={t} />
          ))}
        </div>
      )}
      {account.notes && (
        <div className="text-[11px] text-ink-soft mt-2 line-clamp-2">
          {account.notes}
        </div>
      )}
    </>
  );
  return (
    <Link
      to="/app/rep/accounts/$accountId"
      params={{ accountId: account.id }}
      className="block rounded-xl border border-border bg-card px-4 py-3 hover:shadow-sm hover:border-primary/40 transition"
    >
      {inner}
    </Link>
  );
}

function TierChip({ tier }: { tier: AccountTier }) {
  const color = tierColor(tier.tier);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[10px] font-medium rounded-full px-2 py-0.5",
        color,
      )}
      title={
        tier.qtd_volume !== undefined
          ? `${tier.qtd_volume} QTD${tier.qtr_end ? ` · ends ${tier.qtr_end}` : ""}`
          : undefined
      }
    >
      <span className="opacity-80">{familyLabel(tier.family)}</span>
      <span>·</span>
      <span>{tier.tier}</span>
    </span>
  );
}

function tierColor(tier: string): string {
  const t = tier.toLowerCase();
  if (t.includes("diamond")) return "bg-violet-500/15 text-violet-400 dark:text-violet-300";
  if (t.includes("platinum")) return "bg-sky-500/15 text-sky-400 dark:text-sky-300";
  if (t.includes("gold")) return "bg-amber-500/15 text-amber-500 dark:text-amber-300";
  if (t.includes("silver")) return "bg-zinc-500/15 text-zinc-500 dark:text-zinc-300";
  if (t.includes("bronze")) return "bg-orange-700/15 text-orange-600 dark:text-orange-300";
  return "bg-muted text-ink-soft";
}

// ── Import pane ───────────────────────────────────────────────────────────

function ImportPane({
  existingLookupKeys,
  onCancel,
  onComplete,
}: {
  existingLookupKeys: Set<string>;
  onCancel: () => void;
  onComplete: (result: ImportLizAccountsResult) => void;
}) {
  const [csvText, setCsvText] = useState("");
  const [parsed, setParsed] = useState<ParsedAccountRow[] | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  function handleParse(text: string) {
    setCsvText(text);
    if (!text.trim()) {
      setParsed(null);
      return;
    }
    try {
      const rows = parseLizAccountsCsv(text);
      setParsed(rows);
      if (rows.length === 0) {
        toast.error("Couldn't find any rows in that CSV.");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't parse CSV.");
      setParsed(null);
    }
  }

  function handleFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === "string" ? reader.result : "";
      handleParse(text);
    };
    reader.onerror = () => toast.error("Couldn't read file.");
    reader.readAsText(file);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  }

  function downloadTemplate() {
    const csv = accountsCsvTemplate();
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "liz-accounts-template.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const importableRows = useMemo(
    () => (parsed ?? []).filter((r) => r.errors.length === 0),
    [parsed],
  );
  const errorRows = useMemo(
    () => (parsed ?? []).filter((r) => r.errors.length > 0),
    [parsed],
  );

  async function handleSubmit() {
    if (importableRows.length === 0) return;
    setSubmitting(true);
    try {
      const { data: session } = await supabase.auth.getSession();
      const accessToken = session.session?.access_token;
      if (!accessToken) throw new Error("Please sign in to import.");
      const result = await importLizAccounts({
        data: { accessToken, rows: importableRows },
      });
      onComplete(result);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Import failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      {!parsed && (
        <>
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDrop}
            className="rounded-xl border-2 border-dashed border-border bg-card/50 px-6 py-10 text-center"
          >
            <Upload className="h-8 w-8 text-primary mx-auto mb-3 opacity-70" />
            <div className="text-sm font-medium text-foreground mb-1">
              Drop a CSV file here
            </div>
            <div className="text-xs text-ink-soft mb-4">
              or pick one from your computer
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 text-xs font-medium rounded-full bg-primary text-white px-3 py-1.5 hover:opacity-90"
            >
              Choose file
            </button>
          </div>

          <div className="rounded-xl border border-border bg-card px-4 py-3">
            <div className="flex items-center justify-between gap-3 mb-2">
              <div className="text-xs font-medium text-foreground">
                First time? Start with the template.
              </div>
              <button
                type="button"
                onClick={downloadTemplate}
                className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
              >
                <Download className="h-3.5 w-3.5" />
                Download template
              </button>
            </div>
            <div className="text-[11px] text-ink-soft leading-relaxed">
              Required: <code>account_name</code>. Optional: contact info,
              address, notes, plus per-family tier columns like{" "}
              <code>botox_tier</code>, <code>botox_qtd</code>,{" "}
              <code>botox_qtr_end</code>. The template includes columns for
              every product family Liz already knows about.
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card px-4 py-3">
            <div className="text-xs font-medium text-foreground mb-2">
              …or paste CSV here
            </div>
            <textarea
              value={csvText}
              onChange={(e) => setCsvText(e.target.value)}
              placeholder="account_name,contact_name,..."
              rows={6}
              className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-xs font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            />
            <div className="flex justify-end mt-2">
              <button
                type="button"
                disabled={!csvText.trim()}
                onClick={() => handleParse(csvText)}
                className="inline-flex items-center gap-1.5 text-xs font-medium rounded-full bg-primary text-white px-3 py-1.5 hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Parse CSV
              </button>
            </div>
          </div>
        </>
      )}

      {parsed && (
        <div className="space-y-4">
          <div className="rounded-xl border border-border bg-card px-4 py-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <div className="text-sm font-semibold text-foreground">
                  Preview — {parsed.length} row{parsed.length === 1 ? "" : "s"} parsed
                </div>
                <div className="text-[11px] text-ink-soft mt-0.5">
                  {importableRows.length} ready to import
                  {errorRows.length > 0 && ` · ${errorRows.length} skipped`}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setParsed(null);
                    setCsvText("");
                  }}
                  className="inline-flex items-center gap-1.5 text-xs text-ink-soft hover:text-foreground rounded-full border border-border px-3 py-1.5"
                >
                  Start over
                </button>
                <button
                  type="button"
                  disabled={importableRows.length === 0 || submitting}
                  onClick={() => void handleSubmit()}
                  className="inline-flex items-center gap-1.5 text-xs font-medium rounded-full bg-primary text-white px-3 py-1.5 hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {submitting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5" />
                  )}
                  Import {importableRows.length}
                </button>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <div className="divide-y divide-border">
              {parsed.map((row) => {
                const isError = row.errors.length > 0;
                const isUpdate =
                  !isError && existingLookupKeys.has(row.lookupKey);
                return (
                  <div
                    key={row.sourceRow}
                    className="px-4 py-3 flex items-start gap-3"
                  >
                    <RowBadge
                      kind={isError ? "skip" : isUpdate ? "update" : "new"}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-foreground truncate">
                        {row.accountName || "(no name)"}
                      </div>
                      <div className="text-[11px] text-ink-soft mt-0.5">
                        Row {row.sourceRow} · {row.tiers.length} tier
                        {row.tiers.length === 1 ? "" : "s"}
                      </div>
                      {row.tiers.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1.5">
                          {row.tiers.map((t, i) => (
                            <TierChip key={i} tier={t} />
                          ))}
                        </div>
                      )}
                      {isError && (
                        <div className="text-[11px] text-rose-500 mt-1.5">
                          {row.errors.join("; ")}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <button
            type="button"
            onClick={onCancel}
            className="text-xs text-ink-soft hover:text-foreground"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

function RowBadge({ kind }: { kind: "new" | "update" | "skip" }) {
  if (kind === "new") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-medium rounded-full bg-emerald-500/15 text-emerald-400 dark:text-emerald-300 px-2 py-0.5 mt-0.5">
        <Sparkles className="h-3 w-3" /> NEW
      </span>
    );
  }
  if (kind === "update") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-medium rounded-full bg-sky-500/15 text-sky-400 dark:text-sky-300 px-2 py-0.5 mt-0.5">
        <RefreshCw className="h-3 w-3" /> UPDATE
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-medium rounded-full bg-rose-500/15 text-rose-400 dark:text-rose-300 px-2 py-0.5 mt-0.5">
      <XCircle className="h-3 w-3" /> SKIP
    </span>
  );
}

// ── Result pane ───────────────────────────────────────────────────────────

function ResultPane({
  result,
  onDone,
  onImportMore,
}: {
  result: ImportLizAccountsResult;
  onDone: () => void;
  onImportMore: () => void;
}) {
  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <div className="rounded-xl border border-border bg-card px-5 py-4">
        <div className="flex items-center gap-3 mb-3">
          <CheckCircle2 className="h-6 w-6 text-emerald-500" />
          <div>
            <div className="text-sm font-semibold text-foreground">
              Import complete
            </div>
            <div className="text-[11px] text-ink-soft">
              Liz now has {result.created + result.updated} more account
              {result.created + result.updated === 1 ? "" : "s"} to reason about.
            </div>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Stat label="Created" value={result.created} accent="emerald" />
          <Stat label="Updated" value={result.updated} accent="sky" />
          <Stat label="Skipped" value={result.skipped} accent="rose" />
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="divide-y divide-border">
          {result.rows.map((r) => (
            <div
              key={r.sourceRow}
              className="px-4 py-2.5 flex items-center gap-3 text-sm"
            >
              <RowBadge
                kind={
                  r.action === "created"
                    ? "new"
                    : r.action === "updated"
                      ? "update"
                      : "skip"
                }
              />
              <div className="flex-1 min-w-0">
                <div className="font-medium text-foreground truncate">
                  {r.accountName}
                </div>
                {r.message && (
                  <div className="text-[11px] text-ink-soft truncate">
                    {r.message}
                  </div>
                )}
              </div>
              <div className="text-[11px] text-ink-soft">
                Row {r.sourceRow}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onImportMore}
          className="inline-flex items-center gap-1.5 text-xs text-ink-soft hover:text-foreground rounded-full border border-border px-3 py-1.5"
        >
          <Upload className="h-3.5 w-3.5" />
          Import more
        </button>
        <button
          type="button"
          onClick={onDone}
          className="inline-flex items-center gap-1.5 text-xs font-medium rounded-full bg-primary text-white px-3 py-1.5 hover:opacity-90"
        >
          Done
        </button>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent: "emerald" | "sky" | "rose";
}) {
  const color =
    accent === "emerald"
      ? "text-emerald-500"
      : accent === "sky"
        ? "text-sky-500"
        : "text-rose-500";
  return (
    <div className="rounded-lg border border-border bg-background/40 px-3 py-2">
      <div className={cn("text-2xl font-semibold tabular-nums", color)}>
        {value}
      </div>
      <div className="text-[10px] uppercase tracking-wider text-ink-soft">
        {label}
      </div>
    </div>
  );
}
