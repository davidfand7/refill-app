/**
 * /app/refill/reports — Promotions Engine Phase 9 (v357).
 *
 * The spa owner's marketing report card. Four big stat cards across the
 * top (Total sent · Open rate · Booking rate · Attributed revenue), a
 * spa-wide funnel visualization showing how many patients made it
 * through each stage, then a per-campaign table for slicing.
 *
 * Empty state: spas who haven't sent anything yet land on a card with
 * a CTA pointing back to /app/refill/campaigns. We don't render the
 * funnel viz with zeros — that just looks like a broken page.
 *
 * Phase 9 stops at "read the data" — no segmentation, no exports, no
 * cohort comparison yet. Those are future ships once we see which
 * questions spas actually ask of the data in practice.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  BarChart3,
  CalendarClock,
  Loader2,
  Megaphone,
  Send,
  TrendingUp,
  Users,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { SettingsTabStrip } from "@/components/refill/SettingsTabStrip";
import { supabase } from "@/integrations/supabase/client";
import {
  getEmmaReports,
  type CampaignFunnel,
  type EmmaReports,
} from "@/server/emma-reports.functions";
import { useTenantMembership } from "@/lib/use-tenant-membership";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/refill/reports")({
  component: ReportsPage,
});

function ReportsPage() {
  const [reports, setReports] = useState<EmmaReports | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // v1.23.0 P3 sweep: plumb viewAsUserId for admin impersonation.
  const membership = useTenantMembership();
  const viewAsUserId =
    membership.status === "tenant" ? membership.viewAsUserId : undefined;

  const load = useCallback(async () => {
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        setLoadError("Please sign in to view reports.");
        return;
      }
      const r = await getEmmaReports({ data: { accessToken: token, viewAsUserId } });
      setReports(r);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Couldn't load reports.");
    }
  }, [viewAsUserId]);

  useEffect(() => {
    void load();
  }, [load]);

  const hasAnyActivity = reports && reports.totals.sent > 0;

  return (
    <div className="min-h-screen bg-background">
      <PageHeader wide
        eyebrow="Account"
        title="Reports"
        description="How your campaigns are converting — from message sent to revenue attributed."
        breadcrumbs={[
          { label: "Account", to: "/app/refill/reports" },
          { label: "Reports" },
        ]}
      />
      <SettingsTabStrip active="reports" />

      <div className="px-6 lg:px-10 py-8 max-w-[1280px] w-full mx-auto space-y-8">
        {loadError && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            {loadError}
          </div>
        )}

        {reports === null && !loadError && (
          <div className="flex items-center gap-2 text-sm text-ink-soft">
            <Loader2 className="h-4 w-4 animate-spin" />
            Crunching the funnel…
          </div>
        )}

        {reports && !hasAnyActivity && <EmptyReports />}

        {reports && hasAnyActivity && (
          <>
            <TopStats totals={reports.totals} />
            <FunnelChart totals={reports.totals} />
            <CampaignTable campaigns={reports.campaigns} />
            <div className="text-[11px] text-ink-soft text-right">
              Updated {new Date(reports.generatedAt).toLocaleTimeString()}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────

function EmptyReports() {
  return (
    <div className="rounded-2xl border border-border bg-card p-10 text-center">
      <div className="mx-auto h-12 w-12 rounded-full bg-muted/40 flex items-center justify-center mb-3">
        <BarChart3 className="h-6 w-6 text-ink-soft" />
      </div>
      <h2 className="text-lg font-semibold text-foreground mb-1">
        No campaign activity yet
      </h2>
      <p className="text-sm text-ink-soft mb-5 max-w-md mx-auto">
        Once Emma sends your first blast, this page fills in with how many
        patients opened, clicked, booked, and showed up.
      </p>
      <Link
        to="/app/refill/campaigns"
        className="inline-flex items-center gap-1.5 rounded-lg bg-emerald text-paper px-4 py-2 text-sm font-medium hover:opacity-90 transition"
      >
        <Megaphone className="h-4 w-4" />
        Go to Campaigns
      </Link>
    </div>
  );
}

// ─── Top stats ────────────────────────────────────────────────────────────

function TopStats({
  totals,
}: {
  totals: EmmaReports["totals"];
}) {
  const openRate = totals.sentEmail > 0 ? totals.opened / totals.sentEmail : 0;
  const bookRate = totals.sent > 0 ? totals.booked / totals.sent : 0;

  const cards = [
    {
      label: "Total sent",
      icon: Send,
      value: totals.sent.toLocaleString(),
      sub: `${totals.sentEmail.toLocaleString()} email · ${totals.sentSms.toLocaleString()} SMS`,
    },
    {
      label: "Open rate",
      icon: TrendingUp,
      value: formatRate(openRate),
      sub: `${totals.opened.toLocaleString()} of ${totals.sentEmail.toLocaleString()} emails`,
    },
    {
      label: "Booking rate",
      icon: CalendarClock,
      value: formatRate(bookRate),
      sub: `${totals.booked.toLocaleString()} booked of ${totals.sent.toLocaleString()} reached`,
    },
    {
      label: "Attributed revenue",
      icon: Users,
      value: formatMoney(totals.revenueUsd),
      sub: `${totals.won.toLocaleString()} closed-won · ${totals.showed.toLocaleString()} showed`,
    },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      {cards.map((c) => (
        <div key={c.label} className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-1.5 text-[11px] font-medium tracking-wider text-ink-soft uppercase mb-1.5">
            <c.icon className="h-3 w-3" />
            {c.label}
          </div>
          <div className="text-2xl font-semibold tracking-tight text-foreground">
            {c.value}
          </div>
          <div className="text-[11px] text-ink-soft mt-1">{c.sub}</div>
        </div>
      ))}
    </div>
  );
}

// ─── Funnel chart ─────────────────────────────────────────────────────────

function FunnelChart({ totals }: { totals: EmmaReports["totals"] }) {
  // Stages in narrowing order. We render each as a horizontal bar whose
  // width is proportional to the targeted count (the widest stage).
  // Opened denominator is sentEmail (SMS has no open signal); for the
  // visual we keep opened in the chain and let it look small vs sent.
  const stages = useMemo(() => {
    const max = Math.max(totals.targeted, 1);
    const rows = [
      { label: "Targeted", count: totals.targeted, tone: "neutral" as const },
      { label: "Sent", count: totals.sent, tone: "neutral" as const },
      { label: "Opened", count: totals.opened, tone: "engagement" as const },
      { label: "Clicked", count: totals.clicked, tone: "engagement" as const },
      { label: "Booked", count: totals.booked, tone: "conversion" as const },
      { label: "Showed", count: totals.showed, tone: "conversion" as const },
      { label: "Won", count: totals.won, tone: "won" as const },
    ];
    return rows.map((r) => ({
      ...r,
      pct: r.count / max,
    }));
  }, [totals]);

  return (
    <div className="rounded-2xl border border-border bg-card p-5">
      <div className="flex items-center gap-2 text-xs font-medium tracking-wider text-ink-soft uppercase mb-4">
        <BarChart3 className="h-3.5 w-3.5" />
        Funnel
      </div>
      <div className="space-y-2">
        {stages.map((s) => (
          <div key={s.label} className="flex items-center gap-3">
            <div className="w-20 shrink-0 text-xs font-medium text-ink-soft">
              {s.label}
            </div>
            <div className="flex-1 h-7 rounded-md bg-muted/40 overflow-hidden relative">
              <div
                className={cn(
                  "h-full transition-all duration-500 ease-out",
                  s.tone === "neutral" && "bg-foreground/80",
                  s.tone === "engagement" && "bg-emerald/80",
                  s.tone === "conversion" && "bg-amber-500/80",
                  s.tone === "won" && "bg-emerald-500/80",
                )}
                style={{ width: `${Math.max(s.pct * 100, s.count > 0 ? 2 : 0)}%` }}
              />
              <div className="absolute inset-0 flex items-center px-2.5 text-xs font-semibold text-foreground mix-blend-luminosity">
                {s.count.toLocaleString()}
              </div>
            </div>
          </div>
        ))}
      </div>
      {totals.skipped > 0 && (
        <div className="mt-4 pt-4 border-t border-border">
          <div className="text-xs font-medium text-ink-soft mb-2">
            Skipped sends (compliance rails — not failures)
          </div>
          <div className="flex flex-wrap gap-2">
            {Object.entries(totals.skipReasons)
              .sort(([, a], [, b]) => b - a)
              .map(([reason, count]) => (
                <span
                  key={reason}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-muted/40 text-[11px]"
                >
                  <span className="font-mono text-ink-soft">{reason}</span>
                  <span className="font-semibold text-foreground">{count}</span>
                </span>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Per-campaign table ───────────────────────────────────────────────────

function CampaignTable({ campaigns }: { campaigns: CampaignFunnel[] }) {
  return (
    <div className="rounded-2xl border border-border bg-card overflow-hidden">
      <div className="px-5 py-3 border-b border-border flex items-center gap-2">
        <Megaphone className="h-3.5 w-3.5 text-ink-soft" />
        <span className="text-xs font-medium tracking-wider text-ink-soft uppercase">
          By campaign
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/30 text-[11px] font-medium tracking-wider text-ink-soft uppercase">
            <tr className="text-right">
              <th className="px-4 py-2 text-left">Campaign</th>
              <th className="px-3 py-2">Targeted</th>
              <th className="px-3 py-2">Sent</th>
              <th className="px-3 py-2">Open</th>
              <th className="px-3 py-2">Click</th>
              <th className="px-3 py-2">Booked</th>
              <th className="px-3 py-2">Showed</th>
              <th className="px-3 py-2">Won</th>
              <th className="px-3 py-2">Revenue</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {campaigns.map((c) => {
              const openRate =
                c.sentEmail > 0 ? c.opened / c.sentEmail : null;
              const clickRate =
                c.opened > 0 ? c.clicked / c.opened : null;
              return (
                <tr
                  key={c.campaignId}
                  className="border-t border-border text-right hover:bg-muted/20 transition-colors"
                >
                  <td className="px-4 py-2.5 text-left">
                    <Link
                      to="/app/refill/campaigns/$campaignId"
                      params={{ campaignId: c.campaignId }}
                      className="font-medium text-foreground hover:text-emerald"
                    >
                      {c.title}
                    </Link>
                    {c.lastActivityAt && (
                      <div className="text-[11px] text-ink-soft mt-0.5">
                        {new Date(c.lastActivityAt).toLocaleDateString(
                          undefined,
                          { month: "short", day: "numeric" },
                        )}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2.5 tabular-nums">{c.targeted}</td>
                  <td className="px-3 py-2.5 tabular-nums">{c.sent}</td>
                  <td className="px-3 py-2.5 tabular-nums">
                    {c.opened}
                    {openRate !== null && (
                      <span className="text-[11px] text-ink-soft ml-1">
                        {formatRate(openRate)}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 tabular-nums">
                    {c.clicked}
                    {clickRate !== null && (
                      <span className="text-[11px] text-ink-soft ml-1">
                        {formatRate(clickRate)}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 tabular-nums">{c.booked}</td>
                  <td className="px-3 py-2.5 tabular-nums">{c.showed}</td>
                  <td className="px-3 py-2.5 tabular-nums">{c.won}</td>
                  <td className="px-3 py-2.5 tabular-nums font-medium text-foreground">
                    {c.revenueUsd > 0 ? formatMoney(c.revenueUsd) : "—"}
                  </td>
                  <td className="px-3 py-2.5">
                    <Link
                      to="/app/refill/campaigns/$campaignId"
                      params={{ campaignId: c.campaignId }}
                      className="inline-flex items-center text-ink-soft hover:text-foreground"
                      title="Open campaign"
                    >
                      <ArrowRight className="h-3.5 w-3.5" />
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Formatters ───────────────────────────────────────────────────────────

function formatRate(r: number): string {
  if (!isFinite(r) || r < 0) return "—";
  if (r >= 1) return "100%";
  return `${(r * 100).toFixed(1)}%`;
}

function formatMoney(n: number): string {
  if (!isFinite(n) || n <= 0) return "$0";
  if (n >= 10_000)
    return `$${(n / 1000).toFixed(1)}k`;
  return `$${Math.round(n).toLocaleString()}`;
}
