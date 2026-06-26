/**
 * /app/refill/rescue — Same-day rescue activity (v361).
 *
 * Two tabs:
 *   - Activity: list of rescue attempts (one per cancellation), status,
 *     outreach count, who claimed it
 *   - Waitlist: the spa's roster of opted-in patients
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowLeft,
  Award,
  CalendarClock,
  CheckCircle2,
  Clock,
  Heart,
  Lightbulb,
  Loader2,
  RefreshCw,
  Sparkles,
  Trash2,
  TrendingDown,
  Users,
  X,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { supabase } from "@/integrations/supabase/client";
import {
  listRescueActivity,
  type RescueActivityItem,
} from "@/server/emma-rescue.functions";
import {
  deleteWaitlistRow,
  listWaitlist,
  markPatientOptedOut,
  type WaitlistEntry,
} from "@/server/emma-waitlist.functions";
import {
  dismissPatternAlert,
  listPatternAlerts,
  type PatternAlert,
  type PatternAlertKind,
  type ReliabilityTier,
} from "@/server/emma-reliability.functions";
import {
  applyRecommendation,
  dismissRecommendation,
  listRecommendations,
  type Recommendation,
} from "@/server/emma-intelligence.functions";
import { useTenantMembership } from "@/lib/use-tenant-membership";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/refill/rescue")({
  component: RescuePage,
});

type Tab = "activity" | "waitlist" | "patterns";

function RescuePage() {
  const [tab, setTab] = useState<Tab>("activity");
  const [activity, setActivity] = useState<RescueActivityItem[] | null>(null);
  const [waitlist, setWaitlist] = useState<WaitlistEntry[] | null>(null);
  const [patterns, setPatterns] = useState<PatternAlert[] | null>(null);
  const [recommendations, setRecommendations] = useState<
    Recommendation[] | null
  >(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [dismissingId, setDismissingId] = useState<string | null>(null);
  const [recBusyId, setRecBusyId] = useState<string | null>(null);

  // v1.23.0 P3 sweep: all four parallel fns now accept viewAsUserId.
  // Pre-P3 only listWaitlist was opted in (v1.20 priority-5); the other
  // three returned the admin's empty data when impersonating. P3 closed
  // the gap so the Recovery surface fully honors persona-switcher state.
  const membership = useTenantMembership();
  const viewAsUserId =
    membership.status === "tenant" ? membership.viewAsUserId : undefined;

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        setLoadError("Please sign in.");
        return;
      }
      const [act, wait, pat, recs] = await Promise.all([
        listRescueActivity({ data: { accessToken: token, viewAsUserId } }),
        listWaitlist({ data: { accessToken: token, viewAsUserId } }),
        listPatternAlerts({ data: { accessToken: token, viewAsUserId } }),
        listRecommendations({ data: { accessToken: token, viewAsUserId } }),
      ]);
      setActivity(act);
      setWaitlist(wait);
      setPatterns(pat);
      setRecommendations(recs);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Couldn't load.");
    } finally {
      setRefreshing(false);
    }
  }, [viewAsUserId]);

  async function applyRec(rec: Recommendation) {
    setRecBusyId(rec.id);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) return;
      await applyRecommendation({
        data: { accessToken: token, recommendationId: rec.id },
      });
      toast.success(`Applied: ${rec.headline}`);
      setRecommendations(
        (prev) => prev?.filter((r) => r.id !== rec.id) ?? null,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't apply.");
    } finally {
      setRecBusyId(null);
    }
  }

  async function dismissRec(rec: Recommendation) {
    setRecBusyId(rec.id);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) return;
      await dismissRecommendation({
        data: { accessToken: token, recommendationId: rec.id },
      });
      setRecommendations(
        (prev) => prev?.filter((r) => r.id !== rec.id) ?? null,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't dismiss.");
    } finally {
      setRecBusyId(null);
    }
  }

  useEffect(() => {
    void load();
  }, [load]);

  async function dismissAlert(alert: PatternAlert) {
    setDismissingId(alert.id);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) return;
      await dismissPatternAlert({
        data: { accessToken: token, alertId: alert.id, viewAsUserId },
      });
      setPatterns(
        (prev) =>
          prev?.map((p) =>
            p.id === alert.id
              ? { ...p, dismissedAt: new Date().toISOString() }
              : p,
          ).filter((p) => !p.dismissedAt) ?? null,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't dismiss.");
    } finally {
      setDismissingId(null);
    }
  }

  async function removeFromWaitlist(entry: WaitlistEntry) {
    if (
      !window.confirm(
        `Remove ${entry.patientName ?? "this patient"} from the waitlist?`,
      )
    )
      return;
    setRemovingId(entry.id);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) return;
      await markPatientOptedOut({
        data: { accessToken: token, patientNodeId: entry.patientNodeId },
      });
      setWaitlist((prev) =>
        prev?.map((e) =>
          e.id === entry.id
            ? { ...e, status: "revoked", revokedAt: new Date().toISOString() }
            : e,
        ) ?? null,
      );
      toast.success("Removed.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't remove.");
    } finally {
      setRemovingId(null);
    }
  }

  async function deleteWaitlistEntry(entry: WaitlistEntry) {
    if (
      !window.confirm(
        `Permanently delete the waitlist row for ${
          entry.patientName ?? "this patient"
        }?\n\nThis removes the row entirely (different from Remove, which keeps an opt-out audit trail). Use for wrong-patient mistakes, test rows, or duplicates. The patient's opt-in URL stays valid for future re-seed.\n\nThis cannot be undone.`,
      )
    )
      return;
    setDeletingId(entry.id);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) return;
      await deleteWaitlistRow({
        data: { accessToken: token, waitlistRowId: entry.id },
      });
      setWaitlist((prev) => prev?.filter((e) => e.id !== entry.id) ?? null);
      toast.success("Deleted.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't delete.");
    } finally {
      setDeletingId(null);
    }
  }

  const stats = useMemo(() => {
    if (!activity) return null;
    let filled = 0;
    let unfilled = 0;
    let active = 0;
    for (const a of activity) {
      if (a.status === "filled") filled++;
      else if (a.status === "closed_unfilled") unfilled++;
      else if (a.status === "active") active++;
    }
    return { filled, unfilled, active, total: activity.length };
  }, [activity]);

  return (
    <div className="min-h-screen bg-background">
      <PageHeader
        eyebrow="SmartSpa"
        title="Refill"
        description="When a slot frees up, SmartSpa offers it to your waitlist. First tap wins. Track every attempt + who's on the list."
        breadcrumbs={[
          { label: "SmartSpa", to: "/app/refill" },
          { label: "Refill" },
        ]}
        actions={
          <button
            type="button"
            onClick={() => void load()}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 text-xs text-ink-soft hover:text-foreground rounded-full border border-border px-3 py-1.5 disabled:opacity-50"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
            Refresh
          </button>
        }
      />

      <div className="px-6 lg:px-10 py-8 max-w-[960px] w-full mx-auto space-y-6">
        {loadError && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            {loadError}
          </div>
        )}

        {recommendations && recommendations.length > 0 && (
          <RecommendationsCard
            recommendations={recommendations}
            busyId={recBusyId}
            onApply={applyRec}
            onDismiss={dismissRec}
          />
        )}

        {stats && (
          <div className="grid grid-cols-4 gap-3">
            <StatCard icon={CalendarClock} label="Total rescues" value={stats.total} />
            <StatCard icon={CheckCircle2} label="Filled" value={stats.filled} accent="emerald" />
            <StatCard icon={Clock} label="Active" value={stats.active} accent="amber" />
            <StatCard icon={X} label="Unfilled" value={stats.unfilled} accent="muted" />
          </div>
        )}

        {/* Tabs */}
        <div className="flex items-center gap-2 border-b border-border">
          <TabBtn
            active={tab === "activity"}
            onClick={() => setTab("activity")}
            label="Activity"
            count={activity?.length ?? null}
          />
          <TabBtn
            active={tab === "waitlist"}
            onClick={() => setTab("waitlist")}
            label="Waitlist"
            count={waitlist?.filter((w) => w.status === "active").length ?? null}
          />
          <TabBtn
            active={tab === "patterns"}
            onClick={() => setTab("patterns")}
            label="Patterns"
            count={patterns?.length ?? null}
            accent="primary"
          />
        </div>

        {tab === "activity" && (
          <ActivityTab activity={activity} />
        )}
        {tab === "waitlist" && (
          <WaitlistTab
            waitlist={waitlist}
            removingId={removingId}
            deletingId={deletingId}
            onRemove={removeFromWaitlist}
            onDelete={deleteWaitlistEntry}
          />
        )}
        {tab === "patterns" && (
          <PatternsTab
            patterns={patterns}
            dismissingId={dismissingId}
            onDismiss={dismissAlert}
          />
        )}
      </div>
    </div>
  );
}

// ─── Stat card ────────────────────────────────────────────────────────────

function StatCard({
  icon: Icon,
  label,
  value,
  accent,
}: {
  icon: typeof CalendarClock;
  label: string;
  value: number;
  accent?: "emerald" | "amber" | "muted";
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-1.5 text-[11px] font-medium tracking-wider text-ink-soft uppercase mb-1.5">
        <Icon className="h-3 w-3" />
        {label}
      </div>
      <div
        className={cn(
          "text-2xl font-semibold tracking-tight tabular-nums",
          accent === "emerald" && "text-emerald-700",
          accent === "amber" && "text-amber-700",
          accent === "muted" && "text-ink-soft",
          !accent && "text-foreground",
        )}
      >
        {value.toLocaleString()}
      </div>
    </div>
  );
}

// ─── Tab button ───────────────────────────────────────────────────────────

function TabBtn({
  active,
  onClick,
  label,
  count,
  accent,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number | null;
  accent?: "primary";
}) {
  const highlight = accent === "primary" && count !== null && count > 0;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "px-3 py-2 text-sm font-medium border-b-2 -mb-px transition",
        active
          ? "border-emerald text-foreground"
          : "border-transparent text-ink-soft hover:text-foreground",
      )}
    >
      {label}
      {count !== null && (
        <span
          className={cn(
            "ml-1.5 inline-flex items-center justify-center min-w-[1.25rem] px-1 rounded-full text-[10px] font-semibold tabular-nums",
            highlight
              ? "bg-emerald text-paper"
              : "bg-muted/40 text-ink-soft",
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}

// ─── Activity tab ─────────────────────────────────────────────────────────

function ActivityTab({ activity }: { activity: RescueActivityItem[] | null }) {
  if (activity === null) {
    return (
      <div className="flex items-center gap-2 text-sm text-ink-soft py-8 justify-center">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading rescue activity…
      </div>
    );
  }
  if (activity.length === 0) {
    return (
      <EmptyCard
        icon={CalendarClock}
        title="No rescue activity yet"
        body="When an appointment is cancelled with a future date, SmartSpa will fire a rescue to your waitlist. You'll see the play-by-play here."
        cta={{
          label: "Configure rescue agent",
          to: "/app/refill/settings/noshow",
        }}
      />
    );
  }
  return (
    <section className="rounded-2xl border border-border bg-card overflow-hidden">
      <ul className="divide-y divide-border">
        {activity.map((a) => (
          <ActivityRow key={a.attemptId} item={a} />
        ))}
      </ul>
    </section>
  );
}

function ActivityRow({ item }: { item: RescueActivityItem }) {
  const freedWhen = new Date(item.freedAppointmentScheduledAt);
  const triggered = new Date(item.triggeredAt);
  return (
    <li className="px-5 py-3 flex items-center gap-3">
      <div className="w-24 shrink-0">
        <StatusPill status={item.status} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-foreground">
          {item.freedAppointmentTreatment ?? "Appointment"}{" "}
          <span className="text-ink-soft font-normal">at</span>{" "}
          {freedWhen.toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })}
        </div>
        <div className="text-xs text-ink-soft mt-0.5">
          {item.outreachCount} contacted ·{" "}
          {item.filledPatientName ? (
            <>
              Filled by <span className="text-foreground font-medium">{item.filledPatientName}</span>
            </>
          ) : (
            <>Triggered {triggered.toLocaleString()}</>
          )}
        </div>
      </div>
    </li>
  );
}

function StatusPill({
  status,
}: {
  status: RescueActivityItem["status"];
}) {
  const cfg = {
    active: { bg: "bg-amber-500/10", fg: "text-amber-700", label: "Active" },
    filled: { bg: "bg-emerald-500/10", fg: "text-emerald-700", label: "Filled" },
    closed_unfilled: { bg: "bg-muted/40", fg: "text-ink-soft", label: "Unfilled" },
    cancelled: { bg: "bg-muted/40", fg: "text-ink-soft", label: "Cancelled" },
  }[status];
  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium",
        cfg.bg,
        cfg.fg,
      )}
    >
      {cfg.label}
    </span>
  );
}

// ─── Waitlist tab ─────────────────────────────────────────────────────────

function WaitlistTab({
  waitlist,
  removingId,
  deletingId,
  onRemove,
  onDelete,
}: {
  waitlist: WaitlistEntry[] | null;
  removingId: string | null;
  deletingId: string | null;
  onRemove: (entry: WaitlistEntry) => void;
  onDelete: (entry: WaitlistEntry) => void;
}) {
  if (waitlist === null) {
    return (
      <div className="flex items-center gap-2 text-sm text-ink-soft py-8 justify-center">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading waitlist…
      </div>
    );
  }
  const active = waitlist.filter((w) => w.status === "active");
  if (active.length === 0) {
    return (
      <EmptyCard
        icon={Heart}
        title="No one on the list yet"
        body="Every SmartSpa message includes an opt-in footer. Patients who tap it join your waitlist automatically. You can also opt-in patients manually from their profile."
        cta={{
          label: "Configure opt-in footer",
          to: "/app/refill/settings/noshow",
        }}
      />
    );
  }
  return (
    <section className="rounded-2xl border border-border bg-card overflow-hidden">
      <ul className="divide-y divide-border">
        {active.map((w) => (
          <li key={w.id} className="px-5 py-3 flex items-center gap-3">
            <Users className="h-4 w-4 text-ink-soft shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-foreground">
                {w.patientName ?? "Unknown patient"}
              </div>
              <div className="text-xs text-ink-soft mt-0.5">
                {w.patientPhone && <span>{w.patientPhone}</span>}
                {w.patientPhone && w.patientEmail && <span> · </span>}
                {w.patientEmail && <span>{w.patientEmail}</span>}
              </div>
              {w.desiredServices.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {w.desiredServices.map((s) => (
                    <span
                      key={s.id}
                      className="inline-flex items-center rounded-full bg-emerald/10 text-emerald-800 px-2 py-0.5 text-[10px] font-medium"
                      title="Catalog-linked desired service"
                    >
                      {s.name}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div className="text-[11px] text-ink-soft shrink-0">
              Opted in {new Date(w.optedInAt).toLocaleDateString()}
            </div>
            <button
              type="button"
              onClick={() => onRemove(w)}
              disabled={removingId === w.id || deletingId === w.id}
              className="p-1.5 rounded hover:bg-destructive/10 text-ink-soft hover:text-destructive disabled:opacity-50"
              title="Remove — soft revoke (opt-out audit trail preserved)"
            >
              {removingId === w.id ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <X className="h-3.5 w-3.5" />
              )}
            </button>
            <button
              type="button"
              onClick={() => onDelete(w)}
              disabled={removingId === w.id || deletingId === w.id}
              className="p-1.5 rounded hover:bg-destructive/10 text-ink-soft hover:text-destructive disabled:opacity-50"
              title="Delete — permanently remove the row (use for wrong-patient mistakes, test rows, duplicates)"
            >
              {deletingId === w.id ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ─── Recommendations card ────────────────────────────────────────────────

function RecommendationsCard({
  recommendations,
  busyId,
  onApply,
  onDismiss,
}: {
  recommendations: Recommendation[];
  busyId: string | null;
  onApply: (rec: Recommendation) => void;
  onDismiss: (rec: Recommendation) => void;
}) {
  return (
    <section className="rounded-2xl border border-emerald/30 bg-emerald/5 p-5">
      <div className="flex items-center gap-2 mb-3">
        <Lightbulb className="h-4 w-4 text-emerald" />
        <h3 className="text-sm font-semibold text-foreground">
          SmartSpa recommends
        </h3>
        <span className="text-[11px] text-ink-soft ml-auto">
          {recommendations.length} suggestion{recommendations.length === 1 ? "" : "s"}
        </span>
      </div>
      <ul className="space-y-2.5">
        {recommendations.slice(0, 3).map((rec) => (
          <RecommendationRow
            key={rec.id}
            rec={rec}
            busy={busyId === rec.id}
            onApply={() => onApply(rec)}
            onDismiss={() => onDismiss(rec)}
          />
        ))}
      </ul>
      {recommendations.length > 3 && (
        <div className="mt-3 text-[11px] text-ink-soft">
          {recommendations.length - 3} more suggestion{recommendations.length - 3 === 1 ? "" : "s"} hidden — apply or dismiss these to see the rest.
        </div>
      )}
    </section>
  );
}

function RecommendationRow({
  rec,
  busy,
  onApply,
  onDismiss,
}: {
  rec: Recommendation;
  busy: boolean;
  onApply: () => void;
  onDismiss: () => void;
}) {
  return (
    <li className="rounded-lg bg-card border border-border p-3.5 flex items-start gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <h4 className="text-sm font-semibold text-foreground">
            {rec.headline}
          </h4>
          {rec.projectedLiftUsd && rec.projectedLiftUsd > 0 && (
            <span className="text-[11px] font-medium text-emerald-700 tabular-nums">
              +${rec.projectedLiftUsd.toLocaleString()}/mo est.
            </span>
          )}
          <span className="text-[10px] text-ink-soft uppercase tracking-wider ml-auto">
            {rec.source === "starter_rule" ? "best practice" : "peer data"}
          </span>
        </div>
        {rec.body && (
          <p className="text-xs text-ink-soft mt-1.5 leading-relaxed">
            {rec.body}
          </p>
        )}
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <button
          type="button"
          onClick={onApply}
          disabled={busy}
          className="inline-flex items-center gap-1 rounded-md bg-emerald text-paper px-2.5 py-1 text-xs font-semibold hover:opacity-90 transition disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <CheckCircle2 className="h-3 w-3" />
          )}
          Apply
        </button>
        <button
          type="button"
          onClick={onDismiss}
          disabled={busy}
          className="p-1.5 rounded hover:bg-muted/60 text-ink-soft hover:text-foreground disabled:opacity-50"
          title="Dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </li>
  );
}

// ─── Patterns tab ─────────────────────────────────────────────────────────

function PatternsTab({
  patterns,
  dismissingId,
  onDismiss,
}: {
  patterns: PatternAlert[] | null;
  dismissingId: string | null;
  onDismiss: (alert: PatternAlert) => void;
}) {
  if (patterns === null) {
    return (
      <div className="flex items-center gap-2 text-sm text-ink-soft py-8 justify-center">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading patterns…
      </div>
    );
  }
  if (patterns.length === 0) {
    return (
      <EmptyCard
        icon={Sparkles}
        title="No patterns to surface yet"
        body="SmartSpa watches every appointment status change. When a patient hits VIP, becomes chronic-no-show, or returns to good standing, you'll see it here."
      />
    );
  }
  return (
    <section className="space-y-3">
      {patterns.map((p) => (
        <PatternCard
          key={p.id}
          alert={p}
          dismissing={dismissingId === p.id}
          onDismiss={() => onDismiss(p)}
        />
      ))}
    </section>
  );
}

function PatternCard({
  alert,
  dismissing,
  onDismiss,
}: {
  alert: PatternAlert;
  dismissing: boolean;
  onDismiss: () => void;
}) {
  const { Icon, tone } = patternIcon(alert.kind);
  return (
    <div
      className={cn(
        "rounded-2xl border bg-card p-5 flex items-start gap-3",
        tone === "alert" && "border-amber-500/30 bg-amber-500/5",
        tone === "win" && "border-emerald-500/30 bg-emerald-500/5",
        tone === "neutral" && "border-border",
      )}
    >
      <div
        className={cn(
          "h-9 w-9 rounded-full flex items-center justify-center shrink-0",
          tone === "alert" && "bg-amber-500/15 text-amber-700",
          tone === "win" && "bg-emerald-500/15 text-emerald-700",
          tone === "neutral" && "bg-muted/40 text-ink-soft",
        )}
      >
        <Icon className="h-4 w-4" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <TierBadge tier={alert.toTier} />
          {alert.fromTier && alert.fromTier !== alert.toTier && (
            <span className="text-[11px] text-ink-soft">
              from {alert.fromTier}
            </span>
          )}
          <span className="text-[11px] text-ink-soft ml-auto">
            {new Date(alert.createdAt).toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
          </span>
        </div>
        <h3 className="text-sm font-semibold text-foreground mt-1">
          {alert.headline}
        </h3>
        {alert.body && (
          <p className="text-xs text-ink-soft mt-1.5 leading-relaxed">
            {alert.body}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        disabled={dismissing}
        className="p-1.5 rounded hover:bg-muted/60 text-ink-soft hover:text-foreground disabled:opacity-50 shrink-0"
        title="Dismiss"
      >
        {dismissing ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <X className="h-3.5 w-3.5" />
        )}
      </button>
    </div>
  );
}

function patternIcon(kind: PatternAlertKind): {
  Icon: typeof CalendarClock;
  tone: "alert" | "win" | "neutral";
} {
  switch (kind) {
    case "in_recovery_triggered":
      return { Icon: AlertTriangle, tone: "alert" };
    case "vip_unlocked":
      return { Icon: Award, tone: "win" };
    case "regular_unlocked":
    case "returned_to_trusted":
    case "tier_promoted":
      return { Icon: CheckCircle2, tone: "win" };
    case "tier_demoted":
      return { Icon: TrendingDown, tone: "neutral" };
  }
}

function TierBadge({ tier }: { tier: ReliabilityTier }) {
  const cfg: Record<
    ReliabilityTier,
    { bg: string; fg: string; label: string }
  > = {
    trusted: { bg: "bg-muted/40", fg: "text-ink-soft", label: "Trusted" },
    regular: { bg: "bg-emerald-500/10", fg: "text-emerald-700", label: "Regular" },
    vip: { bg: "bg-amber-500/10", fg: "text-amber-700", label: "VIP" },
    in_recovery: {
      bg: "bg-destructive/10",
      fg: "text-destructive",
      label: "In recovery",
    },
  };
  const c = cfg[tier];
  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium",
        c.bg,
        c.fg,
      )}
    >
      {c.label}
    </span>
  );
}

// ─── Empty card ───────────────────────────────────────────────────────────

function EmptyCard({
  icon: Icon,
  title,
  body,
  cta,
}: {
  icon: typeof CalendarClock;
  title: string;
  body: string;
  cta?: { label: string; to: string };
}) {
  return (
    <div className="rounded-2xl border border-border bg-card p-10 text-center">
      <div className="mx-auto h-12 w-12 rounded-full bg-muted/40 flex items-center justify-center mb-3">
        <Icon className="h-6 w-6 text-ink-soft" />
      </div>
      <h2 className="text-lg font-semibold text-foreground mb-1">{title}</h2>
      <p className="text-sm text-ink-soft mb-5 max-w-md mx-auto">{body}</p>
      {cta && (
        <Link
          to={cta.to}
          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald text-paper px-4 py-2 text-sm font-medium hover:opacity-90 transition"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {cta.label}
        </Link>
      )}
    </div>
  );
}
