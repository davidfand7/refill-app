/**
 * /app/admin/arbiter — The Impartial Arbiter (v2.99). Admin-only.
 *
 * The crown-jewel data product, internal-first: pool every Smart-A/B arm across
 * ALL spas by product + offer structure and let the bandit say which structure
 * books best — "$65 off books 1.7× the $50 off across N spas, 92% confident."
 * Spa identity masked (count only); no patient data. This is the pitch-deck /
 * partnership-leverage asset — the impartiality (the market votes, an AI
 * measures, SmartSpa just reports) is what makes it credible to manufacturers.
 */

import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { PageHeader } from "@/components/PageHeader";
import { supabase } from "@/integrations/supabase/client";
import { getArbiterVerdicts, type ArbiterProductVerdict } from "@/server/smart-ab.functions";
import { liftPhrase } from "@/lib/smart-ab";

export const Route = createFileRoute("/app/admin/arbiter")({
  component: ArbiterPage,
});

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

function ArbiterPage() {
  const [rows, setRows] = useState<ArbiterProductVerdict[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token;
        if (!token) {
          setError("Please sign in.");
          return;
        }
        const r = await getArbiterVerdicts({ data: { accessToken: token } });
        setRows(r);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't load.");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div>
      <PageHeader
        eyebrow="Admin · Impartial"
        title="Promo Performance Arbiter"
        description="Which offer structure books best, pooled across every spa and decided by real customer bookings — measured by an impartial AI bandit. Spa identity is masked; no patient data. Internal asset (pitch-deck + partnership leverage)."
      />

      <div className="mx-auto max-w-3xl px-4 lg:px-8 py-6 space-y-5">
        {loading ? (
          <p className="text-sm text-ink-soft">Pooling A/B data across spas…</p>
        ) : error ? (
          <div className="rounded-xl border border-rose/30 bg-rose-soft p-4 text-sm text-rose">{error}</div>
        ) : rows.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-rule bg-white/50 p-8 text-center">
            <p className="text-sm font-semibold text-ink">No multi-version data yet</p>
            <p className="mt-1 text-[13px] text-ink-soft max-w-md mx-auto">
              A product shows here once at least two offer structures have run as A/B
              variants (across any spas). As Smart-A/B tests accrue bookings, the
              impartial verdict fills in here.
            </p>
          </div>
        ) : (
          rows.map((p) => <ArbiterCard key={p.product} p={p} />)
        )}
      </div>
    </div>
  );
}

function ArbiterCard({ p }: { p: ArbiterProductVerdict }) {
  const v = p.verdict;
  const maxRate = Math.max(0.001, ...v.arms.map((a) => a.rate));
  const winnerId = v.best?.id ?? null;
  const arms = [...v.arms].sort((a, b) => b.winProb - a.winProb);

  return (
    <div className="overflow-hidden rounded-2xl border border-rule bg-white shadow-sm">
      <div
        className="px-5 py-4 text-white"
        style={{ background: "linear-gradient(120deg,#0a6b50,#04412f)" }}
      >
        <div className="text-[10.5px] font-bold uppercase tracking-[0.12em] opacity-80">
          SmartSpa · Promo Performance · Impartial
        </div>
        <div className="mt-1 text-[17px] font-bold">
          {titleCase(p.product)} — which offer books best?
        </div>
        <div className="mt-0.5 text-[12px] opacity-85">
          {p.manufacturer ? `${titleCase(p.manufacturer)} · ` : ""}
          across {p.spaCount} spa{p.spaCount === 1 ? "" : "s"} ·{" "}
          {v.totalImpressions.toLocaleString()} patients reached · {v.totalConversions.toLocaleString()} booked
        </div>
      </div>

      <div className="px-5 py-4">
        {v.best && (
          <div className="mb-4 flex items-start gap-3 rounded-xl border border-emerald-ink/20 bg-emerald-soft px-4 py-3">
            <span className="text-[20px] leading-none">🏆</span>
            <div>
              <div className="text-[14px] font-bold text-ink">{v.best.label} wins</div>
              <div className="mt-0.5 text-[12.5px] text-ink-soft">
                It {liftPhrase(v.lift)} than the runner-up. An impartial AI bandit measured it at
                the point of booking — <b className="text-emerald-ink">{(v.confidence * 100).toFixed(0)}% confidence</b>.
              </div>
            </div>
          </div>
        )}

        <div className="space-y-2">
          {arms.map((a) => {
            const isWin = a.id === winnerId;
            return (
              <div key={a.id} className="grid grid-cols-[120px_1fr_92px] items-center gap-3">
                <span className={`text-[12.5px] font-semibold truncate ${isWin ? "text-emerald-ink" : "text-ink-soft"}`}>
                  {a.label}
                </span>
                <div className="h-2.5 rounded-full bg-rule overflow-hidden">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.round((a.rate / maxRate) * 100)}%`,
                      background: isWin ? "#056048" : "#cdd0cb",
                    }}
                  />
                </div>
                <span className="text-[11.5px] text-ink-soft text-right tabular-nums">
                  {(a.rate * 100).toFixed(1)}% · {(a.winProb * 100).toFixed(0)}%
                </span>
              </div>
            );
          })}
        </div>

        <div className="mt-4 flex items-start gap-2.5 border-t border-rule pt-3">
          <span
            className="flex h-7 w-7 flex-none items-center justify-center rounded-lg text-[11px] font-extrabold"
            style={{ background: "#f3eefb", color: "#5b3a86" }}
          >
            AI
          </span>
          <p className="text-[12px] leading-relaxed text-ink-soft">
            <b style={{ color: "#5b3a86" }}>Why this is trustworthy:</b> SmartSpa didn&rsquo;t choose.
            The spa owner didn&rsquo;t choose. <b>Patients chose — by booking</b> — and an impartial AI
            bandit measured it at the point of sale, shifting reach toward the winner as it emerged.
            No platform with a stake in the outcome can credibly say that.
          </p>
        </div>
      </div>
    </div>
  );
}
