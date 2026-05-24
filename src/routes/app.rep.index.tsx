/**
 * /app/rep — Rep Liz's PWA chat surface.
 *
 * Mobile-first chat UI for medical-aesthetics reps. Async by design:
 * every message is a self-contained POST to sendLizMessage; conversation
 * history persists server-side so reps can pick up from any device.
 *
 * Architecture: route loads existing turns via listLizMessages on mount,
 * renders chat bubbles, sends new messages via sendLizMessage. Server-side
 * each call invokes the persona-agnostic agent-runtime with LIZ_CONFIG.
 *
 * Established 2026-05-09 (v250) as part of the productization parallel-dev
 * kickoff. See project_med_aesthetics_plan_locked.md for design context.
 * URL slug renamed /app/liz → /app/rep in v283; legacy /app/liz
 * redirects via the stub at src/routes/app.liz.tsx.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { z } from "zod";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Send, Loader2, Sparkles, Users, ThumbsUp, ThumbsDown, X, Library, Activity, UserCircle, Check, RefreshCw, Mail, CheckCircle2, Eye, BadgeCheck, Target, Tag } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { sendSampleOrderEmail } from "@/server/sample-order-email.functions";
import type { LizSampleOrder, LizSampleOrderSend } from "@/server/liz-chat.functions";
import { PageHeader } from "@/components/PageHeader";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { supabase } from "@/integrations/supabase/client";
import {
  clearLizMessages,
  listLizMessages,
  rateLizTurn,
  sendLizMessage,
  type LizChatTurn,
  type LizTurnRating,
} from "@/server/liz-chat.functions";
import { cn } from "@/lib/utils";
import { ChipDrawer } from "@/components/lizzie/ChipDrawer";
import { RepHome } from "@/components/lizzie/RepHome";
import { useRepProfile } from "@/lib/use-rep-profile";
import { STARTER_CHIPS } from "@/lib/liz-starter-chips";
import {
  REP_PERSONAS,
  loadActingAs,
  saveActingAs,
  personaLabel,
  type RepPersona,
} from "@/lib/liz-acting-as";

// v326: optional `?turn=<id>` search param so the Deals Desk can deep-link
// back to the chat reply that produced a given sample order. Tolerant —
// unrecognized values fall through and just don't scroll/highlight anything.
const lizzieSearchSchema = z.object({
  turn: z.string().min(1).max(80).optional(),
});

export const Route = createFileRoute("/app/rep/")({
  validateSearch: (search: Record<string, unknown>) =>
    lizzieSearchSchema.parse(search),
  component: LizzieIndex,
});

// v402 (3.1.9) — persona branch. Refill reps land on RepHome (the rep
// platform dashboard); everyone else (Liz-AI medical-aesthetics
// dogfooders) keeps the existing chat surface. The shell layer in
// app.tsx already selected RepShell vs LizDevShell upstream, but the
// CONTENT at /app/rep was still LizChat for reps until v402 —
// Pinch #23 from the 2026-05-22 Kelly Caffee dry-run. Loading state
// falls through to LizChat: the shared module cache in useRepProfile
// resolves synchronously on second mount, so the race only matters
// on cold load for non-reps (the right answer anyway).
function LizzieIndex() {
  const repProfile = useRepProfile();
  if (repProfile.status === "rep") return <RepHome />;
  return <LizChat />;
}

function LizChat() {
  const { turn: turnAnchor } = Route.useSearch();
  const [turns, setTurns] = useState<LizChatTurn[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [usedChipIds, setUsedChipIds] = useState<Set<string>>(new Set());
  const [actingAs, setActingAs] = useState<RepPersona | null>(null);
  const [highlightedTurnId, setHighlightedTurnId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  // v326: track whether we've already handled the ?turn= deep-link so a
  // subsequent send doesn't keep re-scrolling away from the new reply.
  const deepLinkHandled = useRef(false);

  // Hydrate persona scope from localStorage on mount (client-only).
  useEffect(() => {
    setActingAs(loadActingAs());
  }, []);

  function handlePersonaPick(next: RepPersona | null) {
    setActingAs(next);
    saveActingAs(next);
  }

  // ⌘K / ⌃K toggles the prompt drawer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setDrawerOpen((d) => !d);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function handleChipPick(prompt: string, chipId?: string) {
    setDraft(prompt);
    if (chipId) {
      setUsedChipIds((prev) => new Set(prev).add(chipId));
    }
    setDrawerOpen(false);
    // Defer focus until the drawer transition finishes so the input keeps focus.
    setTimeout(() => inputRef.current?.focus(), 60);
  }

  // Load history on mount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { data: session } = await supabase.auth.getSession();
        const accessToken = session.session?.access_token;
        if (!accessToken) {
          if (!cancelled) {
            setLoading(false);
            toast.error("Please sign in to chat with Liz.");
          }
          return;
        }
        const history = await listLizMessages({ data: { accessToken } });
        if (!cancelled) {
          setTurns(history);
          setLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setLoading(false);
          toast.error(
            e instanceof Error ? e.message : "Couldn't load conversation.",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-scroll to bottom when turns change — UNLESS we're handling a
  // ?turn=<id> deep-link from the Deals Desk, in which case the
  // turn-anchor effect below takes precedence on first paint.
  useEffect(() => {
    if (turnAnchor && !deepLinkHandled.current && turns.length > 0) return;
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [turns, sending, turnAnchor]);

  // v326: ?turn=<id> deep-link from /app/rep/sends. Once turns are loaded
  // and the matching DOM node exists, scroll it into view and pulse a
  // highlight briefly so the rep sees what they came back to look at. Fires
  // once per page-mount; subsequent sends scroll normally.
  useEffect(() => {
    if (!turnAnchor) return;
    if (deepLinkHandled.current) return;
    if (turns.length === 0) return;
    const target = turns.find((t) => t.id === turnAnchor);
    if (!target) return;
    deepLinkHandled.current = true;
    setHighlightedTurnId(target.id);
    // Defer to next paint so the DOM is mounted before we look it up.
    requestAnimationFrame(() => {
      const el = document.getElementById(`turn-${target.id}`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    const t = setTimeout(() => setHighlightedTurnId(null), 2200);
    return () => clearTimeout(t);
  }, [turnAnchor, turns]);

  async function handleSend() {
    const message = draft.trim();
    if (!message || sending) return;

    setSending(true);
    setDraft("");
    // Optimistic user turn.
    const optimisticId = `optimistic-${Date.now()}`;
    setTurns((prev) => [
      ...prev,
      {
        id: optimisticId,
        role: "user",
        body: message,
        createdAt: new Date().toISOString(),
      },
    ]);

    try {
      const { data: session } = await supabase.auth.getSession();
      const accessToken = session.session?.access_token;
      if (!accessToken) {
        throw new Error("Sign in to chat with Liz.");
      }
      const result = await sendLizMessage({
        data: { accessToken, message, actingAs },
      });
      // Replace the optimistic turn with the real one + append the agent reply.
      setTurns((prev) => [
        ...prev.filter((t) => t.id !== optimisticId),
        result.userTurn,
        result.agentTurn,
      ]);
    } catch (e) {
      // Rollback the optimistic turn on failure; restore the draft so the rep
      // can edit + retry.
      setTurns((prev) => prev.filter((t) => t.id !== optimisticId));
      setDraft(message);
      toast.error(
        e instanceof Error ? e.message : "Couldn't reach Liz — try again.",
      );
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }

  function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // ⌘↵ / ⌃↵ — send immediately (matches the drawer hint copy)
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void handleSend();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }

  // v320: clear the conversation. Used when prior turns are poisoning
  // Gemini's output (e.g. a hallucinated answer Liz keeps regurgitating).
  // Keeps the session row + persona scope intact; only wipes the turns.
  async function handleNewChat() {
    const turnCount = turns.length;
    if (turnCount > 0) {
      const msg =
        turnCount === 1
          ? "Start a new chat? The current message will be cleared."
          : `Start a new chat? The current ${turnCount} messages will be cleared.`;
      if (!confirm(msg)) return;
    }
    try {
      const { data: session } = await supabase.auth.getSession();
      const accessToken = session.session?.access_token;
      if (!accessToken) {
        toast.error("You're not signed in.");
        return;
      }
      const { deleted } = await clearLizMessages({ data: { accessToken } });
      setTurns([]);
      setUsedChipIds(new Set());
      toast.success(
        deleted > 0
          ? `Started fresh. ${deleted} prior ${deleted === 1 ? "message" : "messages"} cleared.`
          : "Started fresh.",
      );
    } catch (e) {
      toast.error("Couldn't start a new chat", { description: (e as Error).message });
    }
  }

  return (
    <div className="flex flex-col h-screen">
      <PageHeader
        eyebrow="Lizzie(OS)"
        title="Liz"
        description="Your AI partner for accounts, products, and territory."
        actions={
          <div className="flex items-center gap-2">
            <ActingAsPicker actingAs={actingAs} onPick={handlePersonaPick} />
            <button
              type="button"
              onClick={handleNewChat}
              className="inline-flex items-center gap-1.5 text-xs text-ink-soft hover:text-foreground rounded-full border border-border px-3 py-1.5"
              aria-label="Start a new chat — clears the current conversation"
              title="Start a new chat (clears prior messages so a poisoned conversation context can't keep regurgitating)"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              New chat
            </button>
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              className="inline-flex items-center gap-1.5 text-xs text-ink-soft hover:text-foreground rounded-full border border-border px-3 py-1.5"
              aria-label="Open prompt library"
              title="Prompt library — ⌘K"
            >
              <Library className="h-3.5 w-3.5" />
              Prompts
              <kbd className="ml-0.5 px-1 py-px text-[9px] rounded bg-sidebar-accent/40 text-ink-soft font-mono">⌘K</kbd>
            </button>
            <Link
              to="/app/rep/today"
              className="inline-flex items-center gap-1.5 text-xs rounded-full border border-primary/40 bg-primary/5 px-3 py-1.5 text-primary hover:bg-primary/10"
              title="Today's focus — top opportunities, follow-ups, recent activity"
            >
              <Target className="h-3.5 w-3.5" />
              Today
            </Link>
            <Link
              to="/app/rep/sends"
              className="inline-flex items-center gap-1.5 text-xs text-ink-soft hover:text-foreground rounded-full border border-border px-3 py-1.5"
              title="Deals desk — every sample order you've sent, opened, confirmed"
            >
              <Mail className="h-3.5 w-3.5" />
              Sends
            </Link>
            <Link
              to="/app/rep/promotions"
              className="inline-flex items-center gap-1.5 text-xs text-ink-soft hover:text-foreground rounded-full border border-border px-3 py-1.5"
              title="Promotions — active, upcoming, recently-expired across all manufacturers"
            >
              <Tag className="h-3.5 w-3.5" />
              Promos
            </Link>
            {/* v330: removed duplicate "Accounts" chip — it duplicated the
                top-nav RepShell tab AND pointed to the legacy /app/liz
                redirect URL, which surfaced as a clunky double-hop. Accounts
                lives in the top nav now (canonical /app/rep/accounts). */}
            <Link
              to="/app/rep/diag"
              className="inline-flex items-center gap-1.5 text-xs text-ink-soft hover:text-foreground rounded-full border border-border px-3 py-1.5"
              title="Eval diag — recent turns + tool calls + anti-pattern flags"
            >
              <Activity className="h-3.5 w-3.5" />
              Diag
            </Link>
          </div>
        }
      />

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-6 lg:px-10 space-y-4 bg-background"
      >
        {loading && (
          <div className="flex items-center justify-center text-sm text-ink-soft py-12">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            Loading conversation…
          </div>
        )}

        {!loading && turns.length === 0 && (
          <EmptyLiz onPick={(prompt, id) => handleChipPick(prompt, id)} onOpenDrawer={() => setDrawerOpen(true)} />
        )}

        {turns.map((t) => (
          <MessageBubble
            key={t.id}
            turn={t}
            highlighted={t.id === highlightedTurnId}
            onRated={(turnId, rating, note) =>
              setTurns((prev) =>
                prev.map((x) =>
                  x.id === turnId ? { ...x, rating, ratingNote: note } : x,
                ),
              )
            }
            onSent={(turnId, send) =>
              setTurns((prev) =>
                prev.map((x) =>
                  x.id === turnId
                    ? { ...x, sampleOrderSends: [...(x.sampleOrderSends ?? []), send] }
                    : x,
                ),
              )
            }
          />
        ))}

        {sending && (
          <div className="flex items-center gap-2 text-xs text-ink-soft px-2">
            <Sparkles className="h-3.5 w-3.5 text-primary animate-pulse" />
            Liz is thinking…
          </div>
        )}
      </div>

      <div className="border-t border-border bg-card px-4 py-3 lg:px-10">
        <div className="flex items-end gap-2 max-w-3xl mx-auto">
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Ask Liz about an account, product, or what to do next…"
            rows={1}
            disabled={sending}
            className="flex-1 resize-none rounded-2xl border border-border bg-background px-4 py-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:border-primary/40 disabled:opacity-60"
            style={{ maxHeight: 160 }}
          />
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={sending || !draft.trim()}
            className="inline-flex items-center justify-center h-10 w-10 shrink-0 rounded-full bg-primary text-white hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition"
            aria-label="Send"
          >
            {sending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>

      <ChipDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        currentDraft={draft}
        onPick={(prompt) => handleChipPick(prompt)}
        usedIds={usedChipIds}
      />
    </div>
  );
}

function MessageBubble({
  turn,
  onRated,
  onSent,
  highlighted,
}: {
  turn: LizChatTurn;
  onRated?: (turnId: string, rating: LizTurnRating | null, note: string | null) => void;
  onSent?: (turnId: string, send: LizSampleOrderSend) => void;
  highlighted?: boolean;
}) {
  const isUser = turn.role === "user";
  return (
    <div
      id={`turn-${turn.id}`}
      className={cn(
        "flex w-full scroll-mt-8 transition-shadow",
        isUser ? "justify-end" : "justify-start",
        highlighted && "rounded-2xl ring-2 ring-amber-400/70 ring-offset-2 ring-offset-background",
      )}
    >
      <div className={cn("max-w-[80%] lg:max-w-[60%] flex flex-col", isUser ? "items-end" : "items-start")}>
        <div
          className={cn(
            "rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap",
            isUser
              ? "bg-primary text-white rounded-br-sm"
              : "bg-card border border-border text-foreground rounded-bl-sm shadow-sm",
          )}
        >
          {isUser ? turn.body : <VerifiedAwareBody body={turn.body} />}
        </div>
        {!isUser && turn.id && !turn.id.startsWith("optimistic-") && turn.sampleOrder && (
          <SendToPracticeBlock turn={turn} onSent={onSent} />
        )}
        {!isUser && turn.id && !turn.id.startsWith("optimistic-") && (
          <RatingBar turn={turn} onRated={onRated} />
        )}
      </div>
    </div>
  );
}

// ── [VERIFIED] data-receipt chip (v324) ────────────────────────────────────
// Detect the structured [VERIFIED] line Liz emits at the top of any
// tier-math reply, render it as a styled green pill (the "data receipt"
// pattern — values quoted verbatim from the DB, scan-friendly in one
// glance), and render the remaining body without the verbatim line so the
// numbers don't appear twice.
//
// Defensive: if the line is missing or malformed, fall back to plain body
// rendering — never blank a message.

const VERIFIED_RE =
  /^\s*\[VERIFIED\]\s+([^:]+?):\s*tier=([^,]+?),\s*ytd=\$?([\d,]+(?:\.\d+)?)\s*,\s*threshold_to_advance=\$?([\d,]+(?:\.\d+)?)\s*,\s*gap=\$?([\d,]+(?:\.\d+)?)\s*$/im;

type VerifiedParsed = {
  account: string;
  tier: string;
  ytd: string;
  threshold: string;
  gap: string;
};

function parseVerifiedLine(body: string): { parsed: VerifiedParsed | null; rest: string } {
  const m = body.match(VERIFIED_RE);
  if (!m) return { parsed: null, rest: body };
  return {
    parsed: {
      account: m[1].trim(),
      tier: m[2].trim(),
      ytd: m[3].trim(),
      threshold: m[4].trim(),
      gap: m[5].trim(),
    },
    // Strip the matched line from the body; collapse the leading blank line
    // it leaves behind so spacing reads natural.
    rest: body.replace(VERIFIED_RE, "").replace(/^\s*\n/, ""),
  };
}

function fmtMoney(raw: string): string {
  const n = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(n)) return `$${raw}`;
  // Whole-dollar if no cents; otherwise 2-decimal — matches how the source
  // line was written (e.g. $24,649.80 stays exact, $150,000 stays clean).
  const hasCents = raw.includes(".");
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: hasCents ? 2 : 0,
  });
}

function VerifiedAwareBody({ body }: { body: string }) {
  const { parsed, rest } = parseVerifiedLine(body);
  if (!parsed) return <>{body}</>;
  return (
    <>
      <div className="mb-2 rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-3 py-2.5">
        <div className="flex items-center gap-1.5 mb-1.5">
          <CheckCircle2 className="h-3 w-3 text-emerald-600" />
          <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-700">Verified from data</span>
          <span className="text-[11px] text-ink-soft truncate">· {parsed.account}</span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-1.5">
          <VerifiedCell label="Tier" value={parsed.tier} />
          <VerifiedCell label="YTD" value={fmtMoney(parsed.ytd)} mono />
          <VerifiedCell label="To advance" value={fmtMoney(parsed.threshold)} mono />
          <VerifiedCell label="Gap" value={fmtMoney(parsed.gap)} mono accent />
        </div>
      </div>
      {rest}
    </>
  );
}

function VerifiedCell({
  label,
  value,
  mono,
  accent,
}: {
  label: string;
  value: string;
  mono?: boolean;
  accent?: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[9px] font-semibold uppercase tracking-wider text-ink-soft">{label}</div>
      <div
        className={cn(
          "text-[12px] leading-tight font-medium truncate",
          mono && "font-mono",
          accent ? "text-emerald-700 font-semibold" : "text-foreground",
        )}
        title={value}
      >
        {value}
      </div>
    </div>
  );
}

// ── Send-to-practice (v323) ────────────────────────────────────────────────
// Renders below a Liz reply that carries a structured sample-order artifact.
// Single button → opens a modal pre-filled with practice-friendly email
// copy. Rep edits to/subject/body, hits Send, the server fn generates a
// PDF and sends via Resend. Past sends show inline so the rep doesn't
// double-send accidentally.

function SendToPracticeBlock({
  turn,
  onSent,
}: {
  turn: LizChatTurn;
  onSent?: (turnId: string, send: LizSampleOrderSend) => void;
}) {
  const [open, setOpen] = useState(false);
  const sends = turn.sampleOrderSends ?? [];
  const lastSend = sends[sends.length - 1];

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "inline-flex items-center gap-1.5 text-xs rounded-full px-3 py-1.5 transition shadow-sm",
          lastSend
            ? "border border-border bg-card text-ink-soft hover:text-foreground"
            : "bg-primary text-white hover:opacity-90",
        )}
        aria-label={lastSend ? "Send sample order again" : "Send sample order to practice"}
      >
        <Mail className="h-3.5 w-3.5" />
        {lastSend ? "Send again" : "Send to practice"}
      </button>
      {lastSend && <SendStatusChip send={lastSend} />}
      <SendToPracticeDialog
        turn={turn}
        open={open}
        onClose={() => setOpen(false)}
        onSent={(send) => {
          onSent?.(turn.id, send);
          setOpen(false);
        }}
      />
    </div>
  );
}

// v325: stacked send-status chip — bottom line is "Sent to X · timestamp"
// (always present), top line surfaces practice-side activity from the Order
// NOW intent: confirmed (green BadgeCheck), viewed-but-not-confirmed (slate
// Eye), or nothing yet. Three states matter to a rep: they haven't opened
// it, they opened but didn't confirm, they confirmed. The "viewed" signal
// in particular is a follow-up cue — and the "confirmed" signal lets the
// rep stop chasing.
function SendStatusChip({ send }: { send: LizSampleOrderSend }) {
  const sentAt = formatChipTime(send.sent_at);
  const confirmedAt = send.intent_confirmed_at
    ? formatChipTime(send.intent_confirmed_at)
    : null;
  const viewedAt = send.intent_first_viewed_at
    ? formatChipTime(send.intent_first_viewed_at)
    : null;

  return (
    <span className="inline-flex flex-col gap-0.5 text-[11px] leading-tight">
      {confirmedAt ? (
        <span className="inline-flex items-center gap-1 text-emerald-700 font-medium">
          <BadgeCheck className="h-3 w-3" />
          Confirmed
          {send.intent_confirmed_by_name ? (
            <> by <strong className="font-semibold">{send.intent_confirmed_by_name}</strong></>
          ) : null}
          <span className="text-emerald-700/70 font-normal">· {confirmedAt}</span>
        </span>
      ) : viewedAt ? (
        <span className="inline-flex items-center gap-1 text-slate-600">
          <Eye className="h-3 w-3" />
          Opened
          <span className="text-ink-soft">· {viewedAt}</span>
        </span>
      ) : null}
      <span className="inline-flex items-center gap-1 text-emerald-600">
        <CheckCircle2 className="h-3 w-3" />
        Sent to <strong className="font-medium">{send.to}</strong>
        <span className="text-ink-soft">· {sentAt}</span>
      </span>
    </span>
  );
}

function formatChipTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function usdShort(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function defaultSubjectFor(order: LizSampleOrder): string {
  return `Sample order for ${order.account.title}${order.puts_them_at_tier ? ` — reach ${order.puts_them_at_tier}` : ""}`;
}

function defaultBodyFor(order: LizSampleOrder): string {
  const total = order.total_usd.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  const tierLine = order.puts_them_at_tier
    ? `This order would bring ${order.account.title} to the ${order.puts_them_at_tier} tier (total ${total}). `
    : `Total: ${total}. `;
  const familyList = order.line_items
    .map((li) => li.product_display || li.product_family)
    .join(", ");
  return (
    `Hi —\n\n` +
    `${tierLine}` +
    `The order keeps the mix you usually run: ${familyList}. PDF attached with the line-item breakdown.\n\n` +
    `Happy to adjust the mix or talk through the math — just hit reply.\n\n` +
    `Best,\n`
  );
}

function SendToPracticeDialog({
  turn,
  open,
  onClose,
  onSent,
}: {
  turn: LizChatTurn;
  open: boolean;
  onClose: () => void;
  onSent: (send: LizSampleOrderSend) => void;
}) {
  const order = turn.sampleOrder;
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState(order ? defaultSubjectFor(order) : "");
  const [body, setBody] = useState(order ? defaultBodyFor(order) : "");
  const [sending, setSending] = useState(false);

  // Reset state when dialog opens — so reopening after an edit doesn't
  // strand stale local input. Order itself is stable on the turn.
  useEffect(() => {
    if (open && order) {
      setSubject(defaultSubjectFor(order));
      setBody(defaultBodyFor(order));
      // Keep "to" as-is so a rep can reopen mid-typing without losing it.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!order) return null;

  async function handleSend() {
    if (!order) return;
    const trimmedTo = to.trim();
    if (!trimmedTo) {
      toast.error("Add the practice owner's email first.");
      return;
    }
    if (!subject.trim()) {
      toast.error("Subject can't be empty.");
      return;
    }
    setSending(true);
    try {
      const { data: session } = await supabase.auth.getSession();
      const accessToken = session.session?.access_token;
      if (!accessToken) throw new Error("Sign in to send.");
      const res = await sendSampleOrderEmail({
        data: { accessToken, turnId: turn.id, to: trimmedTo, subject: subject.trim(), body },
      });
      const send: LizSampleOrderSend = {
        to: res.to,
        subject: subject.trim(),
        sent_at: res.sentAt,
        email_id: res.emailId,
      };
      onSent(send);
      toast.success(`Sent to ${res.to}`, {
        description: "Practice owner will see the PDF attached.",
      });
    } catch (e) {
      toast.error("Couldn't send the order", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !sending && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mail className="h-4 w-4 text-primary" />
            Send sample order
          </DialogTitle>
          <DialogDescription>
            Pre-filled from Liz's order. Edit anything, then send — the practice owner gets a PDF attached.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-2 rounded-lg border border-border bg-sidebar-accent/20 px-3 py-2 text-xs">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-ink-soft font-medium">Practice</div>
            <div className="text-sm font-medium text-foreground truncate" title={order.account.title}>{order.account.title}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-ink-soft font-medium">Total</div>
            <div className="text-sm font-semibold text-primary">{usdShort(order.total_usd)}</div>
          </div>
        </div>

        <div className="space-y-3 mt-1">
          <div>
            <label htmlFor="send-to" className="block text-[11px] uppercase tracking-wider text-ink-soft font-medium mb-1">
              To
            </label>
            <input
              id="send-to"
              type="email"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="owner@practice.com"
              autoFocus
              disabled={sending}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:border-primary/40 disabled:opacity-60"
            />
          </div>
          <div>
            <label htmlFor="send-subject" className="block text-[11px] uppercase tracking-wider text-ink-soft font-medium mb-1">
              Subject
            </label>
            <input
              id="send-subject"
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              disabled={sending}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:border-primary/40 disabled:opacity-60"
            />
          </div>
          <div>
            <label htmlFor="send-body" className="block text-[11px] uppercase tracking-wider text-ink-soft font-medium mb-1">
              Message
            </label>
            <textarea
              id="send-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={8}
              disabled={sending}
              className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:border-primary/40 disabled:opacity-60"
            />
          </div>
          <p className="text-[11px] text-ink-soft">
            The PDF attachment includes the verified position, line items, and total — math closes exactly.
          </p>
        </div>

        <div className="mt-2 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={sending}
            className="text-xs text-ink-soft hover:text-foreground px-3 py-2 rounded-md disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={sending || !to.trim() || !subject.trim()}
            className="inline-flex items-center gap-1.5 bg-primary text-white text-xs font-medium rounded-md px-4 py-2 hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition"
          >
            {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RatingBar({
  turn,
  onRated,
}: {
  turn: LizChatTurn;
  onRated?: (turnId: string, rating: LizTurnRating | null, note: string | null) => void;
}) {
  const [rating, setRating] = useState<LizTurnRating | null>(turn.rating ?? null);
  const [note, setNote] = useState<string>(turn.ratingNote ?? "");
  const [noteOpen, setNoteOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function persist(next: LizTurnRating | null, nextNote: string | null) {
    setSubmitting(true);
    try {
      const { data: session } = await supabase.auth.getSession();
      const accessToken = session.session?.access_token;
      if (!accessToken) throw new Error("Sign in to rate Liz's replies.");
      const result = await rateLizTurn({
        data: { accessToken, turnId: turn.id, rating: next, note: nextNote },
      });
      setRating(result.rating);
      setNote(result.note ?? "");
      onRated?.(turn.id, result.rating, result.note);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save rating.");
    } finally {
      setSubmitting(false);
    }
  }

  async function clickUp() {
    if (submitting) return;
    if (rating === "up") {
      await persist(null, null);
      setNoteOpen(false);
    } else {
      await persist("up", null);
      setNoteOpen(false);
    }
  }

  async function clickDown() {
    if (submitting) return;
    if (rating === "down") {
      await persist(null, null);
      setNoteOpen(false);
    } else {
      await persist("down", note.trim() || null);
      setNoteOpen(true);
    }
  }

  async function saveNote() {
    if (submitting) return;
    await persist("down", note.trim() || null);
    setNoteOpen(false);
  }

  return (
    <div className="mt-1 flex flex-col gap-1.5 items-start">
      <div className="flex items-center gap-1 text-ink-soft">
        <button
          type="button"
          onClick={clickUp}
          disabled={submitting}
          aria-label={rating === "up" ? "Remove thumbs up" : "Rate this reply helpful"}
          aria-pressed={rating === "up"}
          className={cn(
            "p-1 rounded-md transition disabled:opacity-50",
            rating === "up"
              ? "text-emerald-500 bg-emerald-500/10"
              : "hover:text-foreground hover:bg-sidebar-accent/50",
          )}
        >
          <ThumbsUp className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={clickDown}
          disabled={submitting}
          aria-label={rating === "down" ? "Remove thumbs down" : "Rate this reply not helpful"}
          aria-pressed={rating === "down"}
          className={cn(
            "p-1 rounded-md transition disabled:opacity-50",
            rating === "down"
              ? "text-rose-500 bg-rose-500/10"
              : "hover:text-foreground hover:bg-sidebar-accent/50",
          )}
        >
          <ThumbsDown className="h-3.5 w-3.5" />
        </button>
        {rating === "down" && !noteOpen && (
          <button
            type="button"
            onClick={() => setNoteOpen(true)}
            className="ml-1 text-[10px] uppercase tracking-wider font-bold text-rose-500/80 hover:text-rose-500"
          >
            {note ? "edit reason" : "add reason"}
          </button>
        )}
        {rating === "down" && note && !noteOpen && (
          <span className="ml-2 text-[11px] italic text-ink-soft truncate max-w-[260px]" title={note}>
            “{note}”
          </span>
        )}
      </div>
      {rating === "down" && noteOpen && (
        <div className="flex items-center gap-1.5 w-full max-w-md">
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); void saveNote(); }
              if (e.key === "Escape") setNoteOpen(false);
            }}
            placeholder="One-line why? (helps train Liz)"
            maxLength={800}
            autoFocus
            className="flex-1 text-xs rounded-md border border-border bg-card px-2 py-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/30"
          />
          <button
            type="button"
            onClick={() => void saveNote()}
            disabled={submitting}
            className="text-[10px] uppercase tracking-wider font-bold rounded-md bg-rose-500/90 text-white px-2 py-1 hover:bg-rose-500 disabled:opacity-50"
          >
            save
          </button>
          <button
            type="button"
            onClick={() => setNoteOpen(false)}
            className="p-1 rounded-md text-ink-soft hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
    </div>
  );
}

function EmptyLiz({
  onPick,
  onOpenDrawer,
}: {
  onPick: (prompt: string, chipId: string) => void;
  onOpenDrawer: () => void;
}) {
  // Curated empty-state set — one chip per category so new reps see the
  // breadth of what Liz can do. Click any of these to drop into the input.
  const featured = [
    STARTER_CHIPS.find((c) => c.id === "cmp-volbella-kysse"),
    STARTER_CHIPS.find((c) => c.id === "tier-galderma-mid"),
    STARTER_CHIPS.find((c) => c.id === "traj-at-risk"),
    STARTER_CHIPS.find((c) => c.id === "acc-rejuv"),
  ].filter((c): c is NonNullable<typeof c> => Boolean(c));

  return (
    <div className="max-w-2xl mx-auto py-12 px-4 text-center">
      <div className="inline-flex items-center justify-center h-12 w-12 rounded-full bg-primary/10 mb-4">
        <Sparkles className="h-6 w-6 text-primary" />
      </div>
      <h2 className="text-xl font-semibold text-foreground mb-2">Hey, I'm Liz.</h2>
      <p className="text-sm text-ink-soft leading-relaxed mb-6 max-w-md mx-auto">
        Your AI partner for medical-aesthetics rep work. I know toxins, fillers,
        biostimulators, and skin boosters across all four major manufacturers —
        and I learn your accounts as you tell me about them.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-w-xl mx-auto text-left">
        {featured.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => onPick(c.prompt, c.id)}
            className="rounded-xl border border-border bg-card px-3 py-2 text-xs text-ink-soft hover:text-foreground hover:border-primary/40 hover:bg-primary/5 text-left transition"
          >
            "{c.label}"
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={onOpenDrawer}
        className="mt-5 inline-flex items-center gap-1.5 text-[11px] text-primary hover:underline"
      >
        See all prompts → <kbd className="px-1 py-px text-[9px] rounded bg-sidebar-accent/40 text-ink-soft font-mono">⌘K</kbd>
      </button>
    </div>
  );
}

// ── Acting-as persona picker ───────────────────────────────────────────────
// Lets the admin user (who holds all 68 rep-territory accounts) put on a rep
// hat so Liz scopes her reasoning to that rep's territory + tier model. The
// chosen persona persists in localStorage and propagates through every
// sendLizMessage call as the `actingAs` field — see liz-chat.functions.ts
// `configFor()` which prepends `buildActingAsPrefix(persona)` to LIZ_SYSTEM_PROMPT.

function ActingAsPicker({
  actingAs,
  onPick,
}: {
  actingAs: RepPersona | null;
  onPick: (next: RepPersona | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const isScoped = actingAs !== null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Choose rep persona"
          title={isScoped
            ? `Liz is scoped to your ${personaLabel(actingAs)} territory. Click to change.`
            : "Liz is in generalist mode (sees all 68 accounts). Click to scope to a rep persona."}
          className={cn(
            "inline-flex items-center gap-1.5 text-xs rounded-full border px-3 py-1.5 transition",
            isScoped
              ? "border-amber/50 bg-amber/10 text-foreground hover:bg-amber/20"
              : "border-border text-ink-soft hover:text-foreground",
          )}
        >
          <UserCircle className="h-3.5 w-3.5" />
          <span className="font-medium">Acting as:</span>
          <span>{personaLabel(actingAs)}</span>
          <span className="text-ink-soft">▾</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-1.5">
        <div className="px-2 py-1.5 text-[11px] font-medium tracking-wider text-ink-soft uppercase">
          Test Liz from a rep's seat
        </div>
        <button
          type="button"
          onClick={() => { onPick(null); setOpen(false); }}
          className={cn(
            "w-full flex items-start gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-sidebar-accent/40 transition",
            actingAs === null && "bg-sidebar-accent/30",
          )}
        >
          <Check className={cn("h-3.5 w-3.5 mt-0.5 shrink-0", actingAs === null ? "opacity-100 text-primary" : "opacity-0")} />
          <div className="flex-1 min-w-0">
            <div className="font-medium">Generalist</div>
            <div className="text-[11px] text-ink-soft mt-0.5">Liz sees all 68 accounts, no manufacturer scope.</div>
          </div>
        </button>
        <div className="h-px bg-border my-1" />
        {REP_PERSONAS.map((p) => (
          <button
            key={p.value}
            type="button"
            onClick={() => { onPick(p.value); setOpen(false); }}
            className={cn(
              "w-full flex items-start gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-sidebar-accent/40 transition",
              actingAs === p.value && "bg-sidebar-accent/30",
            )}
          >
            <Check className={cn("h-3.5 w-3.5 mt-0.5 shrink-0", actingAs === p.value ? "opacity-100 text-primary" : "opacity-0")} />
            <div className="flex-1 min-w-0">
              <div className="font-medium">{p.label}</div>
              <div className="text-[11px] text-ink-soft mt-0.5">{p.manufacturer}</div>
            </div>
          </button>
        ))}
        <div className="px-2 py-1.5 mt-1 text-[10px] text-ink-soft border-t border-border">
          Saved to this device. Liz scopes her chat reasoning to the chosen rep's territory + tier model.
        </div>
      </PopoverContent>
    </Popover>
  );
}
