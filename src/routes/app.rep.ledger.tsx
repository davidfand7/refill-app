/**
 * /app/rep/ledger — Phase 2D commission ledger view.
 *
 * Reads rep_commission_ledger via getMyLedger() server fn. Groups rows by
 * period_month with pending/paid/voided status. Tier 1 (direct, 3%) and
 * Tier 2 (cascade, 1%) commissions appear here once the monthly cron writes
 * them — that cron is a separate ship (schema is ready in v395, runner
 * lands later). Empty state until first cron run.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Receipt } from "lucide-react";

import { getAdminViewAsUserId } from "@/lib/admin-view-as";
import { useAuth } from "@/lib/auth";
import { LiveEarningsCard } from "@/components/refill/LiveEarningsCard";
import {
  getMyLedger,
  getMyRepAccount,
  type LedgerRow,
  type LedgerTotals,
  type RepAccountRow,
} from "@/server/rep-platform";

export const Route = createFileRoute("/app/rep/ledger")({
  component: LedgerPage,
});

const ZERO_TOTALS: LedgerTotals = {
  pendingUsd: 0,
  paidUsd: 0,
  voidedUsd: 0,
  lifetimeUsd: 0,
};

function LedgerPage() {
  const { session, loading: authLoading } = useAuth();
  const accessToken = session?.access_token;

  const [rep, setRep] = useState<RepAccountRow | null>(null);
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [totals, setTotals] = useState<LedgerTotals>(ZERO_TOTALS);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading) return;
    if (!accessToken) {
      setLoaded(true);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const viewAsUserId =
          typeof window !== "undefined" ? getAdminViewAsUserId() : undefined;
        const [repRes, ledgerRes] = await Promise.all([
          getMyRepAccount({ data: { accessToken, viewAsUserId } }),
          getMyLedger({ data: { accessToken, viewAsUserId } }),
        ]);
        if (cancelled) return;
        setRep(repRes.rep);
        setRows(ledgerRes.rows);
        setTotals(ledgerRes.totals);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Couldn't load your ledger.",
          );
        }
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authLoading, accessToken]);

  if (authLoading || !loaded) {
    return <Pulse label="Loading your commission ledger…" />;
  }

  if (!accessToken) {
    return (
      <Page>
        <Heading>Commissions</Heading>
        <Lede>Sign in to view your ledger.</Lede>
      </Page>
    );
  }

  if (!rep) {
    return (
      <Page>
        <Heading>Commissions</Heading>
        <Lede>
          Set up your rep profile to start earning commissions on the spas you
          refer.
        </Lede>
        <Link
          to="/app/rep/referral-links"
          className="inline-flex items-center gap-2 rounded-md px-5 py-2.5 text-[14px] font-semibold shadow-sm transition"
          style={{ background: "#056048", color: "#fbfaf7" }}
        >
          Set up rep profile
        </Link>
      </Page>
    );
  }

  const byPeriod = groupByPeriod(rows);

  return (
    <Page>
      <Heading>Commissions</Heading>
      <Lede>
        Hi {rep.displayName}. Every recovery your downstream spas confirm rolls
        up here on the monthly close. Tier 1 commissions pay 3% direct; Tier 2
        cascade pays 1% upstream — both lifetime.
      </Lede>

      <LiveEarningsCard accessToken={accessToken} repUserId={rep.repUserId} />

      <SectionHeader
        icon={<Receipt className="h-4 w-4" />}
        title="Earned to date"
      />

      <div
        className="grid grid-cols-3 gap-4 sm:gap-6 mb-6 rounded-lg border p-5"
        style={{ borderColor: "#e6e2d6", background: "#fbfaf7" }}
      >
        <Stat label="Pending" value={totals.pendingUsd} tone="pending" />
        <Stat label="Paid" value={totals.paidUsd} tone="paid" />
        <Stat label="Lifetime" value={totals.lifetimeUsd} tone="lifetime" bold />
      </div>

      {rows.length === 0 ? (
        <EmptyLedger />
      ) : (
        <div className="space-y-5">
          {Array.from(byPeriod.keys()).map((period) => (
            <PeriodSection
              key={period}
              period={period}
              rows={byPeriod.get(period) ?? []}
            />
          ))}
        </div>
      )}

      {error && (
        <div
          className="mt-4 rounded-md px-3 py-2 text-[13px]"
          style={{ background: "#fdecec", color: "#8a1616" }}
        >
          {error}
        </div>
      )}
    </Page>
  );
}

function groupByPeriod(rows: LedgerRow[]): Map<string, LedgerRow[]> {
  const map = new Map<string, LedgerRow[]>();
  for (const r of rows) {
    const list = map.get(r.periodMonth) ?? [];
    list.push(r);
    map.set(r.periodMonth, list);
  }
  return map;
}

function PeriodSection({
  period,
  rows,
}: {
  period: string;
  rows: LedgerRow[];
}) {
  const periodTotal = rows
    .filter((r) => r.status !== "voided")
    .reduce((sum, r) => sum + r.commissionUsd, 0);

  return (
    <div
      className="rounded-lg border"
      style={{ borderColor: "#e6e2d6", background: "#fff" }}
    >
      <div
        className="flex items-center justify-between px-4 py-2.5 border-b"
        style={{ borderColor: "#f0ebe0", background: "#fbfaf7" }}
      >
        <div
          className="text-[12px] font-semibold uppercase tracking-wider"
          style={{ color: "#5a6068" }}
        >
          {formatPeriod(period)}
        </div>
        <div
          className="text-[13px] font-semibold tabular-nums"
          style={{ color: "#1c2024" }}
        >
          {formatUsd(periodTotal)}
        </div>
      </div>
      <ul className="divide-y" style={{ borderColor: "#f0ebe0" }}>
        {rows.map((r) => (
          <li
            key={r.id}
            className="flex items-center justify-between px-4 py-3 gap-4"
          >
            <div className="min-w-0 flex-1">
              <div
                className="text-[13px] font-medium flex items-center gap-2"
                style={{ color: "#1c2024" }}
              >
                <TierTag tier={r.tierLevel} />
                <span>{formatUsd(r.sourceRevenueUsd)} recovered</span>
              </div>
              {r.notes && (
                <div
                  className="text-[12px] mt-0.5 truncate"
                  style={{ color: "#8a9098" }}
                >
                  {stripDemoPrefix(r.notes)}
                </div>
              )}
            </div>
            <div className="flex items-center gap-3 flex-shrink-0">
              <span
                className="text-[14px] font-semibold tabular-nums"
                style={{
                  color: r.status === "voided" ? "#8a9098" : "#1c2024",
                  textDecoration:
                    r.status === "voided" ? "line-through" : undefined,
                }}
              >
                {formatUsd(r.commissionUsd)}
              </span>
              <StatusPill status={r.status} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TierTag({ tier }: { tier: 1 | 2 | 3 }) {
  return (
    <span
      className="text-[10px] uppercase tracking-wider font-semibold rounded px-1.5 py-0.5"
      style={{ background: "#f0ebe0", color: "#5a6068" }}
    >
      T{tier}
    </span>
  );
}

function StatusPill({ status }: { status: LedgerRow["status"] }) {
  const palette =
    status === "paid"
      ? { bg: "#e8f3ed", fg: "#056048" }
      : status === "pending"
        ? { bg: "#fdf6e6", fg: "#8a6d10" }
        : { bg: "#f0ebe0", fg: "#8a9098" };
  return (
    <span
      className="text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5"
      style={{ background: palette.bg, color: palette.fg }}
    >
      {status}
    </span>
  );
}

function Stat({
  label,
  value,
  tone,
  bold,
}: {
  label: string;
  value: number;
  tone: "pending" | "paid" | "lifetime";
  bold?: boolean;
}) {
  const color =
    tone === "paid" ? "#056048" : tone === "pending" ? "#8a6d10" : "#1c2024";
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
          color,
          fontWeight: bold ? 700 : 600,
          fontFamily: "Georgia, 'Times New Roman', serif",
        }}
      >
        {formatUsd(value)}
      </div>
    </div>
  );
}

function EmptyLedger() {
  return (
    <div
      className="rounded-lg border p-6 text-center"
      style={{
        borderColor: "#e6e2d6",
        background: "#fbfaf7",
        borderStyle: "dashed",
      }}
    >
      <Receipt
        className="h-7 w-7 mx-auto mb-3"
        style={{ color: "#8a9098" }}
        aria-hidden
      />
      <div
        className="text-[15px] font-semibold mb-1.5"
        style={{ color: "#1c2024" }}
      >
        No commissions posted yet
      </div>
      <p
        className="text-[13px] leading-[1.55] max-w-md mx-auto"
        style={{ color: "#5a6068" }}
      >
        Commissions post here on the monthly close. Until your first spa
        recovers revenue, the live earnings card above is the real-time view —
        once recoveries verify, they roll up into the ledger.
      </p>
    </div>
  );
}

function formatPeriod(yyyymmdd: string): string {
  const d = new Date(yyyymmdd + "T00:00:00Z");
  return d.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "America/Denver",
  });
}

function formatUsd(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

// v405 Pinch #4: ledger rows store a "DEMO_KELLY · <spa name>" prefix so the
// wipe_kelly_demo_data() function can clean them up via notes LIKE
// 'DEMO_KELLY%'. The prefix is internal — the rep should see just the spa
// name. The Demo-mode banner at the top of every rep page already signals
// the data is seeded, so the per-row tag is redundant noise here.
const DEMO_PREFIX = "DEMO_KELLY · ";
function stripDemoPrefix(notes: string): string {
  return notes.startsWith(DEMO_PREFIX) ? notes.slice(DEMO_PREFIX.length) : notes;
}

// ─── presentational helpers (mirror app.lizzie.network.tsx + referral-links) ─

function Page({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="min-h-screen px-5 sm:px-8 py-12 sm:py-16"
      style={{ background: "#fbfaf7", color: "#1c2024" }}
    >
      <div className="w-full max-w-2xl mx-auto">
        <div
          className="rounded-xl border bg-white p-7 sm:p-10 shadow-sm"
          style={{ borderColor: "#e6e2d6" }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return (
    <h1
      className="text-[28px] leading-[1.15] font-semibold tracking-tight mb-3"
      style={{
        fontFamily: "Georgia, 'Times New Roman', serif",
        color: "#1c2024",
      }}
    >
      {children}
    </h1>
  );
}

function Lede({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[15px] leading-[1.6] mb-6" style={{ color: "#5a6068" }}>
      {children}
    </p>
  );
}

function SectionHeader({
  icon,
  title,
}: {
  icon: React.ReactNode;
  title: string;
}) {
  return (
    <div className="flex items-center gap-2 mb-3">
      {icon}
      <h2
        className="text-[16px] font-semibold tracking-tight"
        style={{ color: "#1c2024" }}
      >
        {title}
      </h2>
    </div>
  );
}

function Pulse({ label }: { label: string }) {
  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center gap-4"
      style={{ background: "#fbfaf7" }}
      role="status"
      aria-live="polite"
    >
      <div
        className="h-9 w-9 rounded-full animate-pulse"
        style={{ background: "#056048" }}
        aria-hidden
      />
      <div className="text-[14px]" style={{ color: "#5a6068" }}>
        {label}
      </div>
    </div>
  );
}
