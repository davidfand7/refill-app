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
  ExternalLink,
  FileText,
  Loader2,
  Plus,
  RefreshCw,
  Sparkles,
  Zap,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { supabase } from "@/integrations/supabase/client";
import {
  applyPricingPlan,
  getActivePlan,
  getPaymentMethodStatus,
  getPlanEconomics,
  listInvoices,
  type RefillActivePlan,
  type RefillInvoice,
  type RefillPaymentMethodStatus,
  type RefillPricingPlan,
} from "@/server/refill-billing";
import { useTenantMembership } from "@/lib/use-tenant-membership";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/billing")({
  component: BillingPage,
});

// PLAN_META is keyed on RefillPricingPlan (starter/predictable/pro), the
// canonical internal name. Visible labels keep the emma-era brand language
// (Performance/Predictable/Hybrid) so Karen's mental model isn't disturbed
// by an internal cleanup. A future copy-refresh ship can rename labels if
// the marketing story shifts.
const PLAN_META: Record<
  RefillPricingPlan,
  { label: string; tagline: string; icon: typeof Zap; tone: "primary" | "neutral" | "amber" }
> = {
  starter: {
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
  pro: {
    label: "Hybrid",
    tagline: "Lower monthly. Smaller share. Best of both.",
    icon: Sparkles,
    tone: "amber",
  },
};

function BillingPage() {
  const [active, setActive] = useState<RefillActivePlan>(null);
  const [invoices, setInvoices] = useState<RefillInvoice[] | null>(null);
  const [pm, setPm] = useState<RefillPaymentMethodStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [applyingPlan, setApplyingPlan] = useState<RefillPricingPlan | null>(null);
  const [redirecting, setRedirecting] = useState<"add" | "manage" | null>(null);

  // v1.20: admin viewing-as plumbing — getActivePlan + listInvoices accept
  // viewAsUserId. getPaymentMethodStatus is intentionally NOT opted-in;
  // it touches Stripe and admin shouldn't be inadvertently observing the
  // tenant's PM unless we explicitly choose to.
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
      const [a, inv, pmStatus] = await Promise.all([
        getActivePlan({ data: { accessToken: token, viewAsUserId } }),
        listInvoices({ data: { accessToken: token, viewAsUserId } }),
        // Card lookup hits Stripe — keep it best-effort so a Stripe outage
        // doesn't take down the rest of the billing page.
        getPaymentMethodStatus({ data: { accessToken: token } }).catch(
          () => null,
        ),
      ]);
      setActive(a);
      setInvoices(inv);
      setPm(pmStatus);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Couldn't load.");
    } finally {
      setRefreshing(false);
    }
  }, [viewAsUserId]);

  useEffect(() => {
    // v1.34.8.2: wait for tenant-membership before firing the load —
    // same race as the Recovery page. Without this gate, admin viewers
    // briefly hit getInvoicePreview without viewAsUserId and flash the
    // "No Refill tenant" error before the real data renders.
    if (membership.status === "loading") return;
    void load();
  }, [load, membership.status]);

  // Handle return from Stripe Checkout setup-mode flow. The success_url in
  // api.refill-checkout.ts pins ?upgrade=success&plan=… on the URL; we
  // toast + reload to pick up the freshly-attached payment method, then
  // strip the search params so a refresh doesn't re-trigger the toast.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const upgrade = params.get("upgrade");
    if (upgrade === "success") {
      toast.success("Card on file. You're all set.");
      window.history.replaceState({}, "", window.location.pathname);
      void load();
    } else if (upgrade === "cancelled") {
      toast.info("No card added. You can do it whenever you're ready.");
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, [load]);

  // Add-card always uses Checkout setup mode (plan="starter") — captures
  // the card with no charge regardless of which plan the spa is on. Per
  // [[project-trial-first-no-money-asks]], we never charge upfront; the
  // card just sits on file until the first verified-recovery invoice runs.
  async function handleAddCard() {
    setRedirecting("add");
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        toast.error("Please sign in again.");
        setRedirecting(null);
        return;
      }
      const res = await fetch("/api/refill-checkout", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ plan: "starter" }),
      });
      const body = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !body.url) {
        toast.error(body.error ?? "Couldn't start card capture.");
        setRedirecting(null);
        return;
      }
      window.location.href = body.url;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't start card capture.");
      setRedirecting(null);
    }
  }

  async function handleManageCard() {
    setRedirecting("manage");
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        toast.error("Please sign in again.");
        setRedirecting(null);
        return;
      }
      const res = await fetch("/api/refill-portal", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !body.url) {
        toast.error(body.error ?? "Couldn't open the Stripe portal.");
        setRedirecting(null);
        return;
      }
      window.location.href = body.url;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't open the Stripe portal.");
      setRedirecting(null);
    }
  }

  async function pickPlan(plan: RefillPricingPlan) {
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
        data: { accessToken: token, plan, viewAsUserId },
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
            className="inline-flex items-center gap-1.5 text-[12px] font-semibold rounded-full px-3 py-1.5 transition disabled:opacity-50"
            style={{
              background: "transparent",
              color: "#5a6068",
              border: "1px solid #e6e2d6",
            }}
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
          <div className="rounded-xl border border-emerald/30 bg-emerald-soft p-5 flex items-center gap-3">
            <div className="h-10 w-10 rounded-full bg-emerald text-paper flex items-center justify-center shrink-0">
              <CheckCircle2 className="h-5 w-5" />
            </div>
            <div className="flex-1">
              <div className="text-[11px] font-semibold text-emerald mb-0.5">
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
                {pm?.hasCardOnFile
                  ? " · Card on file · invoices charge automatically"
                  : " · No card on file yet · invoices stay in draft until added"}
              </div>
            </div>
          </div>
        )}

        {!active && !loadError && (
          <div className="rounded-xl border border-amber/30 bg-amber-soft p-5">
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

        {/* Card on file (v1.6) */}
        <CardOnFileSection
          pm={pm}
          onAdd={handleAddCard}
          onManage={handleManageCard}
          redirecting={redirecting}
        />

        {/* Plan selector */}
        <section>
          <h2 className="text-[15px] font-semibold text-foreground mb-3">
            Pick your plan
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {(["starter", "predictable", "pro"] as RefillPricingPlan[]).map((p) => (
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
          <h2 className="text-[15px] font-semibold text-foreground mb-3">
            Invoice history
          </h2>
          {invoices === null ? (
            <div className="flex items-center gap-2 text-sm text-ink-soft py-6">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading…
            </div>
          ) : invoices.length === 0 ? (
            <div className="rounded-xl border border-border bg-card p-8 text-center">
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
            <div className="rounded-xl border border-border bg-card overflow-hidden">
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
            Card capture is via Stripe — same hosted checkout you've seen
            anywhere reputable on the web. We never see your card number.
            Invoices charge automatically when you confirm a verified
            recovery; you can manage or remove the card anytime via Manage.
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
  plan: RefillPricingPlan;
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
        "rounded-xl border bg-card p-5 flex flex-col gap-3 transition",
        isActive
          ? "border-emerald bg-emerald-soft shadow-sm"
          : "border-border hover:border-foreground/30",
      )}
    >
      <div className="flex items-center gap-2">
        <div
          className={cn(
            "h-9 w-9 rounded-full flex items-center justify-center shrink-0",
            meta.tone === "primary" && "bg-emerald-soft text-emerald",
            meta.tone === "neutral" && "bg-muted/40 text-foreground",
            meta.tone === "amber" && "bg-amber-soft text-amber",
          )}
        >
          <Icon className="h-4 w-4" />
        </div>
        <h3 className="text-base font-semibold text-foreground">{meta.label}</h3>
        {isActive && (
          <span className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-soft text-emerald text-[10px] font-semibold uppercase tracking-wider">
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
            : "bg-emerald text-paper hover:opacity-90 disabled:opacity-50",
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

// ─── Card on file (v1.6) ─────────────────────────────────────────────────

function CardOnFileSection({
  pm,
  onAdd,
  onManage,
  redirecting,
}: {
  pm: RefillPaymentMethodStatus | null;
  onAdd: () => void;
  onManage: () => void;
  redirecting: "add" | "manage" | null;
}) {
  // Loading state — keep the row compact so the page doesn't jump on hydrate.
  if (!pm) {
    return (
      <div className="rounded-xl border border-border bg-card p-5 flex items-center gap-3 text-sm text-ink-soft">
        <Loader2 className="h-4 w-4 animate-spin shrink-0" />
        Checking card on file…
      </div>
    );
  }

  if (pm.hasCardOnFile) {
    return (
      <div className="rounded-xl border border-emerald/30 bg-emerald-soft p-5 flex items-center gap-3">
        <div className="h-10 w-10 rounded-full bg-emerald text-paper flex items-center justify-center shrink-0">
          <CreditCard className="h-5 w-5" />
        </div>
        <div className="flex-1">
          <div className="text-[11px] font-semibold text-emerald mb-0.5">
            Card on file
          </div>
          <div className="text-base font-semibold text-foreground">
            {formatBrand(pm.brand)} &middot;&middot; {pm.last4}
            {pm.expMonth && pm.expYear && (
              <span className="text-ink-soft font-normal text-sm">
                {" "}&middot; expires {String(pm.expMonth).padStart(2, "0")}/
                {String(pm.expYear).slice(-2)}
              </span>
            )}
          </div>
          {pm.stripeMode === "test" && (
            <div className="text-[11px] text-amber mt-1">
              Stripe test mode — no real charges
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onManage}
          disabled={redirecting !== null}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground hover:bg-muted/40 transition disabled:opacity-50"
        >
          {redirecting === "manage" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <ExternalLink className="h-4 w-4" />
          )}
          Manage
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card p-5 flex items-center gap-3">
      <div className="h-10 w-10 rounded-full bg-muted/40 text-ink-soft flex items-center justify-center shrink-0">
        <CreditCard className="h-5 w-5" />
      </div>
      <div className="flex-1">
        <div className="text-base font-semibold text-foreground">
          No card on file yet
        </div>
        <div className="text-xs text-ink-soft mt-0.5">
          Add one whenever you'd like — Refill never charges until a verified
          recovery lands AND you confirm it on the Recovery tab.
        </div>
      </div>
      <button
        type="button"
        onClick={onAdd}
        disabled={redirecting !== null}
        className="inline-flex items-center gap-1.5 rounded-md bg-emerald text-paper px-3.5 py-2 text-sm font-semibold hover:opacity-90 transition disabled:opacity-50"
      >
        {redirecting === "add" ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Plus className="h-4 w-4" />
        )}
        Add payment method
      </button>
    </div>
  );
}

function formatBrand(b: string | null): string {
  if (!b) return "Card";
  const map: Record<string, string> = {
    visa: "Visa",
    mastercard: "Mastercard",
    amex: "Amex",
    discover: "Discover",
    diners: "Diners",
    jcb: "JCB",
    unionpay: "UnionPay",
  };
  return map[b.toLowerCase()] ?? b.charAt(0).toUpperCase() + b.slice(1);
}

// ─── Invoice row ──────────────────────────────────────────────────────────

function InvoiceRow({ invoice }: { invoice: RefillInvoice }) {
  // periodStart is the UTC month boundary (e.g. 2026-05-01T00:00:00Z).
  // Without timeZone:"UTC" toLocaleString shifts it back one day in any
  // negative-offset locale (May 1 UTC → April 30 in MT), and the rendered
  // month-and-year flips to "April 2026". Pin to UTC so the period label
  // matches the period the row actually covers.
  const start = new Date(invoice.periodStart);
  const periodLabel = start.toLocaleString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
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

function InvoiceStatusPill({ status }: { status: RefillInvoice["status"] }) {
  const cfg: Record<
    RefillInvoice["status"],
    { bg: string; fg: string; label: string }
  > = {
    draft: { bg: "bg-muted/40", fg: "text-ink-soft", label: "Draft" },
    sent: { bg: "bg-amber-soft", fg: "text-amber", label: "Sent" },
    paid: { bg: "bg-emerald-soft", fg: "text-emerald", label: "Paid" },
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
  plan: RefillPricingPlan,
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
