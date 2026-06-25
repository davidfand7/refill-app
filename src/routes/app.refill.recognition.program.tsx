/**
 * /app/refill/recognition/program — Program Intelligence (Purchase & Rebate
 * Intelligence · Phase 2). Renders the brain's output (program-intel.ts) on the
 * tenant's manufacturer-rewards snapshot: tier progress, the rebates + their
 * status, the dollar-on-it "moves" to unlock them, and the change-feed (the
 * "rules moved under you" detector). The snapshot is a dated manual capture of
 * the real Rejuv ASPIRE dashboard for now; the auto-pull swaps in behind it.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  Target,
  CheckCircle2,
  AlertTriangle,
  Clock,
  TrendingUp,
  Sparkles,
  ArrowRight,
  Camera,
  Gift,
  Tag,
  Users,
  ShieldAlert,
  ShieldCheck,
  Calculator,
} from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { RecognitionTabs } from "@/components/refill/RecognitionTabs";
import { supabase } from "@/integrations/supabase/client";
import { useTenantMembership } from "@/lib/use-tenant-membership";
import { getProgramIntelFn, type ProgramIntel } from "@/server/program-intel.functions";
import {
  moveHeadline,
  maintenanceHeadline,
  changeHeadline,
  type RebateProgram,
  type ProgramSnapshot,
  type MaintenanceMove,
  type MoveWorth,
} from "@/lib/program-intel";
import { computeVerdict, formatAge, tierLabel } from "@/lib/connection-health";
import { resolveProduct, type ProductKind } from "@/lib/product-manufacturer-map";

/** Friendly cohort word for a treatment kind. */
function kindWord(kind: ProductKind | null): string {
  if (kind === "toxin") return "tox";
  if (kind === "filler") return "filler";
  if (kind === "biostimulator") return "biostimulator";
  return "due";
}

/** The overdue-list deep-link kind — only the three countable cohorts. */
function cohortKindOf(move: { product: string; productLabel: string }):
  | "toxin"
  | "filler"
  | "biostimulator"
  | null {
  const k = resolveProduct(move.product || move.productLabel).kind;
  return k === "toxin" || k === "filler" || k === "biostimulator" ? k : null;
}

export const Route = createFileRoute("/app/refill/recognition/program")({
  component: ProgramPage,
});

function ProgramPage() {
  const membership = useTenantMembership();
  const viewAsUserId = membership.status === "tenant" ? membership.viewAsUserId : undefined;
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [intel, setIntel] = useState<ProgramIntel | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      const { data: sess } = await supabase.auth.getSession();
      setAccessToken(sess.session?.access_token ?? null);
    })();
  }, []);

  useEffect(() => {
    if (!accessToken) return;
    void (async () => {
      setLoading(true);
      try {
        const r = await getProgramIntelFn({ data: { accessToken, viewAsUserId } });
        setIntel(r);
      } catch {
        setIntel(null);
      } finally {
        setLoading(false);
      }
    })();
  }, [accessToken, viewAsUserId]);

  return (
    <div>
      <PageHeader
        eyebrow="Incentives"
        title="Program Intelligence"
        description="Your manufacturer's rewards program — tiers, rebates, and the exact moves to unlock them. The dashboard nobody reads, read for you."
      />
      <RecognitionTabs active="program" />

      <div className="px-6 lg:px-10 py-6 max-w-[860px] mx-auto">
        {loading ? (
          <div className="text-sm text-ink-faint">Reading your program…</div>
        ) : !intel || !intel.captured ? (
          <NotCapturedState />
        ) : (
          <ProgramView intel={intel} />
        )}
      </div>
    </div>
  );
}

function ProgramView({ intel }: { intel: ProgramIntel }) {
  const { snapshot, moves, changes } = intel;
  return (
    <div className="space-y-5">
      <NextMoveCallout intel={intel} moves={moves} />
      <FreshnessBanner intel={intel} />
      <TierCard snapshot={snapshot} />
      {snapshot.maintenance && (
        <MaintenanceCard
          maintenance={snapshot.maintenance}
          move={intel.maintenanceMove}
        />
      )}
      <MovesCard intel={intel} moves={moves} />
      <div className="grid grid-cols-1 gap-4">
        {snapshot.rebates.map((r) => (
          <RebateCard key={r.key} r={r} />
        ))}
      </div>
      <PricingCard snapshot={snapshot} />
      <ChangesCard changes={changes} />
    </div>
  );
}

const fmtUsd = (n: number): string =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

/**
 * The signature prices read off the dashboard. Reference-grade (what the
 * manufacturer says you pay) — distinct from the catalog's verified cost, which
 * is what actually drives margin. Cross-links to the verified-pricing lane where
 * a "Your Price" screenshot becomes the real per-unit cost (with the ÷box GIGO
 * check). Hidden when the capture had no pricing panel.
 */
function PricingCard({ snapshot }: { snapshot: ProgramSnapshot }) {
  if (snapshot.pricing.length === 0) return null;
  return (
    <div className="rounded-2xl border border-rule bg-white p-5">
      <div className="flex items-center gap-2 text-sm font-semibold text-ink">
        <Tag className="h-4 w-4 text-ink-faint" />
        Signature pricing
        <span className="rounded-full bg-paper px-2 py-0.5 text-[10.5px] font-semibold text-ink-soft">
          {snapshot.pricing.length}
        </span>
      </div>
      <p className="mt-1 text-[11.5px] leading-relaxed text-ink-faint">
        What your rewards dashboard lists you pay. To turn these into the verified per-unit cost that
        drives your margin, set them in catalog pricing.
      </p>
      <div className="mt-3 divide-y divide-rule/70">
        {snapshot.pricing.map((p, i) => (
          <div key={`${p.product}-${i}`} className="flex items-center justify-between gap-3 py-1.5">
            <span className="text-[13px] text-ink-soft">{p.label}</span>
            <span className="text-[13px] font-semibold tabular-nums text-ink">
              {fmtUsd(p.unitPriceUsd)}
            </span>
          </div>
        ))}
      </div>
      <Link
        to="/app/refill/catalog/verified-pricing"
        className="mt-3 inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-emerald-ink hover:underline"
      >
        Set these as your catalog cost
        <ArrowRight className="h-3.5 w-3.5" />
      </Link>
    </div>
  );
}

/**
 * The "What's it worth?" reveal — a calculation button that turns a move into a
 * dollar figure on the bottom line. Offensive (rebate) = $ to gain; defensive
 * (maintenance) = $ at risk. Both ride on the spa's REAL trailing-365d spend ×
 * the rebate %, so the number is grounded, not modeled. Renders nothing when the
 * worth can't be computed honestly (no captured volume / no rebate %).
 */
function WorthReveal({ worth }: { worth: MoveWorth | null }) {
  const [open, setOpen] = useState(false);
  if (!worth) return null;
  const amber = worth.defensive;
  const accent = amber ? "text-amber" : "text-emerald-ink";
  const ring = amber ? "border-amber/30 bg-amber-soft/30" : "border-emerald-ink/20 bg-emerald-soft/30";
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[12px] font-semibold ${ring} ${accent} hover:opacity-90 transition`}
      >
        <Calculator className="h-3.5 w-3.5" />
        {open ? "Hide the math" : "What's it worth?"}
      </button>
      {open && (
        <div className={`mt-2 rounded-xl border ${ring} p-3`}>
          <div className={`text-[16px] font-bold ${accent}`}>
            ~${worth.rebateValueUsd.toLocaleString()}/yr {amber ? "at risk" : "back"}
          </div>
          <div className="mt-0.5 text-[12px] leading-snug text-ink-soft">
            {worth.rebatePct}% {amber ? "rebate rides on" : "back on"} your{" "}
            <span className="font-semibold text-ink">
              ${worth.annualVolumeUsd.toLocaleString()}/yr
            </span>{" "}
            of volume{amber ? "" : " at your current pace"}.
          </div>
          {worth.costToReachUsd != null && (
            <div className="mt-1 text-[12px] leading-snug text-ink-soft">
              One-time to close the gap: ~
              <span className="font-semibold text-ink">
                ${worth.costToReachUsd.toLocaleString()}
              </span>{" "}
              in product you&apos;ll use anyway.
            </div>
          )}
          {worth.caveat && (
            <div className="mt-1.5 text-[11px] leading-snug text-ink-faint">{worth.caveat}</div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The landing callout — always tells the owner the next step. States, in order:
 *   ① a rebate move is within reach → the dollar-on-it action + a door to act on it
 *   ①ᴹ no rebate move, but the spa is short of its tier-MAINTENANCE floor →
 *      the defensive move ("earn N more points by <date> → keep your pricing")
 *   ② captured, but no move to chase (achieved / blocked) → "put your earned units to work"
 *   ③ no capture yet → handled by NotCapturedState (shown instead of ProgramView)
 * Rebate-move-first is deliberate (the established dollar-on-it hero); maintenance
 * is the next priority when no rebate move is live. Tunable if a deadline should
 * ever pre-empt a rebate.
 */
function NextMoveCallout({ intel, moves }: { intel: ProgramIntel; moves: ProgramIntel["moves"] }) {
  if (moves.length > 0) {
    const top = moves[0];
    const cohort = top.lapsedInCohort;
    const cohortKind = cohortKindOf(top);
    const word = kindWord(resolveProduct(top.product || top.productLabel).kind);
    const hasCohort = cohort != null && cohort > 0 && cohortKind != null;
    // Inline count = "just show me the list"; CTA = "recall" → lands pre-selected.
    const seeSearch = { overdue: "1" as const, kind: cohortKind ?? undefined };
    const recallSearch = { ...seeSearch, preselect: "overdue" as const };
    return (
      <div className="rounded-2xl border border-emerald-ink/30 bg-emerald-soft/50 p-5">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-emerald-ink">
          <Target className="h-3.5 w-3.5" />
          Your next move
        </div>
        <p className="mt-2 text-[15px] font-semibold leading-snug text-ink">{moveHeadline(top)}</p>
        {hasCohort && (
          <p className="mt-1.5 text-[13px] leading-snug text-ink-soft">
            You have{" "}
            <Link
              to="/app/refill/patients"
              search={seeSearch}
              className="font-bold text-emerald-ink underline decoration-emerald-ink/30 underline-offset-2 hover:decoration-emerald-ink"
            >
              {cohort!.toLocaleString()} {word} {cohort === 1 ? "patient" : "patients"}
            </Link>{" "}
            due to come back — recall them and those visits count toward this rebate <em>and</em>{" "}
            recover the patient.
          </p>
        )}
        {moves.length > 1 && (
          <p className="mt-1 text-[12px] text-ink-soft">
            +{moves.length - 1} more {moves.length - 1 === 1 ? "move" : "moves"} below.
          </p>
        )}
        <WorthReveal worth={top.worth} />
        {hasCohort ? (
          <Link
            to="/app/refill/patients"
            search={recallSearch}
            className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-emerald px-4 py-2 text-[13px] font-semibold text-paper shadow-sm hover:opacity-95 transition"
          >
            <Users className="h-3.5 w-3.5" />
            See &amp; recall these patients
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        ) : (
          <Link
            to="/app/refill/recognition/offers"
            className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-emerald px-4 py-2 text-[13px] font-semibold text-paper shadow-sm hover:opacity-95 transition"
          >
            <Gift className="h-3.5 w-3.5" />
            Set up a recall offer
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        )}
      </div>
    );
  }

  // ①ᴹ No rebate move to chase, but the spa is BELOW its tier-maintenance floor.
  // This is the defensive flywheel: don't lose your tier (and its pricing) — the
  // points come from any recall, so the cohort is the whole overdue book.
  if (intel.maintenanceMove) {
    return <MaintenanceCallout move={intel.maintenanceMove} />;
  }

  // ②b No rebate trackers in this capture at all — don't claim "maxed" (they
  // weren't on the screenshot). Nudge to capture the rebate page so moves can
  // surface. Honest: absence of data ≠ nothing to do.
  if (intel.snapshot.rebates.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-emerald/40 bg-emerald-soft/20 p-5">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-emerald-ink">
          <Target className="h-3.5 w-3.5" />
          One more capture unlocks your moves
        </div>
        <p className="mt-2 text-[14px] leading-snug text-ink-soft">
          This capture has your tier and pricing, but no <strong>rebate trackers</strong> yet —
          they live on your portal&apos;s rebate/tracker tab. Capture that screen and we&apos;ll turn
          it into the exact &ldquo;buy/treat N more to unlock the rebate&rdquo; moves, right here.
        </p>
        <Link
          to="/app/refill/settings/manufacturers"
          hash="capture"
          className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-emerald px-4 py-2 text-[13px] font-semibold text-paper shadow-sm hover:opacity-95 transition"
        >
          <Camera className="h-3.5 w-3.5" />
          Capture your rebate trackers
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    );
  }

  // ②c A rebate IS in progress but emits no buy-N-units move — e.g. a
  // points-maintenance threshold ("maintain 20 pts") rather than a purchase
  // requirement. Don't call that "maxed" (it's live); show its honest status.
  const inProgress = intel.snapshot.rebates.filter((r) => r.status === "in_progress");
  if (inProgress.length > 0) {
    return (
      <div className="rounded-2xl border border-rule bg-paper/40 p-5">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
          <Clock className="h-3.5 w-3.5 text-ink-soft" />
          On track — nothing to buy toward it right now
        </div>
        <p className="mt-2 text-[14px] leading-snug text-ink-soft">
          {inProgress.length === 1 ? "Your " : "Your "}
          {inProgress.map((r) => r.label).join(" and ")}{" "}
          {inProgress.length === 1 ? "is" : "are"} in progress.
          {inProgress.find((r) => r.note) && (
            <> {inProgress.find((r) => r.note)?.note}</>
          )}{" "}
          There&apos;s no unit to buy toward it yet — keep doing what you&apos;re doing, and the
          moment a purchase move would help, it shows up here with the exact units.
        </p>
        <Link
          to="/app/refill/recognition/inventory"
          className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-emerald/40 bg-white px-4 py-2 text-[13px] font-semibold text-emerald-ink shadow-sm hover:bg-emerald-soft/40 transition"
        >
          <ArrowRight className="h-3.5 w-3.5" />
          Put your earned units to work
        </Link>
      </div>
    );
  }

  // ② Captured rebates, all secured / blocked — genuinely maxed for now; point
  // them to deploying the units they've earned.
  return (
    <div className="rounded-2xl border border-rule bg-paper/40 p-5">
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-ink" />
        You&apos;re maxed on this program for now
      </div>
      <p className="mt-2 text-[14px] leading-snug text-ink-soft">
        No rebate to chase right now — you&apos;ve secured what&apos;s in reach. Put the units
        you&apos;ve earned to work for specific patients, and we&apos;ll surface the next move here
        the moment one opens up.
      </p>
      <Link
        to="/app/refill/recognition/inventory"
        className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-emerald/40 bg-white px-4 py-2 text-[13px] font-semibold text-emerald-ink shadow-sm hover:bg-emerald-soft/40 transition"
      >
        <ArrowRight className="h-3.5 w-3.5" />
        Put your earned units to work
      </Link>
    </div>
  );
}

/**
 * ①ᴹ The DEFENSIVE next-move callout — the spa is short of its tier-maintenance
 * floor. Framed as retention ("keep your pricing"), not acquisition. The points
 * come from ANY points-earning recall, so the cohort is the whole overdue book
 * (no kind filter) and the CTA lands on the recall list pre-selected.
 */
function MaintenanceCallout({ move }: { move: MaintenanceMove }) {
  const cohort = move.lapsedInCohort;
  const hasCohort = cohort != null && cohort > 0;
  return (
    <div className="rounded-2xl border border-amber/40 bg-amber-soft/50 p-5">
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-amber">
        <ShieldAlert className="h-3.5 w-3.5" />
        Keep your {move.tierAtRisk ?? "tier"} — points maintenance
      </div>
      <p className="mt-2 text-[15px] font-semibold leading-snug text-ink">{maintenanceHeadline(move)}</p>
      {move.consequence && (
        <p className="mt-1 text-[12.5px] leading-snug text-ink-soft">
          Fall short and you {move.consequence.toLowerCase().startsWith("drop") ? "" : "risk "}
          {move.consequence}.
        </p>
      )}
      {hasCohort && (
        <p className="mt-1.5 text-[13px] leading-snug text-ink-soft">
          You have{" "}
          <Link
            to="/app/refill/patients"
            search={{ overdue: "1" }}
            className="font-bold text-amber underline decoration-amber/30 underline-offset-2 hover:decoration-amber"
          >
            {cohort!.toLocaleString()} {cohort === 1 ? "patient" : "patients"}
          </Link>{" "}
          due to come back — every recall earns points and defends your tier.
        </p>
      )}
      <WorthReveal worth={move.worth} />
      {hasCohort ? (
        <Link
          to="/app/refill/patients"
          search={{ overdue: "1", preselect: "overdue" }}
          className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-amber px-4 py-2 text-[13px] font-semibold text-paper shadow-sm hover:opacity-95 transition"
        >
          <Users className="h-3.5 w-3.5" />
          See &amp; recall to hold your tier
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      ) : (
        <Link
          to="/app/refill/recognition/offers"
          className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-amber px-4 py-2 text-[13px] font-semibold text-paper shadow-sm hover:opacity-95 transition"
        >
          <Gift className="h-3.5 w-3.5" />
          Set up a recall offer
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      )}
    </div>
  );
}

/**
 * The body card for a tier-maintenance requirement — the retention equivalent of
 * a RebateCard. Renders whenever the snapshot HAS a maintenance requirement: amber
 * "at risk" with a points-to-floor bar when short (move present), emerald "secured"
 * when at/above the floor (no move). Honest either way — never a false alarm.
 */
function MaintenanceCard({
  maintenance,
  move,
}: {
  maintenance: NonNullable<ProgramSnapshot["maintenance"]>;
  move: MaintenanceMove | null;
}) {
  const atRisk = move != null;
  const req = maintenance.pointsRequired;
  const cur = maintenance.pointsCurrent;
  const pct = req > 0 ? Math.min(100, Math.round((cur / req) * 100)) : 100;
  const tone = atRisk
    ? { border: "border-amber/30", bg: "bg-amber-soft/40", fg: "text-amber", bar: "bg-amber", Icon: ShieldAlert, label: "Action needed" }
    : { border: "border-emerald-ink/25", bg: "bg-emerald-soft/40", fg: "text-emerald-ink", bar: "bg-emerald-ink/80", Icon: ShieldCheck, label: "Secured" };
  const Icon = tone.Icon;
  return (
    <div className={`rounded-2xl border ${tone.border} ${tone.bg} p-5`}>
      <div className="flex items-center gap-2">
        <Icon className={`h-4 w-4 ${tone.fg}`} />
        <div className="text-sm font-semibold text-ink">
          Keep your {maintenance.tierAtRisk ?? "tier"}
        </div>
        <span className={`ml-auto rounded-full bg-white/70 px-2 py-0.5 text-[10.5px] font-semibold ${tone.fg}`}>
          {tone.label}
        </span>
      </div>
      <p className="mt-2 text-[12px] leading-relaxed text-ink-soft">
        {atRisk ? (
          <>
            You&apos;re <span className="font-semibold text-ink">{move!.pointsShort.toLocaleString()} points</span> short
            of the floor to hold this tier
            {maintenance.deadlineLabel ? <> by <span className="font-semibold text-ink">{maintenance.deadlineLabel}</span></> : null}.
            {maintenance.consequence ? <> Fall short → {maintenance.consequence}.</> : null}
          </>
        ) : (
          <>
            You&apos;re at or above the floor to hold this tier
            {maintenance.deadlineLabel ? <> through <span className="font-semibold text-ink">{maintenance.deadlineLabel}</span></> : null}.
            Nothing to do — we&apos;ll flag it here if you slip below.
          </>
        )}
      </p>
      <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-white/70">
        <div className={`h-full rounded-full ${tone.bar} transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1.5 text-[11px] text-ink-faint tabular-nums">
        {cur.toLocaleString()} / {req.toLocaleString()} points
        {maintenance.deadlineLabel ? ` · by ${maintenance.deadlineLabel}` : ""}
      </div>
      <WorthReveal worth={move?.worth ?? null} />
    </div>
  );
}

/**
 * ③ The "out" when there's no real capture for this tenant yet — instead of
 * dressing the seed placeholder as their own standing, invite the capture that
 * lights the whole tab up. Deep-links to the capture modal (hash=capture).
 */
function NotCapturedState() {
  return (
    <div className="rounded-2xl border border-dashed border-emerald/40 bg-emerald-soft/20 p-10 text-center">
      <div className="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-soft">
        <Sparkles className="h-6 w-6 text-emerald" />
      </div>
      <h2 className="mt-3 text-lg font-semibold text-ink">No program standing captured yet</h2>
      <p className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-ink-soft">
        Capture your manufacturer rewards dashboard and your tier, rebate trackers, and the exact
        moves to unlock them land here — plus a “what changed” alert every time the program shifts
        under you. The auth-walled numbers no spreadsheet can reach, read for you.
      </p>
      <Link
        to="/app/refill/settings/manufacturers"
        hash="capture"
        className="mt-5 inline-flex items-center gap-2 rounded-lg bg-emerald px-5 py-2.5 text-sm font-semibold text-paper shadow-sm hover:opacity-95 transition"
      >
        <Camera className="h-4 w-4" />
        Capture rewards snapshot
        <ArrowRight className="h-4 w-4" />
      </Link>
    </div>
  );
}

function FreshnessBanner({ intel }: { intel: ProgramIntel }) {
  const live = intel.source === "portal_pull";
  // Honest freshness via the Connection Health spine: a program snapshot is the
  // "snapshot" tier — it ages into "stale" after ~2 weeks but never hard-breaks
  // on silence. This stops an old capture from quietly reading as current.
  const capturedMs = new Date(intel.capturedOn + "T00:00:00").getTime();
  const { severity, ageMs } = computeVerdict({
    tier: "snapshot",
    connected: true,
    lastEventAtMs: Number.isFinite(capturedMs) ? capturedMs : null,
    nowMs: Date.now(),
  });
  const stale = severity === "warn"; // snapshot tier never returns "error"
  const tone = stale
    ? { box: "border-amber/40 bg-amber-soft/40", icon: "text-amber", pill: "bg-amber-soft text-amber" }
    : { box: "border-rule bg-paper/40", icon: "text-ink-faint", pill: "bg-emerald-soft text-emerald-ink" };
  return (
    <div>
      <div
        className={`flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border ${tone.box} px-4 py-2.5 text-[12px] text-ink-soft`}
      >
        <Clock className={`h-3.5 w-3.5 ${tone.icon}`} />
        <span className="font-semibold capitalize text-ink">{intel.snapshot.manufacturer}</span>
        <span className="text-ink-faint">·</span>
        <span>
          {live ? "Pulled" : "Captured"} {formatAge(ageMs)}
        </span>
        <span className="text-ink-faint hidden sm:inline">·</span>
        <span className="text-ink-faint hidden sm:inline">{tierLabel("snapshot")}</span>
        <span className={`ml-auto rounded-full ${tone.pill} px-2 py-0.5 text-[10.5px] font-semibold`}>
          {stale ? "May be out of date" : live ? "Fresh" : "Manual capture"}
          {!live && !stale ? " · auto-pull coming" : ""}
        </span>
      </div>
      {stale && (
        <p className="mt-1.5 px-1 text-[11px] leading-snug text-amber">
          This snapshot is {formatAge(ageMs)} old — your manufacturer may have moved a tier,
          threshold, or price since. Treat these as your last known numbers until it refreshes
          {live ? "" : " (auto-pull is coming)"}.
        </p>
      )}
    </div>
  );
}

function TierCard({ snapshot }: { snapshot: ProgramSnapshot }) {
  const idx = snapshot.tiers.findIndex((t) => t.name === snapshot.currentTier);
  const next = idx >= 0 ? snapshot.tiers[idx + 1] ?? null : null;
  const target = next?.minPoints ?? null;
  const cur = snapshot.pointsCurrent ?? 0;
  const pct = target ? Math.min(100, Math.round((cur / target) * 100)) : 100;
  return (
    <div className="rounded-2xl border border-rule bg-white p-5">
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
        <TrendingUp className="h-3.5 w-3.5" />
        Membership level
      </div>
      <div className="mt-2 flex items-end justify-between">
        <div className="text-2xl font-bold text-ink">{snapshot.currentTier ?? "—"}</div>
        {next && (
          <div className="text-[12px] text-ink-faint">
            Next: <span className="font-semibold text-ink-soft">{next.name}</span>
          </div>
        )}
      </div>
      {target && (
        <>
          <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-paper">
            <div
              className="h-full rounded-full bg-emerald-ink/80 transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="mt-1.5 text-[11px] text-ink-faint tabular-nums">
            {cur.toLocaleString()} / {target.toLocaleString()} points to {next?.name}
          </div>
        </>
      )}
    </div>
  );
}

function MovesCard({ intel, moves }: { intel: ProgramIntel; moves: ProgramIntel["moves"] }) {
  const blocked = intel.snapshot.rebates.filter((r) => r.status === "not_eligible");
  const secured = intel.snapshot.rebates.filter((r) => r.status === "achieved");
  return (
    <div className="rounded-2xl border border-rule bg-white p-5">
      <div className="flex items-center gap-2 text-sm font-semibold text-ink">
        <Target className="h-4 w-4 text-emerald-ink" />
        Your moves
        {moves.length > 0 && (
          <span className="rounded-full bg-emerald-soft px-2 py-0.5 text-[10.5px] font-semibold text-emerald-ink">
            {moves.length}
          </span>
        )}
      </div>

      {moves.length > 0 ? (
        <div className="mt-3 space-y-2">
          {moves.map((m, i) => {
            const ck = cohortKindOf(m);
            const cohort = m.lapsedInCohort;
            return (
              <div
                key={`${m.rebateKey}-${m.product}-${i}`}
                className="flex items-start gap-3 rounded-xl border border-emerald-ink/20 bg-emerald-soft/40 px-3 py-2.5"
              >
                <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-emerald-ink" />
                <div>
                  <div className="text-[13px] text-ink">{moveHeadline(m)}</div>
                  {cohort != null && cohort > 0 && ck && (
                    <Link
                      to="/app/refill/patients"
                      search={{ overdue: "1", kind: ck }}
                      className="mt-0.5 inline-block text-[11.5px] text-emerald-ink underline decoration-emerald-ink/30 underline-offset-2 hover:decoration-emerald-ink"
                    >
                      {cohort.toLocaleString()} {kindWord(resolveProduct(m.product || m.productLabel).kind)}{" "}
                      {cohort === 1 ? "patient" : "patients"} due to recall toward it →
                    </Link>
                  )}
                  <WorthReveal worth={m.worth} />
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="mt-3 rounded-xl bg-paper/50 px-4 py-3 text-[12.5px] leading-relaxed text-ink-soft">
          <span className="font-semibold text-ink">No moves to chase right now — and that&apos;s the point.</span>{" "}
          {secured.length > 0 && (
            <>You&apos;ve already secured {secured.map((r) => `the ${r.rebatePct}% ${r.label}`).join(" and ")}.{" "}</>
          )}
          {blocked.length > 0 && (
            <>The {blocked.map((r) => r.label).join(" and ")} is blocked this quarter (see below).{" "}</>
          )}
          We won&apos;t nudge you to buy product you don&apos;t need — the moment a rebate
          comes within reach, the move shows up here with the exact units.
        </div>
      )}
    </div>
  );
}

function RebateCard({ r }: { r: RebateProgram }) {
  const tone =
    r.status === "achieved"
      ? { bg: "bg-emerald-soft/40", border: "border-emerald-ink/25", fg: "text-emerald-ink", Icon: CheckCircle2, label: `${r.rebatePct}% secured` }
      : r.status === "not_eligible"
        ? { bg: "bg-amber-soft/50", border: "border-amber/30", fg: "text-amber", Icon: AlertTriangle, label: "Not eligible" }
        : { bg: "bg-white", border: "border-rule", fg: "text-ink-soft", Icon: Sparkles, label: "In progress" };
  const Icon = tone.Icon;
  return (
    <div className={`rounded-2xl border ${tone.border} ${tone.bg} p-5`}>
      <div className="flex items-center gap-2">
        <Icon className={`h-4 w-4 ${tone.fg}`} />
        <div className="text-sm font-semibold text-ink">{r.label}</div>
        <span className={`ml-auto rounded-full bg-white/70 px-2 py-0.5 text-[10.5px] font-semibold ${tone.fg}`}>
          {tone.label}
        </span>
      </div>
      {r.note && <p className="mt-2 text-[12px] leading-relaxed text-ink-soft">{r.note}</p>}
      {r.requirements.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {r.requirements.map((q, i) => {
            const met = q.current >= q.required;
            return (
              <span
                key={`${q.label}-${i}`}
                className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] tabular-nums ${
                  met
                    ? "border-emerald-ink/20 bg-emerald-soft/50 text-emerald-ink"
                    : "border-rule bg-white text-ink-faint"
                }`}
              >
                {met && <CheckCircle2 className="h-3 w-3" />}
                <span className="font-medium text-ink-soft">{q.label}</span>
                <span>
                  {q.current}/{q.required}
                </span>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ChangesCard({ changes }: { changes: ProgramIntel["changes"] }) {
  return (
    <div className="rounded-2xl border border-rule bg-white p-5">
      <div className="flex items-center gap-2 text-sm font-semibold text-ink">
        <Clock className="h-4 w-4 text-ink-faint" />
        What changed
        {changes.length > 0 && (
          <span className="rounded-full bg-amber-soft px-2 py-0.5 text-[10.5px] font-semibold text-amber">
            {changes.length}
          </span>
        )}
      </div>
      {changes.length > 0 ? (
        <ul className="mt-3 space-y-1.5">
          {changes.map((c, i) => (
            <li
              key={i}
              className="rounded-xl border border-amber/25 bg-amber-soft/40 px-3 py-2 text-[12.5px] text-ink"
            >
              {changeHeadline(c)}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-[12.5px] leading-relaxed text-ink-soft">
          Nothing&apos;s changed yet — this is your first snapshot. We capture the program
          daily; the moment your manufacturer moves a threshold, a price, or a tier,
          you&apos;ll see exactly what changed and how it hits you, right here.
        </p>
      )}
    </div>
  );
}
