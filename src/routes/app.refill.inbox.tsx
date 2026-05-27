/**
 * /app/refill/inbox — patient-reply inbox (v359, Pillar 6 UI).
 *
 * Every patient reply to an Emma blast (SMS or email) lands here.
 * Click events stay in Reports; this surface is for conversation.
 *
 * Layout mirrors /app/rep/inbox so reps and spas have the same
 * mental model: filter chips → list → click row to expand thread.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  ArrowLeft,
  ArrowRight,
  Ban,
  ChevronDown,
  ChevronRight,
  Inbox,
  Loader2,
  Mail,
  MailOpen,
  MessageSquare,
  RefreshCw,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { supabase } from "@/integrations/supabase/client";
import {
  getInboxThread,
  listPatientInbox,
  markInboxRead,
  type InboxRow,
  type InboxThreadMessage,
} from "@/server/emma-inbox.functions";
import { useShell } from "@/lib/shell";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/refill/inbox")({
  component: InboxPage,
});

type Filter = "unread" | "today" | "all";

function InboxPage() {
  // v411.5 — brand-aware constants per [[project-refill-trojan-horse-thesis]].
  // On emma.agentiport.com (shell=karen): Emma(OS) brand + Karen agent name +
  // Campaigns is a real surface to back-link to. On app.getrefill.app
  // (shell=refill): Refill brand + Refill (no separate agent persona) +
  // Campaigns doesn't exist in the 4-chip nav so we back-link to Recovery.
  const shell = useShell();
  const isRefill = shell === "refill";
  const brandHeader = isRefill ? "Refill" : "Emma(OS)";
  const agentName = isRefill ? "Refill" : "Karen";
  const backRoute = isRefill ? "/app/refill/recovery" : "/app/refill/campaigns";
  const backLabel = isRefill ? "Back to Recovery" : "Back to Campaigns";

  const [rows, setRows] = useState<InboxRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<Filter>("unread");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [threads, setThreads] = useState<Map<string, InboxThreadMessage[]>>(
    new Map(),
  );

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setRefreshing(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        toast.error("Please sign in.");
        return;
      }
      const fresh = await listPatientInbox({ data: { accessToken: token } });
      setRows(fresh);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't load inbox.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function markRead(outreachId: string) {
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) return;
      await markInboxRead({ data: { accessToken: token, outreachId } });
      setRows((prev) =>
        prev.map((r) =>
          r.outreachId === outreachId
            ? { ...r, readAt: new Date().toISOString() }
            : r,
        ),
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't mark as read.");
    }
  }

  async function loadThread(stateId: string) {
    if (threads.has(stateId)) return;
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) return;
      const msgs = await getInboxThread({ data: { accessToken: token, stateId } });
      setThreads((prev) => {
        const next = new Map(prev);
        next.set(stateId, msgs);
        return next;
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't load thread.");
    }
  }

  function toggleExpand(row: InboxRow) {
    const opening = expandedId !== row.outreachId;
    setExpandedId(opening ? row.outreachId : null);
    if (opening) {
      void loadThread(row.stateId);
      if (!row.readAt) void markRead(row.outreachId);
    }
  }

  const counts = useMemo(() => {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const startMs = startOfDay.getTime();
    let unread = 0;
    let today = 0;
    for (const r of rows) {
      if (!r.readAt) unread++;
      if (new Date(r.receivedAt).getTime() >= startMs) today++;
    }
    return { unread, today, all: rows.length };
  }, [rows]);

  const visible = useMemo(() => {
    if (filter === "all") return rows;
    if (filter === "unread") return rows.filter((r) => !r.readAt);
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const startMs = startOfDay.getTime();
    return rows.filter((r) => new Date(r.receivedAt).getTime() >= startMs);
  }, [rows, filter]);

  return (
    <div className="flex flex-col min-h-screen bg-background">
      <PageHeader
        eyebrow={brandHeader}
        title="Inbox"
        description={`Every patient reply to your outreach lands here. ${agentName} auto-responds to SMS in real time; this is your view of the conversation.`}
        breadcrumbs={[{ label: brandHeader, to: "/app/refill" }, { label: "Inbox" }]}
        actions={
          <button
            type="button"
            onClick={() => void load(true)}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 text-xs text-ink-soft hover:text-foreground rounded-full border border-border px-3 py-1.5 disabled:opacity-50"
            title="Refresh"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
            <span className="hidden sm:inline">Refresh</span>
          </button>
        }
      />

      <div className="flex-1 px-6 lg:px-10 py-6 space-y-5 max-w-5xl w-full mx-auto">
        <div className="flex items-center gap-2 flex-wrap">
          <FilterChip
            label="Unread"
            count={counts.unread}
            active={filter === "unread"}
            accent="primary"
            onClick={() => setFilter("unread")}
          />
          <FilterChip
            label="Today"
            count={counts.today}
            active={filter === "today"}
            onClick={() => setFilter("today")}
          />
          <FilterChip
            label="All"
            count={counts.all}
            active={filter === "all"}
            onClick={() => setFilter("all")}
          />
        </div>

        {loading ? (
          <div className="flex items-center justify-center text-sm text-ink-soft py-16">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            Pulling replies…
          </div>
        ) : visible.length === 0 ? (
          <EmptyInbox
            filter={filter}
            totalRows={rows.length}
            agentName={agentName}
            backRoute={backRoute}
            backLabel={backLabel}
          />
        ) : (
          <section className="rounded-xl border border-border bg-card overflow-hidden">
            <ul className="divide-y divide-border">
              {visible.map((r) => (
                <InboxItem
                  key={r.outreachId}
                  row={r}
                  expanded={expandedId === r.outreachId}
                  thread={threads.get(r.stateId) ?? null}
                  onToggle={() => toggleExpand(r)}
                  onMarkRead={() => void markRead(r.outreachId)}
                />
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

// ─── Filter chip ──────────────────────────────────────────────────────────

function FilterChip({
  label,
  count,
  active,
  accent,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  accent?: "primary";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-xs font-medium transition",
        active
          ? accent === "primary"
            ? "bg-emerald text-paper border-emerald"
            : "bg-foreground text-background border-foreground"
          : "bg-card text-ink-soft border-border hover:text-foreground",
      )}
    >
      <span>{label}</span>
      <span
        className={cn(
          "tabular-nums rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
          active ? "bg-background/20 text-current" : "bg-muted text-ink-soft",
        )}
      >
        {count}
      </span>
    </button>
  );
}

// ─── Inbox row + thread ───────────────────────────────────────────────────

function InboxItem({
  row,
  expanded,
  thread,
  onToggle,
}: {
  row: InboxRow;
  expanded: boolean;
  thread: InboxThreadMessage[] | null;
  onToggle: () => void;
  onMarkRead: () => void;
}) {
  const isUnread = !row.readAt;
  const snippet = useMemo(() => {
    return row.body.replace(/\s+/g, " ").trim().slice(0, 140);
  }, [row.body]);
  const ago = useMemo(() => timeAgo(row.receivedAt), [row.receivedAt]);

  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        className="w-full text-left px-5 py-3.5 hover:bg-sidebar-accent/10 transition flex items-start gap-3"
      >
        <div className="pt-1">
          {isUnread ? (
            <Mail className="h-4 w-4 text-emerald" />
          ) : (
            <MailOpen className="h-4 w-4 text-ink-soft/60" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className={cn(
                "font-medium text-sm",
                isUnread ? "text-foreground" : "text-ink-soft",
              )}
            >
              {row.patientName}
            </span>
            <ChannelChip channel={row.channel} />
            {row.optedOut && <OptOutBadge />}
            {row.campaignTitle && (
              <span className="text-[11px] text-ink-soft">
                · {row.campaignTitle}
              </span>
            )}
            <span className="ml-auto text-[11px] text-ink-soft tabular-nums">
              {ago}
            </span>
          </div>
          {row.subject && (
            <div
              className={cn(
                "text-xs mt-0.5",
                isUnread ? "text-foreground" : "text-ink-soft",
              )}
            >
              {row.subject}
            </div>
          )}
          <div className="text-xs text-ink-soft mt-0.5 line-clamp-1">
            {snippet}
          </div>
        </div>
        <div className="pt-1 text-ink-soft/60 shrink-0">
          {expanded ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </div>
      </button>

      {expanded && (
        <div className="px-5 pb-5 pt-1 bg-muted/10 border-t border-border">
          <ThreadView row={row} thread={thread} />
        </div>
      )}
    </li>
  );
}

function ThreadView({
  row,
  thread,
}: {
  row: InboxRow;
  thread: InboxThreadMessage[] | null;
}) {
  if (thread === null) {
    return (
      <div className="flex items-center gap-2 text-xs text-ink-soft py-3">
        <Loader2 className="h-3 w-3 animate-spin" />
        Loading conversation…
      </div>
    );
  }

  const messages = thread.filter((m) => {
    // Hide click events (channel='link') from the thread — they're not
    // conversation and would clutter the read.
    if (m.direction === "inbound" && m.channel === "link") return false;
    // Hide skipped outbound rows — those represent compliance refusals
    // (no message actually went out). Reports surfaces them.
    if (m.direction === "outbound" && m.skipReason) return false;
    return true;
  });

  return (
    <div className="space-y-3 pt-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] text-ink-soft">
          {row.patientPhone && <span>{row.patientPhone} · </span>}
          {row.patientEmail && <span>{row.patientEmail}</span>}
        </div>
        {row.campaignId && (
          <Link
            to="/app/refill/campaigns/$campaignId"
            params={{ campaignId: row.campaignId }}
            className="inline-flex items-center gap-1 text-[11px] text-ink-soft hover:text-foreground"
          >
            View campaign
            <ArrowRight className="h-3 w-3" />
          </Link>
        )}
      </div>
      <div className="space-y-2">
        {messages.map((m) => (
          <MessageBubble key={m.outreachId} message={m} />
        ))}
      </div>
      {messages.length === 0 && (
        <div className="text-xs text-ink-soft italic py-2">
          No conversation history yet.
        </div>
      )}
    </div>
  );
}

function MessageBubble({ message }: { message: InboxThreadMessage }) {
  const isOutbound = message.direction === "outbound";
  return (
    <div className={cn("flex", isOutbound ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[80%] rounded-2xl px-3.5 py-2 text-sm",
          isOutbound
            ? "bg-emerald text-paper rounded-br-sm"
            : "bg-card border border-border rounded-bl-sm",
        )}
      >
        {message.subject && (
          <div
            className={cn(
              "text-[11px] font-medium mb-1",
              isOutbound ? "text-paper/80" : "text-ink-soft",
            )}
          >
            {message.subject}
          </div>
        )}
        <div className="whitespace-pre-wrap break-words leading-relaxed">
          {message.body}
        </div>
        <div
          className={cn(
            "text-[10px] mt-1 flex items-center gap-1.5",
            isOutbound ? "text-paper/70" : "text-ink-soft",
          )}
        >
          <ChannelChip channel={message.channel} mini />
          <span>{new Date(message.at).toLocaleString()}</span>
        </div>
      </div>
    </div>
  );
}

// ─── Chips ────────────────────────────────────────────────────────────────

function ChannelChip({
  channel,
  mini,
}: {
  channel: string;
  mini?: boolean;
}) {
  const isSms = channel === "sms";
  const isEmail = channel === "email";
  const Icon = isSms ? MessageSquare : isEmail ? Mail : Inbox;
  const label = isSms ? "SMS" : isEmail ? "Email" : channel;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full",
        mini
          ? "px-1 py-0 text-[9px]"
          : "px-1.5 py-0.5 text-[10px] font-medium bg-muted/40 text-ink-soft",
      )}
    >
      <Icon className={cn(mini ? "h-2.5 w-2.5" : "h-2.5 w-2.5")} />
      {label}
    </span>
  );
}

function OptOutBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 text-destructive px-1.5 py-0.5 text-[10px] font-medium">
      <Ban className="h-2.5 w-2.5" />
      Opted out
    </span>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────

function EmptyInbox({
  filter,
  totalRows,
  agentName,
  backRoute,
  backLabel,
}: {
  filter: Filter;
  totalRows: number;
  agentName: string;
  backRoute: string;
  backLabel: string;
}) {
  return (
    <div className="rounded-2xl border border-border bg-card p-10 text-center">
      <div className="mx-auto h-12 w-12 rounded-full bg-muted/40 flex items-center justify-center mb-3">
        <Inbox className="h-6 w-6 text-ink-soft" />
      </div>
      {totalRows === 0 ? (
        <>
          <h2 className="text-lg font-semibold text-foreground mb-1">
            No replies yet
          </h2>
          <p className="text-sm text-ink-soft mb-5 max-w-md mx-auto">
            When patients reply to your campaigns, you'll see the conversation here.
            {" "}{agentName} auto-responds to SMS in real time — this is your transcript view.
          </p>
          <Link
            to={backRoute}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald text-paper px-4 py-2 text-sm font-medium hover:opacity-90 transition"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            {backLabel}
          </Link>
        </>
      ) : (
        <p className="text-sm text-ink-soft">
          {filter === "unread"
            ? "All caught up — no unread replies."
            : "No replies match this filter."}
        </p>
      )}
    </div>
  );
}

// ─── Time formatter ───────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
