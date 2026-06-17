/**
 * /app/billing — Refill billing: fee-rules config + live ledger + invoices.
 *
 * v1.93.0 retired the tiered plan picker (starter/predictable/pro). Billing
 * is now one formula — Invoice = monthly_base + Σ(per-metric fee × wins) —
 * configured here: a monthly base (default $0) and a per-metric rule (flat $X
 * per win OR X% of the win's revenue, on/off). The default config IS the
 * marketed "Free + $5 per win." A visible counterfactual ledger shows the
 * current period's wins priced line-by-line, and the invoice history sits
 * below. Card capture is unchanged (Stripe hosted checkout / portal).
 */

import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  CheckCircle2,
  CreditCard,
  Download,
  ExternalLink,
  FileText,
  Loader2,
  Plus,
  RefreshCw,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { SettingsTabStrip } from "@/components/refill/SettingsTabStrip";
import { supabase } from "@/integrations/supabase/client";
import {
  getPaymentMethodStatus,
  listInvoices,
  type RefillInvoice,
  type RefillPaymentMethodStatus,
} from "@/server/refill-billing";
import {
  getBillingSettings,
  getBillingLedger,
  updateFeeRule,
  updateBillingConfig,
  type BillingSettings,
  type FeeRuleView,
  type BillingLedger,
} from "@/server/refill-fee-rules.functions";
import { useTenantMembership } from "@/lib/use-tenant-membership";
import { describeCap, type CapPeriod } from "@/lib/billing-metrics";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/billing/")({
  component: BillingPage,
});

function money(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Build a spreadsheet-friendly CSV of every win in the period and download it.
// The client already holds the full set (the ledger returns all wins), so no
// extra round-trip — this is the bookkeeping/audit artifact of the ledger.
function downloadWinsCsv(monthLabel: string, wins: BillingLedger["wins"]) {
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const header = ["Date", "Type", "Patient", "Visit revenue (USD)", "Charge (USD)"];
  const lines = wins.map((w) =>
    [
      w.date ? new Date(w.date).toISOString().slice(0, 10) : "",
      w.label,
      w.patientName ?? "",
      w.revenueUsd.toFixed(2),
      w.charge.toFixed(2),
    ]
      .map((c) => esc(String(c)))
      .join(","),
  );
  const csv = [header.map(esc).join(","), ...lines].join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `refill-ledger-${monthLabel.replace(/\s+/g, "-").toLowerCase()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function BillingPage() {
  const [settings, setSettings] = useState<BillingSettings | null>(null);
  const [ledger, setLedger] = useState<BillingLedger | null>(null);
  const [invoices, setInvoices] = useState<RefillInvoice[] | null>(null);
  const [pm, setPm] = useState<RefillPaymentMethodStatus | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [redirecting, setRedirecting] = useState<"add" | "manage" | null>(null);

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
      setAccessToken(token);
      const [s, led, inv, pmStatus] = await Promise.all([
        getBillingSettings({ data: { accessToken: token, viewAsUserId } }),
        getBillingLedger({ data: { accessToken: token, viewAsUserId } }),
        listInvoices({ data: { accessToken: token, viewAsUserId } }),
        getPaymentMethodStatus({ data: { accessToken: token } }).catch(() => null),
      ]);
      setSettings(s);
      setLedger(led);
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
    if (membership.status === "loading") return;
    void load();
  }, [load, membership.status]);

  // Return from Stripe Checkout setup-mode flow.
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
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
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

  return (
    <div className="min-h-screen bg-background">
      <PageHeader
        eyebrow="Settings"
        title="Billing"
        description="One formula: a monthly base (free by default) plus a small fee per win SmartSpa creates for you. Tune each metric below — you only ever pay on value created, and the ledger shows every charge."
        breadcrumbs={[
          { label: "Settings", to: "/app/refill/settings/account" },
          { label: "Billing" },
        ]}
        actions={
          <button
            type="button"
            onClick={() => void load()}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 text-[12px] font-semibold rounded-full px-3 py-1.5 transition disabled:opacity-50"
            style={{ background: "transparent", color: "#5a6068", border: "1px solid #e6e2d6" }}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
            Refresh
          </button>
        }
      />
      <SettingsTabStrip active="billing" />

      <div className="px-6 lg:px-10 py-8 max-w-5xl w-full mx-auto space-y-8">
        {loadError && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            {loadError}
          </div>
        )}

        {/* This-month scoreboard */}
        <ScoreboardCard ledger={ledger} />

        {/* Card on file */}
        <CardOnFileSection
          pm={pm}
          onAdd={handleAddCard}
          onManage={handleManageCard}
          redirecting={redirecting}
        />

        {/* Fee-rules config */}
        {settings && accessToken && (
          <FeeRulesPanel
            settings={settings}
            accessToken={accessToken}
            viewAsUserId={viewAsUserId}
            onChanged={() => void load()}
          />
        )}

        {/* Invoice history */}
        <section>
          <h2 className="text-[15px] font-semibold text-foreground mb-3">Invoice history</h2>
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
                No invoices yet. The first one generates on the 1st of next month,
                computed from the wins Refill created the month prior. You'll see it
                here as a draft you can audit.
              </p>
            </div>
          ) : (
            <div className="rounded-xl border border-border bg-card overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/30 text-[11px] font-medium tracking-wider text-ink-soft uppercase">
                  <tr>
                    <th className="px-4 py-2.5 text-left">Period</th>
                    <th className="px-3 py-2.5 text-right">Wins</th>
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
            Card capture is via Stripe — the same hosted checkout you've seen anywhere
            reputable. We never see your card number. Invoices charge automatically once
            a win is verified; manage or remove the card anytime via Manage.
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── This-month scoreboard ──────────────────────────────────────────────────
//
// The billing-trust rung (project_trusted_onboarding, step 8): the charge is a
// SCOREBOARD, not a tax. We lead with the value SmartSpa created for the spa and
// show our fee as the small, fair, leaveable cut beside it — never the hero. The
// three honesties (fair / conservative / leaveable) are stated plainly because
// we can afford radical billing honesty: the spa is the wedge, not the profit
// center. No billing math changes here — this only tells the truth more loudly.

function ScoreboardCard({ ledger }: { ledger: BillingLedger | null }) {
  if (!ledger) {
    return (
      <div className="rounded-xl border border-border bg-card p-5 flex items-center gap-2 text-sm text-ink-soft">
        <Loader2 className="h-4 w-4 animate-spin shrink-0" />
        Loading this month…
      </div>
    );
  }
  const monthLabel = new Date(ledger.periodStart).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  const activeLines = ledger.lines.filter((l) => l.count > 0);
  const winCount = ledger.wins.length;
  const recoveredUsd = +ledger.wins.reduce((s, w) => s + w.revenueUsd, 0).toFixed(2);
  const fee = ledger.totalDueUsd;
  // Only frame the ratio when we actually know the recovered revenue (many
  // wins carry no attributed $ — manufacturer/native price unknown — and we
  // never invent a number the data can't back).
  const hasRevenue = recoveredUsd > 0;
  const keptPct = hasRevenue && fee > 0 ? Math.floor(((recoveredUsd - fee) / recoveredUsd) * 100) : null;
  const multiple = hasRevenue && fee > 0 ? recoveredUsd / fee : null;

  return (
    <section className="rounded-2xl border border-emerald/30 bg-emerald-soft/40 overflow-hidden">
      <div className="px-5 sm:px-6 py-3 border-b border-emerald/20">
        <span className="text-xs font-semibold tracking-wider text-emerald uppercase">
          Your SmartSpa scoreboard · {monthLabel}
        </span>
      </div>

      <div className="px-5 sm:px-6 py-5">
        {winCount === 0 && ledger.pendingCount === 0 && fee <= 0 ? (
          <p className="text-sm text-ink-soft">
            No wins yet this month — so <span className="font-semibold text-foreground">$0</span>.
            Every booking SmartSpa creates for you shows up here, and you only ever
            pay on value created.
          </p>
        ) : (
          <>
            {/* Hero: what SmartSpa created (the win, not the bill) */}
            <div className="flex flex-wrap items-end gap-x-8 gap-y-2">
              <div>
                <div className="text-[11px] font-medium uppercase tracking-wide text-emerald/80">
                  SmartSpa booked for you
                </div>
                <div className="text-3xl font-bold tabular-nums text-emerald">
                  {winCount} {winCount === 1 ? "win" : "wins"}
                </div>
              </div>
              {hasRevenue && (
                <div>
                  <div className="text-[11px] font-medium uppercase tracking-wide text-emerald/80">
                    In visits recovered
                  </div>
                  <div className="text-3xl font-bold tabular-nums text-emerald">
                    {money(recoveredUsd)}
                  </div>
                </div>
              )}
            </div>

            {/* The fee, framed as the small fair cut — never the hero */}
            <div className="mt-4 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
              <span className="text-ink-soft">Your SmartSpa fee this month:</span>
              <span className="font-semibold tabular-nums text-foreground">{money(fee)}</span>
              {keptPct != null && multiple != null && (
                <span className="text-[12.5px] text-emerald">
                  · you keep {keptPct}% of what we recovered{" "}
                  <span className="text-ink-soft">({multiple >= 10 ? Math.round(multiple) : multiple.toFixed(1)}× your fee)</span>
                </span>
              )}
              {fee === 0 && (
                <span className="text-[12.5px] text-emerald">· completely free this month</span>
              )}
            </div>

            {/* Pending — recorded, not charged: the conservative proof */}
            {ledger.pendingCount > 0 && (
              <p className="mt-2 text-[12.5px] text-ink-soft">
                <span className="font-medium text-foreground">{ledger.pendingCount}</span> more
                recorded and <span className="font-medium">not charged</span> — we wait until the
                patient actually pays before a win ever bills.
              </p>
            )}
          </>
        )}

        {/* The three honesties: fair · conservative · leaveable */}
        <ul className="mt-4 grid gap-1.5 border-t border-emerald/20 pt-4 text-[12.5px] text-ink-soft sm:grid-cols-1">
          <li className="flex items-start gap-2">
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald mt-0.5 shrink-0" />
            Charged only after the patient actually pays — never on a maybe.
          </li>
          <li className="flex items-start gap-2">
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald mt-0.5 shrink-0" />
            You keep every dollar of the visit. The fee is a small flat amount per win, not a cut of your revenue.
          </li>
          <li className="flex items-start gap-2">
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald mt-0.5 shrink-0" />
            Turn any meter off — or remove your card — anytime. No lock-in.
          </li>
        </ul>

        {/* The math behind it — demoted to an audit detail */}
        {(activeLines.length > 0 || ledger.monthlyBaseUsd > 0 || ledger.whiteLabelAddonUsd > 0) && (
          <details className="mt-4 text-[12px]">
            <summary className="cursor-pointer text-emerald hover:underline">
              The math behind it — {money(fee)}{" "}
              {fee === 1 ? "charge" : "charges"} this month
            </summary>
            <div className="mt-2 space-y-1.5 rounded-lg bg-white/60 p-3">
              {ledger.monthlyBaseUsd > 0 && (
                <Row label="Monthly base" value={money(ledger.monthlyBaseUsd)} />
              )}
              {ledger.whiteLabelAddonUsd > 0 && (
                <Row
                  label="Your Brand — white-label"
                  value={money(ledger.whiteLabelAddonUsd)}
                />
              )}
              {activeLines.map((l) => (
                <Row
                  key={l.metricKey}
                  label={`${l.label} · ${l.count} ${l.count === 1 ? "win" : "wins"}${
                    l.mode === "percent" ? ` (${money(l.revenueUsd)})` : ""
                  }${l.capped ? ` · ${describeCap(l.capUsd, l.capPeriod) ?? "capped"} reached` : ""}`}
                  value={money(l.charge)}
                />
              ))}
              <div className="flex items-baseline justify-between gap-3 border-t border-emerald/20 pt-1.5 text-sm font-semibold">
                <span className="text-foreground">Total this month</span>
                <span className="tabular-nums text-foreground">{money(fee)}</span>
              </div>
              {ledger.wins.length > 0 && (
                <div className="pt-1 flex justify-end">
                  <button
                    type="button"
                    onClick={() => downloadWinsCsv(monthLabel, ledger.wins)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-emerald/30 px-2.5 py-1 text-emerald hover:bg-emerald/10 transition-colors"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Download every win (CSV)
                  </button>
                </div>
              )}
              {ledger.wins.length > 0 && (
                <ul className="mt-1 max-h-80 overflow-auto divide-y divide-emerald/10">
                  {ledger.wins.map((w) => (
                    <li key={w.id} className="flex items-center justify-between gap-3 py-1.5">
                      <span className="text-ink-soft min-w-0 truncate">
                        {new Date(w.date).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                        })}{" "}
                        · {w.label} · {w.patientName ?? "—"}
                      </span>
                      <span className="tabular-nums font-medium text-foreground shrink-0">
                        {money(w.charge)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </details>
        )}
      </div>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-ink-soft min-w-0">{label}</span>
      <span className="tabular-nums font-medium text-foreground shrink-0">{value}</span>
    </div>
  );
}

// ─── Fee-rules config panel ─────────────────────────────────────────────────

function FeeRulesPanel({
  settings,
  accessToken,
  viewAsUserId,
  onChanged,
}: {
  settings: BillingSettings;
  accessToken: string;
  viewAsUserId: string | undefined;
  onChanged: () => void;
}) {
  const [baseInput, setBaseInput] = useState(String(settings.monthlyBaseUsd));
  const [savingBase, setSavingBase] = useState(false);

  async function saveBase() {
    const val = Number(baseInput);
    if (!Number.isFinite(val) || val < 0) {
      setBaseInput(String(settings.monthlyBaseUsd));
      return;
    }
    if (val === settings.monthlyBaseUsd) return;
    setSavingBase(true);
    try {
      await updateBillingConfig({ data: { accessToken, viewAsUserId, monthlyBaseUsd: val } });
      toast.success("Monthly base saved.");
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save base.");
    } finally {
      setSavingBase(false);
    }
  }

  return (
    <section>
      <h2 className="text-[15px] font-semibold text-foreground mb-1">How you're billed</h2>
      <p className="text-xs text-ink-soft mb-3 max-w-2xl">
        Free by default. Set a fee per win for each thing Refill does for you — a flat
        dollar amount, or a percentage of the revenue that win created. Turn any metric
        off and it never bills — or cap one so it never charges more than a set amount
        per year, no matter how many wins it creates.
      </p>

      <div className="rounded-xl border border-border bg-card divide-y divide-border">
        {/* Monthly base */}
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div>
            <div className="text-sm font-medium text-foreground">Monthly base</div>
            <div className="text-[11px] text-ink-soft">
              A flat monthly fee on top of per-win charges. $0 = the free plan.
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="text-ink-soft text-sm">$</span>
            <input
              type="number"
              min={0}
              step="1"
              value={baseInput}
              onChange={(e) => setBaseInput(e.target.value)}
              onBlur={() => void saveBase()}
              className="w-24 rounded border border-border bg-background px-2 py-1.5 text-sm text-right tabular-nums focus:outline-none focus:ring-2 focus:ring-emerald/30"
            />
            <span className="text-[11px] text-ink-soft">/mo</span>
            {savingBase && <Loader2 className="h-3.5 w-3.5 animate-spin text-ink-soft" />}
          </div>
        </div>

        {/* Per-metric rules */}
        {settings.rules.map((rule) => (
          <FeeRuleRow
            key={rule.metricKey}
            rule={rule}
            accessToken={accessToken}
            viewAsUserId={viewAsUserId}
            onChanged={onChanged}
          />
        ))}
      </div>
    </section>
  );
}

function FeeRuleRow({
  rule,
  accessToken,
  viewAsUserId,
  onChanged,
}: {
  rule: FeeRuleView;
  accessToken: string;
  viewAsUserId: string | undefined;
  onChanged: () => void;
}) {
  // In percent mode the stored amount is a fraction (0.12); show it as 12.
  const display = rule.mode === "percent" ? rule.amount * 100 : rule.amount;
  const [amountInput, setAmountInput] = useState(String(display));
  const [capInput, setCapInput] = useState(rule.capUsd == null ? "" : String(rule.capUsd));
  const [saving, setSaving] = useState(false);

  async function save(next: {
    mode?: "flat" | "percent";
    amount?: number;
    enabled?: boolean;
    // capUsd: undefined = keep current, null = clear, number = set. The upsert
    // replaces the row, so every save MUST carry the cap or it would be wiped.
    capUsd?: number | null;
    capPeriod?: CapPeriod;
  }) {
    const mode = next.mode ?? rule.mode;
    let amount = next.amount ?? (mode === "percent" ? rule.amount * 100 : rule.amount);
    // Convert the displayed value back to storage units.
    amount = mode === "percent" ? +(amount / 100).toFixed(4) : +amount.toFixed(2);
    const enabled = next.enabled ?? rule.enabled;
    const capUsd = next.capUsd !== undefined ? next.capUsd : rule.capUsd;
    const capPeriod = next.capPeriod ?? rule.capPeriod ?? "annual";
    setSaving(true);
    try {
      await updateFeeRule({
        data: {
          accessToken,
          viewAsUserId,
          metricKey: rule.metricKey,
          mode,
          amount,
          enabled,
          capUsd,
          capPeriod,
        },
      });
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save rule.");
    } finally {
      setSaving(false);
    }
  }

  // Commit the cap input: empty / 0 / invalid → clear the cap; a positive
  // number → set an annual cap (the v1 surface).
  function commitCap() {
    const trimmed = capInput.trim();
    if (trimmed === "") {
      if (rule.capUsd != null) void save({ capUsd: null });
      return;
    }
    const v = Number(trimmed);
    if (!Number.isFinite(v) || v <= 0) {
      if (rule.capUsd != null) void save({ capUsd: null });
      setCapInput("");
      return;
    }
    const rounded = +v.toFixed(2);
    if (rounded === rule.capUsd) return;
    void save({ capUsd: rounded, capPeriod: "annual" });
  }

  const capReached = rule.capUsd != null && rule.ytdBilledUsd >= rule.capUsd - 1e-9;

  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground flex items-center gap-2">
            {rule.label}
            {!rule.live && (
              <span className="inline-flex items-center rounded-full bg-muted/50 text-ink-soft px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider">
                Coming soon
              </span>
            )}
          </div>
          <div className="text-[11px] text-ink-soft">{rule.description}</div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <select
            value={rule.mode}
            onChange={(e) => void save({ mode: e.target.value as "flat" | "percent" })}
            disabled={saving}
            className="rounded border border-border bg-background px-1.5 py-1.5 text-[12px] focus:outline-none focus:ring-2 focus:ring-emerald/30"
          >
            <option value="flat">$ / win</option>
            <option value="percent">% of revenue</option>
          </select>
          <div className="flex items-center gap-1">
            {rule.mode === "flat" && <span className="text-ink-soft text-sm">$</span>}
            <input
              type="number"
              min={0}
              step={rule.mode === "percent" ? "0.5" : "1"}
              value={amountInput}
              onChange={(e) => setAmountInput(e.target.value)}
              onBlur={() => {
                const v = Number(amountInput);
                if (Number.isFinite(v) && v >= 0) void save({ amount: v });
              }}
              className="w-20 rounded border border-border bg-background px-2 py-1.5 text-sm text-right tabular-nums focus:outline-none focus:ring-2 focus:ring-emerald/30"
            />
            {rule.mode === "percent" && <span className="text-ink-soft text-sm">%</span>}
          </div>
          <button
            type="button"
            onClick={() => void save({ enabled: !rule.enabled })}
            disabled={saving}
            aria-pressed={rule.enabled}
            className={cn(
              "relative h-5 w-9 rounded-full transition shrink-0",
              rule.enabled ? "bg-emerald" : "bg-muted",
            )}
            title={rule.enabled ? "Billing on" : "Billing off"}
          >
            <span
              className={cn(
                "absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all",
                rule.enabled ? "left-[18px]" : "left-0.5",
              )}
            />
          </button>
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin text-ink-soft" />}
        </div>
      </div>

      {/* Per-feature annual cap (opt-in) + live real-data preview. */}
      <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
        <span className="text-ink-soft">Cap this feature at</span>
        <span className="text-ink-soft">$</span>
        <input
          type="number"
          min={0}
          step="50"
          placeholder="no cap"
          value={capInput}
          onChange={(e) => setCapInput(e.target.value)}
          onBlur={commitCap}
          disabled={saving}
          className="w-24 rounded border border-border bg-background px-2 py-1 text-[12px] text-right tabular-nums focus:outline-none focus:ring-2 focus:ring-emerald/30"
        />
        <span className="text-ink-soft">/ year</span>

        {rule.capUsd != null ? (
          <span
            className={cn(
              "inline-flex items-center rounded-full px-1.5 py-0.5 text-[10.5px] font-medium",
              capReached ? "bg-emerald-soft text-emerald" : "bg-muted/50 text-ink-soft",
            )}
            title={describeCap(rule.capUsd, rule.capPeriod) ?? undefined}
          >
            {capReached
              ? `Cap reached — free for the rest of ${new Date().getUTCFullYear()}`
              : `${money(rule.ytdBilledUsd)} of ${money(rule.capUsd)} used this year`}
          </span>
        ) : (
          rule.last90BilledUsd > 0 && (
            <span className="text-ink-soft">
              · billed {money(rule.last90BilledUsd)} over your last 90 days
            </span>
          )
        )}
      </div>
    </div>
  );
}

// ─── Card on file ────────────────────────────────────────────────────────────

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
          <div className="text-[11px] font-semibold text-emerald mb-0.5">Card on file</div>
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
            <div className="text-[11px] text-amber mt-1">Stripe test mode — no real charges</div>
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
        <div className="text-base font-semibold text-foreground">No card on file yet</div>
        <div className="text-xs text-ink-soft mt-0.5">
          Add one whenever you'd like — Refill never charges until a win is verified.
        </div>
      </div>
      <button
        type="button"
        onClick={onAdd}
        disabled={redirecting !== null}
        className="inline-flex items-center gap-1.5 rounded-md bg-emerald text-paper px-3.5 py-2 text-sm font-semibold hover:opacity-90 transition disabled:opacity-50"
      >
        {redirecting === "add" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
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
      <td className="px-3 py-3 text-right tabular-nums">
        <div>{invoice.recoveredRevenueCount}</div>
        {invoice.recoveredRevenueUsd > 0 && (
          <div className="text-[10px] text-ink-soft">{money(invoice.recoveredRevenueUsd)} value</div>
        )}
      </td>
      <td className="px-3 py-3 text-right tabular-nums font-semibold">
        {money(invoice.totalDueUsd)}
      </td>
      <td className="px-3 py-3 text-center">
        <InvoiceStatusPill status={invoice.status} />
      </td>
    </tr>
  );
}

function InvoiceStatusPill({ status }: { status: RefillInvoice["status"] }) {
  const cfg: Record<RefillInvoice["status"], { bg: string; fg: string; label: string }> = {
    draft: { bg: "bg-muted/40", fg: "text-ink-soft", label: "Draft" },
    sent: { bg: "bg-amber-soft", fg: "text-amber", label: "Sent" },
    paid: { bg: "bg-emerald-soft", fg: "text-emerald", label: "Paid" },
    failed: { bg: "bg-destructive/10", fg: "text-destructive", label: "Failed" },
    void: { bg: "bg-muted/40", fg: "text-ink-soft", label: "Void" },
  };
  const c = cfg[status];
  return (
    <span
      className={cn("inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium", c.bg, c.fg)}
    >
      {c.label}
    </span>
  );
}
