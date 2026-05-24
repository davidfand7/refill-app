/**
 * /app/rep/network — Phase 2D rep network view.
 *
 * Mirror of the surface from app.lizzie.referral-links.tsx (same shell, same
 * loading/error states). Shows:
 *   1. LiveEarningsCard (top) — realtime sub to emma_recovery_events.
 *   2. Tier-grouped downstream tree (Tier 1 = direct, Tier 2/3 = cascade).
 *
 * Empty state per the 5/29 demo spec — "Here's where your downstream will
 * land" — even when getMyNetwork returns []. Phase 2G seeds Kelly's
 * sub-reps for the demo.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Network, Users } from "lucide-react";

import { useAuth } from "@/lib/auth";
import { LiveEarningsCard } from "@/components/lizzie/LiveEarningsCard";
import {
  getMyNetwork,
  getMyRepAccount,
  type NetworkMember,
  type RepAccountRow,
} from "@/server/rep-platform";

export const Route = createFileRoute("/app/rep/network")({
  component: NetworkPage,
});

function NetworkPage() {
  const { session, loading: authLoading } = useAuth();
  const accessToken = session?.access_token;

  const [rep, setRep] = useState<RepAccountRow | null>(null);
  const [members, setMembers] = useState<NetworkMember[]>([]);
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
        const [repRes, netRes] = await Promise.all([
          getMyRepAccount({ data: { accessToken } }),
          getMyNetwork({ data: { accessToken } }),
        ]);
        if (cancelled) return;
        setRep(repRes.rep);
        setMembers(netRes.members);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Couldn't load your network.",
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
    return <Pulse label="Loading your network…" />;
  }

  if (!accessToken) {
    return (
      <Page>
        <Heading>Your network</Heading>
        <Lede>Sign in to view your rep network.</Lede>
      </Page>
    );
  }

  if (!rep) {
    return (
      <Page>
        <Heading>Your network</Heading>
        <Lede>
          Set up your rep profile to see your downstream tree and live earnings.
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

  const byDepth = groupByDepth(members);

  return (
    <Page>
      <Heading>Your network</Heading>
      <Lede>
        Hi {rep.displayName}. Live earnings track every recovery attributed to
        you across {members.length === 0 ? "your future" : "your"} downstream
        spas. Commissions accrue lifetime, with no decay.
      </Lede>

      <LiveEarningsCard accessToken={accessToken} repUserId={rep.repUserId} />

      <SectionHeader icon={<Network className="h-4 w-4" />} title="Downstream tree" />

      {members.length === 0 ? (
        <EmptyNetwork />
      ) : (
        <div className="space-y-5">
          {[1, 2, 3].map((depth) => {
            const rows = byDepth.get(depth) ?? [];
            if (rows.length === 0) return null;
            return <TierSection key={depth} depth={depth} members={rows} />;
          })}
        </div>
      )}

      <div className="mt-6 pt-4 border-t" style={{ borderColor: "#f0ebe0" }}>
        <p className="text-[13px]" style={{ color: "#8a9098" }}>
          Want to add a sub-rep?{" "}
          <Link
            to="/app/rep/referral-links"
            className="font-medium underline-offset-2 hover:underline"
            style={{ color: "#056048" }}
          >
            Share your referral link
          </Link>{" "}
          — anyone who signs up through it joins your Tier 1.
        </p>
      </div>

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

function groupByDepth(members: NetworkMember[]): Map<number, NetworkMember[]> {
  const map = new Map<number, NetworkMember[]>();
  for (const m of members) {
    const list = map.get(m.depth) ?? [];
    list.push(m);
    map.set(m.depth, list);
  }
  return map;
}

function TierSection({
  depth,
  members,
}: {
  depth: number;
  members: NetworkMember[];
}) {
  const label =
    depth === 1
      ? "Tier 1 · direct"
      : depth === 2
        ? "Tier 2 · through your Tier 1"
        : "Tier 3";
  const split = depth === 1 ? "3%" : depth === 2 ? "1%" : "—";
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
          className="text-[11px] uppercase tracking-wider font-semibold"
          style={{ color: "#5a6068" }}
        >
          {label}
        </div>
        <div
          className="text-[11px] uppercase tracking-wider"
          style={{ color: "#8a9098" }}
        >
          {split} of recovered
        </div>
      </div>
      <ul className="divide-y" style={{ borderColor: "#f0ebe0" }}>
        {members.map((m) => (
          <li
            key={m.repId}
            className="flex items-center justify-between px-4 py-3"
          >
            <div>
              <div
                className="text-[14px] font-medium"
                style={{ color: "#1c2024" }}
              >
                {m.displayName}
              </div>
              {m.businessName && (
                <div className="text-[12px]" style={{ color: "#8a9098" }}>
                  {m.businessName}
                </div>
              )}
            </div>
            <StatusPill status={m.status} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function StatusPill({ status }: { status: NetworkMember["status"] }) {
  const palette =
    status === "active"
      ? { bg: "#e8f3ed", fg: "#056048" }
      : status === "paused"
        ? { bg: "#fdf6e6", fg: "#8a6d10" }
        : { bg: "#fdecec", fg: "#8a1616" };
  return (
    <span
      className="text-[11px] font-semibold uppercase tracking-wide rounded-full px-2.5 py-0.5"
      style={{ background: palette.bg, color: palette.fg }}
    >
      {status}
    </span>
  );
}

function EmptyNetwork() {
  return (
    <div
      className="rounded-lg border p-6 text-center"
      style={{
        borderColor: "#e6e2d6",
        background: "#fbfaf7",
        borderStyle: "dashed",
      }}
    >
      <Users
        className="h-7 w-7 mx-auto mb-3"
        style={{ color: "#8a9098" }}
        aria-hidden
      />
      <div
        className="text-[15px] font-semibold mb-1.5"
        style={{ color: "#1c2024" }}
      >
        You haven't invited anyone yet
      </div>
      <p
        className="text-[13px] leading-[1.55] max-w-md mx-auto"
        style={{ color: "#5a6068" }}
      >
        Mint a referral link and share it. Every rep who signs up through your
        link becomes a Tier 1 — you earn 1% on every recovery they attribute,
        lifetime.
      </p>
    </div>
  );
}

// ─── presentational helpers (mirror app.lizzie.referral-links.tsx) ───────

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
