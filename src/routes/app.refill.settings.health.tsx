/**
 * /app/refill/settings/health — Connection Health.
 *
 * The trust surface (feedback_connection_health_doctrine): every external
 * feed SmartSpa depends on — PMS calendar connectors AND the daily reward-
 * portal pulls — shown with an honest freshness verdict and, when something
 * is wrong, a plain statement that it's the CONNECTION and not us, plus the
 * one button that fixes it.
 *
 * Mostly read-only (a Recheck button); all classification happens server-side
 * in getConnectionHealthFn → computeVerdict (pure lib). The one write here is
 * the calendar expect-gate (WatchSourcesSection, kind='scheduler') — declaring
 * a calendar you expect so a revoked/never-connected one is FLAGGED rather than
 * silently absent. It lives on this view-as-aware trust surface, beside the
 * absence it guards (the portal expect-gate is the same control on Rewards).
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  Check,
  CheckCircle2,
  Copy,
  Gift,
  Laptop,
  Loader2,
  MessageSquare,
  PlugZap,
  RefreshCw,
} from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { WatchSourcesSection } from "@/components/refill/WatchSourcesSection";
import { supabase } from "@/integrations/supabase/client";
import { useTenantMembership } from "@/lib/use-tenant-membership";
import {
  getConnectionHealthFn,
  getLocalAgentFn,
  provisionLocalAgentFn,
  rotateLocalAgentSecretFn,
  type ConnectionHealthReport,
  type ConnectionHealthItem,
  type LocalAgentInfo,
} from "@/server/connection-health.functions";
import type { HealthSeverity } from "@/lib/connection-health";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/refill/settings/health")({
  component: ConnectionHealthPage,
});

// Severity → pill colors (inline hex; matches the house tokens used by
// PageHeader so we don't depend on Tailwind color tokens being defined).
const SEVERITY_STYLE: Record<
  HealthSeverity,
  { bg: string; fg: string; dot: string }
> = {
  ok: { bg: "#e8f1ed", fg: "#056048", dot: "#056048" },
  warn: { bg: "#fdf6dc", fg: "#8a6d0c", dot: "#caa50f" },
  error: { bg: "#fdecec", fg: "#b94842", dot: "#b94842" },
  neutral: { bg: "#f3f0e7", fg: "#5a6068", dot: "#8a9098" },
};

function ConnectionHealthPage() {
  const membership = useTenantMembership();
  const viewAsUserId =
    membership.status === "tenant" ? membership.viewAsUserId : undefined;

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [report, setReport] = useState<ConnectionHealthReport | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);

  // "initial" = first paint (full spinner) · "manual" = Recheck button (button
  // spinner) · "silent" = the background auto-refresh (no spinner, no error
  // toast — it just swaps the report in so the live-presence card stays honest
  // without a click).
  const load = useCallback(
    async (mode: "initial" | "manual" | "silent") => {
      if (membership.status !== "tenant") return;
      if (mode === "manual") setRefreshing(true);
      else if (mode === "initial") setLoading(true);
      try {
        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token;
        if (!token) return;
        setAccessToken(token);
        const result = await getConnectionHealthFn({
          data: { accessToken: token, viewAsUserId },
        });
        setReport(result);
      } catch (err) {
        // A background poll that fails shouldn't nag — the last good report
        // stays on screen and the next tick retries. Only foreground loads toast.
        if (mode !== "silent") {
          toast.error(
            err instanceof Error ? err.message : "Couldn't load connection health.",
          );
        }
      } finally {
        if (mode === "manual") setRefreshing(false);
        else if (mode === "initial") setLoading(false);
      }
    },
    [membership.status, viewAsUserId],
  );

  useEffect(() => {
    void load("initial");
  }, [load]);

  // Gentle auto-refresh: a "Connection Health" page that needs a manual Recheck
  // to reflect a LIVE presence isn't honest. Re-poll silently every 45s so the
  // Local delivery agent card flips Live/Quiet/Silent on its own. Paused while a
  // manual Recheck is in flight to avoid a double fetch.
  useEffect(() => {
    if (membership.status !== "tenant") return;
    const id = setInterval(() => {
      if (!refreshing) void load("silent");
    }, 45_000);
    return () => clearInterval(id);
  }, [membership.status, refreshing, load]);

  const attention = report?.summary.attention ?? 0;
  const total = report?.summary.total ?? 0;

  return (
    <div>
      <PageHeader
        title="Connection health"
        description="Every feed SmartSpa relies on — your calendar, your reward-portal pulls, and the messages going out to patients — in one place. If a connection ever goes quiet, you'll see it here first, with one button to fix it. SmartSpa working and a connection working are two different things; this page tells them apart."
        actions={
          <button
            type="button"
            onClick={() => void load("manual")}
            disabled={loading || refreshing}
            className="inline-flex items-center gap-1.5 rounded-md border border-rule bg-white px-3 py-2 text-[13px] font-semibold text-ink-soft hover:text-ink transition disabled:opacity-60"
          >
            {refreshing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Recheck
          </button>
        }
      />

      <div className="px-6 lg:px-10 py-6 max-w-3xl w-full mx-auto space-y-5">
        {loading ? (
          <div className="flex items-center gap-2 text-[13px] text-ink-soft py-8 justify-center">
            <Loader2 className="h-4 w-4 animate-spin" />
            Checking your connections…
          </div>
        ) : !report || report.items.length === 0 ? (
          <EmptyState />
        ) : (
          <>
            <SummaryBanner attention={attention} total={total} />
            <div className="space-y-3">
              {report.items.map((item) => (
                <HealthCard key={item.key} item={item} />
              ))}
            </div>
            {report.generatedAtMs > 0 && (
              <p className="text-[11px] text-ink-faint pt-1">
                Last checked{" "}
                {new Date(report.generatedAtMs).toLocaleTimeString(undefined, {
                  hour: "numeric",
                  minute: "2-digit",
                })}
                . Reward portals pull on a daily schedule; your calendar syncs
                live; patient messages send as people qualify.
              </p>
            )}
          </>
        )}

        {/* The expect-gate for calendars: declaring one lets this page flag a
            calendar that's expected but not connected (token revoked / never
            connected) instead of it silently vanishing. Lives here (not the
            connections page) because Health is the view-as-aware trust surface
            and the absence shows right above. Same primitive as the portal
            toggles on Recognition → Rewards. Self-hides if the read fails. */}
        {!loading && (
          <WatchSourcesSection
            kind="scheduler"
            title="Watch a calendar"
            blurb="Turn on the calendar platform you use. If it's ever not connected — a revoked login, or one you meant to connect — this page flags it instead of simply showing nothing."
            watchingVerb="isn't connected"
            accessToken={accessToken}
            viewAsUserId={viewAsUserId}
            onChanged={() => void load("manual")}
          />
        )}

        {/* The expect-gate for OUTBOUND messaging: declaring a channel lets this
            page flag it if recall / rescue sending ever goes quiet — the silent
            recovery-engine outage. Same primitive as the calendar and portal
            toggles, third feed kind. Never cries wolf (a quiet stretch is
            legitimate); it soft-flags after a few silent days. Self-hides if the
            read fails. */}
        {!loading && (
          <WatchSourcesSection
            kind="delivery"
            title="Watch your messaging"
            blurb="Turn on the channels you send patients on. If recall or rescue messages stop going out — the agent isn't running, or delivery breaks — this page flags it after a quiet stretch instead of the recovery engine going dark unnoticed."
            watchingVerb="goes quiet"
            accessToken={accessToken}
            viewAsUserId={viewAsUserId}
            onChanged={() => void load("manual")}
          />
        )}

        {/* The LOCAL relay agent: the one delivery leg with no server signal —
            the Mac that relays rescue texts via iMessage. Provisioning mints a
            per-spa secret + a one-paste installer; once it checks in, the
            'presence' card above goes Live/Quiet/Silent. */}
        {!loading && (
          <LocalAgentSection
            accessToken={accessToken}
            viewAsUserId={viewAsUserId}
            onChanged={() => void load("manual")}
          />
        )}
      </div>
    </div>
  );
}

function LocalAgentSection({
  accessToken,
  viewAsUserId,
  onChanged,
}: {
  accessToken: string | null;
  viewAsUserId: string | undefined;
  onChanged: () => void;
}) {
  const [info, setInfo] = useState<LocalAgentInfo | null>(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState<"secret" | "install" | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!accessToken) return;
      try {
        const r = await getLocalAgentFn({ data: { accessToken, viewAsUserId } });
        if (!cancelled) setInfo(r);
      } catch {
        // Self-hide on any read failure (e.g. migration not yet applied) so the
        // rest of the trust page stays load-bearing.
        if (!cancelled) setHidden(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accessToken, viewAsUserId]);

  const provision = useCallback(async () => {
    if (!accessToken) return;
    setBusy(true);
    try {
      const r = await provisionLocalAgentFn({ data: { accessToken, viewAsUserId } });
      setInfo(r);
      setRevealed(true);
      onChanged();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Couldn't set up the local agent.",
      );
    } finally {
      setBusy(false);
    }
  }, [accessToken, viewAsUserId, onChanged]);

  const rotate = useCallback(async () => {
    if (!accessToken) return;
    if (
      !window.confirm(
        "Generate a new secret? The current one stops working immediately — you'll need to re-run the install command on the relay Mac.",
      )
    )
      return;
    setBusy(true);
    try {
      const r = await rotateLocalAgentSecretFn({ data: { accessToken, viewAsUserId } });
      setInfo(r);
      setRevealed(true);
      onChanged();
      toast.success(
        "New secret generated. Re-run the install command on the relay Mac — the old secret is now dead.",
      );
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Couldn't rotate the secret.",
      );
    } finally {
      setBusy(false);
    }
  }, [accessToken, viewAsUserId, onChanged]);

  const copy = useCallback((text: string, which: "secret" | "install") => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(which);
      setTimeout(() => setCopied(null), 1800);
    });
  }, []);

  if (hidden) return null;

  return (
    <section className="rounded-xl border border-rule bg-white px-5 py-4">
      <div className="flex items-start gap-3">
        <div className="rounded-full p-2 shrink-0 bg-[#f3f0e7]">
          <Laptop className="h-4 w-4 text-ink-soft" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-[14px] font-semibold text-ink">
            Local delivery agent
          </h3>
          <p className="text-[12px] text-ink-soft mt-1 leading-relaxed">
            The Mac that relays rescue texts over iMessage is the one delivery
            step SmartSpa can't see on its own. Set up a tiny check-in on that
            Mac and this page will tell you, live, whether your texts can
            actually go out — or whether the relay has gone quiet.
          </p>

          {!info?.provisioned ? (
            <button
              type="button"
              onClick={() => void provision()}
              disabled={busy || !accessToken}
              className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-emerald px-3.5 py-2 text-[12px] font-semibold text-paper hover:opacity-95 transition disabled:opacity-60"
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Laptop className="h-3.5 w-3.5" />
              )}
              Set up the local agent
            </button>
          ) : (
            <div className="mt-3 space-y-3">
              <div>
                <div className="text-[11px] font-semibold text-ink-soft mb-1">
                  Run this once on the relay Mac
                </div>
                <p className="text-[11px] text-ink-faint mb-1.5 leading-relaxed">
                  Open Terminal on the Mac that has Messages signed in, paste
                  this, and press Return. It installs a check-in that runs every
                  5 minutes (and survives restarts).
                </p>
                <div className="relative">
                  <pre className="text-[10.5px] leading-relaxed bg-[#1d2127] text-[#e6e1d3] rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-all">
                    {info.installCommand}
                  </pre>
                  <button
                    type="button"
                    onClick={() => copy(info.installCommand ?? "", "install")}
                    className="absolute top-2 right-2 inline-flex items-center gap-1 rounded-md bg-white/10 px-2 py-1 text-[10px] font-semibold text-white hover:bg-white/20 transition"
                  >
                    {copied === "install" ? (
                      <Check className="h-3 w-3" />
                    ) : (
                      <Copy className="h-3 w-3" />
                    )}
                    {copied === "install" ? "Copied" : "Copy"}
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px]">
                <span className="font-semibold text-ink-soft">Agent secret</span>
                <code className="rounded bg-[#f3f0e7] px-2 py-0.5 text-ink-soft break-all">
                  {revealed
                    ? info.secret
                    : "•".repeat(12) + " (hidden)"}
                </code>
                <button
                  type="button"
                  onClick={() => setRevealed((v) => !v)}
                  className="text-emerald font-semibold hover:underline"
                >
                  {revealed ? "Hide" : "Reveal"}
                </button>
                {revealed && (
                  <button
                    type="button"
                    onClick={() => copy(info.secret ?? "", "secret")}
                    className="inline-flex items-center gap-1 text-ink-soft hover:text-ink"
                  >
                    {copied === "secret" ? (
                      <Check className="h-3 w-3" />
                    ) : (
                      <Copy className="h-3 w-3" />
                    )}
                    {copied === "secret" ? "Copied" : "Copy"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void rotate()}
                  disabled={busy}
                  className="inline-flex items-center gap-1 text-ink-faint hover:text-ink disabled:opacity-60"
                >
                  <RefreshCw className="h-3 w-3" />
                  Rotate
                </button>
              </div>
              <p className="text-[11px] text-ink-faint leading-relaxed">
                Keep this secret private — it's the key the Mac uses to check in.
                The status card above turns{" "}
                <span className="font-semibold">Live</span> within a few minutes
                of running the command. If it ever leaks (e.g. caught in a
                screenshot), <span className="font-semibold">Rotate</span> it and
                re-run the installer.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function SummaryBanner({
  attention,
  total,
}: {
  attention: number;
  total: number;
}) {
  const allGood = attention === 0;
  const style = allGood ? SEVERITY_STYLE.ok : SEVERITY_STYLE.warn;
  return (
    <div
      className="flex items-center gap-3 rounded-xl px-4 py-3"
      style={{ background: style.bg }}
    >
      {allGood ? (
        <CheckCircle2 className="h-5 w-5 shrink-0" style={{ color: style.fg }} />
      ) : (
        <AlertTriangle className="h-5 w-5 shrink-0" style={{ color: style.fg }} />
      )}
      <div className="text-[13.5px] font-semibold" style={{ color: style.fg }}>
        {allGood
          ? `All ${total} connection${total === 1 ? "" : "s"} healthy.`
          : `${attention} of ${total} connection${total === 1 ? "" : "s"} need${attention === 1 ? "s" : ""} attention.`}
      </div>
    </div>
  );
}

function HealthCard({ item }: { item: ConnectionHealthItem }) {
  const style = SEVERITY_STYLE[item.severity];
  const KindIcon =
    item.kind === "scheduler"
      ? CalendarClock
      : item.kind === "delivery"
        ? MessageSquare
        : item.kind === "presence"
          ? Laptop
          : Gift;
  const needsAction = item.severity === "error" || item.severity === "warn";
  const lastLabel =
    item.key === "presence:drafting"
      ? "Last run"
      : item.kind === "presence"
        ? "Last check-in"
        : "Last activity";
  return (
    <section className="rounded-xl border border-rule bg-white px-5 py-4">
      <div className="flex items-start gap-3">
        <div className="rounded-full p-2 shrink-0" style={{ background: style.bg }}>
          <KindIcon className="h-4 w-4" style={{ color: style.fg }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[15px] font-semibold text-ink">
              {item.displayName}
            </span>
            {item.subLabel && (
              <span className="text-[12px] text-ink-faint">{item.subLabel}</span>
            )}
            <span
              className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold"
              style={{ background: style.bg, color: style.fg }}
            >
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ background: style.dot }}
              />
              {item.statusLabel}
            </span>
          </div>
          <p className="text-[12px] text-ink-soft mt-1.5 leading-relaxed">
            {item.detail}
          </p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-[11px] text-ink-faint">
            <span>{item.tierLabel}</span>
            <span aria-hidden>·</span>
            <span>
              {lastLabel} {item.lastEventLabel}
            </span>
          </div>
        </div>
        <Link
          to={item.cta.to}
          className={cn(
            "shrink-0 inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-[12px] font-semibold transition self-center",
            needsAction
              ? "bg-emerald text-paper hover:opacity-95"
              : "border border-rule text-ink-soft hover:text-ink",
          )}
        >
          {item.cta.label}
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    </section>
  );
}

function EmptyState() {
  return (
    <section className="rounded-xl border border-rule bg-white px-6 py-10 text-center">
      <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-emerald-soft">
        <Activity className="h-5 w-5 text-emerald" />
      </div>
      <h2 className="text-[16px] font-semibold text-ink">Nothing to watch yet</h2>
      <p className="mx-auto mt-1.5 max-w-md text-[13px] text-ink-soft leading-relaxed">
        Once you connect a calendar or set up reward auto-import, this page
        keeps a live eye on each feed and flags any that go quiet.
      </p>
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        <Link
          to="/app/refill/calendar/connections"
          className="inline-flex items-center gap-1.5 rounded-md bg-emerald px-4 py-2 text-[13px] font-semibold text-paper hover:opacity-95 transition"
        >
          <PlugZap className="h-4 w-4" />
          Connect a calendar
        </Link>
        <Link
          to="/app/refill/recognition/rewards"
          className="inline-flex items-center gap-1.5 rounded-md border border-rule px-4 py-2 text-[13px] font-semibold text-ink-soft hover:text-ink transition"
        >
          <Gift className="h-4 w-4" />
          Set up reward auto-import
        </Link>
      </div>
    </section>
  );
}
