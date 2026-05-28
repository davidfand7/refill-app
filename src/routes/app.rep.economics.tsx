/**
 * /app/rep/economics — Phase 2G commission economics page (screen 2).
 *
 * The 8/3/1 split explainer + worked-example table with the rep's name
 * substituted into the math. Drives demo screen 2: "Here's exactly how
 * commissions work." No interactivity — pure narrative + reference table.
 *
 * Lifetime, no decay. 3-tier cap per FTC compliance.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { TrendingUp } from "lucide-react";

import { useAuth } from "@/lib/auth";
import {
  computeDirectScenario,
  computeMixedScenario,
  formatRate,
  formatRateCents,
  formatThousandsCeil,
  formatUsd0,
  CASCADE_COMMISSION_RATE,
  DIRECT_COMMISSION_RATE,
  REFILL_TAKE_RATE,
  TOTAL_TAKE_RATE,
} from "@/lib/rep-economics";
import { getAdminViewAsUserId } from "@/lib/admin-view-as";
import {
  getMyNetwork,
  getMyRepAccount,
  type RepAccountRow,
} from "@/server/rep-platform";

export const Route = createFileRoute("/app/rep/economics")({
  component: EconomicsPage,
});

function EconomicsPage() {
  const { session, loading: authLoading } = useAuth();
  const accessToken = session?.access_token;

  const [rep, setRep] = useState<RepAccountRow | null>(null);
  const [loaded, setLoaded] = useState(false);
  // v405 Pinch #17: state-aware CTA below the worked-example table. If the
  // rep already has at least one downstream member, the bottom CTA reads
  // "Mint another referral link" instead of "Mint your first…". Defaults
  // to 0 (fall through to first-link copy) so the existing-user fast path
  // doesn't accidentally read "your first" when the network query fails.
  const [networkSize, setNetworkSize] = useState(0);

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
        const [repRes, netRes] = await Promise.all([
          getMyRepAccount({ data: { accessToken, viewAsUserId } }),
          getMyNetwork({ data: { accessToken, viewAsUserId } }).catch(() => ({
            members: [],
          })),
        ]);
        if (cancelled) return;
        setRep(repRes.rep);
        setNetworkSize(netRes.members.length);
      } catch {
        // Non-fatal: economics page renders without rep identity, just less personal.
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authLoading, accessToken]);

  if (authLoading || !loaded) {
    return <Pulse label="Loading economics…" />;
  }

  const name = rep?.displayName ?? "You";

  // v409: every cell in the worked-example table is now COMPUTED from the
  // canonical rep-economics constants. Pinch #12 (cascade=$5,500 vs stated
  // 1% on $250K → real value $2,500) is structurally impossible to ship
  // again — the arithmetic resolves at render time, not at hand-edit time.
  const SPA_AVG_RECOVERY_USD = 5_000;
  const oneDirect = computeDirectScenario(SPA_AVG_RECOVERY_USD);
  const tenDirect = computeDirectScenario(SPA_AVG_RECOVERY_USD * 10);
  const sixtyDirect = computeDirectScenario(SPA_AVG_RECOVERY_USD * 60);
  const mixed = computeMixedScenario({
    directRecoveredUsd: SPA_AVG_RECOVERY_USD * 60,
    cascadeRecoveredUsd: SPA_AVG_RECOVERY_USD * 5 * 10,
  });
  // For the cascade-only row (1 spa your sub-rep introduced):
  // the sub-rep earns the direct slice ($150), the recruiting rep earns
  // the cascade slice ($50). Same recovered dollar, different attribution.
  const oneCascade = computeDirectScenario(SPA_AVG_RECOVERY_USD); // for sub-rep's $150
  const cascadeSliceForMe = SPA_AVG_RECOVERY_USD * CASCADE_COMMISSION_RATE; // $50 to me

  return (
    <Page>
      <Heading>How commissions work</Heading>
      <Lede>
        Of every dollar of revenue Refill recovers for a spa,{" "}
        <strong>{formatRateCents(TOTAL_TAKE_RATE)} flows out as commission</strong>.
        The split is fixed, lifetime, no decay. Once a spa joins through your
        link, you earn on every recovery they bill — forever.
      </Lede>

      <SplitDiagram />

      <SectionHeader
        icon={<TrendingUp className="h-4 w-4" />}
        title={`Worked example — what ${name} sees`}
      />

      <table className="w-full text-[13px] mb-6 border-collapse">
        <thead>
          <tr style={{ background: "#fbfaf7" }}>
            <Th align="left">Scenario</Th>
            <Th align="right">Recovered / mo</Th>
            <Th align="right">Refill</Th>
            <Th align="right">{name} direct</Th>
            <Th align="right">{name} cascade</Th>
          </tr>
        </thead>
        <tbody>
          <Row
            scenario={`1 spa ${name} introduced`}
            recovered={formatUsd0(oneDirect.recoveredUsd)}
            refill={formatUsd0(oneDirect.refillUsd)}
            direct={formatUsd0(oneDirect.directCommissionUsd)}
            cascade="—"
          />
          <Row
            scenario={`1 spa your sub-rep introduced`}
            recovered={formatUsd0(oneCascade.recoveredUsd)}
            refill={formatUsd0(oneCascade.refillUsd)}
            direct={
              <em style={{ color: "#8a9098" }}>
                (sub-rep gets {formatUsd0(oneCascade.directCommissionUsd)})
              </em>
            }
            cascade={formatUsd0(cascadeSliceForMe)}
          />
          <Row
            scenario={`10 spas ${name} introduced`}
            recovered={formatUsd0(tenDirect.recoveredUsd)}
            refill={formatUsd0(tenDirect.refillUsd)}
            direct={formatUsd0(tenDirect.directCommissionUsd)}
            cascade="—"
          />
          <Row
            scenario={`60 spas ${name} introduced`}
            recovered={formatUsd0(sixtyDirect.recoveredUsd)}
            refill={formatUsd0(sixtyDirect.refillUsd)}
            direct={formatUsd0(sixtyDirect.directCommissionUsd)}
            cascade="—"
          />
          <Row
            scenario="60 direct + 5 sub-reps each w/ 10 spas"
            recovered={formatUsd0(mixed.totalRecoveredUsd)}
            refill={formatUsd0(mixed.refillUsd)}
            direct={formatUsd0(mixed.myDirectCommissionUsd)}
            cascade={formatUsd0(mixed.myCascadeCommissionUsd)}
            highlight
          />
        </tbody>
      </table>

      <p className="text-[13px] leading-[1.6] mb-5" style={{ color: "#5a6068" }}>
        That last row is the unlock to hold in your head:{" "}
        <strong>
          at modest conversion, {name} clears $
          {formatThousandsCeil(mixed.myTotalCommissionUsd)}/month in recurring
          commission
        </strong>
        , lifetime, without ever closing the spa yourself.
      </p>

      <SectionHeader title="The boring rules" icon={<TrendingUp className="h-4 w-4" />} />
      <ul
        className="space-y-2 text-[13px] leading-[1.55] mb-6"
        style={{ color: "#5a6068" }}
      >
        <Bullet>
          <strong>3 levels max</strong> — you + your direct + their direct.
          Beyond 3 drifts toward MLM-shaped optics + dilutes economics. Cap
          stays at 3 for FTC defensibility.
        </Bullet>
        <Bullet>
          <strong>Lifetime, not time-decayed.</strong> The{" "}
          {formatRate(DIRECT_COMMISSION_RATE)} (or{" "}
          {formatRate(CASCADE_COMMISSION_RATE)} cascade) keeps paying as long
          as the spa is on Refill. Motivation stays aligned with the spa&apos;s
          long-run success — same incentive Refill itself has.
        </Bullet>
        <Bullet>
          <strong>Paid monthly via Stripe.</strong> Commissions accrue in your
          ledger; Stripe payout fires when the monthly close runs. You can
          watch the live $$ widget on Network or Commissions in real time
          between closes.
        </Bullet>
        <Bullet>
          <strong>Nothing to chase.</strong> You don&apos;t collect from the spa —
          Refill collects, Refill keeps {formatRateCents(REFILL_TAKE_RATE)},
          your slice flows straight to you.
        </Bullet>
      </ul>

      {/* v405 Pinch #17: state-aware CTA. Once any downstream member exists,
          the "your first" framing rots — the rep has obviously already minted.
          Branch on networkSize so the language tracks reality. */}
      <div
        className="mt-6 pt-5 border-t text-[12px] leading-[1.55]"
        style={{ borderColor: "#f0ebe0", color: "#8a9098" }}
      >
        {networkSize === 0 ? (
          <>
            Ready to start?{" "}
            <Link
              to="/app/rep/referral-links"
              className="font-medium underline-offset-2 hover:underline"
              style={{ color: "#056048" }}
            >
              Mint your first referral link
            </Link>{" "}
            — one tap, share with any spa.
          </>
        ) : (
          <>
            {networkSize} spa{networkSize === 1 ? "" : "s"} in your network
            already.{" "}
            <Link
              to="/app/rep/referral-links"
              className="font-medium underline-offset-2 hover:underline"
              style={{ color: "#056048" }}
            >
              Mint another referral link
            </Link>{" "}
            — same one-tap flow, share with any spa.
          </>
        )}
      </div>
    </Page>
  );
}

function SplitDiagram() {
  // Visual breakdown of TOTAL_TAKE_RATE — three colored bars whose widths
  // are proportional to each tier's share of the take. Labels show the per-
  // dollar cents. v409: bar widths + labels both derived from canonical
  // constants so the diagram self-corrects if the split ever changes.
  const refillPct = (REFILL_TAKE_RATE / TOTAL_TAKE_RATE) * 100;
  const directPct = (DIRECT_COMMISSION_RATE / TOTAL_TAKE_RATE) * 100;
  const cascadePct = (CASCADE_COMMISSION_RATE / TOTAL_TAKE_RATE) * 100;
  return (
    <div
      className="rounded-xl border p-5 mb-7"
      style={{ borderColor: "#e6e2d6", background: "#fbfaf7" }}
    >
      <div
        className="text-[11px] uppercase tracking-wider font-semibold mb-3 text-center"
        style={{ color: "#8a9098" }}
      >
        Every recovered dollar
      </div>
      <div className="flex h-10 rounded-lg overflow-hidden border" style={{ borderColor: "#e6e2d6" }}>
        <SplitBar pct={refillPct}  bg="#056048" label={formatRateCents(REFILL_TAKE_RATE)}        sub="Refill" />
        <SplitBar pct={directPct}  bg="#5b8c7a" label={formatRateCents(DIRECT_COMMISSION_RATE)}  sub="Tier-1 direct" />
        <SplitBar pct={cascadePct} bg="#a3c4b5" label={formatRateCents(CASCADE_COMMISSION_RATE)} sub="Tier-2 cascade" />
      </div>
      <div className="flex justify-between mt-3 text-[12px]" style={{ color: "#5a6068" }}>
        <Block title={`${formatRateCents(REFILL_TAKE_RATE)} Refill`} body="Platform + engine + delivery + support." />
        <Block title={`${formatRateCents(DIRECT_COMMISSION_RATE)} direct`} body="To whoever introduced the spa." />
        <Block title={`${formatRateCents(CASCADE_COMMISSION_RATE)} cascade`} body="To the upstream rep, when their sub-rep introduced the spa." />
      </div>
    </div>
  );
}

function SplitBar({ pct, bg, label, sub }: { pct: number; bg: string; label: string; sub: string }) {
  return (
    <div
      className="flex items-center justify-center font-semibold text-[12px]"
      style={{ width: `${pct}%`, background: bg, color: "#fbfaf7" }}
      title={`${label} · ${sub}`}
    >
      {label}
    </div>
  );
}

function Block({ title, body }: { title: string; body: string }) {
  return (
    <div className="max-w-[10rem]">
      <div className="font-semibold" style={{ color: "#1c2024" }}>
        {title}
      </div>
      <div className="text-[11px] leading-[1.4]" style={{ color: "#8a9098" }}>
        {body}
      </div>
    </div>
  );
}

function Th({
  children,
  align,
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      className="text-[10px] uppercase tracking-wider font-semibold border-b py-2 px-3"
      style={{
        textAlign: align ?? "left",
        color: "#8a9098",
        borderColor: "#e6e2d6",
      }}
    >
      {children}
    </th>
  );
}

function Row({
  scenario,
  recovered,
  refill,
  direct,
  cascade,
  highlight,
}: {
  scenario: string;
  recovered: string;
  refill: string;
  direct: React.ReactNode;
  cascade: string;
  highlight?: boolean;
}) {
  return (
    <tr style={{ background: highlight ? "#f0f5ef" : "transparent" }}>
      <Td>{scenario}</Td>
      <Td align="right" mono>
        {recovered}
      </Td>
      <Td align="right" mono>
        {refill}
      </Td>
      <Td align="right" mono>
        {direct}
      </Td>
      <Td align="right" mono>
        {cascade}
      </Td>
    </tr>
  );
}

function Td({
  children,
  align,
  mono,
}: {
  children: React.ReactNode;
  align?: "left" | "right";
  mono?: boolean;
}) {
  return (
    <td
      className={`py-2.5 px-3 border-b ${mono ? "tabular-nums" : ""}`}
      style={{
        textAlign: align ?? "left",
        color: "#1c2024",
        borderColor: "#f0ebe0",
      }}
    >
      {children}
    </td>
  );
}

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span
        className="mt-1.5 h-1.5 w-1.5 rounded-full flex-shrink-0"
        style={{ background: "#056048" }}
        aria-hidden
      />
      <span>{children}</span>
    </li>
  );
}

// ─── shell ───────────────────────────────────────────────────────────────

function Page({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="min-h-screen px-5 sm:px-8 py-12 sm:py-16"
      style={{ background: "#fbfaf7", color: "#1c2024" }}
    >
      <div className="w-full max-w-3xl mx-auto">
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
    <div className="flex items-center gap-2 mb-3 mt-2">
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
