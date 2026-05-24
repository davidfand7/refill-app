/**
 * LiveRecoveryFeed — the "look it's happening" hero widget on RefillHome (v410.4).
 *
 * Tenant-scoped mirror of LiveEarningsCard (the rep-side widget on
 * /app/rep/network + /app/rep/ledger). Karen sees her spa's recovery
 * revenue stream — Today / 7 days / 30 days / All-time totals + a "Most
 * recent" sub-list with the last few recovery events as they land.
 *
 * Realtime: subscribes to emma_recovery_events filtered by user_id, ONE
 * subscription per user_id in the tenant. Most tenants have one owner today
 * (per the v387 wizard's single-tenant-per-user rule) so this collapses to
 * one subscription. Multi-owner tenants get N subscriptions; the refetch
 * is shared so duplicate events don't double-trigger the pulse.
 *
 * Replaces the v410 LiveRecoveryFeedPlaceholder. See [[project-pricing-killshot]]
 * for why this "watching it work" visual is the hero feature on Karen's home —
 * Refill is paid on recovered revenue, so showing the revenue land in real
 * time is the value proposition made tangible.
 */

import { useEffect, useRef, useState } from "react";
import { Activity } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import {
  getMyTenantRecoveryFeed,
  type TenantRecoveryEvent,
  type TenantRecoveryTotals,
} from "@/server/refill-tenants";

type Props = {
  accessToken: string;
};

const ZERO: TenantRecoveryTotals = {
  todayUsd: 0,
  last7DaysUsd: 0,
  last30DaysUsd: 0,
  lifetimeUsd: 0,
  eventCountLifetime: 0,
};

export function LiveRecoveryFeed({ accessToken }: Props) {
  const [totals, setTotals] = useState<TenantRecoveryTotals>(ZERO);
  const [recent, setRecent] = useState<TenantRecoveryEvent[]>([]);
  const [tenantUserIds, setTenantUserIds] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [pulse, setPulse] = useState(false);
  const pulseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Stage 1: initial load + capture tenantUserIds for the subscription stage.
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const r = await getMyTenantRecoveryFeed({ data: { accessToken } });
        if (cancelled) return;
        setTotals(r.totals);
        setRecent(r.recent);
        setTenantUserIds(r.tenantUserIds);
        setLoaded(true);
      } catch {
        if (!cancelled) setLoaded(true);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  // Stage 2: subscribe to emma_recovery_events for each user_id on this
  // tenant. Realtime postgres_changes doesn't take an array filter directly,
  // so we open one channel per user_id. The refetch-on-change handler is
  // shared, and a single pulseTimer ensures multi-channel duplicate events
  // don't double-flash. tenantUserIds is stable across the lifetime of the
  // session for a given Karen-like demo tenant; if a new membership is added
  // mid-session, the next page-load picks it up.
  useEffect(() => {
    if (tenantUserIds.length === 0) return;

    const refetch = async () => {
      try {
        const r = await getMyTenantRecoveryFeed({ data: { accessToken } });
        setTotals(r.totals);
        setRecent(r.recent);
      } catch {
        /* keep last-known state on transient failure */
      }
    };

    const onChange = () => {
      if (pulseTimer.current) clearTimeout(pulseTimer.current);
      setPulse(true);
      pulseTimer.current = setTimeout(() => setPulse(false), 1200);
      void refetch();
    };

    const channels = tenantUserIds.map((uid) =>
      supabase
        .channel(`refill-recovery-${uid}`)
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "emma_recovery_events",
            filter: `user_id=eq.${uid}`,
          },
          onChange,
        )
        .subscribe(),
    );

    return () => {
      if (pulseTimer.current) clearTimeout(pulseTimer.current);
      for (const ch of channels) {
        void supabase.removeChannel(ch);
      }
    };
  }, [accessToken, tenantUserIds]);

  return (
    <div
      className="rounded-xl border p-6 sm:p-7 mb-6 transition-shadow"
      style={{
        borderColor: pulse ? "#056048" : "#e6e2d6",
        background: "#fff",
        boxShadow: pulse ? "0 0 0 2px rgba(5,96,72,0.18)" : undefined,
      }}
      role="region"
      aria-label="Live recovery revenue for your spa"
    >
      <div className="flex items-center gap-2 mb-4">
        <Activity
          className="h-4 w-4"
          style={{ color: pulse ? "#056048" : "#8a9098" }}
        />
        <div
          className="text-[11px] uppercase tracking-wider font-semibold"
          style={{ color: pulse ? "#056048" : "#8a9098" }}
        >
          Live · recovery feed
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
            ? "No recoveries yet. The moment Refill confirms a recovery for your spa, it shows up here in real time."
            : `${totals.eventCountLifetime} recovery event${totals.eventCountLifetime === 1 ? "" : "s"} on file. New ones land here live as Refill confirms them.`
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

function formatAgent(a: TenantRecoveryEvent["recoveryAgent"]): string {
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
