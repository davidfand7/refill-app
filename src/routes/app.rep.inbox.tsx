/**
 * /app/rep/inbox — Promo Reply Inbox (v338).
 *
 * The first conversational surface in Lizzie(OS). Every email reply to a
 * promo blast routes here via the Resend inbound webhook
 * (POST /api/resend/inbound → routeInboundPromoReply). The rep sees:
 *
 *   - Filter chips: Unread (default) · Today · All
 *   - Per-row: account · promo · subject · 1-line snippet · time-ago · unread dot
 *   - Click-to-expand: full reply body above the outbound parent it answered
 *   - Mark-as-read on expand (auto-mark + manual button for re-read flow)
 *
 * Loader: listPromoInbox server-fn (capped 50 rows, sent_at desc). Demo
 * mode honored via useViewAs(). No new shell — the rep gets here from
 * the Today dashboard "Unread replies" card or by manually typing the
 * URL (no top-nav entry yet — Today is the canonical surface).
 *
 * v339 will add: auto-drafted reply composer with the [VERIFIED] convention.
 * v340 will add: scheduled follow-up cadence digest.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  Mail,
  MailOpen,
  RefreshCw,
  RotateCcw,
  Send,
  Sparkles,
  Tag,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { supabase } from "@/integrations/supabase/client";
import {
  listPromoInbox,
  markInboxRead,
  regenerateInboundReplyDraft,
  sendInboundReplyDraft,
  type DraftVerifiedBlock,
  type InboxRow,
} from "@/server/promotions.functions";
import { useViewAs } from "@/lib/demo-mode";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/rep/inbox")({
  component: InboxPage,
});

type Filter = "unread" | "today" | "all";

function InboxPage() {
  const viewAs = useViewAs();
  const [rows, setRows] = useState<InboxRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<Filter>("unread");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  async function load({ silent = false }: { silent?: boolean } = {}) {
    if (!silent) setLoading(true);
    setRefreshing(true);
    try {
      const { data: session } = await supabase.auth.getSession();
      const accessToken = session.session?.access_token;
      if (!accessToken) {
        toast.error("Please sign in.");
        setLoading(false);
        setRefreshing(false);
        return;
      }
      const fresh = await listPromoInbox({ data: { accessToken, viewAs } });
      setRows(fresh);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't load your inbox.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewAs]);

  async function markRead(outreachId: string) {
    try {
      const { data: session } = await supabase.auth.getSession();
      const accessToken = session.session?.access_token;
      if (!accessToken) return;
      await markInboxRead({ data: { accessToken, outreachId } });
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

  function toggleExpand(row: InboxRow) {
    const opening = expandedId !== row.outreachId;
    setExpandedId(opening ? row.outreachId : null);
    if (opening && !row.readAt) {
      void markRead(row.outreachId);
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
      if (new Date(r.sentAt).getTime() >= startMs) today++;
    }
    return { unread, today, all: rows.length };
  }, [rows]);

  const visible = useMemo(() => {
    if (filter === "all") return rows;
    if (filter === "unread") return rows.filter((r) => !r.readAt);
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const startMs = startOfDay.getTime();
    return rows.filter((r) => new Date(r.sentAt).getTime() >= startMs);
  }, [rows, filter]);

  return (
    <div className="flex flex-col min-h-screen bg-background">
      <PageHeader
        eyebrow="Lizzie(OS)"
        title="Inbox"
        description="Practice-owner replies to your promo blasts. Liz routes every reply here so nothing falls through."
        breadcrumbs={[{ label: "Liz", to: "/app/rep" }, { label: "Inbox" }]}
        actions={
          <div className="flex items-center gap-2">
            <Link
              to="/app/rep/today"
              className="inline-flex items-center gap-1.5 text-xs text-ink-soft hover:text-foreground rounded-full border border-border px-3 py-1.5"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back to Today
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
              <span className="hidden sm:inline">Refresh</span>
            </button>
          </div>
        }
      />

      <div className="flex-1 px-6 lg:px-10 py-6 space-y-5 max-w-5xl w-full mx-auto">
        {/* Filter chips */}
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
            Pulling your replies…
          </div>
        ) : visible.length === 0 ? (
          <EmptyState filter={filter} totalRows={rows.length} />
        ) : (
          <section className="rounded-xl border border-border bg-card overflow-hidden">
            <ul className="divide-y divide-border">
              {visible.map((r) => (
                <InboxItem
                  key={r.outreachId}
                  row={r}
                  expanded={expandedId === r.outreachId}
                  viewAs={viewAs}
                  onToggle={() => toggleExpand(r)}
                  onMarkRead={() => void markRead(r.outreachId)}
                  onSent={() => void load({ silent: true })}
                />
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

// ── Filter chip ───────────────────────────────────────────────────────────

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
            ? "bg-primary text-primary-foreground border-primary"
            : "bg-foreground text-background border-foreground"
          : "bg-card text-ink-soft border-border hover:text-foreground",
      )}
    >
      <span>{label}</span>
      <span
        className={cn(
          "tabular-nums rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
          active
            ? "bg-background/20 text-current"
            : "bg-muted text-ink-soft",
        )}
      >
        {count}
      </span>
    </button>
  );
}

// ── Inbox row ─────────────────────────────────────────────────────────────

function InboxItem({
  row,
  expanded,
  viewAs,
  onToggle,
  onMarkRead,
  onSent,
}: {
  row: InboxRow;
  expanded: boolean;
  viewAs: "demo" | undefined;
  onToggle: () => void;
  onMarkRead: () => void;
  onSent: () => void;
}) {
  const isUnread = !row.readAt;
  const snippet = useMemo(() => {
    const body = row.bodyText ?? "";
    return body.replace(/\s+/g, " ").trim().slice(0, 140);
  }, [row.bodyText]);
  // v339.2 + v339.3 fix: Gmail's plain-text export hard-wraps at ~76 chars
  // AND doubles newlines between wrapped lines (giving blank-line gaps mid-
  // sentence in the rendered view). Unwrap continuation lines: ANY run of
  // newlines preceded by a non-terminal char and followed by a lowercase
  // letter is treated as a hard-wrap and joined with a space. Then collapse
  // any remaining runs of 3+ newlines to 2 for clean paragraph breaks.
  const cleanBody = useMemo(() => {
    const raw = row.bodyText ?? "";
    return raw
      .replace(/\r\n/g, "\n")
      .replace(/([a-zA-Z0-9,])\n+([a-z])/g, "$1 $2")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }, [row.bodyText]);
  const ago = useMemo(() => timeAgo(row.sentAt), [row.sentAt]);

  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        className="w-full text-left px-5 py-3.5 hover:bg-sidebar-accent/10 transition flex items-start gap-3"
      >
        <div className="pt-1">
          {isUnread ? (
            <Mail className="h-4 w-4 text-primary" />
          ) : (
            <MailOpen className="h-4 w-4 text-ink-soft/60" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <span
                className={cn(
                  "text-sm truncate",
                  isUnread ? "font-semibold text-foreground" : "font-medium text-ink-soft",
                )}
              >
                {row.accountTitle ?? row.fromAddr ?? "Unknown sender"}
              </span>
              {row.promotionTitle && (
                <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-ink-soft shrink-0">
                  <Tag className="h-2.5 w-2.5" />
                  {row.promotionTitle}
                </span>
              )}
            </div>
            <span className="text-[11px] text-ink-soft shrink-0 tabular-nums">{ago}</span>
          </div>
          <div className="mt-0.5 text-xs text-foreground truncate">
            {row.subject ?? "(no subject)"}
          </div>
          {snippet && (
            <div className="mt-0.5 text-[12px] text-ink-soft truncate">{snippet}</div>
          )}
        </div>
        <div className="pt-1 shrink-0">
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-ink-soft/60" />
          ) : (
            <ChevronRight className="h-4 w-4 text-ink-soft/60" />
          )}
        </div>
      </button>

      {expanded && (
        <div className="bg-muted/40 border-t border-border px-5 py-4 space-y-3">
          {/* Parent outbound for context */}
          {row.parentOutboundSubject && (
            <details className="rounded-md border border-border bg-card/60">
              <summary className="cursor-pointer px-3 py-2 text-[11px] uppercase tracking-wider text-ink-soft font-medium select-none">
                You sent (
                {row.parentOutboundSentAt ? timeAgo(row.parentOutboundSentAt) : "earlier"}
                )
              </summary>
              <div className="px-3 pb-3 text-xs text-ink-soft whitespace-pre-wrap">
                <div className="font-medium text-foreground mb-1">
                  {row.parentOutboundSubject}
                </div>
                {row.parentOutboundBody}
              </div>
            </details>
          )}

          {/* The reply itself */}
          <div className="rounded-md border border-border bg-card px-4 py-3">
            <div className="flex items-center justify-between gap-2 mb-2">
              <div className="text-[11px] uppercase tracking-wider text-ink-soft font-medium">
                Reply from {row.fromAddr ?? "(unknown)"}
              </div>
              {isUnread && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onMarkRead();
                  }}
                  className="text-[11px] text-ink-soft hover:text-foreground rounded-full border border-border px-2.5 py-0.5"
                >
                  Mark read
                </button>
              )}
            </div>
            <div className="text-sm text-foreground whitespace-pre-wrap leading-relaxed">
              {cleanBody.length > 0
                ? cleanBody
                : (
                  <span className="text-ink-soft italic">(empty body)</span>
                )}
            </div>
            <div className="mt-3 pt-2 border-t border-border flex items-center justify-between gap-2 text-[11px] text-ink-soft">
              <div>
                State: <span className="font-medium text-foreground">{row.state}</span>
              </div>
              {row.accountId && (
                <Link
                  to="/app/rep/accounts/$accountId"
                  params={{ accountId: row.accountId }}
                  className="text-primary hover:underline inline-flex items-center gap-1"
                >
                  Open account <ChevronRight className="h-3 w-3" />
                </Link>
              )}
            </div>
          </div>

          {/* v339: Liz auto-draft composer */}
          <AutoDraftComposer row={row} viewAs={viewAs} onSent={onSent} />
        </div>
      )}
    </li>
  );
}

// ── AutoDraftComposer (v339) ───────────────────────────────────────────────
// Surfaces Liz's pre-drafted reply with the [VERIFIED] math chip. Rep edits
// subject + body inline, then one-clicks Send. The draft is generated
// synchronously when the inbound webhook lands (so for any reply older than
// ~10s it's already in the DB). If the draft hasn't generated yet, show a
// "still drafting" hint with a refresh button.

function AutoDraftComposer({
  row,
  viewAs,
  onSent,
}: {
  row: InboxRow;
  viewAs: "demo" | undefined;
  onSent: () => void;
}) {
  const hasDraft =
    typeof row.autoDraftSubject === "string" && typeof row.autoDraftBody === "string";

  const [subject, setSubject] = useState<string>(row.autoDraftSubject ?? "");
  const [body, setBody] = useState<string>(row.autoDraftBody ?? "");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  // Re-sync local form when the underlying row's draft fields change
  // (e.g. parent did a silent refresh after generation completed).
  useEffect(() => {
    if (sent) return; // never overwrite post-send confirmation state
    setSubject(row.autoDraftSubject ?? "");
    setBody(row.autoDraftBody ?? "");
  }, [row.autoDraftSubject, row.autoDraftBody, sent]);

  // v339.3: trigger fresh draft generation on demand. Used for:
  //   - Backfilling rows that predate v339 / had generation fail
  //   - Iterating on REPLY_SYSTEM_PROMPT without sending new emails
  async function handleRegenerate() {
    setRegenerating(true);
    try {
      const { data: session } = await supabase.auth.getSession();
      const accessToken = session.session?.access_token;
      if (!accessToken) {
        toast.error("Please sign in.");
        setRegenerating(false);
        return;
      }
      await regenerateInboundReplyDraft({
        data: { accessToken, outreachId: row.outreachId, viewAs },
      });
      toast.success("Liz redrafted the reply.");
      onSent(); // re-fetch the inbox so the new draft shows up
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't regenerate the draft.");
    } finally {
      setRegenerating(false);
    }
  }

  if (!hasDraft) {
    // v339.1: differentiate "still drafting" vs "predates v339 / draft failed".
    // v339.3: stale rows get a Regenerate button instead of just a static
    // "no auto-draft" message.
    const ageMs = Date.now() - new Date(row.sentAt).getTime();
    const isStale = ageMs > 60_000;
    if (isStale) {
      return (
        <div className="rounded-md border border-dashed border-border bg-card/40 px-4 py-3 text-[12px] text-ink-soft flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-3.5 w-3.5 opacity-50" />
            No auto-draft for this row yet. Liz can draft one now.
          </div>
          <button
            type="button"
            onClick={handleRegenerate}
            disabled={regenerating}
            className="inline-flex items-center gap-1.5 text-xs font-medium rounded-full bg-primary text-white px-3 py-1.5 hover:opacity-90 disabled:opacity-50"
          >
            {regenerating ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            {regenerating ? "Drafting…" : "Draft now"}
          </button>
        </div>
      );
    }
    return (
      <div className="rounded-md border border-dashed border-border bg-card/40 px-4 py-3 text-[12px] text-ink-soft">
        <div className="flex items-center gap-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Liz is drafting a reply… (usually takes 5-10s). Refresh the inbox if
          this sticks around longer than 30s.
        </div>
      </div>
    );
  }

  if (sent) {
    return (
      <div className="rounded-md border border-emerald-200 bg-emerald-50/60 px-4 py-3 text-[12px] text-emerald-800 inline-flex items-center gap-2">
        <Check className="h-3.5 w-3.5" />
        Reply sent. Threading back into the practice owner's inbox.
      </div>
    );
  }

  async function handleSend() {
    if (viewAs === "demo") {
      toast.error("Demo mode is read-only. Exit demo to send a real reply.");
      return;
    }
    if (subject.trim().length === 0 || body.trim().length === 0) {
      toast.error("Subject and body can't be empty.");
      return;
    }
    setSending(true);
    try {
      const { data: session } = await supabase.auth.getSession();
      const accessToken = session.session?.access_token;
      if (!accessToken) {
        toast.error("Please sign in.");
        setSending(false);
        return;
      }
      const res = await sendInboundReplyDraft({
        data: {
          accessToken,
          inboundOutreachId: row.outreachId,
          subject: subject.trim(),
          body: body.trim(),
          viewAs,
        },
      });
      setSent(true);
      toast.success(`Reply sent to ${res.to}.`);
      onSent();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't send the reply.");
    } finally {
      setSending(false);
    }
  }

  function handleReset() {
    setSubject(row.autoDraftSubject ?? "");
    setBody(row.autoDraftBody ?? "");
  }

  const verified = row.autoDraftVerified;
  const isEdited =
    subject !== (row.autoDraftSubject ?? "") || body !== (row.autoDraftBody ?? "");

  return (
    <div className="rounded-md border border-primary/30 bg-primary/[0.04] px-4 py-3 space-y-3">
      <div className="flex items-center gap-2">
        <Sparkles className="h-3.5 w-3.5 text-primary" />
        <span className="text-[11px] uppercase tracking-wider text-primary font-semibold">
          Liz drafted a reply
        </span>
        {row.autoDraftGeneratedAt && (
          <span className="text-[11px] text-ink-soft ml-auto">
            generated {timeAgo(row.autoDraftGeneratedAt)}
          </span>
        )}
        <button
          type="button"
          onClick={handleRegenerate}
          disabled={regenerating || sending}
          className="inline-flex items-center gap-1 text-[11px] text-ink-soft hover:text-primary rounded-full border border-border px-2 py-0.5 disabled:opacity-50"
          title="Regenerate Liz's draft (e.g. after a prompt update)"
        >
          {regenerating ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RefreshCw className="h-3 w-3" />
          )}
          {regenerating ? "Redrafting…" : "Regenerate"}
        </button>
      </div>

      {verified && <VerifiedChip verified={verified} />}

      <div className="space-y-2">
        <label className="block">
          <span className="block text-[11px] uppercase tracking-wider text-ink-soft font-medium mb-1">
            Subject
          </span>
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            disabled={sending}
            className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60"
          />
        </label>
        <label className="block">
          <span className="block text-[11px] uppercase tracking-wider text-ink-soft font-medium mb-1">
            Body
          </span>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            disabled={sending}
            rows={8}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm font-sans leading-relaxed focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60 whitespace-pre-wrap"
          />
        </label>
      </div>

      <div className="flex items-center justify-between gap-2 pt-1">
        <div className="text-[11px] text-ink-soft">
          {isEdited ? (
            <span className="text-amber-700">Edited from Liz's draft</span>
          ) : (
            <span>Using Liz's draft as-is</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {isEdited && (
            <button
              type="button"
              onClick={handleReset}
              disabled={sending}
              className="inline-flex items-center gap-1.5 text-xs text-ink-soft hover:text-foreground rounded-full border border-border px-3 py-1.5 disabled:opacity-50"
              title="Reset to Liz's original draft"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Reset
            </button>
          )}
          <button
            type="button"
            onClick={handleSend}
            disabled={sending}
            className="inline-flex items-center gap-1.5 text-xs font-medium rounded-full bg-primary text-white px-4 py-1.5 hover:opacity-90 disabled:opacity-50"
          >
            {sending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
            {sending ? "Sending…" : "Send reply"}
          </button>
        </div>
      </div>
    </div>
  );
}

function VerifiedChip({ verified }: { verified: DraftVerifiedBlock }) {
  const hasTier = verified.recommended_tier_code.length > 0;
  return (
    <div className="rounded-lg border border-emerald-200 bg-emerald-50/70 px-4 py-3 text-emerald-900">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-semibold text-emerald-700">
        <Tag className="h-3 w-3" />
        [VERIFIED]
        {!verified.llm_tier_was_valid && hasTier && (
          <span className="ml-auto inline-block rounded-sm bg-amber-100 text-amber-800 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider">
            tier fallback
          </span>
        )}
      </div>
      <div className="mt-1 text-[12px] text-emerald-700">
        {verified.promo_title || "(promo)"}
      </div>
      {hasTier ? (
        <>
          <div className="mt-2 font-mono text-[18px] font-semibold leading-none text-emerald-900 tracking-tight">
            {verified.recommended_tier_code}
          </div>
          <div className="mt-1.5 text-[12px] text-emerald-800">
            {verified.recommended_tier_label}
          </div>
          {verified.recommended_tier_clause && (
            <div className="mt-0.5 text-[12px] text-emerald-700">
              {verified.recommended_tier_clause}
            </div>
          )}
        </>
      ) : (
        <div className="mt-2 italic text-[12px] text-emerald-700">
          No structured tier ladder on this promo — Liz can't surface tier math.
        </div>
      )}
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────

function EmptyState({
  filter,
  totalRows,
}: {
  filter: Filter;
  totalRows: number;
}) {
  const msg = (() => {
    if (totalRows === 0) {
      return {
        title: "No replies yet",
        body: "When a practice owner replies to a promo blast, it'll land here. Send a blast from a promo's detail page to start the conversation.",
      };
    }
    if (filter === "unread") {
      return { title: "Inbox zero ✓", body: "Every reply's been read. Sweet." };
    }
    if (filter === "today") {
      return { title: "Nothing new today", body: "Check Unread or All to see older replies." };
    }
    return { title: "Nothing here", body: "Try a different filter." };
  })();
  return (
    <div className="rounded-xl border border-dashed border-border bg-card/40 px-6 py-12 text-center">
      <Mail className="h-6 w-6 text-ink-soft/40 mx-auto mb-3" />
      <div className="text-sm font-medium text-foreground">{msg.title}</div>
      <div className="text-xs text-ink-soft mt-1.5 max-w-md mx-auto">{msg.body}</div>
    </div>
  );
}

// ── Time-ago formatter ────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.round(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d`;
  const wk = Math.round(day / 7);
  if (wk < 5) return `${wk}w`;
  return new Date(iso).toLocaleDateString();
}
