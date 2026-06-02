/**
 * WishlistWidget — v1.33.0 floating affordance on every authenticated
 * spa-owner page where Karen can submit feature requests and see the
 * status of her existing ones.
 *
 * Per project_wishlist_thesis (banked 2026-06-01): customer-requested
 * feature build IS the moat. The widget is the in-product surface that
 * operationalizes the 48h SLA promise. Submit → submitted → reviewing →
 * in_progress → shipped — every status change Karen sees is proof of the
 * thesis.
 *
 * Mounted inside RefillShellChrome so it appears on every /app/refill/*
 * route but stays out of admin / marketing surfaces. Per
 * feedback_link_when_no_nav: even though there's no nav chip for this
 * surface, the widget itself IS the always-visible affordance.
 */

import { useEffect, useMemo, useState } from "react";
import { useLocation } from "@tanstack/react-router";
import {
  Lightbulb,
  Loader2,
  MessageCircle,
  Plus,
  Send,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { useTenantMembership } from "@/lib/use-tenant-membership";
import {
  addReplyToWishlistRequest,
  listMyWishlistRequests,
  submitWishlistRequest,
  type WishlistPriority,
  type WishlistRequest,
  type WishlistStatus,
} from "@/server/wishlist.functions";

type ActiveTab = "submit" | "my-requests";

type ComposeDraft = {
  title: string;
  description: string;
  priority: WishlistPriority;
};

const EMPTY_DRAFT: ComposeDraft = {
  title: "",
  description: "",
  priority: "normal",
};

const PRIORITY_OPTIONS: { value: WishlistPriority; label: string }[] = [
  { value: "low", label: "Low" },
  { value: "normal", label: "Normal" },
  { value: "high", label: "High" },
  { value: "urgent", label: "Urgent" },
];

export function WishlistWidget() {
  const location = useLocation();
  const membership = useTenantMembership();

  // Widget surfaces only when the user has a tenant context (i.e., they're a
  // spa-owner on an authenticated app page). Admin-only routes hide it.
  const onAdminRoute = location.pathname.startsWith("/app/admin/");
  const hasTenant = membership.status === "tenant";
  const visible = hasTenant && !onAdminRoute;

  const viewAsUserId =
    membership.status === "tenant" ? membership.viewAsUserId : undefined;

  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<ActiveTab>("submit");
  const [draft, setDraft] = useState<ComposeDraft>(EMPTY_DRAFT);
  const [submitting, setSubmitting] = useState(false);
  const [requests, setRequests] = useState<WishlistRequest[] | null>(null);
  const [loadingRequests, setLoadingRequests] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState<string>("");
  const [replyBusy, setReplyBusy] = useState(false);

  const areaContext = useMemo(() => {
    // Auto-capture the route Karen was on when she opened the widget —
    // gives Grasshopper context without forcing her to describe "where."
    const path = location.pathname;
    const search = location.search;
    return `${path}${search && Object.keys(search).length ? "?" : ""}`;
  }, [location.pathname, location.search]);

  const loadMyRequests = async () => {
    setLoadingRequests(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Please sign in again.");
      const rows = await listMyWishlistRequests({
        data: { accessToken: token, viewAsUserId },
      });
      setRequests(rows);
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Couldn't load your requests.",
      );
    } finally {
      setLoadingRequests(false);
    }
  };

  useEffect(() => {
    if (open && tab === "my-requests" && requests === null) {
      void loadMyRequests();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tab]);

  const submit = async () => {
    const title = draft.title.trim();
    const description = draft.description.trim();
    if (!title || !description) {
      toast.error("Title and description are both required.");
      return;
    }
    setSubmitting(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Please sign in again.");
      const created = await submitWishlistRequest({
        data: {
          accessToken: token,
          viewAsUserId,
          title,
          description,
          area: areaContext || null,
          priority: draft.priority,
        },
      });
      toast.success("Wishlist request submitted — we'll respond in 48 hours or less.");
      setDraft(EMPTY_DRAFT);
      // Prepend to local list so the "My requests" tab feels instant.
      setRequests((prior) => (prior ? [created, ...prior] : [created]));
      setTab("my-requests");
      setExpandedId(created.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't submit.");
    } finally {
      setSubmitting(false);
    }
  };

  const sendReply = async (requestId: string) => {
    const body = replyDraft.trim();
    if (!body) return;
    setReplyBusy(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Please sign in again.");
      const updated = await addReplyToWishlistRequest({
        data: {
          accessToken: token,
          viewAsUserId,
          requestId,
          body,
        },
      });
      setRequests((prior) =>
        prior
          ? prior.map((r) => (r.id === updated.id ? updated : r))
          : [updated],
      );
      setReplyDraft("");
      toast.success("Reply sent.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't send reply.");
    } finally {
      setReplyBusy(false);
    }
  };

  if (!visible) return null;

  return (
    <>
      {/* Floating launcher button — bottom-right, fixed positioning */}
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed bottom-6 right-6 z-40 inline-flex items-center gap-2 rounded-full bg-emerald px-4 py-3 text-paper shadow-lg shadow-emerald/20 hover:opacity-95 hover:shadow-xl transition-all"
          title="Submit a feature request — we'll respond in 48h or less"
        >
          <Lightbulb className="h-4 w-4" />
          <span className="text-[13px] font-semibold hidden sm:inline">
            Wishlist
          </span>
        </button>
      )}

      {/* Modal panel — anchored bottom-right, slides up */}
      {open && (
        <div className="fixed bottom-6 right-6 z-50 w-[min(420px,calc(100vw-3rem))] max-h-[calc(100vh-3rem)] flex flex-col rounded-xl border border-rule bg-white shadow-2xl overflow-hidden">
          {/* Header */}
          <div className="px-4 py-3 border-b border-rule bg-emerald-soft/40 flex items-center gap-2">
            <Lightbulb className="h-4 w-4 text-emerald-ink" />
            <div className="text-[13px] font-semibold text-emerald-ink">
              Wishlist
            </div>
            <div className="text-[10px] text-ink-soft italic ml-1">
              · we respond in 48h or less
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="ml-auto text-ink-soft hover:text-ink transition"
              title="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Tabs */}
          <div className="px-4 pt-3 flex items-center gap-1 border-b border-rule">
            <TabButton
              active={tab === "submit"}
              onClick={() => setTab("submit")}
            >
              <Plus className="h-3 w-3" />
              New request
            </TabButton>
            <TabButton
              active={tab === "my-requests"}
              onClick={() => setTab("my-requests")}
            >
              <MessageCircle className="h-3 w-3" />
              My requests
              {requests && requests.length > 0 && (
                <span className="text-[10px] text-ink-faint">
                  ({requests.length})
                </span>
              )}
            </TabButton>
          </div>

          {/* Body — scrollable */}
          <div className="flex-1 overflow-y-auto px-4 py-3">
            {tab === "submit" && (
              <div className="space-y-3">
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-soft mb-1">
                    Title
                  </div>
                  <input
                    type="text"
                    value={draft.title}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, title: e.target.value }))
                    }
                    placeholder="What feature do you wish you had?"
                    maxLength={140}
                    disabled={submitting}
                    className="w-full rounded-md border border-rule bg-white px-3 py-1.5 text-[13px] text-ink placeholder:text-ink-faint focus:border-emerald focus:outline-none disabled:opacity-50"
                  />
                </div>
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-soft mb-1">
                    Description
                  </div>
                  <textarea
                    value={draft.description}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, description: e.target.value }))
                    }
                    placeholder="Walk us through how you'd use it. The more specific, the faster we can ship or get back to you."
                    maxLength={5000}
                    rows={5}
                    disabled={submitting}
                    className="w-full rounded-md border border-rule bg-white px-3 py-1.5 text-[12px] text-ink placeholder:text-ink-faint focus:border-emerald focus:outline-none disabled:opacity-50"
                  />
                </div>
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-soft mb-1">
                    Priority
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {PRIORITY_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() =>
                          setDraft((d) => ({ ...d, priority: opt.value }))
                        }
                        disabled={submitting}
                        className={
                          "rounded-full px-3 py-1 text-[11px] font-medium border transition disabled:opacity-50 " +
                          (draft.priority === opt.value
                            ? "border-emerald bg-emerald-soft text-emerald-ink"
                            : "border-rule bg-white text-ink-soft hover:border-emerald/40 hover:text-ink")
                        }
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="rounded-md bg-rule-soft/40 px-3 py-2 text-[10px] text-ink-faint">
                  <div className="font-semibold uppercase tracking-wider mb-0.5">
                    Auto-captured
                  </div>
                  <div className="font-mono truncate">{areaContext}</div>
                </div>
                <button
                  type="button"
                  onClick={submit}
                  disabled={
                    submitting ||
                    !draft.title.trim() ||
                    !draft.description.trim()
                  }
                  className="w-full inline-flex items-center justify-center gap-1.5 rounded-md bg-emerald px-4 py-2 text-[13px] font-semibold text-paper shadow-sm hover:opacity-95 transition disabled:opacity-50"
                >
                  {submitting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Send className="h-3.5 w-3.5" />
                  )}
                  Submit request
                </button>
              </div>
            )}

            {tab === "my-requests" && (
              <div className="space-y-2">
                {loadingRequests && requests === null && (
                  <div className="text-center text-xs text-ink-soft py-8">
                    <Loader2 className="h-4 w-4 animate-spin mx-auto mb-2" />
                    Loading your requests…
                  </div>
                )}
                {requests && requests.length === 0 && (
                  <div className="text-center text-xs text-ink-faint italic py-8">
                    You haven't submitted any requests yet.
                  </div>
                )}
                {requests?.map((r) => (
                  <MyRequestRow
                    key={r.id}
                    request={r}
                    expanded={expandedId === r.id}
                    onToggle={() =>
                      setExpandedId((prev) => (prev === r.id ? null : r.id))
                    }
                    replyDraft={expandedId === r.id ? replyDraft : ""}
                    onReplyDraftChange={setReplyDraft}
                    onSendReply={() => sendReply(r.id)}
                    replyBusy={replyBusy}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "inline-flex items-center gap-1 px-3 py-2 text-[11px] font-medium border-b-2 transition -mb-px " +
        (active
          ? "border-emerald text-emerald-ink"
          : "border-transparent text-ink-soft hover:text-ink")
      }
    >
      {children}
    </button>
  );
}

function MyRequestRow({
  request,
  expanded,
  onToggle,
  replyDraft,
  onReplyDraftChange,
  onSendReply,
  replyBusy,
}: {
  request: WishlistRequest;
  expanded: boolean;
  onToggle: () => void;
  replyDraft: string;
  onReplyDraftChange: (v: string) => void;
  onSendReply: () => void;
  replyBusy: boolean;
}) {
  return (
    <div className="rounded-md border border-rule bg-white overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full px-3 py-2 flex items-start gap-2 hover:bg-rule-soft/40 transition text-left"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <div className="text-[12px] font-medium text-ink truncate">
              {request.title}
            </div>
            <StatusPill status={request.status} />
          </div>
          <div className="mt-0.5 text-[10px] text-ink-faint">
            {formatRelative(request.createdAt)} · priority {request.priority}
            {request.shippedInVersion && (
              <> · shipped in {request.shippedInVersion}</>
            )}
          </div>
        </div>
      </button>
      {expanded && (
        <div className="border-t border-rule bg-rule-soft/30 px-3 py-2 space-y-2">
          <div className="text-[11px] text-ink whitespace-pre-wrap">
            {request.description}
          </div>
          {request.adminNotes && (
            <div className="rounded bg-emerald-soft/50 px-2 py-1.5 text-[11px] text-emerald-ink">
              <div className="text-[9px] uppercase font-semibold tracking-wider opacity-70 mb-0.5">
                Admin notes
              </div>
              {request.adminNotes}
            </div>
          )}
          {request.messages.length > 0 && (
            <div className="space-y-1.5 pt-1">
              <div className="text-[9px] uppercase font-semibold tracking-wider text-ink-faint">
                Conversation
              </div>
              {request.messages.map((m) => (
                <div
                  key={m.id}
                  className={
                    "rounded px-2 py-1.5 text-[11px] " +
                    (m.fromRole === "admin"
                      ? "bg-emerald-soft/40 text-ink"
                      : "bg-white border border-rule text-ink")
                  }
                >
                  <div className="text-[9px] uppercase tracking-wider text-ink-faint mb-0.5">
                    {m.fromRole === "admin" ? "Refill team" : "You"} ·{" "}
                    {formatRelative(m.sentAt)}
                  </div>
                  <div className="whitespace-pre-wrap">{m.body}</div>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-end gap-1.5 pt-1">
            <textarea
              value={replyDraft}
              onChange={(e) => onReplyDraftChange(e.target.value)}
              placeholder="Add a clarification or follow-up…"
              maxLength={5000}
              rows={2}
              disabled={replyBusy}
              className="flex-1 rounded-md border border-rule bg-white px-2 py-1 text-[11px] text-ink placeholder:text-ink-faint focus:border-emerald focus:outline-none disabled:opacity-50"
            />
            <button
              type="button"
              onClick={onSendReply}
              disabled={replyBusy || !replyDraft.trim()}
              className="inline-flex items-center gap-1 rounded-md bg-emerald px-2.5 py-1.5 text-[11px] font-semibold text-paper shadow-sm hover:opacity-95 transition disabled:opacity-50"
            >
              {replyBusy ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Send className="h-3 w-3" />
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: WishlistStatus }) {
  const config = {
    submitted: { label: "Submitted", bg: "bg-rule-soft", text: "text-ink-soft" },
    reviewing: { label: "Reviewing", bg: "bg-amber-100", text: "text-amber-700" },
    in_progress: { label: "Building", bg: "bg-blue-100", text: "text-blue-700" },
    shipped: { label: "Shipped", bg: "bg-emerald-soft", text: "text-emerald-ink" },
    declined: { label: "Declined", bg: "bg-rose-soft", text: "text-rose" },
  }[status];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${config.bg} ${config.text}`}
    >
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
