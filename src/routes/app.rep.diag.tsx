/**
 * /app/rep/diag — Layer 3 of the eval loop: in-app diag surface.
 *
 * Same data the `scripts/diag-liz.ts` CLI shows, rendered as a scrollable
 * feed in the browser. Per (user-prompt, agent-reply) pair: the prompt, the
 * tool calls that fired in that turn's time window, the reply (truncated +
 * expandable), the rating + reason if set, and any anti-pattern flags
 * (EMPTY-PREAMBLE / CLIFFHANGER / DATA-CLAIM-NO-QUERY / MISSING-PULLBACK).
 *
 * Filter toggle: "Only flagged" hides clean turns so you can see just the
 * failures at a glance.
 *
 * Self-serve — no Claude in the loop needed to spot anti-patterns. Refresh
 * pulls a fresh snapshot.
 *
 * Established 2026-05-10 (v296). Backed by the `getLizDiagFeed` server fn
 * in liz-chat.functions.ts.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowLeft,
  Loader2,
  RefreshCw,
  ThumbsDown,
  ThumbsUp,
  Wrench,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { supabase } from "@/integrations/supabase/client";
import {
  getLizDiagFeed,
  type LizDiagFeed,
  type LizDiagPair,
  type LizDiagFlag,
} from "@/server/liz-chat.functions";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/rep/diag")({
  component: LizDiagPage,
});

function LizDiagPage() {
  const [feed, setFeed] = useState<LizDiagFeed | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const [lastN, setLastN] = useState(8);

  async function load({ silent = false }: { silent?: boolean } = {}) {
    if (!silent) setLoading(true);
    setRefreshing(true);
    try {
      const { data: session } = await supabase.auth.getSession();
      const accessToken = session.session?.access_token;
      if (!accessToken) {
        toast.error("Please sign in to view Liz diag.");
        setLoading(false);
        setRefreshing(false);
        return;
      }
      const result = await getLizDiagFeed({ data: { accessToken, lastN } });
      setFeed(result);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't load diag.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastN]);

  const pairs = feed?.pairs ?? [];
  const displayed = onlyFlagged ? pairs.filter((p) => p.flags.length > 0) : pairs;
  const flagCounts = pairs.reduce<Record<string, number>>((acc, p) => {
    for (const f of p.flags) acc[f.kind] = (acc[f.kind] ?? 0) + 1;
    return acc;
  }, {});
  const totalFlags = Object.values(flagCounts).reduce((a, b) => a + b, 0);

  return (
    <div className="flex flex-col min-h-screen bg-background">
      <PageHeader
        eyebrow="Lizzie(OS) · Eval"
        title="Liz diag"
        description="Recent chat turns + tool-call traces + auto-flagged anti-patterns. Self-serve view of what scripts/diag-liz.ts reports."
        breadcrumbs={[
          { label: "Liz", to: "/app/rep" },
          { label: "Diag" },
        ]}
        actions={
          <div className="flex items-center gap-2">
            <Link
              to="/app/rep"
              className="inline-flex items-center gap-1.5 text-xs text-ink-soft hover:text-foreground rounded-full border border-border px-3 py-1.5"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back to Liz
            </Link>
            <button
              type="button"
              onClick={() => load({ silent: true })}
              disabled={refreshing}
              className="inline-flex items-center gap-1.5 text-xs text-ink-soft hover:text-foreground rounded-full border border-border px-3 py-1.5 disabled:opacity-50"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
              Refresh
            </button>
          </div>
        }
      />

      <div className="flex-1 px-4 py-4 lg:px-10 max-w-5xl mx-auto w-full">
        {/* Summary strip */}
        <div className="rounded-xl border border-border bg-card px-4 py-3 mb-4 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-4 text-xs text-ink-soft">
            <div>
              <span className="font-mono text-foreground">{pairs.length}</span> turn{pairs.length === 1 ? "" : "s"} loaded
            </div>
            <div className={cn(totalFlags > 0 ? "text-amber-600" : "")}>
              <span className="font-mono">{totalFlags}</span> flag{totalFlags === 1 ? "" : "s"} raised
            </div>
            {Object.entries(flagCounts).map(([k, v]) => (
              <FlagChip key={k} kind={k as LizDiagFlag["kind"]} count={v} compact />
            ))}
          </div>
          <div className="flex items-center gap-2">
            <label className="inline-flex items-center gap-1.5 text-xs text-ink-soft">
              Show
              <select
                value={lastN}
                onChange={(e) => setLastN(parseInt(e.target.value, 10))}
                className="rounded-full border border-border bg-card px-2 py-0.5 text-xs"
              >
                <option value={4}>4</option>
                <option value={8}>8</option>
                <option value={16}>16</option>
                <option value={30}>30</option>
              </select>
              recent
            </label>
            <label className="inline-flex items-center gap-1.5 text-xs text-ink-soft">
              <input
                type="checkbox"
                checked={onlyFlagged}
                onChange={(e) => setOnlyFlagged(e.target.checked)}
                className="h-3.5 w-3.5"
              />
              Only flagged
            </label>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center text-sm text-ink-soft py-12">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            Loading diag…
          </div>
        ) : displayed.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-card/30 px-4 py-12 text-center text-sm text-ink-soft">
            {onlyFlagged
              ? "No flagged turns in the recent window. Liz is behaving."
              : "No chat history yet. Go to Liz and ask her something."}
          </div>
        ) : (
          <div className="space-y-3">
            {displayed.map((p) => (
              <PairCard key={p.id} pair={p} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PairCard({ pair }: { pair: LizDiagPair }) {
  const [expanded, setExpanded] = useState(false);
  const reply = pair.agentReply ?? "";
  const replyTruncated = !expanded && reply.length > 700 ? reply.slice(0, 700) + "…" : reply;
  return (
    <div
      className={cn(
        "rounded-xl border bg-card overflow-hidden",
        pair.flags.length > 0 ? "border-amber-400/40" : "border-border",
      )}
    >
      {/* Header: timestamp + rating */}
      <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-border bg-bg-card-sub/30">
        <div className="text-[11px] font-mono text-ink-soft">
          {pair.agentAt ?? pair.userAt ?? "?"}
        </div>
        <div className="flex items-center gap-2">
          {pair.rating === "up" && (
            <span className="inline-flex items-center gap-1 text-[10px] font-medium rounded-full bg-emerald-500/15 text-emerald-500 px-2 py-0.5">
              <ThumbsUp className="h-3 w-3" /> rated good
            </span>
          )}
          {pair.rating === "down" && (
            <span
              className="inline-flex items-center gap-1 text-[10px] font-medium rounded-full bg-rose-500/15 text-rose-500 px-2 py-0.5"
              title={pair.ratingNote ?? ""}
            >
              <ThumbsDown className="h-3 w-3" />
              rated bad{pair.ratingNote ? `: ${pair.ratingNote}` : ""}
            </span>
          )}
        </div>
      </div>

      {/* User prompt */}
      {pair.userPrompt && (
        <div className="px-4 py-2.5 border-b border-border bg-primary/5">
          <div className="text-[10px] uppercase tracking-wider font-bold text-ink-soft mb-1">🧑 User</div>
          <div className="text-sm text-foreground leading-snug">{pair.userPrompt}</div>
        </div>
      )}

      {/* Tool calls */}
      <div className="px-4 py-2.5 border-b border-border">
        <div className="text-[10px] uppercase tracking-wider font-bold text-ink-soft mb-1.5 flex items-center gap-1.5">
          <Wrench className="h-3 w-3" />
          Tool calls ({pair.toolCalls.length})
        </div>
        {pair.toolCalls.length === 0 ? (
          <div className="text-xs text-ink-soft italic">(none fired in window)</div>
        ) : (
          <div className="space-y-1">
            {pair.toolCalls.map((c, i) => (
              <div
                key={i}
                className="flex items-center gap-2 text-xs font-mono text-ink-soft bg-bg-card-sub/40 rounded px-2 py-1"
              >
                <span className="flex-1 truncate" title={c.incomingBody}>
                  {c.incomingBody}
                </span>
                <span className="font-bold text-foreground">→ {c.resultCount}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Agent reply */}
      {pair.agentReply && (
        <div className="px-4 py-2.5">
          <div className="text-[10px] uppercase tracking-wider font-bold text-ink-soft mb-1">🤖 Liz ({reply.length} chars)</div>
          <div className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">{replyTruncated}</div>
          {reply.length > 700 && (
            <button
              type="button"
              onClick={() => setExpanded((x) => !x)}
              className="mt-1 text-[11px] text-primary hover:underline"
            >
              {expanded ? "Show less" : `Show full reply (+${reply.length - 700} chars)`}
            </button>
          )}
        </div>
      )}

      {/* Flags */}
      {pair.flags.length > 0 && (
        <div className="px-4 py-2.5 border-t border-border bg-amber-500/5">
          <div className="text-[10px] uppercase tracking-wider font-bold text-amber-600 mb-1.5 flex items-center gap-1.5">
            <AlertTriangle className="h-3 w-3" />
            Anti-patterns ({pair.flags.length})
          </div>
          <div className="space-y-1">
            {pair.flags.map((f, i) => (
              <div key={i} className="text-xs">
                <FlagChip kind={f.kind} />
                <span className="text-ink-soft ml-2">{f.detail}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function FlagChip({ kind, count, compact }: { kind: LizDiagFlag["kind"]; count?: number; compact?: boolean }) {
  const palette: Record<LizDiagFlag["kind"], string> = {
    "EMPTY-PREAMBLE": "bg-rose-500/15 text-rose-600 border-rose-400/40",
    CLIFFHANGER: "bg-orange-500/15 text-orange-600 border-orange-400/40",
    "DATA-CLAIM-NO-QUERY": "bg-amber-500/15 text-amber-700 border-amber-400/40",
    "MISSING-PULLBACK": "bg-sky-500/15 text-sky-600 border-sky-400/40",
    "HARD-TRUNCATION": "bg-red-600/15 text-red-700 border-red-500/40",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[10px] font-bold rounded-full border px-2 py-0.5 uppercase tracking-wider",
        palette[kind],
        compact && "tracking-tight px-1.5 py-px",
      )}
    >
      {kind}
      {count !== undefined && <span className="font-mono ml-0.5">×{count}</span>}
    </span>
  );
}
