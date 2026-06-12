/**
 * /app/refill/recognition/program — Program Intelligence (Purchase & Rebate
 * Intelligence · Phase 2). Renders the brain's output (program-intel.ts) on the
 * tenant's manufacturer-rewards snapshot: tier progress, the rebates + their
 * status, the dollar-on-it "moves" to unlock them, and the change-feed (the
 * "rules moved under you" detector). The snapshot is a dated manual capture of
 * the real Rejuv ASPIRE dashboard for now; the auto-pull swaps in behind it.
 */

import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  Target,
  CheckCircle2,
  AlertTriangle,
  Clock,
  TrendingUp,
  Sparkles,
  ArrowRight,
} from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { RecognitionTabs } from "@/components/refill/RecognitionTabs";
import { supabase } from "@/integrations/supabase/client";
import { useTenantMembership } from "@/lib/use-tenant-membership";
import { getProgramIntelFn, type ProgramIntel } from "@/server/program-intel.functions";
import {
  moveHeadline,
  changeHeadline,
  type RebateProgram,
  type ProgramSnapshot,
} from "@/lib/program-intel";

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
        eyebrow="Recognition"
        title="Program Intelligence"
        description="Your manufacturer's rewards program — tiers, rebates, and the exact moves to unlock them. The dashboard nobody reads, read for you."
      />
      <RecognitionTabs active="program" />

      <div className="px-6 lg:px-10 py-6 max-w-[860px] mx-auto">
        {loading ? (
          <div className="text-sm text-ink-faint">Reading your program…</div>
        ) : !intel ? (
          <div className="rounded-2xl border border-dashed border-rule bg-paper/30 p-10 text-center text-sm text-ink-soft">
            No program snapshot yet. Once your manufacturer portal is connected, your
            tiers, rebates, and pricing land here automatically.
          </div>
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
      <FreshnessBanner intel={intel} />
      <TierCard snapshot={snapshot} />
      <MovesCard intel={intel} moves={moves} />
      <div className="grid grid-cols-1 gap-4">
        {snapshot.rebates.map((r) => (
          <RebateCard key={r.key} r={r} />
        ))}
      </div>
      <ChangesCard changes={changes} />
    </div>
  );
}

function FreshnessBanner({ intel }: { intel: ProgramIntel }) {
  const date = new Date(intel.capturedOn + "T00:00:00").toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const live = intel.source === "portal_pull";
  return (
    <div className="flex items-center gap-2 rounded-xl border border-rule bg-paper/40 px-4 py-2.5 text-[12px] text-ink-soft">
      <Clock className="h-3.5 w-3.5 text-ink-faint" />
      <span className="font-semibold capitalize text-ink">{intel.snapshot.manufacturer}</span>
      <span className="text-ink-faint">·</span>
      <span>
        {live ? "Pulled" : "Snapshot captured"} {date}
      </span>
      {!live && (
        <span className="ml-auto rounded-full bg-amber-soft px-2 py-0.5 text-[10.5px] font-semibold text-amber">
          manual capture · auto-pull coming
        </span>
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
          {moves.map((m, i) => (
            <div
              key={`${m.rebateKey}-${m.product}-${i}`}
              className="flex items-start gap-3 rounded-xl border border-emerald-ink/20 bg-emerald-soft/40 px-3 py-2.5"
            >
              <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-emerald-ink" />
              <div className="text-[13px] text-ink">{moveHeadline(m)}</div>
            </div>
          ))}
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
