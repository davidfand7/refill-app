/**
 * /app/admin/wishlist — Admin inbox for v1.33.0 Wishlist requests.
 *
 * Per project_wishlist_thesis (banked 2026-06-01): the 48h-customization-SLA
 * is the moat. This is where Grasshopper sees every spa-owner's request
 * across all tenants, triages, moves status through the workflow, replies
 * inline, and marks shipped with a v-pill anchor.
 *
 * Mirrors the canonical-brands admin route pattern (v1.30.0) for layout
 * and PageHeader usage.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Filter,
  Lightbulb,
  Loader2,
  Send,
  Sparkles,
  X,
} from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { MarkdownLight } from "@/components/MarkdownLight";
import { supabase } from "@/integrations/supabase/client";
import {
  addReplyToWishlistRequest,
  listAllWishlistRequests,
  updateWishlistRequestStatus,
  type AdminWishlistRequest,
  type WishlistStatus,
} from "@/server/wishlist.functions";

export const Route = createFileRoute("/app/admin/wishlist")({
  component: AdminWishlistPage,
});

const STATUS_ORDER: WishlistStatus[] = [
  "submitted",
  "reviewing",
  "in_progress",
  "shipped",
  "declined",
];

const STATUS_LABEL: Record<WishlistStatus, string> = {
  submitted: "Submitted",
  reviewing: "Reviewing",
  in_progress: "Building",
  shipped: "Shipped",
  declined: "Declined",
};

function AdminWishlistPage() {
  const [requests, setRequests] = useState<AdminWishlistRequest[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // v1.34.0.1: default to "show all" so newly-landed admin sees the full
  // picture. Empty set = no filter applied = show everything; user
  // narrows by tapping chips to add status filters.
  const [statusFilter, setStatusFilter] = useState<Set<WishlistStatus>>(
    new Set(),
  );
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // v1.34.0.1: always load ALL wishes (no server-side status filter) so
  // chip counts reflect TRUE DB totals, not just the current filtered view.
  // Volume is small (~100s of wishes max per tenant); client-side filter
  // is cheap and lets the counts stay honest.
  const load = async () => {
    setError(null);
    setLoading(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Sign in required.");
      const rows = await listAllWishlistRequests({
        data: { accessToken: token },
      });
      setRequests(rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load requests.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const counts = useMemo(() => {
    const c: Record<WishlistStatus, number> = {
      submitted: 0,
      reviewing: 0,
      in_progress: 0,
      shipped: 0,
      declined: 0,
    };
    for (const r of requests ?? []) c[r.status]++;
    return c;
  }, [requests]);

  // v1.34.0.1: client-side filtering. Empty filter = show all.
  const visibleRequests = useMemo(() => {
    if (!requests) return null;
    if (statusFilter.size === 0) return requests;
    return requests.filter((r) => statusFilter.has(r.status));
  }, [requests, statusFilter]);

  const toggleStatus = (s: WishlistStatus) => {
    setStatusFilter((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  };

  const clearFilters = () => setStatusFilter(new Set());

  const onRequestUpdated = (next: AdminWishlistRequest) => {
    setRequests((prior) =>
      prior ? prior.map((r) => (r.id === next.id ? next : r)) : [next],
    );
  };

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <PageHeader
        title="Wishlist inbox"
        description="Every feature request from every spa, with the 48h SLA workflow."
        actions={
          <Link
            to="/app/admin"
            className="inline-flex items-center gap-1.5 rounded-lg border border-rule bg-white px-3 py-1.5 text-xs font-medium text-ink hover:bg-rule-soft transition"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Admin
          </Link>
        }
      />

      <div className="flex-1 px-4 py-6 lg:px-10 max-w-5xl w-full mx-auto space-y-4">
        {/* v1.34.0.1: Filter chips with TRUE DB counts + explicit
            "Filter:" label + Show-all/Clear toggle. Distinct from the
            move-status chips inside each row (which use a different
            shape + "Move status:" label). */}
        <div className="flex flex-wrap gap-1.5 items-center">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint mr-1 inline-flex items-center gap-1">
            <Filter className="h-2.5 w-2.5" />
            Filter
          </span>
          {STATUS_ORDER.map((s) => {
            const active = statusFilter.has(s);
            return (
              <button
                key={s}
                type="button"
                onClick={() => toggleStatus(s)}
                className={
                  "inline-flex items-center gap-1 rounded-full px-3 py-1 text-[11px] font-medium border transition " +
                  (active
                    ? "border-emerald bg-emerald-soft text-emerald-ink"
                    : "border-rule bg-white text-ink-soft hover:border-emerald/40 hover:text-ink")
                }
              >
                {STATUS_LABEL[s]}
                {requests && (
                  <span className="text-[9px] text-ink-faint tabular-nums">
                    {counts[s]}
                  </span>
                )}
              </button>
            );
          })}
          {statusFilter.size > 0 && (
            <button
              type="button"
              onClick={clearFilters}
              className="ml-1 text-[10px] text-ink-soft hover:text-ink underline-offset-2 hover:underline transition"
            >
              Show all
            </button>
          )}
          {requests && (
            <span className="ml-auto text-[10px] text-ink-faint tabular-nums">
              {visibleRequests?.length ?? 0} of {requests.length} shown
            </span>
          )}
        </div>

        {/* Body */}
        {loading && requests === null && (
          <div className="rounded-xl border border-rule bg-white px-5 py-12 text-center text-sm text-ink-soft">
            <Loader2 className="h-4 w-4 animate-spin inline mr-2" />
            Loading requests…
          </div>
        )}
        {error && (
          <div className="rounded-xl border border-rose/30 bg-rose-soft px-5 py-3 text-sm text-rose">
            {error}
          </div>
        )}
        {visibleRequests && visibleRequests.length === 0 && requests && requests.length === 0 && (
          <div className="rounded-xl border border-rule bg-white px-5 py-12 text-center">
            <Sparkles className="h-6 w-6 text-ink-faint mx-auto mb-2" />
            <div className="text-sm text-ink-soft">
              No requests yet.
            </div>
            <div className="text-[11px] text-ink-faint mt-1">
              Once spa-owners start submitting, they'll show up here.
            </div>
          </div>
        )}
        {visibleRequests && visibleRequests.length === 0 && requests && requests.length > 0 && (
          <div className="rounded-xl border border-rule bg-white px-5 py-8 text-center">
            <div className="text-sm text-ink-soft">
              No requests match the current filter.
            </div>
            <button
              type="button"
              onClick={clearFilters}
              className="mt-2 text-[12px] text-emerald-ink hover:underline"
            >
              Show all {requests.length}
            </button>
          </div>
        )}
        {visibleRequests && visibleRequests.length > 0 && (
          <div className="space-y-2">
            {visibleRequests.map((r) => (
              <AdminRequestRow
                key={r.id}
                request={r}
                expanded={expandedId === r.id}
                onToggle={() =>
                  setExpandedId((prev) => (prev === r.id ? null : r.id))
                }
                onUpdated={onRequestUpdated}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AdminRequestRow({
  request,
  expanded,
  onToggle,
  onUpdated,
}: {
  request: AdminWishlistRequest;
  expanded: boolean;
  onToggle: () => void;
  onUpdated: (r: AdminWishlistRequest) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [replyDraft, setReplyDraft] = useState("");
  const [adminNotesDraft, setAdminNotesDraft] = useState(request.adminNotes ?? "");
  const [versionDraft, setVersionDraft] = useState(
    request.shippedInVersion ?? "",
  );

  const withToken = async <T,>(
    fn: (token: string) => Promise<T>,
  ): Promise<T | null> => {
    setBusy(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Sign in required.");
      return await fn(token);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Something went wrong.");
      return null;
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (status: WishlistStatus) => {
    const result = await withToken((token) =>
      updateWishlistRequestStatus({
        data: {
          accessToken: token,
          requestId: request.id,
          status,
          shippedInVersion:
            status === "shipped" ? versionDraft.trim() || null : undefined,
          adminNotes: adminNotesDraft.trim() || null,
        },
      }),
    );
    if (result) {
      onUpdated({
        ...request,
        ...result,
        tenantName: request.tenantName,
        submitterEmail: request.submitterEmail,
      });
      toast.success(`Marked as ${STATUS_LABEL[status]}.`);
    }
  };

  const saveAdminNotes = async () => {
    const result = await withToken((token) =>
      updateWishlistRequestStatus({
        data: {
          accessToken: token,
          requestId: request.id,
          status: request.status,
          adminNotes: adminNotesDraft.trim() || null,
          shippedInVersion: versionDraft.trim() || null,
        },
      }),
    );
    if (result) {
      onUpdated({
        ...request,
        ...result,
        tenantName: request.tenantName,
        submitterEmail: request.submitterEmail,
      });
      toast.success("Saved.");
    }
  };

  const sendReply = async () => {
    const body = replyDraft.trim();
    // v1.34.0.1: guard against double-click duplicates (admin-side
    // mirror of the WishlistWidget fix). Bail if already sending OR
    // body empty. Optimistically clear the draft so a fast second
    // click sees empty textarea = disabled Send button.
    if (!body || busy) return;
    setReplyDraft("");
    const result = await withToken((token) =>
      addReplyToWishlistRequest({
        data: {
          accessToken: token,
          requestId: request.id,
          body,
        },
      }),
    );
    if (result) {
      onUpdated({
        ...request,
        ...result,
        tenantName: request.tenantName,
        submitterEmail: request.submitterEmail,
      });
      toast.success("Reply sent.");
    } else {
      // Restore draft on failure (withToken already toasted the error)
      setReplyDraft(body);
    }
  };

  return (
    <div className="rounded-xl border border-rule bg-white overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full px-5 py-3 flex items-start gap-3 hover:bg-rule-soft/40 transition text-left"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="text-[14px] font-semibold text-ink truncate">
              {request.title}
            </div>
            <StatusBadge status={request.status} />
            <PriorityBadge priority={request.priority} />
            {request.messages.length > 0 && (
              <span className="text-[10px] text-ink-faint">
                · {request.messages.length} reply{request.messages.length === 1 ? "" : "s"}
              </span>
            )}
          </div>
          <div className="mt-0.5 text-[11px] text-ink-soft">
            {request.tenantName ?? "(unknown tenant)"} ·{" "}
            {request.submitterEmail ?? "(unknown submitter)"} ·{" "}
            {formatRelative(request.createdAt)}
          </div>
          {request.area && (
            <div className="mt-0.5 text-[10px] text-ink-faint font-mono truncate">
              from {request.area}
            </div>
          )}
        </div>
        <div className="shrink-0 text-ink-faint">
          {expanded ? (
            <ChevronUp className="h-4 w-4" />
          ) : (
            <ChevronDown className="h-4 w-4" />
          )}
        </div>
      </button>
      {expanded && (
        <div className="border-t border-rule bg-rule-soft/20 p-5 space-y-4">
          {/* Description — v1.34.0.1: renders markdown (bold + bullets)
             so the AI-polished spec format reads cleanly instead of
             showing literal **bold** syntax. */}
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint mb-1">
              Description
            </div>
            <MarkdownLight
              text={request.description}
              className="text-[13px] text-ink bg-white rounded-md border border-rule px-3 py-2"
            />
          </div>

          {/* v1.34.0.1: Workflow — visually distinct from filter chips.
             Square corners + arrow icon + "Move status:" label make it
             clear these MUTATE the wish, vs the filter chips at the top
             which only NARROW the view. */}
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint mb-1 inline-flex items-center gap-1">
              <ArrowRight className="h-2.5 w-2.5" />
              Move status:
            </div>
            <div className="inline-flex flex-wrap rounded-md border border-rule bg-white overflow-hidden">
              {STATUS_ORDER.map((s, i) => {
                const active = request.status === s;
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => void setStatus(s)}
                    disabled={busy || active}
                    className={
                      "inline-flex items-center gap-1 px-3 py-1.5 text-[11px] font-medium transition disabled:opacity-50 disabled:cursor-default " +
                      (i > 0 ? "border-l border-rule " : "") +
                      (active
                        ? "bg-emerald-soft text-emerald-ink font-semibold"
                        : "bg-white text-ink-soft hover:bg-rule-soft hover:text-ink")
                    }
                  >
                    {s === "shipped" && <CheckCircle2 className="h-3 w-3" />}
                    {STATUS_LABEL[s]}
                  </button>
                );
              })}
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <label className="block">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-soft mb-1">
                  Shipped in version
                </div>
                <input
                  type="text"
                  value={versionDraft}
                  onChange={(e) => setVersionDraft(e.target.value)}
                  placeholder="e.g., v1.34.0"
                  maxLength={32}
                  disabled={busy}
                  className="w-full rounded-md border border-rule bg-white px-3 py-1.5 text-[12px] text-ink placeholder:text-ink-faint focus:border-emerald focus:outline-none disabled:opacity-50"
                />
              </label>
              <label className="block">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-soft mb-1">
                  Admin notes (visible to spa-owner)
                </div>
                <input
                  type="text"
                  value={adminNotesDraft}
                  onChange={(e) => setAdminNotesDraft(e.target.value)}
                  placeholder="e.g., scoped for v1.34, ETA Wed"
                  maxLength={5000}
                  disabled={busy}
                  className="w-full rounded-md border border-rule bg-white px-3 py-1.5 text-[12px] text-ink placeholder:text-ink-faint focus:border-emerald focus:outline-none disabled:opacity-50"
                />
              </label>
            </div>
            <div className="mt-2">
              <button
                type="button"
                onClick={() => void saveAdminNotes()}
                disabled={busy}
                className="inline-flex items-center gap-1 rounded-md border border-rule bg-white px-2.5 py-1 text-[11px] font-medium text-ink-soft hover:text-ink transition disabled:opacity-50"
              >
                Save version + notes
              </button>
            </div>
          </div>

          {/* SLA timestamps */}
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint mb-1">
              SLA timeline
            </div>
            <div className="flex flex-wrap gap-3 text-[10px] text-ink-faint">
              <span>
                <Clock className="h-2.5 w-2.5 inline mr-1" />
                submitted {formatRelative(request.createdAt)}
              </span>
              {request.reviewingAt && (
                <span>· reviewing {formatRelative(request.reviewingAt)}</span>
              )}
              {request.inProgressAt && (
                <span>· building {formatRelative(request.inProgressAt)}</span>
              )}
              {request.shippedAt && (
                <span className="text-emerald-ink">
                  · shipped {formatRelative(request.shippedAt)}
                </span>
              )}
              {request.declinedAt && (
                <span className="text-rose">
                  · declined {formatRelative(request.declinedAt)}
                </span>
              )}
            </div>
          </div>

          {/* Conversation thread */}
          {request.messages.length > 0 && (
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint mb-1">
                Conversation
              </div>
              <div className="space-y-1.5">
                {request.messages.map((m) => (
                  <div
                    key={m.id}
                    className={
                      "rounded-md px-3 py-1.5 text-[12px] " +
                      (m.fromRole === "admin"
                        ? "bg-emerald-soft/40 text-ink border border-emerald/30"
                        : "bg-white border border-rule text-ink")
                    }
                  >
                    <div className="text-[9px] uppercase tracking-wider text-ink-faint mb-0.5">
                      {m.fromRole === "admin" ? "Refill team" : "Spa-owner"} ·{" "}
                      {formatRelative(m.sentAt)}
                    </div>
                    <div className="whitespace-pre-wrap">{m.body}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Admin reply */}
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint mb-1">
              Reply to spa-owner
            </div>
            <div className="flex items-end gap-2">
              <textarea
                value={replyDraft}
                onChange={(e) => setReplyDraft(e.target.value)}
                placeholder="Acknowledge, clarify, or send a status update…"
                maxLength={5000}
                rows={3}
                disabled={busy}
                className="flex-1 rounded-md border border-rule bg-white px-3 py-1.5 text-[12px] text-ink placeholder:text-ink-faint focus:border-emerald focus:outline-none disabled:opacity-50"
              />
              <button
                type="button"
                onClick={() => void sendReply()}
                disabled={busy || !replyDraft.trim()}
                className="inline-flex items-center gap-1 rounded-md bg-emerald px-3 py-1.5 text-[12px] font-semibold text-paper shadow-sm hover:opacity-95 transition disabled:opacity-50"
              >
                {busy ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Send className="h-3 w-3" />
                )}
                Send
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: WishlistStatus }) {
  const config = {
    submitted: { bg: "bg-rule-soft", text: "text-ink-soft" },
    reviewing: { bg: "bg-amber-100", text: "text-amber-700" },
    in_progress: { bg: "bg-blue-100", text: "text-blue-700" },
    shipped: { bg: "bg-emerald-soft", text: "text-emerald-ink" },
    declined: { bg: "bg-rose-soft", text: "text-rose" },
  }[status];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${config.bg} ${config.text}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

function PriorityBadge({
  priority,
}: {
  priority: AdminWishlistRequest["priority"];
}) {
  const config = {
    low: { bg: "bg-rule-soft", text: "text-ink-faint", label: "low" },
    normal: { bg: "bg-rule-soft", text: "text-ink-soft", label: "normal" },
    high: { bg: "bg-amber-100", text: "text-amber-700", label: "high" },
    urgent: { bg: "bg-rose-soft", text: "text-rose", label: "urgent" },
  }[priority];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${config.bg} ${config.text}`}
    >
      <Lightbulb className="h-2 w-2 mr-0.5" />
      {config.label}
    </span>
  );
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diff = now - then;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}
