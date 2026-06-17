/**
 * /app/refill/recovery — Recovery receipt dashboard (v363, polished in v377).
 *
 * Every $ Emma recovered, traceable. Verified events with code-computed
 * audit trail. Manual confirm button on each unverified row for spas
 * that don't sync QBO.
 *
 * The math the spa owner audits BEFORE they sign up for the % pricing
 * plan. If this doesn't match their books to the penny, the trust dies.
 * [VERIFIED] discipline applies.
 *
 * v377 added the case-study-grade surface: invoice-preview card (the
 * exact math the 1st-of-month cron will charge), per-treatment
 * breakdown table, MoM delta context on the headline number. This is
 * the page that ships as the cold-outreach screenshot.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  DollarSign,
  Heart,
  Loader2,
  Lock,
  RefreshCw,
  Receipt,
  ShieldCheck,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Undo,
  X,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { RefillSolutionTabs } from "@/components/refill/RefillSolutionTabs";
import { useShell } from "@/lib/shell";
import { supabase } from "@/integrations/supabase/client";
import { useTenantMembership } from "@/lib/use-tenant-membership";
import {
  getRecoveryStats,
  listRecoveryEvents,
  manualConfirmRecovery,
  unconfirmRecovery,
  type RecoveryEvent,
  type RecoveryStats,
  type TreatmentBreakdownRow,
} from "@/server/emma-attribution.functions";
import {
  getInvoicePreview,
  type RefillInvoicePreview,
} from "@/server/refill-billing";
import {
  listDepositIntents,
  markDepositVoided,
  type DepositHold,
} from "@/server/emma-deposits.functions";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/refill/recovery/")({
  component: RecoveryDashboard,
});

type Tab = "saves" | "deposits";

function RecoveryDashboard() {
  const [tab, setTab] = useState<Tab>("saves");
  const [events, setEvents] = useState<RecoveryEvent[] | null>(null);
  const [stats, setStats] = useState<RecoveryStats | null>(null);
  const [invoice, setInvoice] = useState<RefillInvoicePreview | null>(null);
  const [deposits, setDeposits] = useState<DepositHold[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [voidingId, setVoidingId] = useState<string | null>(null);

  // v410.1: shell-aware branding. Inside the Refill standalone-product
  // shell, surface "Refill" everywhere; on emma.agentiport.com the legacy
  // "SmartSpa" branding stays. Per [[project-refill-trojan-horse-thesis]]
  // the two products are separate brands; bleeding SmartSpa labels into
  // Refill chrome conflates them and breaks the stealth positioning.
  const shell = useShell();
  const isRefill = shell === "refill";
  const brandHeader = isRefill ? "Refill" : "SmartSpa";
  const brandName = isRefill ? "Refill" : "SmartSpa";

  // v1.26.8: admin viewing-as plumbing. All 7 server fns called from this
  // page now accept viewAsUserId (emma-attribution + emma-deposits swept
  // in v1.26.8; emma-billing.getInvoicePreview swept in v1.26.7; v1.26.23
  // repointed to refill-billing.getInvoicePreview). Wiring
  // them all at once avoids the split-brain UI v1.25.6 warned about.
  const membership = useTenantMembership();
  const viewAsUserId =
    membership.status === "tenant" ? membership.viewAsUserId : undefined;

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        setLoadError("Please sign in.");
        return;
      }
      const [evts, st, inv, deps] = await Promise.all([
        listRecoveryEvents({ data: { accessToken: token, viewAsUserId } }),
        getRecoveryStats({ data: { accessToken: token, viewAsUserId } }),
        getInvoicePreview({ data: { accessToken: token, viewAsUserId } }),
        listDepositIntents({ data: { accessToken: token, viewAsUserId } }),
      ]);
      setEvents(evts);
      setStats(st);
      setInvoice(inv);
      setDeposits(deps);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Couldn't load.");
    } finally {
      setRefreshing(false);
    }
  }, [viewAsUserId]);

  async function voidDeposit(id: string) {
    if (
      !window.confirm("Void this deposit intent? It will be marked cancelled.")
    )
      return;
    setVoidingId(id);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) return;
      await markDepositVoided({
        data: { accessToken: token, depositHoldId: id, viewAsUserId },
      });
      void load();
      toast.success("Voided.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't void.");
    } finally {
      setVoidingId(null);
    }
  }

  useEffect(() => {
    // v1.34.8.2: wait for tenant-membership to resolve before firing the
    // load — otherwise an admin viewer briefly hits getInvoicePreview
    // without viewAsUserId and the server throws the "No Refill tenant"
    // flash error before the real data renders.
    if (membership.status === "loading") return;
    void load();
  }, [load, membership.status]);

  async function confirm(eventId: string, amount: number) {
    setConfirmingId(eventId);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) return;
      const updated = await manualConfirmRecovery({
        data: {
          accessToken: token,
          recoveryEventId: eventId,
          amountUsd: amount,
          viewAsUserId,
        },
      });
      setEvents((prev) =>
        prev?.map((e) =>
          e.id === eventId
            ? {
                ...e,
                verifiedAt: updated.verifiedAt,
                verificationSource: updated.verificationSource,
                attributedRevenueUsd: updated.attributedRevenueUsd,
              }
            : e,
        ) ?? null,
      );
      toast.success(`Confirmed ${formatMoney(amount)}.`);
      void load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't confirm.");
    } finally {
      setConfirmingId(null);
    }
  }

  async function undo(eventId: string) {
    setConfirmingId(eventId);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) return;
      await unconfirmRecovery({
        data: { accessToken: token, recoveryEventId: eventId, viewAsUserId },
      });
      void load();
      toast.success("Reverted to unverified.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't undo.");
    } finally {
      setConfirmingId(null);
    }
  }

  const grouped = useMemo(() => {
    if (!events) return null;
    const unverified: RecoveryEvent[] = [];
    const verified: RecoveryEvent[] = [];
    for (const e of events) {
      if (e.verifiedAt) verified.push(e);
      else unverified.push(e);
    }
    return { unverified, verified };
  }, [events]);

  return (
    <div className="min-h-screen bg-background">
      <PageHeader
        eyebrow={brandHeader}
        title="Recovery"
        description={`Every dollar ${brandName} recovered, with full math. Verify events here before they count toward your bill.`}
        breadcrumbs={[
          { label: brandHeader, to: "/app/refill" },
          { label: "Recovery" },
        ]}
        actions={
          <button
            type="button"
            onClick={() => void load()}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 text-xs text-ink-soft hover:text-foreground rounded-full border border-border px-3 py-1.5 disabled:opacity-50"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
            Refresh
          </button>
        }
      />
      <RefillSolutionTabs active="overview" />

      <div className="px-6 lg:px-10 py-8 max-w-[960px] w-full mx-auto space-y-6">
        {loadError && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            {loadError}
          </div>
        )}

        {/* Top stats */}
        {stats && (
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <StatCard
              icon={DollarSign}
              label="This month"
              value={formatMoney(stats.monthVerifiedUsd)}
              sub={
                <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                  <span>
                    {stats.monthVerifiedCount}{" "}
                    {stats.monthVerifiedCount === 1 ? "verified" : "verified"}
                  </span>
                  <MoMDelta
                    current={stats.monthVerifiedUsd}
                    prior={stats.priorMonthVerifiedUsd}
                    priorCount={stats.priorMonthVerifiedCount}
                  />
                </span>
              }
              accent="emerald"
            />
            <StatCard
              icon={Loader2}
              label="Awaiting verification"
              value={stats.monthProvisionalCount.toLocaleString()}
              sub={stats.monthProvisionalCount === 1 ? "save" : "saves"}
              accent="amber"
            />
            <StatCard
              icon={TrendingUp}
              label="Lifetime"
              value={formatMoney(stats.lifetimeVerifiedUsd)}
              sub={`${stats.lifetimeVerifiedCount} verified saves`}
            />
            <StatCard
              icon={ShieldCheck}
              label="[VERIFIED]"
              value=""
              sub="Code-computed audit trail. The exact math used for monthly invoicing."
              caption
            />
          </div>
        )}

        {/* Invoice preview — the case-study screenshot anchor. v377. */}
        {invoice && stats && (
          <RefillInvoicePreviewCard invoice={invoice} stats={stats} brandName={brandName} />
        )}

        {/* Tabs */}
        <div className="flex items-center gap-2 border-b border-border">
          <TabBtn
            active={tab === "saves"}
            onClick={() => setTab("saves")}
            label="Saves"
            count={events?.length ?? null}
          />
          <TabBtn
            active={tab === "deposits"}
            onClick={() => setTab("deposits")}
            label="Deposits"
            count={deposits?.length ?? null}
            muted={!deposits || deposits.length === 0}
          />
        </div>

        {tab === "deposits" && (
          <DepositsTab
            deposits={deposits}
            voidingId={voidingId}
            onVoid={voidDeposit}
          />
        )}

        {tab === "saves" && grouped && grouped.unverified.length > 0 && (
          <section className="rounded-2xl border border-amber-500/30 bg-amber-500/5 overflow-hidden">
            <div className="px-5 py-3 border-b border-amber-500/30 flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 text-amber-700" />
              <span className="text-xs font-medium tracking-wider text-amber-700 uppercase">
                Awaiting verification · {grouped.unverified.length}
              </span>
              <span className="text-[11px] text-ink-soft ml-auto">
                QBO reconciliation runs daily at 04:30 UTC. Or confirm manually below.
              </span>
            </div>
            <ul className="divide-y divide-amber-500/20">
              {grouped.unverified.map((e) => (
                <UnverifiedRow
                  key={e.id}
                  event={e}
                  busy={confirmingId === e.id}
                  onConfirm={(amount) => void confirm(e.id, amount)}
                />
              ))}
            </ul>
          </section>
        )}

        {/* Verified — receipt */}
        {tab === "saves" && grouped && grouped.verified.length > 0 && (
          <section className="rounded-2xl border border-border bg-card overflow-hidden">
            <div className="px-5 py-3 border-b border-border bg-emerald-500/5 flex items-center gap-2">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-700" />
              <span className="text-xs font-medium tracking-wider text-emerald-700 uppercase">
                Verified this month · {grouped.verified.length}
              </span>
            </div>
            <ul className="divide-y divide-border">
              {grouped.verified.map((e) => (
                <VerifiedRow
                  key={e.id}
                  event={e}
                  busy={confirmingId === e.id}
                  onUndo={() => void undo(e.id)}
                />
              ))}
            </ul>
          </section>
        )}

        {/* Treatment breakdown — v377. Only renders with at least one
            verified row this month, so the empty state stays clean for
            day-one spas. */}
        {tab === "saves" && stats && stats.monthByTreatment.length > 0 && (
          <TreatmentBreakdownCard
            rows={stats.monthByTreatment}
            totalUsd={stats.monthVerifiedUsd}
          />
        )}

        {/* Empty state */}
        {tab === "saves" &&
          grouped &&
          grouped.unverified.length === 0 &&
          grouped.verified.length === 0 && (
            <div className="rounded-2xl border border-border bg-card p-10 text-center">
              <div className="mx-auto h-12 w-12 rounded-full bg-muted/40 flex items-center justify-center mb-3">
                <Heart className="h-6 w-6 text-ink-soft" />
              </div>
              <h2 className="text-lg font-semibold text-foreground mb-1">
                No recoveries yet this month
              </h2>
              <p className="text-sm text-ink-soft max-w-md mx-auto mb-5">
                When the rescue agent fills a freed slot — or a future recovery
                agent rebooks a no-show — SmartSpa logs the save here. Verified
                revenue flows into the percentage pricing math.
              </p>
              <Link
                to="/app/refill/rescue"
                className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-muted/30 transition"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Rescue activity
              </Link>
            </div>
          )}
      </div>
    </div>
  );
}

// ─── Subcomponents ────────────────────────────────────────────────────────

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  accent,
  caption,
}: {
  icon: typeof DollarSign;
  label: string;
  value: string;
  sub?: React.ReactNode;
  accent?: "emerald" | "amber";
  caption?: boolean;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-1.5 text-[11px] font-medium tracking-wider text-ink-soft uppercase mb-1.5">
        <Icon className="h-3 w-3" />
        {label}
      </div>
      {!caption && (
        <div
          className={cn(
            "text-2xl font-semibold tracking-tight tabular-nums",
            accent === "emerald" && "text-emerald-700",
            accent === "amber" && "text-amber-700",
            !accent && "text-foreground",
          )}
        >
          {value}
        </div>
      )}
      <div
        className={cn(
          "text-[11px] mt-1",
          caption ? "text-ink-soft leading-snug" : "text-ink-soft",
        )}
      >
        {sub}
      </div>
    </div>
  );
}

function UnverifiedRow({
  event,
  busy,
  onConfirm,
}: {
  event: RecoveryEvent;
  busy: boolean;
  onConfirm: (amount: number) => void;
}) {
  const [amountInput, setAmountInput] = useState<string>("");

  return (
    <li className="px-5 py-3.5">
      <div className="flex items-center gap-3 mb-2">
        <AgentPill agent={event.recoveryAgent} />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-foreground">
            {event.patientName ?? "Unknown patient"}
            {event.treatmentType && (
              <span className="text-ink-soft font-normal"> · {event.treatmentType}</span>
            )}
          </div>
          <div className="text-xs text-ink-soft mt-0.5">
            {event.appointmentScheduledAt
              ? `Saved appointment ${new Date(event.appointmentScheduledAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
              : `Logged ${new Date(event.createdAt).toLocaleString()}`}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 pl-1">
        <span className="text-[11px] text-ink-soft">Confirm billed:</span>
        <span className="text-sm text-ink-soft">$</span>
        <input
          type="number"
          step="0.01"
          min="0"
          value={amountInput}
          onChange={(e) => setAmountInput(e.target.value)}
          placeholder="0.00"
          className="w-28 rounded-md border border-border bg-background px-2 py-1 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-emerald/30"
        />
        <button
          type="button"
          onClick={() => {
            const n = Number(amountInput);
            if (!isFinite(n) || n <= 0) {
              toast.error("Enter the billed amount.");
              return;
            }
            onConfirm(n);
          }}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-md bg-emerald-700 text-white px-3 py-1 text-xs font-semibold hover:bg-emerald-800 transition disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5" />
          )}
          Confirm
        </button>
        <span className="text-[10px] text-ink-soft">
          or wait for QBO reconciliation
        </span>
      </div>
    </li>
  );
}

function VerifiedRow({
  event,
  busy,
  onUndo,
}: {
  event: RecoveryEvent;
  busy: boolean;
  onUndo: () => void;
}) {
  return (
    <li className="px-5 py-3 flex items-center gap-3">
      <AgentPill agent={event.recoveryAgent} />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-foreground">
          {event.patientName ?? "Unknown patient"}
          {event.treatmentType && (
            <span className="text-ink-soft font-normal"> · {event.treatmentType}</span>
          )}
        </div>
        <div className="text-xs text-ink-soft mt-0.5 flex items-center gap-1.5 flex-wrap">
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-700 text-[10px] font-mono">
            <ShieldCheck className="h-2.5 w-2.5" />
            [VERIFIED]
          </span>
          <span>via {event.verificationSource}</span>
          <span>·</span>
          <span>{event.verifiedAt ? new Date(event.verifiedAt).toLocaleDateString() : ""}</span>
        </div>
      </div>
      <div className="text-right shrink-0">
        <div className="text-base font-semibold text-emerald-700 tabular-nums">
          {event.attributedRevenueUsd !== null
            ? formatMoney(event.attributedRevenueUsd)
            : "—"}
        </div>
      </div>
      {event.verificationSource === "manual" && (
        <button
          type="button"
          onClick={onUndo}
          disabled={busy}
          className="p-1.5 rounded hover:bg-muted/60 text-ink-soft hover:text-foreground disabled:opacity-50 shrink-0"
          title="Undo confirmation"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Undo className="h-3.5 w-3.5" />
          )}
        </button>
      )}
    </li>
  );
}

function AgentPill({ agent }: { agent: string }) {
  const cfg: Record<string, { bg: string; fg: string; label: string }> = {
    rescue: { bg: "bg-emerald/10", fg: "text-emerald", label: "Rescue" },
    post_recovery: { bg: "bg-amber-500/10", fg: "text-amber-700", label: "Post-show" },
    preshow: { bg: "bg-emerald-500/10", fg: "text-emerald-700", label: "Pre-show" },
  };
  const c = cfg[agent] ?? { bg: "bg-muted/40", fg: "text-ink-soft", label: agent };
  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium shrink-0",
        c.bg,
        c.fg,
      )}
    >
      {c.label}
    </span>
  );
}

function formatMoney(n: number): string {
  if (!isFinite(n)) return "$0";
  return `$${n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

// ─── MoMDelta (v377) ──────────────────────────────────────────────────────

/**
 * Inline month-over-month delta caption. Three states:
 *   - First month (no prior data) → emerald "first month"
 *   - Up → emerald +XX% caption
 *   - Down or flat → muted -XX% caption (no shame, just honest)
 */
function MoMDelta({
  current,
  prior,
  priorCount,
}: {
  current: number;
  prior: number;
  priorCount: number;
}) {
  if (priorCount === 0 && prior === 0) {
    return (
      <span className="inline-flex items-center gap-1 text-emerald-700">
        <Sparkles className="h-2.5 w-2.5" />
        <span>first month</span>
      </span>
    );
  }
  if (prior <= 0) return null;
  const pct = ((current - prior) / prior) * 100;
  const up = pct >= 0;
  const Icon = up ? TrendingUp : TrendingDown;
  const sign = up ? "+" : "";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 tabular-nums",
        up ? "text-emerald-700" : "text-ink-soft",
      )}
      title={`vs ${formatMoney(prior)} last month (${priorCount} verified)`}
    >
      <Icon className="h-2.5 w-2.5" />
      <span>
        {sign}
        {pct.toFixed(0)}% vs last
      </span>
    </span>
  );
}

// ─── RefillInvoicePreviewCard (v377) ────────────────────────────────────────────

// v1.26.23 — labels updated to current refill_pricing_plans names
// (starter/predictable/pro) when the preview swapped from the legacy
// pricing_plans (performance/predictable/hybrid) to the live
// refill source. Pre-v1.26.23 any tenant on a refill-side plan rendered
// the raw enum string ("starter") in this card because the label map
// only knew about the legacy names.
function RefillInvoicePreviewCard({
  invoice,
  stats,
  brandName,
}: {
  invoice: RefillInvoicePreview;
  stats: RecoveryStats;
  brandName: string;
}) {
  // Period close-out date — friendly label for "if this month closed today".
  // periodStart / periodEnd come back as UTC midnight ISO strings; without an
  // explicit timeZone the toLocaleDateString call shifts the date back into the
  // previous day in any negative-offset timezone (v377.1).
  const periodEnd = new Date(invoice.periodEnd);
  const monthLabel = new Date(invoice.periodStart).toLocaleDateString(
    undefined,
    { month: "long", year: "numeric", timeZone: "America/Denver" },
  );

  // v1.93.0 fee-rules model: show only metrics that actually have wins this
  // period. The headline rate comes from the slot_fill rule (the live metric).
  const activeLines = invoice.lines.filter((l) => l.count > 0);
  const base = invoice.monthlyBaseUsd;
  const slot = invoice.lines.find((l) => l.metricKey === "slot_fill");
  const rateLabel = slot
    ? slot.mode === "percent"
      ? `${+(slot.amount * 100).toFixed(2)}% of revenue`
      : `$${slot.amount}/win`
    : "$5/win";
  void brandName;

  return (
    <section className="rounded-2xl border border-emerald-500/30 bg-gradient-to-br from-emerald-500/5 via-card to-card overflow-hidden">
      <div className="px-5 sm:px-6 py-3.5 border-b border-emerald-500/20 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <Receipt className="h-3.5 w-3.5 text-emerald-700 shrink-0" />
          <span className="text-xs font-medium tracking-wider text-emerald-700 uppercase">
            If this month closed today
          </span>
          <span className="text-[11px] text-ink-soft">
            · {monthLabel} · closes {periodEnd.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "America/Denver" })}
          </span>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-700/10 text-emerald-800 px-2.5 py-0.5 text-[11px] font-medium">
          <ShieldCheck className="h-2.5 w-2.5" />
          {base > 0 ? `$${base}/mo + ${rateLabel}` : `Free + ${rateLabel}`}
        </span>
      </div>

      <div className="px-5 sm:px-6 py-5">
        {/* The math, laid out so the spa owner can audit it line-by-line. */}
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-x-6 gap-y-2 items-baseline">
          {base > 0 && (
            <>
              <div className="text-sm text-ink-soft">Monthly base</div>
              <div className="text-sm tabular-nums text-foreground sm:text-right">
                {formatMoney(base)}
              </div>
            </>
          )}

          {activeLines.map((l) => (
            <Fragment key={l.metricKey}>
              <div className="text-sm text-ink-soft">
                {l.label}{" "}
                <span className="text-[11px] text-ink-soft/70">
                  ({l.count} {l.count === 1 ? "win" : "wins"}
                  {l.mode === "percent" ? ` · ${formatMoney(l.revenueUsd)}` : ""})
                </span>
              </div>
              <div className="text-sm tabular-nums text-foreground sm:text-right">
                {formatMoney(l.charge)}
              </div>
            </Fragment>
          ))}

          {activeLines.length === 0 && base === 0 && (
            <>
              <div className="text-sm text-ink-soft">No billable wins yet this month</div>
              <div className="text-sm tabular-nums text-ink-soft sm:text-right">$0.00</div>
            </>
          )}

          <div className="pt-3 mt-1 border-t border-border/60 sm:col-span-2" />

          <div className="text-sm font-semibold text-foreground">
            Total preview
            <span className="ml-2 text-[11px] font-normal text-ink-soft">
              (closes on the 1st)
            </span>
          </div>
          <div className="text-2xl font-semibold tabular-nums text-emerald-700 sm:text-right">
            {formatMoney(invoice.totalDueUsd)}
          </div>
        </div>

        <div className="mt-4 flex items-center gap-1.5 text-[11px] text-ink-soft leading-relaxed">
          <Lock className="h-3 w-3 shrink-0" />
          <span>
            Code-computed against verified events only.{" "}
            {stats.monthProvisionalCount > 0 && (
              <>
                {stats.monthProvisionalCount}{" "}
                {stats.monthProvisionalCount === 1 ? "save is" : "saves are"}{" "}
                still awaiting QBO reconciliation — they'll fold in automatically once verified.
              </>
            )}
            {stats.monthProvisionalCount === 0 &&
              "Every dollar above ties to a row in the receipt below."}
          </span>
        </div>
      </div>
    </section>
  );
}

// ─── TreatmentBreakdownCard (v377) ────────────────────────────────────────

function TreatmentBreakdownCard({
  rows,
  totalUsd,
}: {
  rows: TreatmentBreakdownRow[];
  totalUsd: number;
}) {
  const maxUsd = Math.max(...rows.map((r) => r.recoveredUsd), 1);

  return (
    <section className="rounded-2xl border border-border bg-card overflow-hidden">
      <div className="px-5 py-3 border-b border-border flex items-center gap-2">
        <DollarSign className="h-3.5 w-3.5 text-ink-soft" />
        <span className="text-xs font-medium tracking-wider text-ink-soft uppercase">
          Where the saves came from
        </span>
        <span className="text-[11px] text-ink-soft ml-auto">
          By treatment · {formatMoney(totalUsd)} verified this month
        </span>
      </div>
      <ul className="divide-y divide-border">
        {rows.map((r, idx) => {
          const widthPct = Math.max(2, (r.recoveredUsd / maxUsd) * 100);
          const sharePct =
            totalUsd > 0 ? ((r.recoveredUsd / totalUsd) * 100).toFixed(0) : "0";
          return (
            <li
              key={`${r.treatmentType ?? "untyped"}-${idx}`}
              className="px-5 py-3"
            >
              <div className="flex items-baseline gap-3 mb-1.5">
                <span className="text-sm font-medium text-foreground truncate">
                  {r.treatmentType ?? (
                    <span className="text-ink-soft italic font-normal">
                      Untyped appointment
                    </span>
                  )}
                </span>
                <span className="text-[11px] text-ink-soft tabular-nums shrink-0">
                  {r.count} {r.count === 1 ? "save" : "saves"}
                </span>
                <span className="ml-auto text-sm font-semibold tabular-nums text-foreground shrink-0">
                  {formatMoney(r.recoveredUsd)}
                </span>
                <span className="text-[11px] text-ink-soft tabular-nums shrink-0 min-w-[2.5rem] text-right">
                  {sharePct}%
                </span>
              </div>
              <div className="h-1 rounded-full bg-muted/40 overflow-hidden">
                <div
                  className="h-full bg-emerald-500/60 rounded-full transition-all"
                  style={{ width: `${widthPct}%` }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ─── Tab button ───────────────────────────────────────────────────────────

function TabBtn({
  active,
  onClick,
  label,
  count,
  muted,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number | null;
  muted?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "px-3 py-2 text-sm font-medium border-b-2 -mb-px transition",
        active
          ? "border-emerald text-foreground"
          : "border-transparent text-ink-soft hover:text-foreground",
      )}
    >
      {label}
      {count !== null && (
        <span
          className={cn(
            "ml-1.5 inline-flex items-center justify-center min-w-[1.25rem] px-1 rounded-full text-[10px] font-semibold tabular-nums",
            muted ? "bg-muted/40 text-ink-soft" : "bg-muted/40 text-ink-soft",
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}

// ─── Deposits tab ─────────────────────────────────────────────────────────

function DepositsTab({
  deposits,
  voidingId,
  onVoid,
}: {
  deposits: DepositHold[] | null;
  voidingId: string | null;
  onVoid: (id: string) => void;
}) {
  if (deposits === null) {
    return (
      <div className="flex items-center gap-2 text-sm text-ink-soft py-8 justify-center">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading deposits…
      </div>
    );
  }

  return (
    <>
      {/* Always show the explainer card — even when there are no deposits */}
      <div className="rounded-2xl border border-border bg-muted/20 p-5 flex items-start gap-3">
        <Lock className="h-5 w-5 text-ink-soft mt-0.5 shrink-0" />
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-foreground mb-1">
            Deposit-credit is OFF by default
          </h3>
          <p className="text-xs text-ink-soft leading-relaxed">
            SmartSpa never punishes your patients unless you tell us to. When
            enabled, eligible patients are asked to authorize a deposit that
            becomes credit toward their treatment at the visit. v364 logs
            intent only — no money moves yet. v364.x adds the Stripe card-hold flow.
            Most spas leave this OFF. Configure on{" "}
            <Link
              to="/app/refill/settings/noshow"
              className="text-emerald hover:underline"
            >
              Settings · No-show recovery
            </Link>
            .
          </p>
        </div>
      </div>

      {deposits.length === 0 ? (
        <div className="rounded-2xl border border-border bg-card p-10 text-center">
          <div className="mx-auto h-12 w-12 rounded-full bg-muted/40 flex items-center justify-center mb-3">
            <Lock className="h-6 w-6 text-ink-soft" />
          </div>
          <h2 className="text-lg font-semibold text-foreground mb-1">
            No deposit intents logged
          </h2>
          <p className="text-sm text-ink-soft max-w-md mx-auto">
            When the deposit-credit policy is enabled and an eligible patient
            books, you'll see the intent logged here. Until v364.x ships the
            Stripe card-hold flow, this is intent-only — no money moves.
          </p>
        </div>
      ) : (
        <section className="rounded-2xl border border-border bg-card overflow-hidden">
          <ul className="divide-y divide-border">
            {deposits.map((d) => (
              <DepositRow
                key={d.id}
                deposit={d}
                voiding={voidingId === d.id}
                onVoid={() => onVoid(d.id)}
              />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function DepositRow({
  deposit,
  voiding,
  onVoid,
}: {
  deposit: DepositHold;
  voiding: boolean;
  onVoid: () => void;
}) {
  return (
    <li className="px-5 py-3 flex items-center gap-3">
      <DepositStatusPill status={deposit.status} />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-foreground">
          {deposit.patientName ?? "Unknown patient"}
          {deposit.appointmentTreatment && (
            <span className="text-ink-soft font-normal">
              {" "}
              · {deposit.appointmentTreatment}
            </span>
          )}
        </div>
        <div className="text-xs text-ink-soft mt-0.5 flex items-center gap-1.5 flex-wrap">
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-muted/40 text-[10px]">
            {triggerLabel(deposit.triggerReason)}
          </span>
          <span>
            Logged {new Date(deposit.intentLoggedAt).toLocaleString()}
          </span>
        </div>
      </div>
      <div className="text-right shrink-0">
        <div className="text-base font-semibold text-foreground tabular-nums">
          ${deposit.amountUsd.toFixed(2)}
        </div>
      </div>
      {(deposit.status === "intent" || deposit.status === "held") && (
        <button
          type="button"
          onClick={onVoid}
          disabled={voiding}
          className="p-1.5 rounded hover:bg-destructive/10 text-ink-soft hover:text-destructive disabled:opacity-50 shrink-0"
          title="Void"
        >
          {voiding ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <X className="h-3.5 w-3.5" />
          )}
        </button>
      )}
    </li>
  );
}

function DepositStatusPill({ status }: { status: DepositHold["status"] }) {
  const cfg: Record<
    DepositHold["status"],
    { bg: string; fg: string; label: string }
  > = {
    intent: {
      bg: "bg-amber-500/10",
      fg: "text-amber-700",
      label: "Intent",
    },
    held: { bg: "bg-emerald/10", fg: "text-emerald", label: "Held" },
    applied: {
      bg: "bg-emerald-500/10",
      fg: "text-emerald-700",
      label: "Applied",
    },
    refunded: {
      bg: "bg-muted/40",
      fg: "text-ink-soft",
      label: "Refunded",
    },
    voided: { bg: "bg-muted/40", fg: "text-ink-soft", label: "Voided" },
  };
  const c = cfg[status];
  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium shrink-0",
        c.bg,
        c.fg,
      )}
    >
      {c.label}
    </span>
  );
}

function triggerLabel(t: DepositHold["triggerReason"]): string {
  return {
    in_recovery_tier: "In-recovery patient",
    new_patient: "New patient",
    high_value_treatment: "High-value treatment",
  }[t];
}
