/**
 * LiveEarningsCard — composable rep-facing live revenue widget.
 *
 * Mounted at the top of /app/rep/network and /app/rep/ledger.
 * Subscribes to emma_recovery_events filtered by referred_by_rep_id =
 * accessToken's auth.uid() via Supabase realtime, re-pulls aggregated
 * totals on every change. Phase 2D (v396).
 *
 * Tier-1 direct revenue only — cascade (Tier-2 sub-rep events crediting
 * me 1%) flows through the commission ledger via the monthly cron and is
 * surfaced by the LedgerView, not here. Supabase realtime filter syntax
 * can't easily express "in this set of rep_ids."
 */

import { useEffect, useRef, useState } from "react";
import { Activity } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import {
  CASCADE_COMMISSION_RATE,
  DIRECT_COMMISSION_RATE,
  formatRate,
} from "@/lib/rep-economics";
import {
  getMyLiveEarnings,
  type LiveEarningsEvent,
  type LiveEarningsTotals,
} from "@/server/rep-platform";

type Props = {
  accessToken: string;
  repUserId: string;
};

const ZERO: LiveEarningsTotals = {
  todayUsd: 0,
  last7DaysUsd: 0,
  last30DaysUsd: 0,
  lifetimeUsd: 0,
  eventCountLifetime: 0,
};

export function LiveEarningsCard({ accessToken, repUserId }: Props) {
  const [totals, setTotals] = useState<LiveEarningsTotals>(ZERO);
  const [recent, setRecent] = useState<LiveEarningsEvent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [pulse, setPulse] = useState(false);
  const pulseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const { totals: t, recent: r } = await getMyLiveEarnings({
          data: { accessToken },
        });
        if (cancelled) return;
        setTotals(t);
        setRecent(r);
        setLoaded(true);
      } catch {
        if (!cancelled) setLoaded(true);
      }
    };

    load();

    const channel = supabase
      .channel(`rep-earnings-${repUserId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "emma_recovery_events",
          filter: `referred_by_rep_id=eq.${repUserId}`,
        },
        () => {
          if (pulseTimer.current) clearTimeout(pulseTimer.current);
          setPulse(true);
          pulseTimer.current = setTimeout(() => setPulse(false), 1200);
          load();
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      if (pulseTimer.current) clearTimeout(pulseTimer.current);
      supabase.removeChannel(channel);
    };
  }, [accessToken, repUserId]);

  return (
    <div
      className="rounded-xl border p-6 sm:p-7 mb-6 transition-shadow"
      style={{
        borderColor: pulse ? "#056048" : "#e6e2d6",
        background: "#fff",
        boxShadow: pulse ? "0 0 0 2px rgba(5,96,72,0.18)" : undefined,
      }}
      role="region"
      aria-label="Live revenue recovered by your direct spas"
    >
      {/* v405.x Pinch #5: card explicitly framed as REVENUE RECOVERED (the
          spas' gross bill), not COMMISSION EARNED. Before this label rewrite,
          the card sat above the "Earned to date · Lifetime $5,600" panel on
          the Commissions page, both using the word "Lifetime" with different
          values — the rep would read both as their own money. Header now reads
          "Live · revenue recovered by your direct spas"; the totals chip
          formerly labeled "Lifetime" reads "All time" to avoid the collision.
          The clarifying body text points the rep at the Commissions section
          for their actual slice. */}
      <div className="flex items-center gap-2 mb-4">
        <Activity
          className="h-4 w-4"
          style={{ color: pulse ? "#056048" : "#8a9098" }}
        />
        <div
          className="text-[11px] uppercase tracking-wider font-semibold"
          style={{ color: pulse ? "#056048" : "#8a9098" }}
        >
          Live · revenue recovered by your direct spas
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 sm:gap-6 mb-5">
        <Stat label="Today" value={totals.todayUsd} loaded={loaded} highlight={pulse} />
        <Stat label="7 days" value={totals.last7DaysUsd} loaded={loaded} />
        <Stat label="30 days" value={totals.last30DaysUsd} loaded={loaded} />
        <Stat label="All time" value={totals.lifetimeUsd} loaded={loaded} bold />
      </div>

      <div
        className="text-[12px] mb-3 leading-[1.5]"
        style={{ color: "#8a9098" }}
      >
        {loaded
          ? totals.eventCountLifetime === 0
            ? "No recoveries attributed yet. The moment a spa you referred recovers revenue, it shows up here in real time."
            : (
              <>
                {totals.eventCountLifetime} recovery event
                {totals.eventCountLifetime === 1 ? "" : "s"} attributed to you.{" "}
                <span style={{ color: "#5a6068" }}>
                  These are gross recovered $$ &mdash; your{" "}
                  {formatRate(DIRECT_COMMISSION_RATE)} slice on direct spas (
                  {formatRate(CASCADE_COMMISSION_RATE)} on cascade) rolls up to{" "}
                  <em>Commissions</em> on the monthly close.
                </span>
              </>
            )
          : "Loading…"}
      </div>

      {recent.length > 0 && (
        <div className="border-t pt-3 mt-3" style={{ borderColor: "#f0ebe0" }}>
          <div
            className="text-[11px] uppercase tracking-wider font-semibold mb-2"
            style={{ color: "#8a9098" }}
          >
            Most recent
          </div>
          <ul className="space-y-1.5">
            {recent.slice(0, 5).map((e) => (
              <li
                key={e.id}
                className="flex items-center justify-between text-[13px]"
              >
                <span style={{ color: "#5a6068" }}>
                  {formatAgent(e.recoveryAgent)} ·{" "}
                  <span style={{ color: "#8a9098" }}>
                    {formatRelative(e.createdAt)}
                  </span>
                </span>
                <span
                  className="font-semibold tabular-nums"
                  style={{
                    color:
                      e.attributedRevenueUsd == null ? "#8a9098" : "#1c2024",
                  }}
                >
                  {e.attributedRevenueUsd == null
                    ? "pending"
                    : formatUsd(e.attributedRevenueUsd)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  loaded,
  bold,
  highlight,
}: {
  label: string;
  value: number;
  loaded: boolean;
  bold?: boolean;
  highlight?: boolean;
}) {
  return (
    <div>
      <div
        className="text-[10px] uppercase tracking-wider mb-1"
        style={{ color: "#8a9098" }}
      >
        {label}
      </div>
      <div
        className={`tabular-nums ${bold ? "text-[22px]" : "text-[18px]"}`}
        style={{
          color: highlight ? "#056048" : "#1c2024",
          fontWeight: bold ? 700 : 600,
          fontFamily: "Georgia, 'Times New Roman', serif",
        }}
      >
        {loaded ? formatUsd(value) : "—"}
      </div>
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

function formatAgent(a: LiveEarningsEvent["recoveryAgent"]): string {
  if (a === "rescue") return "Rescue";
  if (a === "post_recovery") return "Post-recovery";
  return "Pre-show";
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}
