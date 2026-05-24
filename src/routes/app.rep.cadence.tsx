/**
 * /app/rep/cadence — Scheduled follow-up cadence digest (v340).
 *
 * The "5 nudges suggested" daily surface from the Phase 2 Promotions Engine
 * spec. Lists stale `outreached` rows (last_touched_at < now() - 5 days,
 * never dismissed), each with a Liz-drafted nudge body. Rep can Send,
 * Edit then Send, or Dismiss. Never auto-send — rep eyes stay in the loop.
 *
 * Loader: listSuggestedNudges (metadata only, ≤50 rows). Each NudgeCard
 * lazy-loads its draft via generateNudgeDraft on mount — ~3-5s per row,
 * but rows render in parallel and the page stays interactive while
 * drafts populate. Sending bumps last_touched_at, so the row falls off
 * the next digest naturally.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  AlertCircle,
  ArrowLeft,
  Check,
  Clock,
  Loader2,
  RefreshCw,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { supabase } from "@/integrations/supabase/client";
import {
  dismissNudgeSuggestion,
  generateNudgeDraft,
  listSuggestedNudges,
  sendNudgeDraft,
  type DraftVerifiedBlock,
  type NudgeDraftResult,
  type SuggestedNudgeRow,
} from "@/server/promotions.functions";
import { useViewAs } from "@/lib/demo-mode";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/rep/cadence")({
  component: CadencePage,
});

function CadencePage() {
  const viewAs = useViewAs();
  const [rows, setRows] = useState<SuggestedNudgeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Soft-hide rows the rep just sent or dismissed (UI only — server has
  // already moved them off the digest, but we don't want to re-fetch +
  // flash an empty space while the toast is still showing).
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());

  async function load({ silent = false }: { silent?: boolean } = {}) {
    if (!silent) setLoading(true);
    setRefreshing(true);
    try {
      const { data: session } = await supabase.auth.getSession();
      const accessToken = session.session?.access_token;
      if (!accessToken) {
        toast.error("Please sign in.");
        return;
      }
      const fresh = await listSuggestedNudges({ data: { accessToken, viewAs } });
      setRows(fresh);
      setHiddenIds(new Set());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`Couldn't load nudges — ${msg}`);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  // Initial load + reload when demo-mode flips.
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewAs]);

  const hideRow = (stateId: string) => {
    setHiddenIds((prev) => {
      const next = new Set(prev);
      next.add(stateId);
      return next;
    });
  };

  const visible = rows.filter((r) => !hiddenIds.has(r.stateId));

  return (
    <div>
      <PageHeader
        title="Cadence"
        eyebrow="Lizzie(OS)"
        description="Stale outreach you haven't heard back on. Liz drafts the nudge — you review and send. Never auto-send."
      />

      <div className="px-6 lg:px-10 py-6 max-w-3xl">
        {/* Summary strip */}
        <div className="mb-5 flex items-center justify-between rounded-xl border border-border bg-card px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="rounded-full bg-primary/15 p-2">
              <Clock className="h-4 w-4 text-primary" />
            </div>
            <div>
              <div className="text-sm font-semibold">
                {loading
                  ? "Checking your queue…"
                  : visible.length === 0
                    ? "No nudges suggested"
                    : `${visible.length} ${visible.length === 1 ? "nudge" : "nudges"} suggested`}
              </div>
              <div className="text-xs text-ink-soft">
                Stale 5+ days, no reply yet, not dismissed.
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => load({ silent: true })}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted transition-colors disabled:opacity-60"
          >
            {refreshing ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
            Refresh
          </button>
        </div>

        {/* Body */}
        {loading ? (
          <LoadingState />
        ) : visible.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="space-y-4">
            {visible.map((row) => (
              <NudgeCard
                key={row.stateId}
                row={row}
                viewAs={viewAs}
                onSent={() => {
                  hideRow(row.stateId);
                  toast.success(`Nudge sent to ${row.accountTitle}`);
                }}
                onDismissed={() => {
                  hideRow(row.stateId);
                  toast.success(`Dismissed — ${row.accountTitle} won't appear again`);
                }}
              />
            ))}
          </div>
        )}

        {/* Footer help */}
        {!loading && visible.length > 0 && (
          <p className="mt-6 text-xs text-ink-soft text-center">
            Sending a nudge resets the timer — the row falls off this digest
            until it goes stale again. <Link to="/app/rep/today" className="underline hover:text-primary">Back to Today</Link>
          </p>
        )}
      </div>
    </div>
  );
}

// ── NudgeCard ─────────────────────────────────────────────────────────────

function NudgeCard({
  row,
  viewAs,
  onSent,
  onDismissed,
}: {
  row: SuggestedNudgeRow;
  viewAs: "demo" | undefined;
  onSent: () => void;
  onDismissed: () => void;
}) {
  const [draft, setDraft] = useState<NudgeDraftResult | null>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [draftError, setDraftError] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(true);
  const [sending, setSending] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  // Bumped by the per-row Retry button to re-fire the draft useEffect when a
  // transient Gemini abort/timeout left the row stuck in error state. The
  // page-level Refresh button only re-queries the LIST of stale accounts;
  // existing rows don't remount, so without this they'd stay broken until
  // the rep navigated away and back.
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function gen() {
      setDrafting(true);
      setDraftError(null);
      try {
        const { data: session } = await supabase.auth.getSession();
        const accessToken = session.session?.access_token;
        if (!accessToken) throw new Error("Sign in required.");
        const d = await generateNudgeDraft({
          data: { accessToken, stateId: row.stateId, viewAs },
        });
        if (cancelled) return;
        setDraft(d);
        setSubject(d.subject);
        setBody(d.body);
      } catch (e) {
        if (cancelled) return;
        setDraftError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setDrafting(false);
      }
    }
    void gen();
    return () => {
      cancelled = true;
    };
  }, [row.stateId, viewAs, retryNonce]);

  const handleSend = async () => {
    if (!subject.trim() || !body.trim()) {
      toast.error("Subject and body are required.");
      return;
    }
    if (viewAs === "demo") {
      toast.error("Demo mode is read-only — exit demo to send.");
      return;
    }
    setSending(true);
    try {
      const { data: session } = await supabase.auth.getSession();
      const accessToken = session.session?.access_token;
      if (!accessToken) throw new Error("Sign in required.");
      await sendNudgeDraft({
        data: {
          accessToken,
          stateId: row.stateId,
          subject: subject.trim(),
          body,
          viewAs,
        },
      });
      onSent();
    } catch (e) {
      toast.error(`Couldn't send — ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSending(false);
    }
  };

  const handleDismiss = async () => {
    setDismissing(true);
    try {
      const { data: session } = await supabase.auth.getSession();
      const accessToken = session.session?.access_token;
      if (!accessToken) throw new Error("Sign in required.");
      await dismissNudgeSuggestion({
        data: { accessToken, stateId: row.stateId, viewAs },
      });
      onDismissed();
    } catch (e) {
      toast.error(`Couldn't dismiss — ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDismissing(false);
    }
  };

  const staleColor = staleColorClass(row.daysSinceLastTouch);

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-border">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-foreground truncate">
            {row.accountTitle}
          </div>
          <div className="text-xs text-ink-soft mt-0.5 truncate">
            {row.promotionTitle}
            {row.manufacturer && (
              <span className="text-ink-soft/60"> · {row.manufacturer}</span>
            )}
            {row.contactEmail && (
              <span className="text-ink-soft/60"> · {row.contactEmail}</span>
            )}
          </div>
        </div>
        <div className={cn("shrink-0 rounded-full px-2.5 py-1 text-[10px] font-semibold", staleColor)}>
          {row.daysSinceLastTouch}d stale
        </div>
      </div>

      {/* Draft */}
      <div className="px-5 py-4 space-y-3">
        {drafting && !draft && (
          <div className="flex items-center gap-2 text-xs text-ink-soft py-4">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Liz is drafting the nudge…
          </div>
        )}

        {draftError && !drafting && (
          <div className="rounded-lg bg-clay/5 border border-clay/30 px-3 py-2 text-xs text-clay flex items-start gap-2">
            <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              <div className="font-medium">Couldn't draft the nudge</div>
              <div className="text-clay/80 mt-0.5">{draftError}</div>
              <button
                type="button"
                onClick={() => setRetryNonce((n) => n + 1)}
                className="mt-2 inline-flex items-center gap-1 rounded-md border border-clay/40 bg-background px-2 py-1 text-[11px] font-medium text-clay hover:bg-clay/10 transition-colors"
              >
                <RefreshCw className="h-3 w-3" />
                Retry draft
              </button>
            </div>
          </div>
        )}

        {draft && (
          <>
            {/* Subject */}
            <div className="space-y-1">
              <label className="text-[10px] font-semibold uppercase tracking-wide text-ink-soft">
                Subject
              </label>
              <input
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                disabled={sending || dismissing}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
              />
            </div>

            {/* Body */}
            <div className="space-y-1">
              <label className="text-[10px] font-semibold uppercase tracking-wide text-ink-soft">
                Body
              </label>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                disabled={sending || dismissing}
                rows={8}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-sans leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 resize-y"
              />
              <p className="text-[10px] text-ink-soft/70">
                [REP_NAME] is substituted with your real name at send-time.
              </p>
            </div>

            {/* Verified chip */}
            <VerifiedChip verified={draft.verified} />
          </>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border bg-muted/30">
        <button
          type="button"
          onClick={handleDismiss}
          disabled={drafting || sending || dismissing}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted transition-colors disabled:opacity-50"
        >
          {dismissing ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <X className="h-3 w-3" />
          )}
          Dismiss
        </button>
        <button
          type="button"
          onClick={handleSend}
          disabled={drafting || sending || dismissing || !draft}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {sending ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Send className="h-3 w-3" />
          )}
          Send nudge
        </button>
      </div>
    </div>
  );
}

// ── VerifiedChip — same shape as v339 inbox VerifiedChip ──────────────────

function VerifiedChip({ verified }: { verified: DraftVerifiedBlock }) {
  if (!verified.recommended_tier_code) {
    return (
      <div className="rounded-lg border border-border bg-muted/30 px-3 py-2">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-soft">
          <Sparkles className="h-3 w-3" />
          No tier ladder available
        </div>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 space-y-1">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-primary">
          [VERIFIED]
        </span>
        {!verified.llm_tier_was_valid && (
          <span className="text-[9px] font-semibold uppercase tracking-wide text-amber rounded bg-amber-soft px-1.5 py-0.5">
            tier fallback
          </span>
        )}
        <span className="text-[10px] text-ink-soft truncate">
          {verified.promo_title}
        </span>
      </div>
      <div className="font-mono text-base font-bold text-foreground tracking-tight">
        {verified.recommended_tier_code}
      </div>
      <div className="text-[11px] text-foreground/80">
        {verified.recommended_tier_label}
        {verified.recommended_tier_clause && (
          <span className="text-ink-soft"> · {verified.recommended_tier_clause}</span>
        )}
      </div>
    </div>
  );
}

// ── Loading / empty states ────────────────────────────────────────────────

function LoadingState() {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-sm text-ink-soft">
      <Loader2 className="h-4 w-4 animate-spin" />
      Checking your outreach for stale rows…
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-dashed border-border bg-card/50 px-6 py-12 text-center space-y-3">
      <div className="mx-auto h-12 w-12 rounded-full bg-sage-soft flex items-center justify-center">
        <Check className="h-6 w-6 text-sage" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-semibold text-foreground">All caught up</p>
        <p className="text-xs text-ink-soft max-w-md mx-auto">
          No outreach has gone stale yet. As your promos run, accounts that
          haven't replied within 5 days will show up here with a Liz-drafted
          nudge ready for your review.
        </p>
      </div>
      <Link
        to="/app/rep/today"
        className="inline-flex items-center gap-1.5 mt-2 text-xs text-ink-soft hover:text-primary"
      >
        <ArrowLeft className="h-3 w-3" />
        Back to Today
      </Link>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────

function staleColorClass(days: number): string {
  if (days >= 14) return "bg-clay/15 text-clay";
  if (days >= 8) return "bg-amber-soft text-amber";
  return "bg-sage-soft text-sage";
}

