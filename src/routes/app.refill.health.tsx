/**
 * /app/refill/health — Engine health vitals (v380).
 *
 * The "is the engine running" page. Three signals: last rescue dispatch,
 * last slot claim, last recovery event. Plus 24h/7d counts for each.
 *
 * Built as cheap insurance for Karen's pilot week — if any row goes quiet
 * for a day while appointments are still flipping no-show, something
 * upstream is wrong. Hidden from main nav for now; bookmarkable at
 * /app/refill/health for me and Grasshopper to glance at.
 */

import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import {
  Activity,
  CheckCircle2,
  CircleDashed,
  DollarSign,
  Heart,
  Loader2,
  RefreshCw,
  Zap,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { supabase } from "@/integrations/supabase/client";
import {
  getEngineHealthVitals,
  type EngineHealthVitals,
  type VitalsRow,
} from "@/server/emma-health.functions";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/refill/health")({
  component: EngineHealthPage,
});

function EngineHealthPage() {
  const [vitals, setVitals] = useState<EngineHealthVitals | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        setError("Please sign in.");
        return;
      }
      const v = await getEngineHealthVitals({ data: { accessToken: token } });
      setVitals(v);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load vitals.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const status = vitals ? computeStatus(vitals) : null;

  return (
    <div className="container mx-auto max-w-[1600px] px-4 py-8">
      <PageHeader
        eyebrow="Emma(OS)"
        title="Engine health"
        description="Is the no-show recovery pipeline alive? Glance here daily during pilot."
        actions={
          <button
            type="button"
            onClick={() => void load(true)}
            disabled={refreshing}
            className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-sm text-ink-soft hover:bg-muted/40 disabled:opacity-50"
          >
            <RefreshCw
              className={cn("h-3.5 w-3.5", refreshing && "animate-spin")}
            />
            Refresh
          </button>
        }
      />

      {loading ? (
        <div className="mt-12 flex items-center justify-center gap-2 text-ink-soft">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading vitals…
        </div>
      ) : error ? (
        <div className="mt-8 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : vitals ? (
        <>
          {status && <StatusBanner status={status} asOf={vitals.asOf} />}

          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            <VitalCard
              icon={Zap}
              label="Engine fired"
              tooltip="Most recent dispatchRescueAttempt — a no-show or cancellation triggered the rescue engine"
              row={vitals.rescueAttempts}
              tone="amber"
            />
            <VitalCard
              icon={Heart}
              label="Slots claimed"
              tooltip="Most recent claimRescueSlot success — a waitlist patient grabbed an open slot"
              row={vitals.rescueClaims}
              tone="rose"
            />
            <VitalCard
              icon={DollarSign}
              label="Recoveries logged"
              tooltip="Most recent emma_recovery_events row — billable save attributed"
              row={vitals.recoveryEvents}
              tone="emerald"
            />
          </div>

          <div className="mt-8 rounded-lg border border-border bg-card p-4 text-sm text-ink-soft">
            <div className="flex items-start gap-2">
              <Activity className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <div className="text-ink mb-1 font-medium">
                  What "healthy" looks like
                </div>
                Engine fires every time an appointment flips to{" "}
                <code className="rounded bg-muted/40 px-1 py-0.5 text-xs">
                  cancelled
                </code>{" "}
                or{" "}
                <code className="rounded bg-muted/40 px-1 py-0.5 text-xs">
                  no_show
                </code>{" "}
                with a future scheduled_at. Claims fire when a patient taps
                their iMessage link. Recoveries are attributed automatically on
                claim; manual confirm sets the dollar amount on{" "}
                <code className="rounded bg-muted/40 px-1 py-0.5 text-xs">
                  /app/refill/recovery
                </code>
                .
              </div>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

type EngineStatus = "armed" | "active" | "quiet" | "cold";

function computeStatus(v: EngineHealthVitals): EngineStatus {
  const haveAny =
    v.rescueAttempts.lastAt || v.rescueClaims.lastAt || v.recoveryEvents.lastAt;
  if (!haveAny) return "armed";
  if (v.rescueAttempts.last24h > 0) return "active";
  if (v.rescueAttempts.last7d > 0) return "quiet";
  return "cold";
}

function StatusBanner({
  status,
  asOf,
}: {
  status: EngineStatus;
  asOf: string;
}) {
  const cfg: Record<
    EngineStatus,
    { bg: string; border: string; ink: string; label: string; body: string }
  > = {
    armed: {
      bg: "bg-sky-500/5",
      border: "border-sky-500/30",
      ink: "text-sky-700",
      label: "Engine armed",
      body: "No events yet. When the first appointment flips to no-show or cancelled, signal will appear below.",
    },
    active: {
      bg: "bg-emerald-500/5",
      border: "border-emerald-500/30",
      ink: "text-emerald-700",
      label: "Engine active",
      body: "Fired in the last 24 hours. Pipeline is alive.",
    },
    quiet: {
      bg: "bg-amber-500/5",
      border: "border-amber-500/30",
      ink: "text-amber-700",
      label: "Engine quiet",
      body: "Last fire was within 7 days but more than 24h ago. Normal for low-volume practices — investigate only if you know appointments flipped today.",
    },
    cold: {
      bg: "bg-destructive/5",
      border: "border-destructive/30",
      ink: "text-destructive",
      label: "Engine cold",
      body: "No fires in 7 days. If appointments have been flipping no-show in this window, the trigger graph is broken.",
    },
  };
  const c = cfg[status];
  const Icon = status === "active" ? CheckCircle2 : CircleDashed;
  return (
    <div
      className={cn(
        "mt-6 rounded-lg border p-4 flex items-start gap-3",
        c.bg,
        c.border,
      )}
    >
      <Icon className={cn("h-5 w-5 mt-0.5 shrink-0", c.ink)} />
      <div className="flex-1">
        <div className={cn("font-medium", c.ink)}>{c.label}</div>
        <div className="text-sm text-ink-soft mt-0.5">{c.body}</div>
      </div>
      <div className="text-xs text-ink-soft shrink-0">
        as of {formatDistanceToNow(new Date(asOf), { addSuffix: true })}
      </div>
    </div>
  );
}

function VitalCard({
  icon: Icon,
  label,
  tooltip,
  row,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  tooltip: string;
  row: VitalsRow;
  tone: "amber" | "rose" | "emerald";
}) {
  const toneClasses = {
    amber: "text-amber-700 bg-amber-500/10",
    rose: "text-rose-700 bg-rose-500/10",
    emerald: "text-emerald-700 bg-emerald-500/10",
  } as const;
  const lastAtLabel = row.lastAt
    ? formatDistanceToNow(new Date(row.lastAt), { addSuffix: true })
    : "—";
  const lastAtTitle = row.lastAt ? new Date(row.lastAt).toLocaleString() : "";
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-ink-soft" title={tooltip}>
        <div className={cn("inline-flex h-6 w-6 items-center justify-center rounded-full", toneClasses[tone])}>
          <Icon className="h-3.5 w-3.5" />
        </div>
        {label}
      </div>
      <div
        className="mt-3 text-2xl font-semibold text-ink"
        title={lastAtTitle}
      >
        {lastAtLabel}
      </div>
      <div className="mt-3 flex items-center gap-3 text-xs text-ink-soft">
        <span>
          <span className="font-medium text-ink">{row.last24h}</span> · 24h
        </span>
        <span className="text-border">·</span>
        <span>
          <span className="font-medium text-ink">{row.last7d}</span> · 7d
        </span>
      </div>
    </div>
  );
}
