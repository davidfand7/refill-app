/**
 * /app/rep/sends — Deals Desk (v326).
 *
 * The rep's portfolio view of every sample order they've sent through Liz.
 * Per-thread chips in chat tell you "did this one practice open it?" — this
 * page rolls up the entire territory: how many sends, how many opened, how
 * many confirmed, what's gone stale, who's worth a follow-up nudge.
 *
 * Data: `listSendIntents` returns every row from `sample_order_intents` for
 * the authed rep, newest first. Follow-up flags are computed client-side
 * from the timestamps so the thresholds stay tunable without a server
 * deploy.
 *
 * Row interactions:
 *   - "View as practice sees it" → opens the public /order/<token> page in
 *     a new tab so the rep can see exactly what the practice owner sees.
 *   - "Open chat thread"         → jumps back to /app/rep?turn=<id>
 *     scrolled to the originating Liz reply (deep-link wired in app.lizzie).
 *
 * Strategic context: this is the portfolio surface Liz Kunze will ask for
 * the moment she sees v325 working end-to-end — "but what does it look like
 * across all my accounts?" Shipping this BEFORE the demo is the difference
 * between "cool one-off" and "this is the dashboard I'd actually open."
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  AlertCircle,
  ArrowLeft,
  BadgeCheck,
  CheckCircle2,
  Clock,
  ExternalLink,
  Eye,
  Loader2,
  Mail,
  MessageSquare,
  RefreshCw,
  Search,
  Sparkles,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { supabase } from "@/integrations/supabase/client";
import {
  listSendIntents,
  type RepSendIntentRow,
} from "@/server/sample-order-intents.functions";
import { useViewAs } from "@/lib/demo-mode";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/rep/sends")({
  component: DealsDeskPage,
});

type StateFilter = "all" | "active" | "viewed" | "confirmed" | "stale";
type TimeFilter = "7d" | "30d" | "all";

const STALE_NO_OPEN_DAYS = 3;
const STALE_NO_CONFIRM_DAYS = 2;

function DealsDeskPage() {
  const viewAs = useViewAs();
  const [rows, setRows] = useState<RepSendIntentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const [timeFilter, setTimeFilter] = useState<TimeFilter>("30d");
  const [search, setSearch] = useState("");

  async function load({ silent = false }: { silent?: boolean } = {}) {
    if (!silent) setLoading(true);
    setRefreshing(true);
    try {
      const { data: session } = await supabase.auth.getSession();
      const accessToken = session.session?.access_token;
      if (!accessToken) {
        toast.error("Please sign in to view your sends.");
        setLoading(false);
        setRefreshing(false);
        return;
      }
      const { rows: fresh } = await listSendIntents({ data: { accessToken, viewAs } });
      setRows(fresh);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't load sends.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewAs]);

  // ── derived ─────────────────────────────────────────────────────────────

  const now = Date.now();

  const enriched = useMemo(
    () =>
      rows.map((r) => {
        const isStale = computeIsStale(r, now);
        return { ...r, isStale };
      }),
    [rows, now],
  );

  const filtered = useMemo(() => {
    const cutoff =
      timeFilter === "all"
        ? 0
        : timeFilter === "7d"
          ? now - 7 * 24 * 60 * 60 * 1000
          : now - 30 * 24 * 60 * 60 * 1000;
    const q = search.trim().toLowerCase();

    return enriched.filter((r) => {
      if (new Date(r.sentAt).getTime() < cutoff) return false;
      if (stateFilter === "stale" && !r.isStale) return false;
      if (
        stateFilter !== "all" &&
        stateFilter !== "stale" &&
        r.state !== stateFilter
      ) {
        return false;
      }
      if (q.length > 0) {
        const hay = `${r.practiceTitle} ${r.practiceEmail} ${r.confirmedByName ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [enriched, stateFilter, timeFilter, search, now]);

  const summary = useMemo(() => {
    const sent = enriched.length;
    const opened = enriched.filter(
      (r) => r.state === "viewed" || r.state === "confirmed",
    ).length;
    const confirmed = enriched.filter((r) => r.state === "confirmed").length;
    const stale = enriched.filter((r) => r.isStale).length;
    const conversionPct = sent > 0 ? Math.round((confirmed / sent) * 100) : 0;
    return { sent, opened, confirmed, stale, conversionPct };
  }, [enriched]);

  // ── render ──────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col min-h-screen bg-background">
      <PageHeader
        eyebrow="Lizzie(OS)"
        title="Sends"
        description="Every sample order you've sent — at a glance. Track what's been opened, what's been confirmed, and who's worth a follow-up."
        breadcrumbs={[{ label: "Liz", to: "/app/rep" }, { label: "Sends" }]}
        actions={
          <div className="flex items-center gap-2">
            <Link
              to="/app/rep"
              className="inline-flex items-center gap-1.5 text-xs text-ink-soft hover:text-foreground rounded-full border border-border px-3 py-1.5"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back to chat
            </Link>
            <button
              type="button"
              onClick={() => void load({ silent: true })}
              disabled={refreshing}
              className="inline-flex items-center gap-1.5 text-xs text-ink-soft hover:text-foreground rounded-full border border-border px-3 py-1.5 disabled:opacity-50"
              aria-label="Refresh"
              title="Refresh"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
              Refresh
            </button>
          </div>
        }
      />

      <div className="flex-1 px-4 py-6 lg:px-10 max-w-6xl w-full mx-auto space-y-6">
        {loading ? (
          <div className="flex items-center justify-center text-sm text-ink-soft py-16">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            Loading your sends…
          </div>
        ) : enriched.length === 0 ? (
          <EmptyState />
        ) : (
          <>
            <SummaryCards summary={summary} />

            <FilterBar
              stateFilter={stateFilter}
              onStateFilter={setStateFilter}
              timeFilter={timeFilter}
              onTimeFilter={setTimeFilter}
              search={search}
              onSearch={setSearch}
              counts={{
                all: enriched.length,
                active: enriched.filter((r) => r.state === "active").length,
                viewed: enriched.filter((r) => r.state === "viewed").length,
                confirmed: summary.confirmed,
                stale: summary.stale,
              }}
            />

            {filtered.length === 0 ? (
              <div className="text-center py-12 text-sm text-ink-soft border border-dashed border-border rounded-lg bg-card/40">
                No sends match those filters. Try widening the time range or clearing the search.
              </div>
            ) : (
              <SendsTable rows={filtered} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Summary cards ──────────────────────────────────────────────────────────

function SummaryCards({
  summary,
}: {
  summary: { sent: number; opened: number; confirmed: number; stale: number; conversionPct: number };
}) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      <SummaryCard label="Total sent" value={summary.sent.toString()} accent="default" icon={<Mail className="h-4 w-4" />} />
      <SummaryCard label="Opened" value={summary.opened.toString()} sub={`${summary.sent > 0 ? Math.round((summary.opened / summary.sent) * 100) : 0}%`} accent="info" icon={<Eye className="h-4 w-4" />} />
      <SummaryCard label="Confirmed" value={summary.confirmed.toString()} sub={`${summary.conversionPct}% conversion`} accent="success" icon={<BadgeCheck className="h-4 w-4" />} />
      <SummaryCard label="Follow-up needed" value={summary.stale.toString()} accent="warning" icon={<AlertCircle className="h-4 w-4" />} />
    </div>
  );
}

function SummaryCard({
  label,
  value,
  sub,
  accent,
  icon,
}: {
  label: string;
  value: string;
  sub?: string;
  accent: "default" | "info" | "success" | "warning";
  icon: React.ReactNode;
}) {
  const accentClasses = {
    default: "text-foreground",
    info: "text-slate-700",
    success: "text-emerald-700",
    warning: "text-amber-700",
  }[accent];
  const bgClasses = {
    default: "bg-card",
    info: "bg-slate-50/60",
    success: "bg-emerald-50/40",
    warning: "bg-amber-50/40",
  }[accent];
  return (
    <div className={cn("rounded-xl border border-border px-4 py-3", bgClasses)}>
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-ink-soft font-medium">
        {icon}
        <span>{label}</span>
      </div>
      <div className={cn("mt-1.5 text-2xl font-semibold tabular-nums", accentClasses)}>{value}</div>
      {sub && <div className="text-[11px] text-ink-soft mt-0.5">{sub}</div>}
    </div>
  );
}

// ── Filter bar ─────────────────────────────────────────────────────────────

function FilterBar({
  stateFilter,
  onStateFilter,
  timeFilter,
  onTimeFilter,
  search,
  onSearch,
  counts,
}: {
  stateFilter: StateFilter;
  onStateFilter: (s: StateFilter) => void;
  timeFilter: TimeFilter;
  onTimeFilter: (t: TimeFilter) => void;
  search: string;
  onSearch: (s: string) => void;
  counts: { all: number; active: number; viewed: number; confirmed: number; stale: number };
}) {
  const stateChips: { key: StateFilter; label: string; count: number }[] = [
    { key: "all", label: "All", count: counts.all },
    { key: "active", label: "Awaiting open", count: counts.active },
    { key: "viewed", label: "Opened, not confirmed", count: counts.viewed },
    { key: "confirmed", label: "Confirmed", count: counts.confirmed },
    { key: "stale", label: "Follow-up needed", count: counts.stale },
  ];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 items-center">
        {stateChips.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => onStateFilter(c.key)}
            className={cn(
              "inline-flex items-center gap-1.5 text-xs rounded-full px-3 py-1.5 transition border",
              stateFilter === c.key
                ? "bg-primary text-white border-primary"
                : "bg-card text-ink-soft border-border hover:text-foreground",
            )}
          >
            {c.label}
            <span
              className={cn(
                "tabular-nums text-[10px] font-medium rounded-full px-1.5 py-px",
                stateFilter === c.key
                  ? "bg-white/20 text-white"
                  : "bg-sidebar-accent/40 text-ink-soft",
              )}
            >
              {c.count}
            </span>
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1.5 text-xs">
          <Clock className="h-3.5 w-3.5 text-ink-soft" />
          <span className="text-ink-soft">Range:</span>
          {(["7d", "30d", "all"] as TimeFilter[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => onTimeFilter(t)}
              className={cn(
                "rounded-full px-2.5 py-1 transition",
                timeFilter === t
                  ? "bg-foreground text-background"
                  : "text-ink-soft hover:text-foreground",
              )}
            >
              {t === "7d" ? "Last 7 days" : t === "30d" ? "Last 30 days" : "All time"}
            </button>
          ))}
        </div>
        <div className="ml-auto relative">
          <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-soft" />
          <input
            type="text"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search practice or email…"
            className="pl-8 pr-3 py-1.5 text-xs rounded-full border border-border bg-card w-[240px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:border-primary/40"
          />
        </div>
      </div>
    </div>
  );
}

// ── Table ──────────────────────────────────────────────────────────────────

function SendsTable({ rows }: { rows: (RepSendIntentRow & { isStale: boolean })[] }) {
  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="hidden md:grid grid-cols-[1.5fr_1fr_1.5fr_1.5fr_auto] gap-3 px-4 py-2.5 border-b border-border bg-sidebar-accent/20 text-[10px] uppercase tracking-wider font-semibold text-ink-soft">
        <div>Practice</div>
        <div className="text-right">Total</div>
        <div>Sent to</div>
        <div>Status</div>
        <div></div>
      </div>
      <ul className="divide-y divide-border">
        {rows.map((r) => (
          <SendRow key={r.token} row={r} />
        ))}
      </ul>
    </div>
  );
}

function SendRow({ row }: { row: RepSendIntentRow & { isStale: boolean } }) {
  return (
    <li className="px-4 py-3 hover:bg-sidebar-accent/10 transition">
      <div className="grid grid-cols-1 md:grid-cols-[1.5fr_1fr_1.5fr_1.5fr_auto] gap-3 items-center">
        <div className="min-w-0">
          {row.practiceAccountId ? (
            <Link
              to="/app/rep/accounts/$accountId"
              params={{ accountId: row.practiceAccountId }}
              className="font-medium text-foreground hover:text-primary truncate block"
              title={`Open ${row.practiceTitle}`}
            >
              {row.practiceTitle}
            </Link>
          ) : (
            <div className="font-medium text-foreground truncate">{row.practiceTitle}</div>
          )}
          {row.putsThemAtTier && (
            <div className="text-[11px] text-ink-soft mt-0.5 flex items-center gap-1">
              <Sparkles className="h-3 w-3" />
              Reaches {row.putsThemAtTier}
            </div>
          )}
        </div>

        <div className="md:text-right font-semibold tabular-nums text-foreground">
          {usd(row.totalUsd)}
        </div>

        <div className="min-w-0">
          <div className="text-sm text-foreground truncate" title={row.practiceEmail}>
            {row.practiceEmail}
          </div>
          <div className="text-[11px] text-ink-soft">{formatRelative(row.sentAt)}</div>
        </div>

        <div className="min-w-0">
          <StatusChip row={row} />
        </div>

        <div className="flex items-center gap-1 justify-self-end">
          <a
            href={`/order/${row.token}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[11px] text-ink-soft hover:text-foreground rounded-md px-2 py-1.5 hover:bg-sidebar-accent/30 transition"
            title="View as the practice owner sees it"
          >
            <ExternalLink className="h-3 w-3" />
            <span className="hidden lg:inline">View page</span>
          </a>
          {row.turnId && (
            <Link
              to="/app/rep"
              search={{ turn: row.turnId, preset: "all", q: "", status: [] }}
              className="inline-flex items-center gap-1 text-[11px] text-ink-soft hover:text-foreground rounded-md px-2 py-1.5 hover:bg-sidebar-accent/30 transition"
              title="Jump to the chat reply that produced this order"
            >
              <MessageSquare className="h-3 w-3" />
              <span className="hidden lg:inline">Open chat</span>
            </Link>
          )}
        </div>
      </div>
      {row.confirmedNote && (
        <div className="mt-2 ml-0 md:ml-0 text-[12px] text-emerald-900/80 bg-emerald-50/40 border border-emerald-100 rounded-md px-3 py-2 leading-snug">
          <span className="font-medium text-emerald-700">
            {row.confirmedByName ? `${row.confirmedByName} said:` : "They wrote back:"}
          </span>{" "}
          <span className="italic">"{row.confirmedNote}"</span>
        </div>
      )}
    </li>
  );
}

function StatusChip({ row }: { row: RepSendIntentRow & { isStale: boolean } }) {
  if (row.state === "revoked") {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] rounded-full px-2 py-1 bg-rose-50 text-rose-700 border border-rose-100">
        Revoked
      </span>
    );
  }
  if (row.state === "confirmed") {
    return (
      <span className="inline-flex flex-col items-start gap-0.5 text-[11px]">
        <span className="inline-flex items-center gap-1 text-emerald-700 font-medium">
          <BadgeCheck className="h-3 w-3" />
          Confirmed{row.confirmedByName ? ` by ${row.confirmedByName}` : ""}
        </span>
        {row.confirmedAt && (
          <span className="text-[10px] text-ink-soft">{formatRelative(row.confirmedAt)}</span>
        )}
      </span>
    );
  }
  if (row.state === "viewed") {
    return (
      <span className="inline-flex flex-col items-start gap-0.5 text-[11px]">
        <span className="inline-flex items-center gap-1 text-slate-700">
          <Eye className="h-3 w-3" />
          Opened
          {row.viewCount > 1 ? (
            <span className="text-ink-soft">· {row.viewCount}×</span>
          ) : null}
        </span>
        {row.firstViewedAt && (
          <span className="text-[10px] text-ink-soft">{formatRelative(row.firstViewedAt)}</span>
        )}
        {row.isStale && (
          <span className="inline-flex items-center gap-1 text-amber-700 text-[10px] font-medium mt-0.5">
            <AlertCircle className="h-2.5 w-2.5" />
            Worth a follow-up
          </span>
        )}
      </span>
    );
  }
  // active
  return (
    <span className="inline-flex flex-col items-start gap-0.5 text-[11px]">
      <span className="inline-flex items-center gap-1 text-ink-soft">
        <CheckCircle2 className="h-3 w-3 text-emerald-600" />
        Sent — awaiting open
      </span>
      {row.isStale && (
        <span className="inline-flex items-center gap-1 text-amber-700 text-[10px] font-medium mt-0.5">
          <AlertCircle className="h-2.5 w-2.5" />
          Worth a follow-up
        </span>
      )}
    </span>
  );
}

// ── Empty state ────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="rounded-2xl border border-dashed border-border bg-card/40 px-8 py-16 text-center">
      <Mail className="h-7 w-7 text-ink-soft mx-auto" />
      <h2 className="mt-3 text-base font-semibold text-foreground">No sends yet</h2>
      <p className="mt-1 text-sm text-ink-soft max-w-md mx-auto leading-relaxed">
        Build a sample order with Liz, then hit <strong>Send to practice</strong> under her reply.
        Once you send your first one, it'll show up here with open + confirm tracking.
      </p>
      <Link
        to="/app/rep"
        className="inline-flex items-center gap-1.5 mt-5 rounded-full bg-primary px-4 py-2 text-xs font-medium text-white hover:opacity-90"
      >
        <Sparkles className="h-3.5 w-3.5" />
        Open Liz chat
      </Link>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function computeIsStale(r: RepSendIntentRow, nowMs: number): boolean {
  if (r.state === "confirmed" || r.state === "revoked") return false;
  const sentMs = new Date(r.sentAt).getTime();
  // Active for too long without an open → stale
  if (r.state === "active") {
    return nowMs - sentMs > STALE_NO_OPEN_DAYS * 24 * 60 * 60 * 1000;
  }
  // Opened but not confirmed for too long → stale
  if (r.state === "viewed" && r.firstViewedAt) {
    const openedMs = new Date(r.firstViewedAt).getTime();
    return nowMs - openedMs > STALE_NO_CONFIRM_DAYS * 24 * 60 * 60 * 1000;
  }
  return false;
}

function usd(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function formatRelative(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: diffDay > 365 ? "numeric" : undefined,
  });
}
