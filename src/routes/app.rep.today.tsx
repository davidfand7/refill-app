/**
 * /app/rep/today — Lizzie Home, "Monday morning" surface (v329).
 *
 * The landing the rep wants when they open the app first thing in the day.
 * Today's focus boils down to three questions:
 *   1. What accounts are most worth my time right now?  (Opportunities)
 *   2. Who's gone quiet on a sample order I sent?       (Follow-ups)
 *   3. What just happened in my territory?               (Recent activity)
 *
 * Plus a four-card territory quick-stats row at the top and three quick-
 * action CTAs at the bottom (start a chat with Liz, import accounts, upload
 * a report).
 *
 * No new server fns — the page is pure client-side compute over the
 * existing listLizAccounts + listSendIntents server fns. That keeps the
 * undo-risk profile at zero: real-rep data flowing in just changes the
 * shape of the cards' contents, never the cards themselves.
 *
 * Strategic context (per the v326 roadmap reorder): account-detail (v327)
 * gives reps the deep dive; this page gives them the daily-orientation
 * surface. Together they answer "how am I doing across my territory" and
 * "what's the story on this one practice."
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  AlertCircle,
  ArrowRight,
  BadgeCheck,
  CalendarDays,
  ChevronRight,
  Clock,
  Eye,
  FileSpreadsheet,
  Loader2,
  Mail,
  MapPin,
  MessageSquare,
  RefreshCw,
  Sparkles,
  Tag,
  Target,
  TrendingUp,
  Upload,
  Users,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { supabase } from "@/integrations/supabase/client";
import {
  listLizAccounts,
  type LizAccount,
} from "@/server/liz-accounts.functions";
import {
  listSendIntents,
  type RepSendIntentRow,
} from "@/server/sample-order-intents.functions";
import {
  countSuggestedNudges,
  countUnreadReplies,
  listPromotions,
  type PromoListRow,
} from "@/server/promotions.functions";
import { familyLabel } from "@/lib/liz-csv";
import { useDemoMode, useViewAs } from "@/lib/demo-mode";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/rep/today")({
  component: TodayPage,
});

const STALE_NO_OPEN_DAYS = 3;
const STALE_NO_CONFIRM_DAYS = 2;
const OPP_TOP_N = 6;
const ACTIVITY_TOP_N = 6;
const FOLLOWUP_TOP_N = 6;

// ── Opportunity computation ────────────────────────────────────────────────

type Opportunity = {
  account: LizAccount;
  family: string;
  tier: string;
  gap: number;
  qtdVolume: number | null;
  threshold: number;
  qtrEnd: string | null;
};

function computeOpportunities(accounts: LizAccount[]): Opportunity[] {
  const opps: Opportunity[] = [];
  for (const a of accounts) {
    if (!a.lookupKey) continue;
    let best: Opportunity | null = null;
    for (const t of a.tiers) {
      if (typeof t.threshold_to_advance !== "number") continue;
      const qtd = typeof t.qtd_volume === "number" ? t.qtd_volume : 0;
      const gap = t.threshold_to_advance - qtd;
      if (gap <= 0) continue;
      const opp: Opportunity = {
        account: a,
        family: t.family,
        tier: t.tier,
        gap,
        qtdVolume: typeof t.qtd_volume === "number" ? t.qtd_volume : null,
        threshold: t.threshold_to_advance,
        qtrEnd: t.qtr_end ?? null,
      };
      if (!best || opp.gap < best.gap) best = opp;
    }
    if (best) opps.push(best);
  }
  opps.sort((a, b) => a.gap - b.gap);
  return opps;
}

function computeStale(rows: RepSendIntentRow[], now: number): RepSendIntentRow[] {
  return rows.filter((r) => {
    if (r.state === "confirmed" || r.state === "revoked") return false;
    const sentMs = new Date(r.sentAt).getTime();
    if (r.state === "active") {
      return now - sentMs > STALE_NO_OPEN_DAYS * 24 * 60 * 60 * 1000;
    }
    if (r.state === "viewed" && r.firstViewedAt) {
      const openedMs = new Date(r.firstViewedAt).getTime();
      return now - openedMs > STALE_NO_CONFIRM_DAYS * 24 * 60 * 60 * 1000;
    }
    return false;
  });
}

function computeActivity(rows: RepSendIntentRow[]): RepSendIntentRow[] {
  // "Recent activity" = anything that happened in the last 14 days, ordered
  // by the most recent state-changing timestamp on that row (confirmed_at →
  // first_viewed_at → sent_at). Keeps the most interesting signal at top.
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const enriched = rows
    .map((r) => {
      const stamps = [
        r.confirmedAt ? new Date(r.confirmedAt).getTime() : 0,
        r.firstViewedAt ? new Date(r.firstViewedAt).getTime() : 0,
        new Date(r.sentAt).getTime(),
      ];
      const latest = Math.max(...stamps);
      return { row: r, latest };
    })
    .filter(({ latest }) => latest >= cutoff)
    .sort((a, b) => b.latest - a.latest);
  return enriched.map((e) => e.row);
}

// ── Page ───────────────────────────────────────────────────────────────────

function TodayPage() {
  const viewAs = useViewAs();
  const { isDemo, enableDemo } = useDemoMode();
  const [accounts, setAccounts] = useState<LizAccount[]>([]);
  const [intents, setIntents] = useState<RepSendIntentRow[]>([]);
  const [promotions, setPromotions] = useState<PromoListRow[]>([]);
  const [unreadReplies, setUnreadReplies] = useState(0);
  const [nudgeCount, setNudgeCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

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
      const [accs, sends, promos, unread, nudges] = await Promise.all([
        listLizAccounts({ data: { accessToken, viewAs } }),
        listSendIntents({ data: { accessToken, viewAs } }),
        listPromotions({ data: { accessToken, viewAs } }),
        countUnreadReplies({ data: { accessToken, viewAs } }),
        countSuggestedNudges({ data: { accessToken, viewAs } }),
      ]);
      setAccounts(accs);
      setIntents(sends.rows);
      setPromotions(promos);
      setUnreadReplies(unread.unread);
      setNudgeCount(nudges.count);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't load Today.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  // Reload whenever demo mode toggles — switching tenants is the only data
  // change that needs an explicit reload.
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewAs]);

  const now = Date.now();
  const opportunities = useMemo(() => computeOpportunities(accounts), [accounts]);
  const stale = useMemo(() => computeStale(intents, now), [intents, now]);
  const activity = useMemo(() => computeActivity(intents), [intents]);

  const summary = useMemo(() => {
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
    const sentThisWeek = intents.filter((r) => new Date(r.sentAt).getTime() >= weekAgo).length;
    const opened = intents.filter((r) => r.state === "viewed" || r.state === "confirmed").length;
    const confirmed = intents.filter((r) => r.state === "confirmed").length;
    const conversionPct = intents.length > 0 ? Math.round((confirmed / intents.length) * 100) : 0;
    return {
      accountCount: accounts.length,
      sentThisWeek,
      opened,
      confirmed,
      conversionPct,
      followUps: stale.length,
    };
  }, [accounts.length, intents, stale.length, now]);

  return (
    <div className="flex flex-col min-h-screen bg-background">
      <PageHeader
        eyebrow="Lizzie(OS)"
        title="Today"
        description="What's worth your time first thing in the morning."
        breadcrumbs={[{ label: "Liz", to: "/app/rep" }, { label: "Today" }]}
        actions={
          <div className="flex items-center gap-2">
            {!isDemo && (
              <button
                type="button"
                onClick={enableDemo}
                className="inline-flex items-center gap-1.5 text-xs text-amber-700 hover:text-amber-900 rounded-full border border-amber-300 bg-amber-50 px-3 py-1.5"
                title="View what your territory will look like with real data loaded"
              >
                <Sparkles className="h-3.5 w-3.5" />
                Try demo data
              </button>
            )}
            <Link
              to="/app/rep"
              className="inline-flex items-center gap-1.5 text-xs text-ink-soft hover:text-foreground rounded-full border border-border px-3 py-1.5"
            >
              <MessageSquare className="h-3.5 w-3.5" />
              Open chat
            </Link>
            <button
              type="button"
              onClick={() => void load({ silent: true })}
              disabled={refreshing}
              className="inline-flex items-center gap-1.5 text-xs text-ink-soft hover:text-foreground rounded-full border border-border px-3 py-1.5 disabled:opacity-50"
              title="Refresh"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
              Refresh
            </button>
          </div>
        }
      />

      <div className="flex-1 px-4 py-6 lg:px-10 max-w-6xl w-full mx-auto space-y-6">
        {loading ? (
          <div className="flex items-center justify-center text-sm text-ink-soft py-16">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            Pulling your territory…
          </div>
        ) : (
          <>
            <SummaryStrip summary={summary} />

            <UnreadRepliesCard count={unreadReplies} />

            <SuggestedNudgesCard count={nudgeCount} />

            <ActivePromosCard promotions={promotions} />

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              <OpportunitiesCard opportunities={opportunities} hasAccounts={accounts.length > 0} />
              <FollowUpsCard rows={stale.slice(0, FOLLOWUP_TOP_N)} totalCount={stale.length} />
            </div>

            <ActivityCard rows={activity.slice(0, ACTIVITY_TOP_N)} totalRecent={activity.length} />

            <QuickActions hasAccounts={accounts.length > 0} hasIntents={intents.length > 0} />
          </>
        )}
      </div>
    </div>
  );
}

// ── Summary strip ──────────────────────────────────────────────────────────

function SummaryStrip({
  summary,
}: {
  summary: {
    accountCount: number;
    sentThisWeek: number;
    opened: number;
    confirmed: number;
    conversionPct: number;
    followUps: number;
  };
}) {
  return (
    <section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      <Stat label="Accounts" value={summary.accountCount} sub="in your territory" icon={<Users className="h-4 w-4" />} accent="default" />
      <Stat label="Sent this week" value={summary.sentThisWeek} sub={`${summary.opened} opened all-time`} icon={<Mail className="h-4 w-4" />} accent="info" />
      <Stat label="Confirmed" value={summary.confirmed} sub={`${summary.conversionPct}% conversion`} icon={<BadgeCheck className="h-4 w-4" />} accent="success" />
      <Stat label="Follow-up needed" value={summary.followUps} sub={summary.followUps === 0 ? "all clear" : "see below"} icon={<AlertCircle className="h-4 w-4" />} accent={summary.followUps > 0 ? "warning" : "default"} />
    </section>
  );
}

function Stat({
  label,
  value,
  sub,
  icon,
  accent,
}: {
  label: string;
  value: number;
  sub: string;
  icon: React.ReactNode;
  accent: "default" | "info" | "success" | "warning";
}) {
  const bg = {
    default: "bg-card",
    info: "bg-slate-50/60",
    success: "bg-emerald-50/40",
    warning: "bg-amber-50/40",
  }[accent];
  const valueClass = {
    default: "text-foreground",
    info: "text-slate-700",
    success: "text-emerald-700",
    warning: "text-amber-700",
  }[accent];
  return (
    <div className={cn("rounded-xl border border-border px-4 py-3", bg)}>
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-ink-soft font-medium">
        {icon}
        <span>{label}</span>
      </div>
      <div className={cn("mt-1.5 text-2xl font-semibold tabular-nums", valueClass)}>{value}</div>
      <div className="text-[11px] text-ink-soft mt-0.5">{sub}</div>
    </div>
  );
}

// ── Active promotions card (v335) ─────────────────────────────────────────

function ActivePromosCard({ promotions }: { promotions: PromoListRow[] }) {
  // Surface only promos that are active OR ending within 14 days (catches
  // the "expires today / tomorrow" hot ones). Upcoming + already-expired
  // are visible on /app/rep/promotions but not on Today.
  const featured = promotions
    .filter((p) => p.status === "active")
    .slice(0, 3);
  if (featured.length === 0) return null;
  return (
    <section className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="px-5 py-4 flex items-baseline justify-between gap-3 border-b border-border">
        <div className="flex items-center gap-2">
          <Tag className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold text-foreground">Active promotions</h2>
        </div>
        <Link
          to="/app/rep/promotions"
          className="text-xs text-primary hover:underline inline-flex items-center gap-1"
        >
          See all <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
      <ul className="divide-y divide-border">
        {featured.map((p) => (
          <li key={p.id}>
            <Link
              to="/app/rep/promotions/$promotionId"
              params={{ promotionId: p.id }}
              className="block px-5 py-3 hover:bg-sidebar-accent/10 transition"
            >
              <div className="grid grid-cols-[1fr_auto_auto] gap-3 items-center">
                <div className="min-w-0">
                  <div className="font-medium text-foreground truncate">{p.title}</div>
                  <div className="text-[11px] text-ink-soft mt-0.5 flex items-center gap-2 flex-wrap">
                    {p.manufacturer && (
                      <span className="capitalize">{p.manufacturer}</span>
                    )}
                    {p.tierCount > 0 && (
                      <>
                        <span className="text-ink-soft/40">·</span>
                        <span>{p.tierCount} tiers</span>
                      </>
                    )}
                    {p.eligibleAccountCount > 0 && (
                      <>
                        <span className="text-ink-soft/40">·</span>
                        <span>{p.eligibleAccountCount} eligible</span>
                      </>
                    )}
                  </div>
                </div>
                <div className="text-right">
                  {p.daysToEnd !== null && p.daysToEnd >= 0 && (
                    <span
                      className={cn(
                        "text-[12px] tabular-nums",
                        p.daysToEnd <= 7 ? "text-amber-700 font-semibold" : "text-ink-soft",
                      )}
                    >
                      {p.daysToEnd === 0
                        ? "Ends today"
                        : p.daysToEnd === 1
                          ? "Ends tomorrow"
                          : `${p.daysToEnd}d left`}
                    </span>
                  )}
                </div>
                <ChevronRight className="h-4 w-4 text-ink-soft/60" />
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── Unread replies (v338) ──────────────────────────────────────────────────

function UnreadRepliesCard({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <Link
      to="/app/rep/inbox"
      className="block group rounded-xl border border-primary/40 bg-primary/5 hover:bg-primary/10 transition px-5 py-4"
    >
      <div className="flex items-center gap-4">
        <div className="rounded-full bg-primary/15 p-2.5">
          <Mail className="h-5 w-5 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-foreground">
            {count} unread {count === 1 ? "reply" : "replies"} from your promos
          </div>
          <div className="text-xs text-ink-soft mt-0.5">
            Practice owners are waiting on you. Open the inbox to read + respond.
          </div>
        </div>
        <ArrowRight className="h-4 w-4 text-primary group-hover:translate-x-0.5 transition" />
      </div>
    </Link>
  );
}

// ── Suggested nudges (v340) ────────────────────────────────────────────────

function SuggestedNudgesCard({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <Link
      to="/app/rep/cadence"
      className="block group rounded-xl border border-amber/40 bg-amber-soft/30 hover:bg-amber-soft/50 transition px-5 py-4"
    >
      <div className="flex items-center gap-4">
        <div className="rounded-full bg-amber/15 p-2.5">
          <Clock className="h-5 w-5 text-amber" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-foreground">
            {count} {count === 1 ? "nudge" : "nudges"} suggested
          </div>
          <div className="text-xs text-ink-soft mt-0.5">
            Outreach gone quiet 5+ days. Liz has drafts ready — review + send.
          </div>
        </div>
        <ArrowRight className="h-4 w-4 text-amber group-hover:translate-x-0.5 transition" />
      </div>
    </Link>
  );
}

// ── Opportunities ──────────────────────────────────────────────────────────

function OpportunitiesCard({
  opportunities,
  hasAccounts,
}: {
  opportunities: Opportunity[];
  hasAccounts: boolean;
}) {
  return (
    <section className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="px-5 py-4 flex items-baseline justify-between gap-3 border-b border-border">
        <div className="flex items-center gap-2">
          <Target className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold text-foreground">Top opportunities</h2>
        </div>
        <div className="text-[11px] text-ink-soft">Ranked by smallest reachable gap</div>
      </div>
      {opportunities.length === 0 ? (
        <div className="px-5 py-8 text-center text-sm text-ink-soft">
          {hasAccounts
            ? "No accounts within reach of the next tier yet — every account either has no tier data on file, or has already maxed out."
            : (
              <>
                No accounts imported yet.{" "}
                <Link to="/app/rep/accounts" className="text-primary hover:underline">
                  Add some →
                </Link>
              </>
            )}
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {opportunities.slice(0, OPP_TOP_N).map((o) => (
            <li key={`${o.account.id}-${o.family}`}>
              <Link
                to="/app/rep/accounts/$accountId"
                params={{ accountId: o.account.id }}
                className="block px-5 py-3 hover:bg-sidebar-accent/10 transition"
              >
                <div className="grid grid-cols-[1fr_auto_auto] gap-3 items-center">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-foreground truncate">
                      {o.account.accountName}
                    </div>
                    <div className="text-[11px] text-ink-soft mt-0.5">
                      {familyLabel(o.family as never)} · {o.tier}
                      {o.qtrEnd ? ` · Q ends ${o.qtrEnd}` : ""}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[10px] uppercase tracking-wider text-ink-soft">Gap</div>
                    <div className="text-sm font-semibold tabular-nums text-primary">{usd(o.gap)}</div>
                  </div>
                  <ChevronRight className="h-4 w-4 text-ink-soft/60" />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {opportunities.length > OPP_TOP_N && (
        <div className="px-5 py-3 border-t border-border">
          <Link
            to="/app/rep/accounts"
            className="text-xs text-primary hover:underline inline-flex items-center gap-1"
          >
            See all {opportunities.length} opportunities <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      )}
    </section>
  );
}

// ── Follow-ups ─────────────────────────────────────────────────────────────

function FollowUpsCard({
  rows,
  totalCount,
}: {
  rows: RepSendIntentRow[];
  totalCount: number;
}) {
  return (
    <section className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="px-5 py-4 flex items-baseline justify-between gap-3 border-b border-border">
        <div className="flex items-center gap-2">
          <AlertCircle className="h-4 w-4 text-amber-600" />
          <h2 className="text-sm font-semibold text-foreground">Worth a follow-up</h2>
        </div>
        <div className="text-[11px] text-ink-soft">3+ days un-opened or 2+ opened-not-confirmed</div>
      </div>
      {rows.length === 0 ? (
        <div className="px-5 py-8 text-center text-sm text-ink-soft">
          ✓ No stale sends. Everything you've sent is either fresh, opened recently, or confirmed.
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((r) => (
            <li key={r.token} className="px-5 py-3 hover:bg-sidebar-accent/10 transition">
              <div className="grid grid-cols-[1fr_auto] gap-3 items-center">
                <div className="min-w-0">
                  {r.practiceAccountId ? (
                    <Link
                      to="/app/rep/accounts/$accountId"
                      params={{ accountId: r.practiceAccountId }}
                      className="text-sm font-medium text-foreground hover:text-primary truncate block"
                    >
                      {r.practiceTitle}
                    </Link>
                  ) : (
                    <div className="text-sm font-medium text-foreground truncate">{r.practiceTitle}</div>
                  )}
                  <div className="text-[11px] mt-0.5 flex items-center gap-1.5 text-ink-soft">
                    {r.state === "viewed" ? (
                      <>
                        <Eye className="h-3 w-3 text-slate-600" />
                        Opened {formatRelative(r.firstViewedAt ?? r.sentAt)} · still no confirm
                      </>
                    ) : (
                      <>
                        <Mail className="h-3 w-3" />
                        Sent {formatRelative(r.sentAt)} · still unopened
                      </>
                    )}
                  </div>
                </div>
                <a
                  href={`/order/${r.token}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] text-ink-soft hover:text-foreground rounded-md px-2 py-1 hover:bg-sidebar-accent/30 transition"
                  title="See what the practice owner sees"
                >
                  View page
                </a>
              </div>
            </li>
          ))}
        </ul>
      )}
      {totalCount > FOLLOWUP_TOP_N && (
        <div className="px-5 py-3 border-t border-border">
          <Link
            to="/app/rep/sends"
            search={{ preset: "all", q: "", status: [] }}
            className="text-xs text-primary hover:underline inline-flex items-center gap-1"
          >
            See all {totalCount} in Sends <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      )}
    </section>
  );
}

// ── Activity feed ──────────────────────────────────────────────────────────

function ActivityCard({
  rows,
  totalRecent,
}: {
  rows: RepSendIntentRow[];
  totalRecent: number;
}) {
  if (rows.length === 0) return null;
  return (
    <section className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="px-5 py-4 flex items-baseline justify-between gap-3 border-b border-border">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-emerald-600" />
          <h2 className="text-sm font-semibold text-foreground">Recent activity</h2>
        </div>
        <div className="text-[11px] text-ink-soft">Last 14 days</div>
      </div>
      <ul className="divide-y divide-border">
        {rows.map((r) => (
          <li key={r.token} className="px-5 py-3 hover:bg-sidebar-accent/10 transition">
            <ActivityRow row={r} />
          </li>
        ))}
      </ul>
      {totalRecent > rows.length && (
        <div className="px-5 py-3 border-t border-border">
          <Link
            to="/app/rep/sends"
            search={{ preset: "all", q: "", status: [] }}
            className="text-xs text-primary hover:underline inline-flex items-center gap-1"
          >
            See all activity in Sends <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      )}
    </section>
  );
}

function ActivityRow({ row }: { row: RepSendIntentRow }) {
  let icon: React.ReactNode = <Mail className="h-3 w-3 text-ink-soft" />;
  let label = "Sent";
  let when = row.sentAt;
  let toneClass = "text-ink-soft";
  if (row.state === "confirmed" && row.confirmedAt) {
    icon = <BadgeCheck className="h-3 w-3 text-emerald-700" />;
    label = row.confirmedByName ? `Confirmed by ${row.confirmedByName}` : "Confirmed";
    when = row.confirmedAt;
    toneClass = "text-emerald-700 font-medium";
  } else if (row.state === "viewed" && row.firstViewedAt) {
    icon = <Eye className="h-3 w-3 text-slate-700" />;
    label = "Opened";
    when = row.firstViewedAt;
    toneClass = "text-slate-700";
  }
  return (
    <div className="grid grid-cols-[1fr_auto_auto] gap-3 items-center">
      <div className="min-w-0">
        {row.practiceAccountId ? (
          <Link
            to="/app/rep/accounts/$accountId"
            params={{ accountId: row.practiceAccountId }}
            className="text-sm font-medium text-foreground hover:text-primary truncate block"
          >
            {row.practiceTitle}
          </Link>
        ) : (
          <div className="text-sm font-medium text-foreground truncate">{row.practiceTitle}</div>
        )}
        <div className="text-[11px] mt-0.5 inline-flex items-center gap-1">
          {icon}
          <span className={toneClass}>{label}</span>
          <span className="text-ink-soft">· {formatRelative(when)}</span>
        </div>
      </div>
      <div className="text-right text-sm font-semibold tabular-nums text-foreground">
        {usd(row.totalUsd)}
      </div>
      <ChevronRight className="h-4 w-4 text-ink-soft/60" />
    </div>
  );
}

// ── Quick actions ──────────────────────────────────────────────────────────

function QuickActions({
  hasAccounts,
  hasIntents,
}: {
  hasAccounts: boolean;
  hasIntents: boolean;
}) {
  return (
    <section className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      <ActionCard
        to="/app/rep"
        icon={<Sparkles className="h-5 w-5 text-primary" />}
        title="Ask Liz to build a sample order"
        sub="Open chat and start with an account you want to push to the next tier"
        primary
      />
      <ActionCard
        to="/app/rep/accounts"
        icon={<MapPin className="h-5 w-5 text-foreground" />}
        title={hasAccounts ? "Browse all accounts" : "Import your accounts"}
        sub={hasAccounts ? "Drill into any practice for tier + order history" : "Drop a CSV — Liz learns names, contacts, tiers in one shot"}
      />
      <ActionCard
        to="/app/knowledge-base"
        icon={<Upload className="h-5 w-5 text-foreground" />}
        title="Upload a report"
        sub={hasIntents ? "Keep Galderma order history fresh as new ASPIRE exports come in" : "Galderma orders + purchase history projectors land your real data"}
      />
    </section>
  );
}

function ActionCard({
  to,
  icon,
  title,
  sub,
  primary,
}: {
  to: string;
  icon: React.ReactNode;
  title: string;
  sub: string;
  primary?: boolean;
}) {
  return (
    <Link
      to={to}
      className={cn(
        "block rounded-xl border px-5 py-4 transition",
        primary
          ? "border-primary/40 bg-primary/5 hover:bg-primary/10"
          : "border-border bg-card hover:border-primary/40",
      )}
    >
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0">{icon}</div>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-foreground">{title}</div>
          <div className="text-[12px] text-ink-soft mt-1 leading-relaxed">{sub}</div>
        </div>
      </div>
    </Link>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function usd(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function formatRelative(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diff = now - then;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}
