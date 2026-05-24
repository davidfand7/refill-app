/**
 * /app/rep/promotions/$promotionId — promotion detail (v335).
 *
 * Three sections:
 *   1. Hero header — title · manufacturer · kind · ends-in-N-days
 *   2. Tier ladder — one card per PromotionBuyInTier with code, label,
 *      volume range, pricing (discount or flat-rate), physical-goods bundle,
 *      rewards credit. The structural transparency of the promo.
 *   3. Eligible accounts — filtered by rep_assignment matching the promo's
 *      manufacturer. Each row: account name + current tier in this
 *      manufacturer's program + contact info. No blast composer yet (v336).
 *
 * Concurrent promos (when this is one of N — e.g. the two Evolus 2026-Q2
 * promos cross-reference each other) surface as a callout linking back to
 * the other promo's detail page.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  ArrowLeft,
  ArrowRight,
  Award,
  Building2,
  Calendar,
  ChevronRight,
  ExternalLink,
  Gift,
  Heart,
  Layers,
  Loader2,
  Mail,
  MapPin,
  MessageSquare,
  Phone,
  Quote,
  RefreshCw,
  Sparkles,
  Tag,
  Users,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { supabase } from "@/integrations/supabase/client";
import {
  getPromotionDetail,
  draftPromoBlast,
  sendPromoBlast,
  listPromoOutreachStates,
  listPromoInterestSignals,
  type PromoDetail,
  type PromoEligibleAccount,
  type AccountOutreachState,
  type PromoInterestSignal,
} from "@/server/promotions.functions";
import {
  getSpaAggregatesForReps,
  type SpaAggregateForRep,
} from "@/server/spa-rep-data-share.functions";
import type { PromotionBuyInTier } from "@/server/agent-schema";
import { useDemoMode, useViewAs } from "@/lib/demo-mode";
import { familyLabel } from "@/lib/liz-csv";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/rep/promotions/$promotionId")({
  component: PromotionDetailPage,
});

function PromotionDetailPage() {
  const { promotionId } = Route.useParams();
  const viewAs = useViewAs();
  const { isDemo } = useDemoMode();
  const [detail, setDetail] = useState<PromoDetail | null>(null);
  const [outreachStates, setOutreachStates] = useState<Map<string, AccountOutreachState>>(new Map());
  const [interestSignals, setInterestSignals] = useState<PromoInterestSignal[]>([]);
  const [aggregatesBySpa, setAggregatesBySpa] = useState<Map<string, SpaAggregateForRep>>(
    new Map(),
  );
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load({ silent = false }: { silent?: boolean } = {}) {
    if (!silent) setLoading(true);
    setRefreshing(true);
    try {
      const { data: session } = await supabase.auth.getSession();
      const accessToken = session.session?.access_token;
      if (!accessToken) {
        setError("Please sign in to view this promotion.");
        setLoading(false);
        setRefreshing(false);
        return;
      }
      const [result, states, signals] = await Promise.all([
        getPromotionDetail({ data: { accessToken, promotionId, viewAs } }),
        listPromoOutreachStates({ data: { accessToken, promotionId, viewAs } }),
        listPromoInterestSignals({ data: { accessToken, promotionId, viewAs } }),
      ]);
      setDetail(result);
      setOutreachStates(new Map(states.map((s) => [s.accountId, s])));
      setInterestSignals(signals);
      setError(null);

      // P4: fan out one aggregate request for the interested spas. Demo
      // mode skips (the showcase tenant doesn't share aggregates today).
      if (signals.length > 0 && viewAs !== "demo") {
        const uniqSpaIds = Array.from(new Set(signals.map((s) => s.spaUserId)));
        try {
          const aggs = await getSpaAggregatesForReps({
            data: { accessToken, spaUserIds: uniqSpaIds },
          });
          setAggregatesBySpa(new Map(aggs.map((a) => [a.spaUserId, a])));
        } catch {
          // Non-fatal — interest card still renders without aggregates.
          setAggregatesBySpa(new Map());
        }
      } else {
        setAggregatesBySpa(new Map());
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load this promotion.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  function noteOutreachSent(accountId: string) {
    setOutreachStates((prev) => {
      const next = new Map(prev);
      next.set(accountId, {
        accountId,
        state: "outreached",
        lastTouchedAt: new Date().toISOString(),
        committedTierCode: prev.get(accountId)?.committedTierCode ?? null,
      });
      return next;
    });
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promotionId, viewAs]);

  return (
    <div className="flex flex-col min-h-screen bg-background">
      <PageHeader
        eyebrow="Lizzie(OS) · Promotion"
        title={detail?.title ?? (loading ? "Loading…" : "Promotion")}
        description={detail?.meta.manufacturer ? `From ${capitalize(detail.meta.manufacturer)}` : undefined}
        breadcrumbs={[
          { label: "Liz", to: "/app/rep" },
          { label: "Promotions", to: "/app/rep/promotions" },
          { label: detail?.title ?? "Promotion" },
        ]}
        actions={
          <div className="flex items-center gap-2">
            <Link
              to="/app/rep/promotions"
              className="inline-flex items-center gap-1.5 text-xs text-ink-soft hover:text-foreground rounded-full border border-border px-3 py-1.5"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              All promotions
            </Link>
            <Link
              to="/app/rep"
              className="inline-flex items-center gap-1.5 text-xs text-ink-soft hover:text-foreground rounded-full border border-border px-3 py-1.5"
            >
              <MessageSquare className="h-3.5 w-3.5" />
              Ask Liz
            </Link>
            <button
              type="button"
              onClick={() => void load({ silent: true })}
              disabled={refreshing}
              className="inline-flex items-center gap-1.5 text-xs text-ink-soft hover:text-foreground rounded-full border border-border px-3 py-1.5 disabled:opacity-50"
              title="Refresh"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
              Refresh
            </button>
          </div>
        }
      />

      <div className="flex-1 px-4 py-6 lg:px-10 max-w-5xl w-full mx-auto space-y-6">
        {loading ? (
          <div className="flex items-center justify-center text-sm text-ink-soft py-16">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            Loading promotion…
          </div>
        ) : error ? (
          <ErrorCard message={error} />
        ) : detail ? (
          <>
            <HeroCard detail={detail} />
            {detail.concurrentPromos.length > 0 && (
              <ConcurrentPromosCallout promos={detail.concurrentPromos} />
            )}
            {interestSignals.length > 0 && (
              <InterestSignalsCard
                signals={interestSignals}
                aggregatesBySpa={aggregatesBySpa}
              />
            )}
            <TierLadder tiers={detail.tiers} promoKind={detail.meta.promoKind ?? undefined} />
            <PromoBlastComposer
              promotionId={promotionId}
              promoTitle={detail.title}
              accounts={detail.eligibleAccounts}
              manufacturer={detail.meta.manufacturer ?? null}
              outreachStates={outreachStates}
              isDemo={isDemo}
              onSent={noteOutreachSent}
            />
            {detail.meta.termsFinePrint && (
              <FinePrintCard text={detail.meta.termsFinePrint} />
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

// ── Hero ───────────────────────────────────────────────────────────────────

function HeroCard({ detail }: { detail: PromoDetail }) {
  const a = detail.meta;
  return (
    <section className="rounded-2xl border border-border bg-card overflow-hidden">
      <div className="px-6 py-6 sm:px-8 sm:py-7">
        <div className="flex items-center gap-2 mb-2 flex-wrap">
          {a.manufacturer && (
            <span className="inline-flex items-center text-[11px] uppercase tracking-wider font-semibold text-ink-soft">
              <Building2 className="h-3 w-3 mr-1" />
              {capitalize(a.manufacturer)}
            </span>
          )}
          {a.promoKind && (
            <>
              <span className="text-ink-soft/40">·</span>
              <span className="text-[11px] uppercase tracking-wider font-medium text-ink-soft capitalize">
                {a.promoKind.replace("-", " ")}
              </span>
            </>
          )}
          <span className="ml-auto">
            <DetailStatusChip status={detail.status} />
          </span>
        </div>
        <h1 className="text-[24px] sm:text-[28px] font-semibold leading-tight text-foreground">
          {detail.title}
        </h1>
        <div className="mt-3 flex items-center gap-4 flex-wrap text-[13px] text-ink-soft">
          {a.starts && (
            <span className="inline-flex items-center gap-1">
              <Calendar className="h-3.5 w-3.5" />
              {formatRange(a.starts, a.ends)}
            </span>
          )}
          {detail.daysToEnd !== null && detail.daysToEnd >= 0 && (
            <span className={cn(
              "inline-flex items-center gap-1 font-medium",
              detail.daysToEnd <= 7 ? "text-amber-700" : "text-foreground/80",
            )}>
              <Sparkles className="h-3.5 w-3.5" />
              {detail.daysToEnd === 0
                ? "Ends today"
                : detail.daysToEnd === 1
                  ? "Ends tomorrow"
                  : `${detail.daysToEnd} days left`}
            </span>
          )}
          {a.appliesTo && a.appliesTo.length > 0 && (
            <span className="inline-flex items-center gap-1">
              <Tag className="h-3.5 w-3.5" />
              {a.appliesTo.map((f) => familyLabel(f as never)).join(", ")}
            </span>
          )}
          {a.sourceUrl && (
            <a
              href={a.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Manufacturer portal
            </a>
          )}
        </div>
        {detail.content && (
          <p className="mt-4 text-[14px] text-foreground/80 leading-relaxed">
            {detail.content}
          </p>
        )}
      </div>
    </section>
  );
}

function DetailStatusChip({ status }: { status: PromoDetail["status"] }) {
  const variants = {
    active: { label: "Active", classes: "bg-emerald-50 text-emerald-700 border-emerald-200" },
    upcoming: { label: "Upcoming", classes: "bg-slate-50 text-slate-700 border-slate-200" },
    expired: { label: "Expired", classes: "bg-rose-50 text-rose-700 border-rose-200" },
    unknown: { label: "Undated", classes: "bg-amber-50 text-amber-700 border-amber-200" },
  };
  const v = variants[status];
  return (
    <span className={cn("inline-flex items-center text-[10px] uppercase tracking-wider font-semibold rounded-full px-2 py-0.5 border", v.classes)}>
      {v.label}
    </span>
  );
}

// ── Concurrent promos callout ─────────────────────────────────────────────

function ConcurrentPromosCallout({
  promos,
}: {
  promos: PromoDetail["concurrentPromos"];
}) {
  return (
    <section className="rounded-xl border border-amber-200 bg-amber-50/40 px-5 py-3.5">
      <div className="flex items-start gap-3">
        <Layers className="h-4 w-4 text-amber-700 mt-0.5 flex-shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-[12px] uppercase tracking-wider font-semibold text-amber-700">
            Concurrent with {promos.length === 1 ? "another promo" : `${promos.length} other promos`}
          </div>
          <p className="text-sm text-amber-900 mt-1 leading-snug">
            Practices may qualify for either or both. Liz can compute combined-savings math when you ask.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {promos.map((p) => (
              <Link
                key={p.id}
                to="/app/rep/promotions/$promotionId"
                params={{ promotionId: p.id }}
                className="inline-flex items-center gap-1 text-xs font-medium text-amber-900 bg-amber-100 hover:bg-amber-200 px-2.5 py-1 rounded-full transition"
              >
                {p.title}
                <ChevronRight className="h-3 w-3" />
              </Link>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

// ── Interest signals (v341.1) ─────────────────────────────────────────────
// Lands above the tier ladder so the rep sees who's already raising their
// hand before deciding whom to email. Read-only here — composing a reply
// happens via the blast composer below (or a future direct CTA).

function InterestSignalsCard({
  signals,
  aggregatesBySpa,
}: {
  signals: PromoInterestSignal[];
  aggregatesBySpa: Map<string, SpaAggregateForRep>;
}) {
  return (
    <section className="rounded-2xl border border-primary/30 bg-primary/5 overflow-hidden">
      <header className="flex items-center gap-2 px-5 py-3 border-b border-primary/20 bg-primary/10">
        <Heart className="h-4 w-4 text-primary fill-primary/30" />
        <h2 className="text-sm font-semibold text-primary">
          {signals.length} {signals.length === 1 ? "practice" : "practices"} interested
        </h2>
        <span className="ml-auto text-[11px] text-primary/70">
          {signals.filter((s) => s.message).length}/{signals.length} left a note
        </span>
      </header>
      <ul className="divide-y divide-primary/15">
        {signals.map((s) => (
          <InterestRow
            key={s.spaUserId}
            signal={s}
            aggregate={aggregatesBySpa.get(s.spaUserId) ?? null}
          />
        ))}
      </ul>
    </section>
  );
}

function InterestRow({
  signal,
  aggregate,
}: {
  signal: PromoInterestSignal;
  aggregate: SpaAggregateForRep | null;
}) {
  return (
    <li className="px-5 py-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Building2 className="h-3.5 w-3.5 text-primary/70 flex-shrink-0" />
            <span className="font-semibold text-foreground">{signal.spaName}</span>
          </div>
          <div className="mt-1 flex items-center gap-3 flex-wrap text-[11px] text-ink-soft">
            {signal.spaAddress && (
              <span className="inline-flex items-center gap-1">
                <MapPin className="h-3 w-3" />
                {signal.spaAddress}
              </span>
            )}
            {signal.spaContactEmail && (
              <a
                href={`mailto:${signal.spaContactEmail}`}
                className="inline-flex items-center gap-1 hover:text-primary"
              >
                <Mail className="h-3 w-3" />
                {signal.spaContactEmail}
              </a>
            )}
          </div>
        </div>
        <span className="text-[11px] text-ink-soft whitespace-nowrap" title={signal.updatedAt}>
          {formatInterestTimestamp(signal.updatedAt)}
        </span>
      </div>
      {signal.message && (
        <blockquote className="mt-3 rounded-lg bg-card border border-primary/20 px-3 py-2 flex gap-2 text-[13px] text-foreground/85 leading-relaxed">
          <Quote className="h-3.5 w-3.5 text-primary/60 flex-shrink-0 mt-1" />
          <span>{signal.message}</span>
        </blockquote>
      )}
      {aggregate && <AggregatesPanel aggregate={aggregate} />}
    </li>
  );
}

function AggregatesPanel({ aggregate }: { aggregate: SpaAggregateForRep }) {
  if (!aggregate.isSharing || !aggregate.aggregates) {
    return (
      <div className="mt-3 rounded-lg border border-dashed border-primary/20 bg-background/60 px-3 py-2 text-[11px] text-ink-faint">
        This practice hasn't shared aggregate counts. Reach out to ask.
      </div>
    );
  }
  const a = aggregate.aggregates;
  const primaryEntries = Object.entries(a.primaryManufacturerCounts).sort(
    (x, y) => (y[1] as number) - (x[1] as number),
  ) as Array<[string, number]>;
  const overdueEntries = Object.entries(a.overdueByManufacturer).sort(
    (x, y) => (y[1] as number) - (x[1] as number),
  ) as Array<[string, number]>;
  return (
    <div className="mt-3 rounded-lg border border-primary/20 bg-background/80 px-3 py-2.5">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="text-[10px] uppercase tracking-wider font-semibold text-primary">
          Patient book — aggregate
        </div>
        <div className="text-[10px] text-ink-faint">
          {a.activePatients12mo.toLocaleString()} active 12mo · {a.totalOverdue.toLocaleString()} overdue
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {primaryEntries.slice(0, 6).map(([mfr, n]) => {
          const overdueN = overdueEntries.find((e) => e[0] === mfr)?.[1] ?? 0;
          return (
            <span
              key={mfr}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2 py-0.5 text-[10px]"
              title={
                overdueN > 0
                  ? `${overdueN.toLocaleString()} overdue`
                  : "primary-brand patient count"
              }
            >
              <span className="font-semibold tabular-nums">{n.toLocaleString()}</span>
              <span className="capitalize">{mfr}</span>
              {overdueN > 0 && (
                <span className="text-amber-700 dark:text-amber-300 tabular-nums">
                  · {overdueN.toLocaleString()} overdue
                </span>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function formatInterestTimestamp(iso: string): string {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHr = Math.floor(diffMs / 3_600_000);
  const diffDay = Math.floor(diffMs / 86_400_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ── Tier ladder ───────────────────────────────────────────────────────────

function TierLadder({
  tiers,
  promoKind,
}: {
  tiers: PromotionBuyInTier[];
  promoKind: string | undefined;
}) {
  if (tiers.length === 0) return null;
  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-[13px] uppercase tracking-wider font-semibold text-ink-soft">
          Tier ladder
        </h2>
        <span className="text-[11px] text-ink-soft">{tiers.length} tiers</span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {tiers.map((t) => (
          <TierCard key={t.code} tier={t} promoKind={promoKind} />
        ))}
      </div>
    </section>
  );
}

function TierCard({ tier, promoKind }: { tier: PromotionBuyInTier; promoKind: string | undefined }) {
  const isFlat = typeof tier.flat_price_per_unit_usd === "number";
  return (
    <article className="rounded-xl border border-border bg-card px-4 py-4 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-foreground">{tier.label}</div>
          <div className="text-[11px] text-ink-soft mt-0.5">
            {tier.min_units}
            {typeof tier.max_units === "number" ? `–${tier.max_units}` : "+"} units
          </div>
        </div>
        <span className="inline-block font-mono text-[10px] font-semibold text-primary bg-primary/10 px-2 py-0.5 rounded-full">
          {tier.code}
        </span>
      </div>

      <div className="border-t border-border my-1" />

      <ul className="space-y-1.5 text-[13px]">
        {isFlat ? (
          <li className="flex items-center gap-2 text-foreground">
            <Tag className="h-3.5 w-3.5 text-primary" />
            <span className="font-semibold tabular-nums">{usd(tier.flat_price_per_unit_usd!)}/unit</span>
            <span className="text-[11px] text-ink-soft">flat</span>
          </li>
        ) : typeof tier.discount_per_unit_usd === "number" ? (
          <li className="flex items-center gap-2 text-foreground">
            <Tag className="h-3.5 w-3.5 text-emerald-600" />
            <span className="font-semibold tabular-nums">${tier.discount_per_unit_usd} off</span>
            <span className="text-[11px] text-ink-soft">per unit</span>
          </li>
        ) : null}
        {tier.physical_goods && tier.physical_goods.length > 0 && (
          <li className="flex items-start gap-2 text-foreground">
            <Gift className="h-3.5 w-3.5 text-rose-600 mt-0.5 flex-shrink-0" />
            <div className="min-w-0">
              {tier.physical_goods.map((g, i) => (
                <div key={i} className="text-[13px]">
                  <span className="tabular-nums font-medium">{g.quantity}×</span>{" "}
                  <span>{g.kind === "scrubs" ? "scrubs set" : g.kind}</span>
                  {g.note && (
                    <span className="text-[11px] text-ink-soft ml-1">— {g.note}</span>
                  )}
                </div>
              ))}
            </div>
          </li>
        )}
        {typeof tier.rewards_credit_usd === "number" && (
          <li className="flex items-center gap-2 text-foreground">
            <Award className="h-3.5 w-3.5 text-amber-600" />
            <span className="tabular-nums">${tier.rewards_credit_usd} rewards credit</span>
          </li>
        )}
        {tier.notes && (
          <li className="text-[11px] text-ink-soft italic">{tier.notes}</li>
        )}
      </ul>
    </article>
  );
}

// ── PromoBlastComposer (v336) — the deep work ─────────────────────────────
// Replaces the eligible-accounts table + the v335 ComposerStub. Multi-select
// → Liz drafts per-account warm emails in parallel → rep reviews + edits →
// bulk send. State badges show which accounts already have an outreach row.

type DraftRowState =
  | { kind: "idle" }
  | { kind: "drafting" }
  | { kind: "ready"; subject: string; body: string; recommendedTierCode: string | null; to: string }
  | { kind: "sending"; subject: string; body: string; recommendedTierCode: string | null; to: string }
  | { kind: "sent"; sentAt: string }
  | { kind: "error"; message: string };

const MAX_BLAST_AT_ONCE = 20;

function PromoBlastComposer({
  promotionId,
  promoTitle,
  accounts,
  manufacturer,
  outreachStates,
  isDemo,
  onSent,
}: {
  promotionId: string;
  promoTitle: string;
  accounts: PromoEligibleAccount[];
  manufacturer: string | null;
  outreachStates: Map<string, AccountOutreachState>;
  isDemo: boolean;
  onSent: (accountId: string) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [drafts, setDrafts] = useState<Map<string, DraftRowState>>(new Map());
  const [drafting, setDrafting] = useState(false);
  const [sending, setSending] = useState(false);

  const selectableAccounts = accounts.filter((a) => !outreachStates.has(a.id));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < MAX_BLAST_AT_ONCE) next.add(id);
      return next;
    });
  }
  function toggleAll() {
    if (selected.size === selectableAccounts.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(selectableAccounts.slice(0, MAX_BLAST_AT_ONCE).map((a) => a.id)));
    }
  }

  async function generateDrafts() {
    if (selected.size === 0) return;
    setDrafting(true);
    const ids = Array.from(selected);
    setDrafts((prev) => {
      const next = new Map(prev);
      for (const id of ids) next.set(id, { kind: "drafting" });
      return next;
    });
    try {
      const { data: session } = await supabase.auth.getSession();
      const accessToken = session.session?.access_token;
      if (!accessToken) {
        toast.error("Sign in to draft.");
        return;
      }
      const results = await Promise.allSettled(
        ids.map(async (accountId) => {
          const draft = await draftPromoBlast({
            data: { accessToken, promotionId, accountId, viewAs: isDemo ? "demo" : undefined },
          });
          return { accountId, draft };
        }),
      );
      setDrafts((prev) => {
        const next = new Map(prev);
        for (const r of results) {
          if (r.status === "fulfilled") {
            const { accountId, draft } = r.value;
            const account = accounts.find((a) => a.id === accountId);
            next.set(accountId, {
              kind: "ready",
              subject: draft.subject,
              body: draft.body,
              recommendedTierCode: draft.recommendedTierCode,
              to: draft.to ?? account?.contactEmail ?? "",
            });
          } else {
            // Find which id failed — Promise.allSettled doesn't tell us
            // directly without metadata. We'll show a generic error.
            // (Edge case: unlikely with allSettled+map order preservation.)
          }
        }
        // Mark any still in "drafting" as error.
        for (const id of ids) {
          if (next.get(id)?.kind === "drafting") {
            next.set(id, { kind: "error", message: "Draft failed — try regenerating." });
          }
        }
        return next;
      });
      const okCount = results.filter((r) => r.status === "fulfilled").length;
      const failCount = results.length - okCount;
      if (failCount === 0) {
        toast.success(`${okCount} draft${okCount === 1 ? "" : "s"} ready to review.`);
      } else {
        toast.warning(`${okCount} drafted, ${failCount} failed.`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Drafting failed.");
    } finally {
      setDrafting(false);
    }
  }

  async function sendAll() {
    const readyEntries = Array.from(drafts.entries()).filter(([, s]) => s.kind === "ready");
    if (readyEntries.length === 0) return;
    if (isDemo) {
      toast.error("Demo mode is read-only. Exit demo to send real promos.");
      return;
    }
    setSending(true);
    try {
      const { data: session } = await supabase.auth.getSession();
      const accessToken = session.session?.access_token;
      if (!accessToken) {
        toast.error("Sign in to send.");
        return;
      }
      let okCount = 0;
      let failCount = 0;
      for (const [accountId, draftState] of readyEntries) {
        if (draftState.kind !== "ready") continue;
        if (!draftState.to) {
          setDrafts((prev) => {
            const next = new Map(prev);
            next.set(accountId, { kind: "error", message: "No email on file — edit account to add one." });
            return next;
          });
          failCount++;
          continue;
        }
        setDrafts((prev) => {
          const next = new Map(prev);
          next.set(accountId, { ...draftState, kind: "sending" });
          return next;
        });
        try {
          const res = await sendPromoBlast({
            data: {
              accessToken,
              promotionId,
              accountId,
              to: draftState.to,
              subject: draftState.subject,
              body: draftState.body,
              recommendedTierCode: draftState.recommendedTierCode ?? undefined,
            },
          });
          setDrafts((prev) => {
            const next = new Map(prev);
            next.set(accountId, { kind: "sent", sentAt: res.sentAt });
            return next;
          });
          onSent(accountId);
          okCount++;
        } catch (e) {
          setDrafts((prev) => {
            const next = new Map(prev);
            next.set(accountId, {
              kind: "error",
              message: e instanceof Error ? e.message : "Send failed.",
            });
            return next;
          });
          failCount++;
        }
      }
      if (failCount === 0) {
        toast.success(`${okCount} promo email${okCount === 1 ? "" : "s"} sent.`);
      } else if (okCount === 0) {
        toast.error(`All ${failCount} sends failed.`);
      } else {
        toast.warning(`${okCount} sent, ${failCount} failed.`);
      }
      setSelected(new Set()); // Clear selection after a send batch.
    } finally {
      setSending(false);
    }
  }

  function updateDraftField(accountId: string, field: "subject" | "body" | "to", value: string) {
    setDrafts((prev) => {
      const next = new Map(prev);
      const s = next.get(accountId);
      if (s?.kind !== "ready") return next;
      next.set(accountId, { ...s, [field]: value });
      return next;
    });
  }

  const readyCount = Array.from(drafts.values()).filter((s) => s.kind === "ready").length;
  const sentCount = Array.from(drafts.values()).filter((s) => s.kind === "sent").length;

  if (accounts.length === 0) {
    return (
      <section className="rounded-xl border border-border bg-card/40 px-5 py-10 text-center text-sm text-ink-soft">
        No {manufacturer ? `${capitalize(manufacturer)} ` : ""}accounts in your territory yet.
        {manufacturer && (
          <span className="block mt-1 text-[12px]">
            Switch to demo data to see this promo with eligible accounts populated.
          </span>
        )}
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="px-5 py-4 border-b border-border">
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Mail className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold text-foreground">Blast composer</h2>
          </div>
          <div className="text-[11px] text-ink-soft">
            {accounts.length} eligible · {outreachStates.size} already outreached · {selected.size} selected
          </div>
        </div>
        <div className="mt-3 flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={toggleAll}
            disabled={drafting || sending}
            className="text-[11px] text-ink-soft hover:text-foreground rounded-full border border-border px-3 py-1.5 disabled:opacity-50"
          >
            {selected.size === selectableAccounts.length && selectableAccounts.length > 0 ? "Clear selection" : `Select all (max ${MAX_BLAST_AT_ONCE})`}
          </button>
          <button
            type="button"
            onClick={generateDrafts}
            disabled={drafting || sending || selected.size === 0}
            className="inline-flex items-center gap-1.5 text-xs font-medium rounded-full bg-primary text-white px-3 py-1.5 hover:opacity-90 disabled:opacity-40"
          >
            {drafting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            {drafting ? "Drafting…" : `Draft for ${selected.size} selected`}
          </button>
          {readyCount > 0 && (
            <button
              type="button"
              onClick={sendAll}
              disabled={drafting || sending || isDemo}
              className="inline-flex items-center gap-1.5 text-xs font-medium rounded-full bg-emerald-600 text-white px-3 py-1.5 hover:opacity-90 disabled:opacity-40"
              title={isDemo ? "Demo mode is read-only" : undefined}
            >
              {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Mail className="h-3.5 w-3.5" />}
              {sending ? "Sending…" : `Send ${readyCount} ready`}
            </button>
          )}
          {sentCount > 0 && (
            <span className="text-[11px] text-emerald-700 inline-flex items-center gap-1">
              <Mail className="h-3 w-3" />
              {sentCount} sent this session
            </span>
          )}
        </div>
        {isDemo && (
          <div className="mt-3 text-[12px] text-amber-700">
            Demo mode: drafts will generate, but sending is disabled. Exit demo to send real promo emails.
          </div>
        )}
      </div>

      <ul className="divide-y divide-border">
        {accounts.map((a) => (
          <BlastAccountRow
            key={a.id}
            account={a}
            selected={selected.has(a.id)}
            onToggle={() => toggle(a.id)}
            draftState={drafts.get(a.id)}
            outreachState={outreachStates.get(a.id)}
            onChangeDraft={(field, value) => updateDraftField(a.id, field, value)}
            disabled={drafting || sending}
          />
        ))}
      </ul>
    </section>
  );
}

function BlastAccountRow({
  account,
  selected,
  onToggle,
  draftState,
  outreachState,
  onChangeDraft,
  disabled,
}: {
  account: PromoEligibleAccount;
  selected: boolean;
  onToggle: () => void;
  draftState: DraftRowState | undefined;
  outreachState: AccountOutreachState | undefined;
  onChangeDraft: (field: "subject" | "body" | "to", value: string) => void;
  disabled: boolean;
}) {
  const alreadyOutreached = outreachState && outreachState.state !== "targeted";
  return (
    <li className="px-5 py-3">
      <div className="grid grid-cols-[auto_1fr_auto] gap-3 items-start">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          disabled={disabled || !!alreadyOutreached}
          className="mt-1.5 h-4 w-4 rounded border-border accent-primary disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
          aria-label={`Select ${account.title}`}
        />
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Link
              to="/app/rep/accounts/$accountId"
              params={{ accountId: account.id }}
              className="font-medium text-foreground hover:text-primary truncate"
            >
              {account.title}
            </Link>
            {account.currentTier && (
              <span className="inline-block text-[10px] uppercase tracking-wider font-medium text-ink-soft bg-sidebar-accent/30 rounded-full px-2 py-0.5">
                {account.currentTier.tier}
              </span>
            )}
            {alreadyOutreached && <OutreachBadge outreachState={outreachState!} />}
            {draftState?.kind === "sent" && <SentBadge sentAt={draftState.sentAt} />}
            {draftState?.kind === "sending" && (
              <span className="text-[10px] text-slate-600 inline-flex items-center gap-1">
                <Loader2 className="h-3 w-3 animate-spin" />
                Sending…
              </span>
            )}
          </div>
          <div className="text-[11px] text-ink-soft mt-0.5 flex items-center gap-2 flex-wrap">
            {account.address && <span className="truncate">{account.address}</span>}
            {account.contactEmail && (
              <span className="inline-flex items-center gap-1">
                <Mail className="h-3 w-3" />
                {account.contactEmail}
              </span>
            )}
            {!account.contactEmail && (
              <span className="text-amber-700">No email on file</span>
            )}
          </div>
          {draftState?.kind === "drafting" && (
            <div className="mt-2 text-[11px] text-ink-soft inline-flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" />
              Liz is drafting…
            </div>
          )}
          {draftState?.kind === "ready" && (
            <DraftEditor
              draft={draftState}
              onChange={onChangeDraft}
              disabled={disabled}
            />
          )}
          {draftState?.kind === "error" && (
            <div className="mt-2 text-[11px] text-rose-700">⚠ {draftState.message}</div>
          )}
        </div>
        <ChevronRight className="h-4 w-4 text-ink-soft/40 mt-2" />
      </div>
    </li>
  );
}

function DraftEditor({
  draft,
  onChange,
  disabled,
}: {
  draft: Extract<DraftRowState, { kind: "ready" }>;
  onChange: (field: "subject" | "body" | "to", value: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="mt-3 rounded-lg border border-border bg-background/60 px-3 py-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wider font-medium text-ink-soft w-14 flex-shrink-0">To</span>
        <input
          type="email"
          value={draft.to}
          onChange={(e) => onChange("to", e.target.value)}
          disabled={disabled}
          placeholder="owner@practice.com"
          className="flex-1 rounded-md border border-border bg-card px-2.5 py-1 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        />
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wider font-medium text-ink-soft w-14 flex-shrink-0">Subject</span>
        <input
          type="text"
          value={draft.subject}
          onChange={(e) => onChange("subject", e.target.value)}
          disabled={disabled}
          className="flex-1 rounded-md border border-border bg-card px-2.5 py-1 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        />
      </div>
      {draft.recommendedTierCode && (
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider font-medium text-ink-soft w-14 flex-shrink-0">Tier</span>
          <span className="text-[11px] text-foreground font-mono">{draft.recommendedTierCode}</span>
        </div>
      )}
      <div>
        <textarea
          value={draft.body}
          onChange={(e) => onChange("body", e.target.value)}
          disabled={disabled}
          rows={8}
          className="w-full rounded-md border border-border bg-card px-3 py-2 text-[13px] leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 resize-y"
        />
      </div>
    </div>
  );
}

function OutreachBadge({ outreachState }: { outreachState: AccountOutreachState }) {
  // v337: prefer intent-side state when available (Confirmed > Opened > Sent).
  // The intent join surfaces practice-owner activity even before the rep's
  // local state row catches up (committed transition happens via the public
  // landing page's confirmPromoIntent fn).
  if (outreachState.intentConfirmedAt) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-full px-2 py-0.5 font-medium">
        <CheckCircleDot />
        Confirmed
        {outreachState.intentConfirmedTierCode && (
          <span className="font-mono ml-0.5">· {outreachState.intentConfirmedTierCode}</span>
        )}
        <span className="text-emerald-700/70 font-normal">
          {" "}· {new Date(outreachState.intentConfirmedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
        </span>
      </span>
    );
  }
  if (outreachState.intentFirstViewedAt) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-slate-700 bg-slate-100 rounded-full px-2 py-0.5">
        <CheckCircleDot />
        Opened
        <span className="text-slate-500"> · {new Date(outreachState.intentFirstViewedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
      </span>
    );
  }
  // Fall back to the promotion_account_state machine label.
  const state = outreachState.state;
  const label =
    state === "outreached" ? "Sent"
    : state === "engaged" ? "Engaged"
    : state === "meeting_scheduled" ? "Meeting set"
    : state === "meeting_done" ? "Met"
    : state === "committed" ? "Committed"
    : state === "ordered" || state === "fulfilled" ? "Ordered"
    : state === "closed_won" ? "Won"
    : state === "closed_lost" ? "Lost"
    : state === "opted_out" ? "Opted out"
    : state;
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-slate-600 bg-slate-100 rounded-full px-2 py-0.5">
      <CheckCircleDot />
      {label}
      {outreachState.lastTouchedAt && (
        <span className="text-slate-500"> · {new Date(outreachState.lastTouchedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
      )}
    </span>
  );
}

function SentBadge({ sentAt }: { sentAt: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-emerald-700 bg-emerald-50 rounded-full px-2 py-0.5 font-medium">
      <CheckCircleDot />
      Sent {new Date(sentAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
    </span>
  );
}

function CheckCircleDot() {
  return (
    <svg viewBox="0 0 16 16" className="h-3 w-3" fill="currentColor" aria-hidden="true">
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="8" cy="8" r="3" />
    </svg>
  );
}

// ── Fine print ────────────────────────────────────────────────────────────

function FinePrintCard({ text }: { text: string }) {
  return (
    <section className="rounded-xl border border-border bg-card/40 px-5 py-3.5">
      <div className="text-[11px] uppercase tracking-wider font-semibold text-ink-soft mb-1.5">
        Terms &amp; fine print
      </div>
      <p className="text-[12px] text-ink-soft leading-relaxed">{text}</p>
    </section>
  );
}

// ── Error ─────────────────────────────────────────────────────────────────

function ErrorCard({ message }: { message: string }) {
  return (
    <div className="rounded-2xl border border-rose-200 bg-rose-50/40 px-6 py-10 text-center">
      <Calendar className="h-7 w-7 mx-auto text-rose-600" />
      <h2 className="mt-3 text-base font-semibold text-rose-900">
        Couldn't load this promotion
      </h2>
      <p className="mt-1 text-sm text-rose-900/80 leading-relaxed">{message}</p>
      <Link
        to="/app/rep/promotions"
        className="mt-4 inline-flex items-center gap-1.5 text-xs text-rose-700 hover:text-rose-900 rounded-full border border-rose-200 px-3 py-1.5"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to promotions
      </Link>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────

function usd(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function capitalize(s: string): string {
  if (!s) return s;
  return s[0].toUpperCase() + s.slice(1);
}

function formatRange(starts: string | null | undefined, ends: string | null | undefined): string {
  const fmt = (d: string) =>
    new Date(d + "T00:00:00").toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  if (starts && ends) return `${fmt(starts)} → ${fmt(ends)}`;
  if (starts) return `From ${fmt(starts)}`;
  if (ends) return `Until ${fmt(ends)}`;
  return "";
}
