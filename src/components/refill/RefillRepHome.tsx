/**
 * RefillRepHome — Refill rep daily landing dashboard.
 *
 * Replaces openagenticv4's Liz-chat surface at /app/rep/index. The Refill
 * rep platform is rep-recruits-spa territory (referrals, sub-rep cascade,
 * commission ledger) — not med-aesthetics AI chat.
 *
 * Layout mirrors RefillHome (paper bg + emerald accent + Georgia hero):
 *   - Hero: "Hey {firstName}." + 1-line subtitle
 *   - Stats strip: sub-reps in network · lifetime recovery events · MTD recovered
 *   - 6 quick-action cards in frequency order per memory
 *     project_rep_to_rep_recruiting_outreach: Outreach, Recruit, Network,
 *     Commissions, Referral links, Integrations
 *
 * Stats wired to existing rep-platform.ts server fns (getMyNetwork +
 * getMyLiveEarnings) — no new server fn needed.
 */

import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  ArrowRight,
  Mail,
  Network,
  Plug,
  Share2,
  TrendingUp,
  UserPlus,
  Wallet,
  type LucideIcon,
} from "lucide-react";

import { getAdminViewAsUserId } from "@/lib/admin-view-as";
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
  icon: LucideIcon;
};

const ACTIONS: QuickAction[] = [
  {
    key: "outreach",
    to: "/app/rep/outreach",
    label: "Outreach",
    subtitle: "Send a recruit email to a spa owner",
    icon: Mail,
  },
  {
    key: "recruit",
    to: "/app/rep/recruit",
    label: "Recruit",
    subtitle: "Pull other reps into your network",
    icon: UserPlus,
  },
  {
    key: "economics",
    to: "/app/rep/economics",
    label: "Economics",
    subtitle: "How the 8/3/1 split pays you",
    icon: TrendingUp,
  },
  {
    key: "network",
    to: "/app/rep/network",
    label: "Network",
    subtitle: "Sub-reps and the spas under them",
    icon: Network,
  },
  {
    key: "ledger",
    to: "/app/rep/ledger",
    label: "Commissions",
    subtitle: "Earnings + payout history",
    icon: Wallet,
  },
  {
    key: "referral-links",
    to: "/app/rep/referral-links",
    label: "Referral links",
    subtitle: "Mint + share your links",
    icon: Share2,
  },
  {
    key: "integrations",
    to: "/app/rep/integrations",
    label: "Integrations",
    subtitle: "Sync contacts from your CRM",
    icon: Plug,
  },
];

function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return "$0";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

export function RefillRepHome() {
  const profile = useRepProfile();
  const { session } = useAuth();
  const [network, setNetwork] = useState<NetworkMember[] | null>(null);
  const [earnings, setEarnings] = useState<LiveEarningsTotals | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);

  useEffect(() => {
    const accessToken = session?.access_token;
    if (!accessToken || profile.status !== "rep") return;
    let cancelled = false;
    const viewAsUserId =
      typeof window !== "undefined" ? getAdminViewAsUserId() : undefined;
    void Promise.all([
      getMyNetwork({ data: { accessToken, viewAsUserId } }).then((r) => r.members),
      getMyLiveEarnings({ data: { accessToken, viewAsUserId } }).then((r) => r.totals),
    ])
      .then(([members, totals]) => {
        if (cancelled) return;
        setNetwork(members);
        setEarnings(totals);
      })
      .catch((err) => {
        if (cancelled) return;
        setStatsError(err instanceof Error ? err.message : "Couldn't load stats.");
      });
    return () => {
      cancelled = true;
    };
  }, [session?.access_token, profile.status]);

  if (profile.status === "loading") {
    return (
      <div className="px-4 sm:px-8 py-12 text-center text-sm" style={{ color: "#5a6068" }}>
        Loading your dashboard…
      </div>
    );
  }
  if (profile.status === "not-a-rep" || !profile.rep) {
    return (
      <div className="px-4 sm:px-8 py-12 max-w-md mx-auto text-center" style={{ color: "#1c2024" }}>
        <h1
          className="text-[24px] mb-3"
          style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}
        >
          You're signed in, but…
        </h1>
        <p className="text-[14px] leading-[1.55] mb-4" style={{ color: "#5a6068" }}>
          Your account isn't set up as a Refill rep yet. If this is a mistake,
          ping admin to flip you to rep status.
        </p>
      </div>
    );
  }

  const firstName = profile.rep.displayName?.split(" ")[0] ?? "there";

  const subRepCount = network
    ? network.filter((m) => m.depth === 1 && m.status === "active").length
    : null;
  const lifetimeEvents = earnings?.eventCountLifetime ?? null;
  const recovered30d = earnings?.last30DaysUsd ?? null;

  return (
    <div className="px-4 sm:px-8 py-8 sm:py-12" style={{ color: "#1c2024" }}>
      <div className="mx-auto max-w-6xl">
        {/* Hero */}
        <div className="mb-10">
          <h1
            className="text-[36px] sm:text-[44px] leading-[1.1] font-semibold tracking-tight mb-3"
            style={{
              fontFamily: "Georgia, 'Times New Roman', serif",
              color: "#1c2024",
            }}
          >
            Hey {firstName}.
          </h1>
          <p
            className="text-[15px] sm:text-[16px] leading-[1.55] max-w-2xl"
            style={{ color: "#5a6068" }}
          >
            Your network — and the recoveries flowing through it.
          </p>

          {/* Stats strip */}
          <div className="mt-6 flex flex-wrap gap-x-8 gap-y-3">
            <Stat label="Sub-reps" value={subRepCount != null ? String(subRepCount) : "—"} />
            <Stat
              label="Recapture events"
              value={lifetimeEvents != null ? String(lifetimeEvents) : "—"}
            />
            <Stat
              label="Recovered (30d)"
              value={recovered30d != null ? formatUsd(recovered30d) : "$—"}
            />
          </div>
          {statsError && (
            <div className="mt-3 text-[12px]" style={{ color: "#8a1616" }}>
              {statsError}
            </div>
          )}
        </div>

        {/* Quick actions */}
        <SectionLabel>Quick actions</SectionLabel>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4 mb-10">
          {ACTIONS.map((a) => (
            <ActionCard key={a.key} action={a} />
          ))}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div
        className="text-[10px] uppercase tracking-wider font-semibold"
        style={{ color: "#8a9098" }}
      >
        {label}
      </div>
      <div
        className="text-[20px] font-semibold mt-0.5"
        style={{
          fontFamily: "Georgia, 'Times New Roman', serif",
          color: "#1c2024",
        }}
      >
        {value}
      </div>
    </div>
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

function ActionCard({ action }: { action: QuickAction }) {
  const Icon = action.icon;
  return (
    <Link
      to={action.to}
      className="group rounded-xl border bg-white p-5 transition hover:shadow-md flex flex-col justify-between min-h-[140px]"
      style={{ borderColor: "#e6e2d6" }}
    >
      <div>
        <div
          className="inline-flex h-10 w-10 items-center justify-center rounded-lg mb-3"
          style={{ background: "#e8f1ed", color: "#056048" }}
        >
          <Icon className="h-5 w-5" />
        </div>
        <div
          className="text-[16px] font-semibold mb-1"
          style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}
        >
          {action.label}
        </div>
        <div className="text-[13px] leading-[1.5]" style={{ color: "#5a6068" }}>
          {action.subtitle}
        </div>
      </div>
      <div
        className="mt-3 inline-flex items-center gap-1.5 text-[12px] font-semibold"
        style={{ color: "#056048" }}
      >
        Open
        <ArrowRight className="h-3 w-3 transition group-hover:translate-x-0.5" />
      </div>
    </Link>
  );
}
