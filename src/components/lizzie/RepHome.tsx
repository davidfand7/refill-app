/**
 * RepHome — the Refill Rep Platform landing dashboard (Phase 3.1.8, v402).
 *
 * Mounts at /app/rep when the signed-in user resolves to a Refill rep
 * (gated by the persona branch in app.lizzie.index.tsx, 3.1.9). Closes
 * demo blocker #23 from the 2026-05-22 Kelly Caffee dry-run: the rep home
 * URL was previously serving Liz-AI (medical-aesthetics injectable rep
 * chat) to Refill reps — wrong product at the front door.
 *
 * Three regions:
 *   1. Hero strip — "Hey {firstName}." + two metric pills (active spas,
 *      lifetime $ recovered). Sets the welcome tone; gives Kelly a single-
 *      glance read on her network's state without scrolling.
 *   2. Quick-actions grid — six cards, one per rep-nav destination. Each
 *      links into the corresponding route. 1-col mobile → 2-col tablet →
 *      3-col desktop.
 *   3. LiveEarningsCard — same realtime widget used on /network + /ledger,
 *      so the home page surfaces the live ticker without an extra hop.
 *
 * Width: max-w-6xl to match RepShellChrome header — the dashboard wants
 * room to breathe across 3 columns. Sub-routes still use max-w-2xl for
 * readability; the home is the only wide surface in the rep platform.
 */

import { Link } from "@tanstack/react-router";
import {
  ArrowRight,
  Link2,
  Mail,
  Receipt,
  UserPlus,
  Users,
} from "lucide-react";
import { useEffect, useState, type ComponentType } from "react";

import { LiveEarningsCard } from "@/components/lizzie/LiveEarningsCard";
import { useAuth } from "@/lib/auth";
import { useRepProfile } from "@/lib/use-rep-profile";
import {
  getMyLiveEarnings,
  getMyNetwork,
  type LiveEarningsTotals,
  type NetworkMember,
} from "@/server/rep-platform";

type QuickAction = {
  key: string;
  to: string;
  label: string;
  subtitle: string;
  icon: ComponentType<{ className?: string }>;
};

// v412 — cards are the daily-use launchpads ONLY. Static-reference surfaces
// (Commission economics, Integrations) live in the global chip nav since
// they're one-time-read / connect-once and don't deserve homepage real estate.
// Ordering top-to-bottom + left-to-right matches Kelly's frequency-of-use:
// Outreach (daily send loop) → Recruit reps (weekly growth) →
// Network (weekly status check) → Commissions (monthly earnings check) →
// Referral links (mint-once, share-many — least frequent action).
const ACTIONS: QuickAction[] = [
  {
    key: "outreach",
    to: "/app/rep/outreach",
    label: "Outreach",
    subtitle: "Send to spa prospects",
    icon: Mail,
  },
  {
    // v408: rep-to-rep recruiting outreach — the compounding growth lever.
    key: "recruit",
    to: "/app/rep/recruit",
    label: "Recruit reps",
    subtitle: "Earn 1% cascade, lifetime",
    icon: UserPlus,
  },
  {
    key: "network",
    to: "/app/rep/network",
    label: "Network",
    subtitle: "See your downstream tree",
    icon: Users,
  },
  {
    key: "ledger",
    to: "/app/rep/ledger",
    label: "Commissions",
    subtitle: "Track pending and paid",
    icon: Receipt,
  },
  {
    key: "referral-links",
    to: "/app/rep/referral-links",
    label: "Referral links",
    subtitle: "Mint new and share",
    icon: Link2,
  },
];

const ZERO_TOTALS: LiveEarningsTotals = {
  todayUsd: 0,
  last7DaysUsd: 0,
  last30DaysUsd: 0,
  lifetimeUsd: 0,
  eventCountLifetime: 0,
};

export function RepHome() {
  const { session, loading: authLoading } = useAuth();
  const accessToken = session?.access_token;
  const repProfile = useRepProfile();

  const [members, setMembers] = useState<NetworkMember[]>([]);
  const [totals, setTotals] = useState<LiveEarningsTotals>(ZERO_TOTALS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (authLoading || !accessToken) return;
    let cancelled = false;
    (async () => {
      try {
        const [net, earnings] = await Promise.all([
          getMyNetwork({ data: { accessToken } }),
          getMyLiveEarnings({ data: { accessToken } }),
        ]);
        if (cancelled) return;
        setMembers(net.members);
        setTotals(earnings.totals);
      } catch {
        // Fail-soft: hero pills fall back to "—" / $0. Sub-route loads will
        // surface a real error when the user clicks in.
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authLoading, accessToken]);

  if (repProfile.status !== "rep") return null;
  const rep = repProfile.rep;
  const firstName = rep.displayName.split(" ")[0] || rep.displayName;
  const activeCount = members.filter((m) => m.status === "active").length;

  return (
    <div
      className="px-4 sm:px-8 py-8 sm:py-12"
      style={{ color: "#1c2024" }}
    >
      <div className="mx-auto max-w-6xl">
        <Hero
          firstName={firstName}
          activeCount={activeCount}
          lifetimeUsd={totals.lifetimeUsd}
          loaded={loaded}
        />

        <SectionLabel>Quick actions</SectionLabel>
        {/* v412 — 4-up row of action launchpads (Outreach / Recruit / Network /
            Commissions) + Referral links wraps to row 2 column 1. Most-frequent
            top-left, least-frequent bottom. Reference surfaces live in the chip
            nav above, not here. */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-10">
          {ACTIONS.map((a) => (
            <ActionCard key={a.key} action={a} />
          ))}
        </div>

        {accessToken && (
          <>
            <SectionLabel>Live earnings</SectionLabel>
            <LiveEarningsCard
              accessToken={accessToken}
              repUserId={rep.repUserId}
            />
          </>
        )}
      </div>
    </div>
  );
}

function Hero({
  firstName,
  activeCount,
  lifetimeUsd,
  loaded,
}: {
  firstName: string;
  activeCount: number;
  lifetimeUsd: number;
  loaded: boolean;
}) {
  return (
    <div className="mb-10">
      <h1
        className="text-[30px] sm:text-[36px] leading-[1.1] font-semibold tracking-tight mb-3"
        style={{
          fontFamily: "Georgia, 'Times New Roman', serif",
          color: "#1c2024",
        }}
      >
        Hey {firstName}.
      </h1>
      <p
        className="text-[15px] leading-[1.6] max-w-xl mb-5"
        style={{ color: "#5a6068" }}
      >
        Your network is recovering revenue. Commissions accrue lifetime,
        with no decay.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <MetricPill
          label="Active in network"
          value={loaded ? String(activeCount) : "—"}
        />
        <MetricPill
          label="Lifetime recovered"
          value={loaded ? formatUsd(lifetimeUsd) : "—"}
          accent
        />
      </div>
    </div>
  );
}

function MetricPill({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div
      className="inline-flex items-baseline gap-2 rounded-full border px-3.5 py-1.5"
      style={{
        background: accent ? "#e8f3ed" : "#fff",
        borderColor: accent ? "#cfe4d8" : "#e6e2d6",
      }}
    >
      <span
        className="text-[10px] uppercase tracking-wider font-semibold"
        style={{ color: accent ? "#056048" : "#8a9098" }}
      >
        {label}
      </span>
      <span
        className="text-[15px] font-semibold tabular-nums"
        style={{
          color: accent ? "#056048" : "#1c2024",
          fontFamily: "Georgia, 'Times New Roman', serif",
        }}
      >
        {value}
      </span>
    </div>
  );
}

function ActionCard({ action }: { action: QuickAction }) {
  const Icon = action.icon;
  return (
    <Link
      to={action.to}
      className="group rounded-xl border bg-white p-5 transition hover:shadow-sm focus-visible:outline-none focus-visible:ring-2"
      style={{ borderColor: "#e6e2d6" }}
    >
      <div className="flex items-start justify-between gap-3">
        <div
          className="flex h-9 w-9 items-center justify-center rounded-lg shrink-0 transition-colors"
          style={{ background: "#e8f3ed" }}
        >
          <Icon className="h-[18px] w-[18px]" />
        </div>
        <ArrowRight
          className="h-4 w-4 mt-1 transition-transform group-hover:translate-x-0.5"
          style={{ color: "#8a9098" }}
        />
      </div>
      <div className="mt-4">
        <div
          className="text-[15px] font-semibold tracking-tight mb-1"
          style={{ color: "#1c2024" }}
        >
          {action.label}
        </div>
        <div className="text-[13px] leading-[1.45]" style={{ color: "#8a9098" }}>
          {action.subtitle}
        </div>
      </div>
    </Link>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="text-[11px] uppercase tracking-wider font-semibold mb-3"
      style={{ color: "#8a9098" }}
    >
      {children}
    </div>
  );
}

function formatUsd(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}
