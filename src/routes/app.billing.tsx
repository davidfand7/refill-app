/**
 * /app/billing — Refill pricing plan + monthly invoices (v1.4).
 *
 * Where the $$ flows. Three plans, one click to choose.
 *
 * History: the working BillingPage component lived for weeks inside
 * app.refill.billing.tsx behind a useShell() === "refill" redirect to
 * /app/billing — a route that was speced (v391) but the frontend was
 * never created. v1.4 finishes the lift: this file is the canonical
 * Refill billing surface; app.refill.billing.tsx is now a thin
 * back-compat redirect shim for any stale email links / bookmarks.
 *
 * The backend (server/refill-billing.ts) + Stripe checkout/portal
 * routes (api.refill-checkout.ts, api.refill-portal.ts) ship draft
 * invoices today. Stripe payment-method capture flips on per-tenant.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  ArrowLeft,
  CheckCircle2,
  CreditCard,
  DollarSign,
  FileText,
  Loader2,
  RefreshCw,
  Sparkles,
  Zap,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { supabase } from "@/integrations/supabase/client";
import {
  applyPricingPlan,
  getActivePlan,
  getPlanEconomics,
  listInvoices,
  type ActivePlan,
  type Invoice,
  type PricingPlan,
} from "@/server/emma-billing.functions";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/billing")({
  component: BillingPage,
});

const PLAN_META: Record<
  PricingPlan,
  { label: string; tagline: string; icon: typeof Zap; tone: "primary" | "neutral" | "amber" }
> = {
  performance: {
    label: "Performance",
    tagline: "Free. You only pay when Refill recovers revenue.",
    icon: Zap,
    tone: "primary",
  },
  predictable: {
    label: "Predictable",
    tagline: "Flat monthly fee. Everything included, no revenue share.",
    icon: FileText,
    tone: "neutral",
  },
  hybrid: {
    label: "Hybrid",
    tagline: "Lower monthly. Smaller share. Best of both.",
    icon: Sparkles,
    tone: "amber",
  },
};

function BillingPage() {
  const [active, setActive] = useState<ActivePlan>(null);
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [applyingPlan, setApplyingPlan] = useState<PricingPlan | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        setLoadError("Please sign in.");
        return;
      }
      const [a, inv] = await Promise.all([
        getActivePlan({ data: { accessToken: token } }),
        listInvoices({ data: { accessToken: token } }),
      ]);
      setActive(a);
      setInvoices(inv);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Couldn't load.");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function pickPlan(plan: PricingPlan) {
    if (active?.plan === plan) {
      toast.info(`You're already on the ${PLAN_META[plan].label} plan.`);
      return;
    }
    if (
      !window.confirm(
        active
          ? `Switch from ${PLAN_META[active.plan].label} to ${PLAN_META[plan].label}? Past invoices keep the plan they were generated under.`
          : `Activate the ${PLAN_META[plan].label} plan?`,
      )
    )
      return;
    setApplyingPlan(plan);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) return;
      const updated = await applyPricingPlan({
        data: { accessToken: token, plan },
      });
      setActive(updated);
      toast.success(`${PLAN_META[plan].label} plan activated.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't apply plan.");
    } finally {
      setApplyingPlan(null);
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <PageHeader
        eyebrow="Refill"
        title="Billing"
        description="The pricing model is the killshot: free + a small percentage of recovered revenue, with two alternatives if you prefer something predictable. Pick the shape that fits your model — you can switch anytime."
        breadcrumbs={[
          { label: "Refill", to: "/app/refill" },
          { label: "Billing" },
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

      <div className="px-6 lg:px-10 py-8 max-w-5xl w-full mx-auto space-y-8">
        {loadError && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            {loadError}
          </div>
        )}

        {/* Active plan banner */}
        {active && (
          <div className="rounded-2xl border border-primary/30 bg-primary/5 p-5 flex items-center gap-3">
            <div className="h-10 w-10 rounded-full bg-primary text-primary-foreground flex items-center justify-center shrink-0">
              <CheckCircle2 className="h-5 w-5" />
            </div>
            <div className="flex-1">
              <div className="text-xs font-medium tracking-wider text-primary uppercase mb-0.5">
                Active plan
              </div>
              <div className="text-base font-semibold text-foreground">
                {PLAN_META[active.plan].label} ·{" "}
                <span className="text-ink-soft font-normal">
                  {planSummary(active.plan, active.revenueSharePct, active.monthlyFlatUsd)}
                </span>
              </div>
              <div className="text-[11px] text-ink-soft mt-1">
                Since {new Date(active.planStartedAt).toLocaleDateString()}
                {active.stripeCustomerId
                  ? " · Stripe customer linked"
                  : " · Stripe linkage in v366.x · invoices stay in draft until then"}
              </div>
            </div>
          </div>
        )}

        {!active && !loadError && (
          <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-5">
            <h2 className="text-base font-semibold text-foreground mb-1">
              No active plan yet
            </h2>
            <p className="text-sm text-ink-soft">
              Pick a plan below. Until you do, Refill's recovery engine still
              runs — but no invoices generate. Your settings and data are
              independent of your billing choice.
            </p>
          </div>
        )}

        {/* Plan selector */}
        <section>
          <h2 className="text-sm font-semibold text-foreground mb-3 uppercase tracking-wider">
            Pick your plan
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {(["performance", "predictable", "hybrid"] as PricingPlan[]).map((p) => (
              <PlanCard
                key={p}
                plan={p}
                isActive={active?.plan === p}
                applying={applyingPlan === p}
                disabled={applyingPlan !== null}
                onPick={() => void pickPlan(p)}
              />
            ))}
          </div>
        </section>

        {/* Invoice history */}
        <section>
          <h2 className="text-sm font-semibold text-foreground mb-3 uppercase tracking-wider">
            Invoice history
          </h2>
          {invoices === null ? (
            <div className="flex items-center gap-2 text-sm text-ink-soft py-6">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading…
            </div>
          ) : invoices.length === 0 ? (
            <div className="rounded-2xl border border-border bg-card p-8 text-center">
              <div className="mx-auto h-12 w-12 rounded-full bg-muted/40 flex items-center justify-center mb-3">
                <FileText className="h-6 w-6 text-ink-soft" />
              </div>
              <p className="text-sm text-ink-soft max-w-md mx-auto">
                No invoices yet. The first one generates on the 1st of next
                month, computed from verified recovery events the month
                prior. You'll see it here as a draft you can audit.
              </p>
            </div>
          ) : (
            <div className="rounded-2xl border border-border bg-card overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/30 text-[11px] font-medium tracking-wider text-ink-soft uppercase">
                  <tr>
                    <th className="px-4 py-2.5 text-left">Period</th>
                    <th className="px-3 py-2.5 text-left">Plan</th>
                    <th className="px-3 py-2.5 text-right">Recovered</th>
                    <th className="px-3 py-2.5 text-right">Share</th>
                    <th className="px-3 py-2.5 text-right">Flat</th>
                    <th className="px-3 py-2.5 text-right">Due</th>
                    <th className="px-3 py-2.5 text-center">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((inv) => (
                    <InvoiceRow key={inv.id} invoice={inv} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Footer disclaimer */}
        <div className="rounded-xl bg-muted/30 border border-border p-4 flex items-start gap-3">
          <CreditCard className="h-4 w-4 text-ink-soft mt-0.5 shrink-0" />
          <p className="text-xs text-ink-soft leading-relaxed">
            v366 ships invoices in draft status — no payment method capture yet.
            v366.x adds the Stripe customer + auto-pay flow when you're ready
            to flip from auditing the math to actually paying it. Until then,
            consider every invoice a receipt — Refill is showing you what it
            would have charged.
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Plan card ────────────────────────────────────────────────────────────

function PlanCard({
  plan,
  isActive,
  applying,
  disabled,
  onPick,
}: {
  plan: PricingPlan;
  isActive: boolean;
  applying: boolean;
  disabled: boolean;
  onPick: () => void;
}) {
  const meta = PLAN_META[plan];
  const econ = getPlanEconomics(plan);
  const Icon = meta.icon;

  return (
    <div
      className={cn(
        "rounded-2xl border bg-card p-5 flex flex-col gap-3 transition",
        isActive
          ? "border-primary bg-primary/5 shadow-sm"
          : "border-border hover:border-foreground/30",
      )}
    >
      <div className="flex items-center gap-2">
        <div
          className={cn(
            "h-9 w-9 rounded-full flex items-center justify-center shrink-0",
            meta.tone === "primary" && "bg-primary/15 text-primary",
            meta.tone === "neutral" && "bg-muted/40 text-foreground",
            meta.tone === "amber" && "bg-amber-500/15 text-amber-700",
          )}
        >
          <Icon className="h-4 w-4" />
        </div>
        <h3 className="text-base font-semibold text-foreground">{meta.label}</h3>
        {isActive && (
          <span className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary/15 text-primary text-[10px] font-semibold uppercase tracking-wider">
            Active
          </span>
        )}
      </div>
      <p className="text-xs text-ink-soft min-h-[2.5em]">{meta.tagline}</p>

      <div className="border-t border-border pt-3 space-y-1.5">
        <Line
          label="Monthly fee"
          value={econ.monthly_flat_usd > 0 ? `$${econ.monthly_flat_usd}` : "$0 free"}
        />
        <Line
          label="Revenue share"
          value={
            econ.revenue_share_pct > 0
              ? `${(econ.revenue_share_pct * 100).toFixed(0)}% of recovered`
              : "0%"
          }
        />
        <Line
          label="Contract"
          value="Month-to-month, cancel anytime"
        />
      </div>

      <button
        type="button"
        onClick={onPick}
        disabled={disabled || isActive}
        className={cn(
          "mt-auto inline-flex items-center justify-center gap-1.5 rounded-md px-4 py-2 text-sm font-semibold transition",
          isActive
            ? "bg-muted/40 text-ink-soft cursor-not-allowed"
            : "bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50",
        )}
      >
        {applying ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : isActive ? (
          <CheckCircle2 className="h-4 w-4" />
        ) : (
          <Zap className="h-4 w-4" />
        )}
        {isActive ? "Current plan" : `Pick ${meta.label}`}
      </button>
    </div>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between text-xs">
      <span className="text-ink-soft">{label}</span>
      <span className="font-medium text-foreground">{value}</span>
    </div>
  );
}

// ─── Invoice row ──────────────────────────────────────────────────────────

function InvoiceRow({ invoice }: { invoice: Invoice }) {
  const start = new Date(invoice.periodStart);
  const periodLabel = start.toLocaleString("en-US", {
    month: "long",
    year: "numeric",
  });
  return (
    <tr className="border-t border-border">
      <td className="px-4 py-3 text-left">
        <div className="font-medium text-foreground">{periodLabel}</div>
        <div className="text-[10px] text-ink-soft">
          Generated {new Date(invoice.generatedAt).toLocaleDateString()}
        </div>
      </td>
      <td className="px-3 py-3 text-left text-xs text-ink-soft">
        {PLAN_META[invoice.planAtInvoice].label}
      </td>
      <td className="px-3 py-3 text-right tabular-nums">
        <div>${invoice.recoveredRevenueUsd.toLocaleString()}</div>
        <div className="text-[10px] text-ink-soft">
          {invoice.recoveredRevenueCount} event{invoice.recoveredRevenueCount === 1 ? "" : "s"}
        </div>
      </td>
      <td className="px-3 py-3 text-right tabular-nums">
        {invoice.shareDueUsd > 0
          ? `$${invoice.shareDueUsd.toLocaleString()}`
          : "—"}
        {invoice.revenueSharePct > 0 && (
          <div className="text-[10px] text-ink-soft">
            @ {(invoice.revenueSharePct * 100).toFixed(0)}%
          </div>
        )}
      </td>
      <td className="px-3 py-3 text-right tabular-nums">
        {invoice.monthlyFlatUsd > 0
          ? `$${invoice.monthlyFlatUsd.toLocaleString()}`
          : "—"}
      </td>
      <td className="px-3 py-3 text-right tabular-nums font-semibold">
        ${invoice.totalDueUsd.toLocaleString()}
      </td>
      <td className="px-3 py-3 text-center">
        <InvoiceStatusPill status={invoice.status} />
      </td>
    </tr>
  );
}

function InvoiceStatusPill({ status }: { status: Invoice["status"] }) {
  const cfg: Record<
    Invoice["status"],
    { bg: string; fg: string; label: string }
  > = {
    draft: { bg: "bg-muted/40", fg: "text-ink-soft", label: "Draft" },
    sent: { bg: "bg-amber-500/10", fg: "text-amber-700", label: "Sent" },
    paid: { bg: "bg-emerald-500/10", fg: "text-emerald-700", label: "Paid" },
    failed: { bg: "bg-destructive/10", fg: "text-destructive", label: "Failed" },
    void: { bg: "bg-muted/40", fg: "text-ink-soft", label: "Void" },
  };
  const c = cfg[status];
  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium",
        c.bg,
        c.fg,
      )}
    >
      {c.label}
    </span>
  );
}

function planSummary(
  plan: PricingPlan,
  revenueSharePct: number,
  monthlyFlatUsd: number,
): string {
  const sharePart = revenueSharePct > 0 ? `${(revenueSharePct * 100).toFixed(0)}% of recovered` : null;
  const flatPart = monthlyFlatUsd > 0 ? `$${monthlyFlatUsd}/mo` : null;
  if (sharePart && flatPart) return `${flatPart} + ${sharePart}`;
  if (sharePart) return sharePart;
  if (flatPart) return flatPart;
  return "free";
}
