/**
 * "Incentives at work" — the cross-source incentive-ROI scoreboard band that
 * sits atop the Incentives tab (v2.158.0).
 *
 * Unifies the three incentive surfaces under one honest lens (trailing 12mo):
 *   - Recall + Cross-sell: VERIFIED recovery_events → {bookings, $recovered}.
 *     The dollar is the spa's recovered TREATMENT revenue (reconciled from
 *     patient_transactions) — never SmartSpa's $5 fee.
 *   - Allocation: SEND-ONLY. Incentives the spa put to work (count + units),
 *     no dollar claimed until booking attribution ships. We say so out loud.
 */

import { useEffect, useState } from "react";
import { Activity, ArrowDownRight, Gift, Sparkles, TrendingUp } from "lucide-react";

import {
  getIncentiveScoreboard,
  type IncentiveScoreboard,
} from "@/server/refill-incentive-scoreboard.functions";

function usd(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

export function IncentivesAtWorkBand({
  accessToken,
  viewAsUserId,
}: {
  accessToken: string;
  viewAsUserId?: string;
}) {
  const [data, setData] = useState<IncentiveScoreboard | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await getIncentiveScoreboard({
          data: { accessToken, viewAsUserId },
        });
        if (!cancelled) setData(res);
      } catch {
        // Silent: a scoreboard read failing must never block the page it tops.
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accessToken, viewAsUserId]);

  if (failed) return null;

  if (!data) {
    return (
      <div className="rounded-2xl border border-rule bg-white/60 px-5 py-4 animate-pulse">
        <div className="h-3 w-32 rounded bg-rule-soft" />
        <div className="mt-3 h-7 w-40 rounded bg-rule-soft" />
      </div>
    );
  }

  const recoveredUsd =
    data.recall.recoveredUsd +
    data.crossSell.recoveredUsd +
    data.allocation.recoveredUsd;
  const recoveredBookings =
    data.recall.count + data.crossSell.count + data.allocation.bookedCount;
  const allEmpty =
    recoveredBookings === 0 &&
    recoveredUsd === 0 &&
    data.allocation.sentCount === 0;

  return (
    <div className="rounded-2xl border border-emerald/30 bg-gradient-to-br from-emerald-soft/50 to-white px-5 py-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 mb-3.5">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-6 w-6 items-center justify-center rounded-lg bg-emerald text-paper">
            <TrendingUp className="h-3.5 w-3.5" />
          </span>
          <h2 className="text-sm font-semibold text-ink tracking-tight">
            Incentives at work
          </h2>
        </div>
        <span className="text-[11px] text-ink-soft">Last 12 months</span>
      </div>

      {allEmpty ? (
        <div className="flex items-start gap-2.5 rounded-xl border border-dashed border-rule bg-white/60 px-4 py-3.5">
          <Sparkles className="h-4 w-4 text-emerald shrink-0 mt-0.5" />
          <p className="text-[12.5px] text-ink-soft leading-relaxed">
            Your incentive ROI shows up here as recalls and offers convert into
            booked, paid visits — and as you put rebate units to work for
            specific patients. Nothing to total yet.
          </p>
        </div>
      ) : (
        <>
          {/* Headline: recovered revenue (the spa's own money) */}
          <div className="flex items-baseline gap-2 mb-3">
            <span className="text-[26px] font-bold text-emerald-ink leading-none tracking-tight">
              {usd(recoveredUsd)}
            </span>
            <span className="text-[12px] text-ink-soft">
              recovered across{" "}
              <span className="font-semibold text-ink">{recoveredBookings}</span>{" "}
              {recoveredBookings === 1 ? "booking" : "bookings"}
            </span>
          </div>

          {/* Three lanes */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            <LaneTile
              icon={<ArrowDownRight className="h-3.5 w-3.5" />}
              label="Recall"
              primary={usd(data.recall.recoveredUsd)}
              secondary={`${data.recall.count} ${
                data.recall.count === 1 ? "booking" : "bookings"
              } recovered`}
            />
            <LaneTile
              icon={<Gift className="h-3.5 w-3.5" />}
              label="Cross-sell offers"
              primary={usd(data.crossSell.recoveredUsd)}
              secondary={`${data.crossSell.count} ${
                data.crossSell.count === 1 ? "booking" : "bookings"
              } recovered`}
            />
            {data.allocation.bookedCount > 0 ? (
              <LaneTile
                icon={<Activity className="h-3.5 w-3.5" />}
                label="Allocation"
                primary={usd(data.allocation.recoveredUsd)}
                secondary={`${data.allocation.bookedCount} booked · ${data.allocation.sentCount} sent`}
              />
            ) : (
              <LaneTile
                icon={<Activity className="h-3.5 w-3.5" />}
                label="Allocation"
                primary={`${data.allocation.sentCount} sent`}
                secondary={`${data.allocation.units} ${
                  data.allocation.units === 1 ? "unit" : "units"
                } to patients`}
                tag={data.allocation.sentCount > 0 ? "Awaiting first booking" : undefined}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}

function LaneTile({
  icon,
  label,
  primary,
  secondary,
  tag,
}: {
  icon: React.ReactNode;
  label: string;
  primary: string;
  secondary: string;
  tag?: string;
}) {
  return (
    <div className="rounded-xl border border-rule bg-white px-3.5 py-2.5">
      <div className="flex items-center gap-1.5 text-ink-soft">
        <span className="text-emerald">{icon}</span>
        <span className="text-[10px] font-semibold uppercase tracking-wider">
          {label}
        </span>
      </div>
      <div className="mt-1.5 text-[17px] font-bold text-ink leading-none tracking-tight">
        {primary}
      </div>
      <div className="mt-1 text-[11px] text-ink-soft">{secondary}</div>
      {tag && (
        <span className="mt-1.5 inline-flex items-center rounded-full bg-rule-soft px-2 py-0.5 text-[9.5px] font-medium text-ink-soft">
          {tag}
        </span>
      )}
    </div>
  );
}
