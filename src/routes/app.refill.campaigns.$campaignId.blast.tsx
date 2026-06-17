/**
 * /app/refill/campaigns/$campaignId/blast — Promotions Engine composer + send.
 *
 * v349 (Phase 3.0): rendered the cohort as editable rows with Emma-drafted
 * copy + [VERIFIED] chips; Send was disabled.
 *
 * v350 (Phase 3.1): Send wires to live Twilio + Resend dispatch. Client
 * iterates targets with concurrency=3, per-row state chip flips draft →
 * sending → sent/skipped/failed in real time. Confirmation modal with
 * patient + channel breakdown before any dispatch.
 *
 * Established 2026-05-15. Phase 3.1 ships 2026-05-15.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  CalendarClock,
  CheckCircle2,
  Edit3,
  Loader2,
  Mail,
  MessageSquare,
  RefreshCw,
  Save,
  Send,
  ShieldAlert,
  Sparkles,
  X,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { supabase } from "@/integrations/supabase/client";
import {
  cancelScheduledBlast,
  generateCampaignDraft,
  listCampaignTargets,
  saveCampaignDraft,
  scheduleCampaignBlast,
  sendCampaignMessage,
  type BlastChannel,
  type CampaignDraft,
  type CampaignTarget,
  type ListCampaignTargetsResult,
  type SendCampaignMessageResult,
  type SendSkipReason,
} from "@/server/emma-blast.functions";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/refill/campaigns/$campaignId/blast")({
  component: BlastComposerPage,
});

// ─── Module-level draft-generation throttle (v350.1) ─────────────────────
//
// Without this, opening a composer with 9+ rows fired 9+ concurrent Gemini
// calls; Vertex serializes them and the back-of-queue requests hit the 30s
// abort window. Cap at 3 concurrent — matches the send flow's pacing and
// stays well under Vertex's per-project concurrent-request guidance.
const MAX_CONCURRENT_DRAFTS = 3;
let activeDraftCount = 0;
const draftQueue: Array<() => void> = [];
async function withDraftSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeDraftCount >= MAX_CONCURRENT_DRAFTS) {
    await new Promise<void>((resolve) => draftQueue.push(resolve));
  }
  activeDraftCount++;
  try {
    return await fn();
  } finally {
    activeDraftCount--;
    const next = draftQueue.shift();
    if (next) next();
  }
}

/** Per-row send status (client-side overlay over the server state). */
type RowSendStatus =
  | { kind: "idle" }
  | { kind: "queued" }
  | { kind: "sending" }
  | { kind: "sent"; messageId: string | null; channel: "sms" | "email" }
  | { kind: "skipped"; reason: SendSkipReason; message: string }
  | { kind: "failed"; message: string };

function BlastComposerPage() {
  const { campaignId } = Route.useParams();
  const [result, setResult] = useState<ListCampaignTargetsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0); // bump to refresh row drafts
  const [sendStatus, setSendStatus] = useState<Map<string, RowSendStatus>>(
    new Map(),
  );
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [cancelingSchedule, setCancelingSchedule] = useState(false);

  const load = async () => {
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        setError("Please sign in to compose this blast.");
        setLoading(false);
        return;
      }
      const r = await listCampaignTargets({
        data: { accessToken: token, campaignId },
      });
      setResult(r);
      setLoading(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load targets.");
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId]);

  function updateRow(patientId: string, next: RowSendStatus) {
    setSendStatus((prev) => {
      const m = new Map(prev);
      m.set(patientId, next);
      return m;
    });
  }

  async function runBlast() {
    if (!result) return;
    setSending(true);
    setConfirmOpen(false);

    // Filter to rows that are still 'targeted' (not already sent in a prior
    // run). The server fn double-checks but we don't want to flood it with
    // already_sent skips.
    const queue = result.targets.filter((t) => t.state === "targeted");
    queue.forEach((t) => updateRow(t.patientNodeId, { kind: "queued" }));

    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    if (!token) {
      toast.error("Sign-in lost — refresh and try again.");
      setSending(false);
      return;
    }

    // Concurrency-3 worker pool. Twilio's default rate limit is 1/s; Resend
    // is more generous. 3 concurrent slots keeps a comfortable margin while
    // making 300-patient blasts feel responsive (~100s end-to-end).
    let cursor = 0;
    let sentCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    async function worker(): Promise<void> {
      while (cursor < queue.length) {
        const i = cursor++;
        const target = queue[i];
        updateRow(target.patientNodeId, { kind: "sending" });
        try {
          const r: SendCampaignMessageResult = await sendCampaignMessage({
            data: {
              accessToken: token!,
              campaignId,
              patientNodeId: target.patientNodeId,
            },
          });
          if (r.ok) {
            sentCount++;
            updateRow(target.patientNodeId, {
              kind: "sent",
              messageId: r.messageId,
              channel: r.channel,
            });
          } else {
            skippedCount++;
            updateRow(target.patientNodeId, {
              kind: "skipped",
              reason: r.skipReason,
              message: r.message,
            });
          }
        } catch (e) {
          failedCount++;
          updateRow(target.patientNodeId, {
            kind: "failed",
            message: e instanceof Error ? e.message : "Unknown error.",
          });
        }
      }
    }

    await Promise.all([worker(), worker(), worker()]);

    setSending(false);
    toast.success(
      `Blast complete — ${sentCount} sent, ${skippedCount} skipped, ${failedCount} failed.`,
    );
    // Reload to pull fresh server-side state (last_touched_at + new state).
    void load();
  }

  async function runSchedule(whenISO: string) {
    if (!result) return;
    setScheduling(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        toast.error("Sign-in lost — refresh and try again.");
        return;
      }
      const r = await scheduleCampaignBlast({
        data: { accessToken: token, campaignId, scheduledAt: whenISO },
      });
      toast.success(
        `Scheduled ${r.count} message${r.count === 1 ? "" : "s"} for ${new Date(r.scheduledAt).toLocaleString()}.`,
      );
      setScheduleOpen(false);
      void load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't schedule.");
    } finally {
      setScheduling(false);
    }
  }

  async function runCancelSchedule() {
    setCancelingSchedule(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        toast.error("Sign-in lost — refresh and try again.");
        return;
      }
      const r = await cancelScheduledBlast({
        data: { accessToken: token, campaignId },
      });
      toast.success(
        `Cancelled — ${r.count} row${r.count === 1 ? "" : "s"} back to targeted.`,
      );
      void load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't cancel schedule.");
    } finally {
      setCancelingSchedule(false);
    }
  }

  const counts = useMemo(() => {
    if (!result) return null;
    let sms = 0;
    let email = 0;
    let unreachable = 0;
    for (const t of result.targets) {
      if (t.state !== "targeted") continue;
      const ch = t.draft?.channel ?? t.recommendedChannel;
      if (ch === "sms" && t.phone) sms++;
      else if (ch === "email" && t.email) email++;
      else if (ch === "both" && (t.phone || t.email)) {
        if (t.phone) sms++;
        else email++;
      } else unreachable++;
    }
    return { sms, email, unreachable, total: sms + email };
  }, [result]);

  /**
   * Derive scheduling state: when ANY target is in 'scheduled' state we
   * treat the whole campaign as scheduled. The schedule was set across
   * all targeted rows in one call so the scheduled_at should be
   * uniform; we surface the earliest one and the count for the banner.
   */
  const scheduledInfo = useMemo(() => {
    if (!result) return null;
    const scheduled = result.targets.filter(
      (t) => t.state === "scheduled" && t.scheduledAt,
    );
    if (scheduled.length === 0) return null;
    const earliest = scheduled
      .map((t) => t.scheduledAt!)
      .sort()[0];
    return { count: scheduled.length, scheduledAt: earliest };
  }, [result]);

  return (
    <div className="flex flex-col min-h-screen bg-background">
      <PageHeader
        eyebrow="SmartSpa · Blast composer"
        title={result?.campaignTitle ?? (loading ? "Loading…" : "Compose")}
        description="Review every draft, then send. Each send respects banned + opted-out + velocity + quiet hours — SmartSpa never breaks compliance."
        breadcrumbs={[
          { label: "SmartSpa", to: "/app/refill" },
          { label: "Campaigns", to: "/app/refill/campaigns" },
          {
            label: result?.campaignTitle ?? "Campaign",
          },
          { label: "Compose" },
        ]}
        actions={
          <div className="flex items-center gap-2">
            <Link
              to="/app/refill/campaigns/$campaignId"
              params={{ campaignId }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-muted transition"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back to campaign
            </Link>
            <button
              type="button"
              disabled={
                sending ||
                scheduling ||
                loading ||
                !result ||
                result.targets.length === 0 ||
                (counts?.total ?? 0) === 0
              }
              onClick={() => setScheduleOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-muted transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <CalendarClock className="h-3.5 w-3.5" />
              Schedule
            </button>
            <button
              type="button"
              disabled={
                sending ||
                scheduling ||
                loading ||
                !result ||
                result.targets.length === 0 ||
                (counts?.total ?? 0) === 0
              }
              onClick={() => setConfirmOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald text-paper px-3 py-1.5 text-xs font-semibold hover:opacity-90 transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {sending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
              Send all
            </button>
          </div>
        }
      />

      <div className="flex-1 px-4 py-6 lg:px-10 max-w-[960px] w-full mx-auto space-y-5">
        {loading ? (
          <div className="flex items-center justify-center text-sm text-ink-soft py-16">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            Resolving cohort + seeding rows…
          </div>
        ) : error || !result ? (
          <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-5 text-sm">
            <div className="font-semibold text-destructive">
              Couldn't load this blast
            </div>
            <p className="text-xs text-ink-soft mt-1">{error}</p>
            <Link
              to="/app/refill/campaigns/$campaignId"
              params={{ campaignId }}
              className="inline-flex items-center gap-1.5 mt-3 rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted transition"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back to campaign
            </Link>
          </div>
        ) : (
          <>
            <SummaryBar result={result} />
            {scheduledInfo && (
              <ScheduledBanner
                count={scheduledInfo.count}
                scheduledAt={scheduledInfo.scheduledAt}
                canceling={cancelingSchedule}
                onCancel={() => void runCancelSchedule()}
              />
            )}
            {result.exceedsBlastCap && (
              <BlastCapWarning
                blastCap={result.blastCap}
                totalMatched={result.totalMatched}
              />
            )}
            <div className="space-y-3">
              {result.targets.map((t) => (
                <TargetRow
                  key={t.id + ":" + version}
                  campaignId={campaignId}
                  target={t}
                  sendStatus={sendStatus.get(t.patientNodeId) ?? { kind: "idle" }}
                />
              ))}
            </div>
            {result.targets.length === 0 && (
              <div className="rounded-2xl border border-border bg-card p-10 text-center text-sm text-ink-soft">
                Your cohort returned no patients — adjust the filters on the
                campaign detail page.
              </div>
            )}
            {result.targets.length > 0 && (
              <div className="flex items-center justify-between pt-2 text-[11px] text-ink-soft">
                <span>
                  Showing {result.targets.length} of{" "}
                  {result.totalMatched.toLocaleString()} matched
                  {result.exceedsBlastCap
                    ? ` (capped at ${result.blastCap})`
                    : ""}
                </span>
                <button
                  type="button"
                  onClick={() => setVersion((v) => v + 1)}
                  className="inline-flex items-center gap-1 hover:text-foreground transition"
                  title="Regenerate every row's draft"
                >
                  <RefreshCw className="h-3 w-3" />
                  Refresh drafts
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {confirmOpen && result && counts && (
        <SendConfirmModal
          campaignTitle={result.campaignTitle}
          counts={counts}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => void runBlast()}
        />
      )}

      {scheduleOpen && result && counts && (
        <ScheduleModal
          campaignTitle={result.campaignTitle}
          counts={counts}
          scheduling={scheduling}
          onCancel={() => setScheduleOpen(false)}
          onConfirm={(whenISO) => void runSchedule(whenISO)}
        />
      )}
    </div>
  );
}

// ─── Scheduled banner ─────────────────────────────────────────────────────

function ScheduledBanner({
  count,
  scheduledAt,
  canceling,
  onCancel,
}: {
  count: number;
  scheduledAt: string;
  canceling: boolean;
  onCancel: () => void;
}) {
  const when = new Date(scheduledAt);
  return (
    <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4 flex items-center justify-between gap-3">
      <div className="flex items-start gap-3">
        <CalendarClock className="h-5 w-5 mt-0.5 text-amber-600 dark:text-amber-400 shrink-0" />
        <div>
          <div className="text-sm font-semibold text-foreground">
            Scheduled — {count} {count === 1 ? "message will" : "messages will"} send{" "}
            {when.toLocaleString(undefined, {
              weekday: "short",
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
          </div>
          <div className="text-xs text-ink-soft mt-0.5">
            Compliance rails (quiet hours · velocity · opt-out) still run at send time.
            You can edit drafts until then.
          </div>
        </div>
      </div>
      <button
        type="button"
        onClick={onCancel}
        disabled={canceling}
        className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-muted transition disabled:opacity-50 shrink-0"
      >
        {canceling ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <X className="h-3.5 w-3.5" />
        )}
        Cancel schedule
      </button>
    </div>
  );
}

// ─── Schedule modal ───────────────────────────────────────────────────────

function ScheduleModal({
  campaignTitle,
  counts,
  scheduling,
  onCancel,
  onConfirm,
}: {
  campaignTitle: string;
  counts: { sms: number; email: number; total: number };
  scheduling: boolean;
  onCancel: () => void;
  onConfirm: (whenISO: string) => void;
}) {
  // Default = tomorrow at 10am spa-local (matches typical patient-engagement
  // good-time-to-send heuristics). User can change anything.
  const [localValue, setLocalValue] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(10, 0, 0, 0);
    // <input type="datetime-local"> expects "YYYY-MM-DDTHH:mm" in LOCAL time.
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  });

  const minLocal = useMemo(() => {
    const d = new Date(Date.now() + 60_000);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }, []);

  const parsed = new Date(localValue);
  const valid = !isNaN(parsed.getTime()) && parsed.getTime() > Date.now() + 60_000;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="relative w-full max-w-md rounded-2xl border border-border bg-card shadow-2xl overflow-hidden">
        <button
          type="button"
          onClick={onCancel}
          className="absolute top-3 right-3 p-1.5 rounded-lg text-ink-soft hover:text-foreground hover:bg-muted transition"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
        <div className="px-6 pt-6 pb-4">
          <div className="flex items-center gap-2 text-xs font-medium tracking-wider text-emerald uppercase mb-1">
            <CalendarClock className="h-3.5 w-3.5" />
            Schedule send
          </div>
          <h2 className="text-lg font-semibold text-foreground">
            {campaignTitle}
          </h2>
          <p className="text-xs text-ink-soft mt-1">
            SmartSpa will queue {counts.total} message{counts.total === 1 ? "" : "s"}{" "}
            ({counts.sms} SMS · {counts.email} email) to dispatch at the time you pick.
          </p>
        </div>
        <div className="px-6 pb-2 space-y-3">
          <label className="block">
            <span className="block text-xs font-medium text-ink-soft mb-1.5">
              Send at (your local time)
            </span>
            <input
              type="datetime-local"
              value={localValue}
              min={minLocal}
              onChange={(e) => setLocalValue(e.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald/30"
            />
          </label>
          {valid && (
            <div className="rounded-md bg-muted/40 px-3 py-2 text-xs">
              <span className="text-ink-soft mr-2">Will send:</span>
              <span className="font-medium text-foreground">
                {parsed.toLocaleString(undefined, {
                  weekday: "long",
                  month: "long",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </span>
            </div>
          )}
          <p className="text-[11px] text-ink-soft">
            Quiet hours, velocity cap, and opt-out checks still run at send time —
            a 2 AM scheduled send will skip rows that violate quiet hours.
          </p>
        </div>
        <div className="px-6 py-4 flex items-center justify-end gap-2 border-t border-border">
          <button
            type="button"
            onClick={onCancel}
            disabled={scheduling}
            className="px-3 py-2 rounded-md border border-border text-sm text-ink-soft hover:text-foreground disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => valid && onConfirm(parsed.toISOString())}
            disabled={scheduling || !valid}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-emerald text-paper text-sm font-semibold hover:opacity-90 transition disabled:opacity-50"
          >
            {scheduling ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <CalendarClock className="h-4 w-4" />
            )}
            Schedule
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Send confirmation modal ──────────────────────────────────────────────

function SendConfirmModal({
  campaignTitle,
  counts,
  onCancel,
  onConfirm,
}: {
  campaignTitle: string;
  counts: { sms: number; email: number; unreachable: number; total: number };
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="relative w-full max-w-md rounded-2xl border border-border bg-card shadow-2xl overflow-hidden">
        <button
          type="button"
          onClick={onCancel}
          className="absolute top-3 right-3 text-ink-soft hover:text-foreground transition"
          aria-label="Cancel"
        >
          <X className="h-4 w-4" />
        </button>
        <div className="px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-amber-600 dark:text-amber-400" />
            <h2 className="text-sm font-semibold">Send real messages</h2>
          </div>
          <p className="text-[11px] text-ink-soft mt-1">
            {campaignTitle}
          </p>
        </div>
        <div className="px-5 py-4 space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-lg border border-border bg-background px-3 py-2">
              <div className="text-[10px] uppercase tracking-wider font-semibold text-ink-soft">
                SMS
              </div>
              <div className="text-xl font-semibold tabular-nums mt-0.5">
                {counts.sms.toLocaleString()}
              </div>
            </div>
            <div className="rounded-lg border border-border bg-background px-3 py-2">
              <div className="text-[10px] uppercase tracking-wider font-semibold text-ink-soft">
                Email
              </div>
              <div className="text-xl font-semibold tabular-nums mt-0.5">
                {counts.email.toLocaleString()}
              </div>
            </div>
          </div>
          {counts.unreachable > 0 && (
            <div className="text-[11px] text-ink-soft">
              {counts.unreachable.toLocaleString()} unreachable (no phone or
              email) — will be skipped.
            </div>
          )}
          <ul className="text-[11px] text-ink-soft space-y-1 list-disc list-inside leading-relaxed">
            <li>Banned + opted-out patients excluded.</li>
            <li>Velocity cap enforced (1 per patient per campaign window).</li>
            <li>Quiet hours respected (9am–9pm local).</li>
            <li>Every send is logged and idempotent.</li>
          </ul>
        </div>
        <div className="px-5 py-3 border-t border-border flex items-center justify-end gap-2 bg-muted/30">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted transition"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald text-paper px-3 py-1.5 text-xs font-semibold hover:opacity-90 transition"
          >
            <Send className="h-3.5 w-3.5" />
            Send {counts.total.toLocaleString()} now
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Summary + warnings ───────────────────────────────────────────────────

function SummaryBar({ result }: { result: ListCampaignTargetsResult }) {
  return (
    <section className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="grid grid-cols-3 divide-x divide-border">
        <Stat
          label="Matched"
          value={result.totalMatched.toLocaleString()}
        />
        <Stat
          label="In this blast"
          value={result.targets.length.toLocaleString()}
        />
        <Stat
          label="Blast cap"
          value={result.blastCap.toLocaleString()}
          warn={result.exceedsBlastCap}
        />
      </div>
    </section>
  );
}

function BlastCapWarning({
  blastCap,
  totalMatched,
}: {
  blastCap: number;
  totalMatched: number;
}) {
  return (
    <div className="rounded-xl border border-amber-400/30 bg-amber-50/60 dark:bg-amber-950/20 px-4 py-3 flex items-start gap-3">
      <AlertTriangle className="h-4 w-4 text-amber-700 dark:text-amber-300 mt-0.5 shrink-0" />
      <div className="text-xs text-foreground leading-relaxed">
        <strong>{totalMatched.toLocaleString()} patients match</strong> — only
        the top {blastCap.toLocaleString()} (by lifetime spend) are shown
        here for review. Narrow the cohort, or split the blast into batches
        when Phase 3.1 ships.
      </div>
    </div>
  );
}

// ─── Target row ───────────────────────────────────────────────────────────

function TargetRow({
  campaignId,
  target,
  sendStatus,
}: {
  campaignId: string;
  target: CampaignTarget;
  sendStatus: RowSendStatus;
}) {
  const [draft, setDraft] = useState<CampaignDraft | null>(target.draft);
  const [generating, setGenerating] = useState(!target.draft);
  const [saving, setSaving] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const dirtyRef = useRef(false);
  // Track which channel is currently selected — independent of draft.channel
  // so the spa owner can swap without losing the current draft text.
  const [channel, setChannel] = useState<BlastChannel>(
    target.draft?.channel ?? target.recommendedChannel ?? "email",
  );

  // Lazy-generate on mount when no saved draft.
  useEffect(() => {
    if (target.draft) return;
    let cancelled = false;
    void (async () => {
      try {
        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token;
        if (!token) {
          if (!cancelled) {
            setGenError("Sign in to generate.");
            setGenerating(false);
          }
          return;
        }
        const d = await withDraftSlot(() =>
          generateCampaignDraft({
            data: {
              accessToken: token,
              campaignId,
              patientNodeId: target.patientNodeId,
              channel,
            },
          }),
        );
        if (cancelled) return;
        setDraft(d);
        setGenerating(false);
        // Auto-persist so Send actually has something to read. Without
        // this, the user has to manually Save every row before Send works
        // — confusing UX since the draft is visible in the textarea
        // (v350 lesson). Edits are still preserved via manual Save below.
        void saveCampaignDraft({
          data: {
            accessToken: token,
            campaignId,
            patientNodeId: target.patientNodeId,
            draft: { ...d, edited: false },
          },
        }).catch((saveErr) => {
          // Non-fatal — the manual Save button still works.
          console.warn("auto-save failed:", saveErr);
        });
      } catch (e) {
        if (!cancelled) {
          setGenError(
            e instanceof Error ? e.message : "Couldn't generate.",
          );
          setGenerating(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function regenerate() {
    setGenerating(true);
    setGenError(null);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        setGenError("Sign in to regenerate.");
        return;
      }
      const d = await withDraftSlot(() =>
        generateCampaignDraft({
          data: {
            accessToken: token,
            campaignId,
            patientNodeId: target.patientNodeId,
            channel,
          },
        }),
      );
      setDraft(d);
      dirtyRef.current = false;
      // Auto-save the regenerated draft (same rationale as lazy-mount path).
      void saveCampaignDraft({
        data: {
          accessToken: token,
          campaignId,
          patientNodeId: target.patientNodeId,
          draft: { ...d, edited: false },
        },
      }).catch((saveErr) => {
        console.warn("auto-save after regenerate failed:", saveErr);
      });
    } catch (e) {
      setGenError(e instanceof Error ? e.message : "Couldn't regenerate.");
    } finally {
      setGenerating(false);
    }
  }

  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        toast.error("Sign-in lost — refresh and try again.");
        return;
      }
      const toSave: CampaignDraft = {
        ...draft,
        channel,
        edited: dirtyRef.current,
      };
      await saveCampaignDraft({
        data: {
          accessToken: token,
          campaignId,
          patientNodeId: target.patientNodeId,
          draft: toSave,
        },
      });
      dirtyRef.current = false;
      toast.success("Saved.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save draft.");
    } finally {
      setSaving(false);
    }
  }

  function updateSubject(v: string) {
    if (!draft) return;
    setDraft({ ...draft, subject: v });
    dirtyRef.current = true;
  }
  function updateBody(v: string) {
    if (!draft) return;
    setDraft({ ...draft, body: v });
    dirtyRef.current = true;
  }

  const locked = sendStatus.kind === "sent" || target.state === "outreached";
  return (
    <article
      className={cn(
        "rounded-xl border bg-card overflow-hidden",
        sendStatus.kind === "sent" || target.state === "outreached"
          ? "border-emerald-500/40 bg-emerald-50/30 dark:bg-emerald-950/10"
          : sendStatus.kind === "skipped" || sendStatus.kind === "failed"
            ? "border-amber-500/40 bg-amber-50/30 dark:bg-amber-950/10"
            : "border-border",
      )}
    >
      <header className="px-4 py-3 border-b border-border bg-muted/30 flex items-start justify-between gap-3 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold">{target.displayName}</span>
            <SendStatusChip status={sendStatus} priorState={target.state} />
          </div>
          <div className="text-[11px] text-ink-soft mt-0.5 flex items-center gap-2 flex-wrap">
            <span>
              {target.totalVisits} visits ·{" "}
              {target.lifetimeSpendUsd.toLocaleString("en-US", {
                style: "currency",
                currency: "USD",
                maximumFractionDigits: 0,
              })}{" "}
              lifetime
            </span>
            {target.primaryManufacturer && (
              <span className="text-ink-faint">
                · {target.primaryManufacturer}
              </span>
            )}
            {target.lastVisit && (
              <span className="text-ink-faint">
                · last visit {target.lastVisit}
              </span>
            )}
          </div>
          {sendStatus.kind === "skipped" && (
            <div className="text-[11px] text-amber-700 dark:text-amber-300 mt-1 flex items-center gap-1">
              <Ban className="h-2.5 w-2.5" />
              Skipped — {sendStatus.message}
            </div>
          )}
          {sendStatus.kind === "failed" && (
            <div className="text-[11px] text-destructive mt-1 flex items-center gap-1">
              <AlertTriangle className="h-2.5 w-2.5" />
              {sendStatus.message}
            </div>
          )}
        </div>
        <ChannelToggle
          value={channel}
          onChange={(c) => !locked && setChannel(c)}
          phone={target.phone}
          email={target.email}
        />
      </header>

      <div className="px-4 py-3 space-y-3">
        {draft?.verifiedChip && (
          <div className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider">
            <CheckCircle2 className="h-2.5 w-2.5" />
            {draft.verifiedChip}
          </div>
        )}

        {generating ? (
          <div className="flex items-center gap-2 text-xs text-ink-soft py-6">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            SmartSpa is drafting…
          </div>
        ) : genError ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs">
            <div className="text-destructive font-semibold">Couldn't draft</div>
            <p className="text-ink-soft mt-1">{genError}</p>
            <button
              type="button"
              onClick={() => void regenerate()}
              className="mt-2 inline-flex items-center gap-1 rounded-lg border border-border bg-background px-2.5 py-1 text-[11px] font-medium hover:bg-muted transition"
            >
              <RefreshCw className="h-3 w-3" />
              Retry
            </button>
          </div>
        ) : draft ? (
          <>
            {(channel === "email" || channel === "both") && (
              <div>
                <label className="text-[10px] uppercase tracking-wider font-semibold text-ink-soft block mb-1">
                  Email subject
                </label>
                <input
                  type="text"
                  value={draft.subject ?? ""}
                  onChange={(e) => updateSubject(e.target.value)}
                  placeholder="A short, specific subject"
                  className="w-full rounded-lg border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            )}
            <div>
              <label className="text-[10px] uppercase tracking-wider font-semibold text-ink-soft block mb-1">
                {channel === "sms" ? "SMS body" : "Body"}
              </label>
              <textarea
                value={draft.body}
                onChange={(e) => updateBody(e.target.value)}
                rows={channel === "sms" ? 3 : 6}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-ring font-mono"
              />
              <div className="mt-1 text-[10px] text-ink-faint flex items-center justify-between">
                <span>
                  {draft.body.length} chars
                  {channel === "sms" && draft.body.length > 320 && (
                    <span className="text-amber-600 dark:text-amber-400">
                      {" "}
                      · over SMS guidance (320)
                    </span>
                  )}
                </span>
                {draft.edited && (
                  <span className="inline-flex items-center gap-1">
                    <Edit3 className="h-2.5 w-2.5" />
                    edited
                  </span>
                )}
              </div>
            </div>
          </>
        ) : null}
      </div>

      <footer className="px-4 py-3 border-t border-border bg-muted/15 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => void regenerate()}
          disabled={generating || saving || locked}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted transition disabled:opacity-50"
        >
          {generating ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Sparkles className="h-3 w-3" />
          )}
          Regenerate
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={!draft || saving || generating || locked}
          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald text-paper px-3 py-1.5 text-xs font-semibold hover:opacity-90 transition disabled:opacity-50"
        >
          {saving ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Save className="h-3 w-3" />
          )}
          Save draft
        </button>
      </footer>
    </article>
  );
}

// ─── Per-row send-status chip ─────────────────────────────────────────────

function SendStatusChip({
  status,
  priorState,
}: {
  status: RowSendStatus;
  priorState: string;
}) {
  // Server-side state takes precedence when no client-side overlay exists.
  if (status.kind === "idle" && priorState === "outreached") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider">
        <CheckCircle2 className="h-2.5 w-2.5" />
        Sent
      </span>
    );
  }
  if (status.kind === "idle") return null;
  if (status.kind === "queued") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-muted text-ink-soft px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider">
        Queued
      </span>
    );
  }
  if (status.kind === "sending") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-300 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider">
        <Loader2 className="h-2.5 w-2.5 animate-spin" />
        Sending
      </span>
    );
  }
  if (status.kind === "sent") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider">
        <CheckCircle2 className="h-2.5 w-2.5" />
        Sent · {status.channel}
      </span>
    );
  }
  if (status.kind === "skipped") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-300 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider">
        <Ban className="h-2.5 w-2.5" />
        Skipped · {status.reason.replace(/_/g, " ")}
      </span>
    );
  }
  if (status.kind === "failed") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-destructive/15 text-destructive px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider">
        <AlertTriangle className="h-2.5 w-2.5" />
        Failed
      </span>
    );
  }
  return null;
}

// ─── Building blocks ──────────────────────────────────────────────────────

function Stat({
  label,
  value,
  warn,
}: {
  label: string;
  value: string;
  warn?: boolean;
}) {
  return (
    <div className="px-5 py-3">
      <div className="text-[10px] uppercase tracking-wider text-ink-soft font-semibold">
        {label}
      </div>
      <div
        className={cn(
          "text-xl font-semibold mt-0.5 tabular-nums",
          warn && "text-destructive",
        )}
      >
        {value}
      </div>
    </div>
  );
}

function ChannelToggle({
  value,
  onChange,
  phone,
  email,
}: {
  value: BlastChannel;
  onChange: (v: BlastChannel) => void;
  phone: string | null;
  email: string | null;
}) {
  const opts: Array<{
    key: BlastChannel;
    label: string;
    icon: typeof MessageSquare;
    disabled: boolean;
  }> = [
    { key: "sms", label: "SMS", icon: MessageSquare, disabled: !phone },
    { key: "email", label: "Email", icon: Mail, disabled: !email },
    {
      key: "both",
      label: "Both",
      icon: MessageSquare,
      disabled: !phone || !email,
    },
  ];
  return (
    <div className="inline-flex items-center rounded-lg border border-border bg-card p-0.5 text-xs shrink-0">
      {opts.map(({ key, label, icon: Icon, disabled }) => (
        <button
          key={key}
          type="button"
          onClick={() => !disabled && onChange(key)}
          disabled={disabled}
          className={cn(
            "px-2.5 py-1 rounded-md font-medium transition inline-flex items-center gap-1",
            value === key
              ? "bg-emerald text-paper"
              : "text-ink-soft hover:text-foreground",
            disabled && "opacity-40 cursor-not-allowed",
          )}
          title={disabled ? `No ${key === "sms" ? "phone" : key === "email" ? "email" : "phone or email"} on file` : undefined}
        >
          <Icon className="h-3 w-3" />
          {label}
        </button>
      ))}
    </div>
  );
}
