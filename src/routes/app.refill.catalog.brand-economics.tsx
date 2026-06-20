/**
 * Brand Economics — Pillar 2.1 surface (the hidden lever, made visible).
 *
 * Per-brand `margin_now` (base catalog margin + active manufacturer incentives)
 * + `patient value-feel`, ranked within each category so the substitutability
 * set reads at a glance. The owner maintains the Manufacturer Incentive Ledger
 * here via a structured form (the agentic plain-English parser is a fast-
 * follow). This is what the tier-aware Brand-Substitution Recommender (2.2)
 * reads. Internal-only; margin_now is the SPA's margin — unrelated to the $5.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Loader2, Plus, Save, Sparkles, Trash2, X } from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { supabase } from "@/integrations/supabase/client";
import { useTenantMembership } from "@/lib/use-tenant-membership";
import {
  getBrandEconomics,
  listIncentiveLedger,
  upsertIncentiveLedgerEntry,
  deleteIncentiveLedgerEntry,
  type BrandEconomicsBundle,
} from "@/server/refill-brand-economics.functions";
import {
  defaultBeneficiary,
  type BrandEconomics,
  type IncentiveBeneficiary,
  type IncentiveLedgerEntry,
  type IncentiveType,
} from "@/lib/brand-economics";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/refill/catalog/brand-economics")({
  component: BrandEconomicsPage,
});

const TYPE_OPTIONS: Array<{ value: IncentiveType; label: string }> = [
  { value: "rebate", label: "Rebate (mfr pays you back)" },
  { value: "sample", label: "Sample (free units)" },
  { value: "voucher", label: "Voucher (patient coupon)" },
  { value: "patient_reward", label: "Patient reward (loyalty)" },
  { value: "instant", label: "Instant savings" },
];

const CATEGORY_LABEL: Record<string, string> = {
  tox: "Tox",
  filler: "Filler",
  laser_consumable: "Laser consumable",
  facial: "Facial",
  skincare: "Skincare",
  other: "Other",
};

type Draft = {
  id?: string;
  brand: string;
  manufacturer: string;
  category: string;
  incentiveType: IncentiveType;
  beneficiary: IncentiveBeneficiary;
  amountUsd: string;
  perUnit: boolean;
  startsOn: string;
  endsOn: string;
  notes: string;
};

const EMPTY_DRAFT: Draft = {
  brand: "",
  manufacturer: "",
  category: "tox",
  incentiveType: "rebate",
  beneficiary: "spa",
  amountUsd: "",
  perUnit: true,
  startsOn: "",
  endsOn: "",
  notes: "",
};

const inputCls =
  "w-full rounded-md border border-rule bg-white px-3 py-2 text-[14px] text-ink focus:border-emerald/50 focus:outline-none focus:ring-2 focus:ring-emerald/20";

const fmtUsd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

function BrandEconomicsPage() {
  const membership = useTenantMembership();
  const viewAsUserId =
    membership.status === "tenant" ? membership.viewAsUserId : undefined;

  const [loading, setLoading] = useState(true);
  const [bundle, setBundle] = useState<BrandEconomicsBundle | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);

  async function reload() {
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    if (!token) return;
    const b = await getBrandEconomics({ data: { accessToken: token, viewAsUserId } });
    setBundle(b);
  }

  useEffect(() => {
    if (membership.status !== "tenant") return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token;
        if (!token) return;
        const b = await getBrandEconomics({ data: { accessToken: token, viewAsUserId } });
        if (!cancelled) setBundle(b);
      } catch (err) {
        if (!cancelled) toast.error(err instanceof Error ? err.message : "Couldn't load brand economics.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [membership.status, viewAsUserId]);

  // Group ranked economics by category for the panel.
  const byCategory = useMemo(() => {
    const groups: Array<{ category: string; rows: BrandEconomics[] }> = [];
    for (const e of bundle?.economics ?? []) {
      let g = groups.find((x) => x.category === e.category);
      if (!g) {
        g = { category: e.category, rows: [] };
        groups.push(g);
      }
      g.rows.push(e);
    }
    return groups;
  }, [bundle]);

  async function onSave(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const amount = Number(draft.amountUsd.trim());
    if (!draft.brand.trim()) return toast.error("Brand is required.");
    if (!Number.isFinite(amount) || amount < 0) return toast.error("Enter a valid amount.");
    setBusy(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Not signed in.");
      await upsertIncentiveLedgerEntry({
        data: {
          accessToken: token,
          viewAsUserId,
          entry: {
            id: draft.id,
            brand: draft.brand.trim(),
            manufacturer: draft.manufacturer.trim() || null,
            category: draft.category,
            incentiveType: draft.incentiveType,
            beneficiary: draft.beneficiary,
            amountUsd: amount,
            perUnit: draft.perUnit,
            startsOn: draft.startsOn || null,
            endsOn: draft.endsOn || null,
            notes: draft.notes.trim() || null,
          },
        },
      });
      toast.success(draft.id ? "Incentive updated." : "Incentive added.");
      setAdding(false);
      setDraft(EMPTY_DRAFT);
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save incentive.");
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(id: string) {
    setBusy(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Not signed in.");
      await deleteIncentiveLedgerEntry({ data: { accessToken: token, viewAsUserId, id } });
      toast.success("Incentive removed.");
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't remove incentive.");
    } finally {
      setBusy(false);
    }
  }

  function startEdit(entry: IncentiveLedgerEntry) {
    setDraft({
      id: entry.id,
      brand: entry.brand,
      manufacturer: entry.manufacturer ?? "",
      category: entry.category,
      incentiveType: entry.incentiveType,
      beneficiary: entry.beneficiary,
      amountUsd: String(entry.amountUsd),
      perUnit: entry.perUnit,
      startsOn: entry.startsOn ?? "",
      endsOn: entry.endsOn ?? "",
      notes: entry.notes ?? "",
    });
    setAdding(true);
  }

  // Inline "+ Add" from a row — pre-fills the form with that brand + the right
  // beneficiary so the owner only enters amount + dates.
  function openAddFor(r: BrandEconomics, beneficiary: IncentiveBeneficiary) {
    setDraft({
      ...EMPTY_DRAFT,
      brand: r.brand,
      manufacturer: r.manufacturer ?? "",
      category: r.category,
      beneficiary,
      incentiveType: beneficiary === "spa" ? "rebate" : "voucher",
    });
    setAdding(true);
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const addBtnCls =
    "inline-flex items-center gap-0.5 text-[11px] font-medium text-ink-faint hover:text-emerald-ink transition";

  return (
    <div>
      <PageHeader
        title="Brand economics"
        description="The hidden lever, made visible. Each brand's margin right now = your catalog margin (price − cost) plus any active manufacturer incentive, ranked within its category so the high-margin substitute is obvious. Maintain the incentive ledger below; this feeds the brand-substitution recommendations. Internal only — your margin, never the patient's view."
        actions={
          !adding && (
            <button
              type="button"
              onClick={() => {
                setDraft(EMPTY_DRAFT);
                setAdding(true);
              }}
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald px-4 py-2 text-[14px] font-semibold text-paper shadow-sm hover:opacity-95 transition"
            >
              <Plus className="h-4 w-4" />
              Add incentive
            </button>
          )
        }
      />

      <div className="border-b border-rule bg-paper/50">
        <div className="max-w-[960px] mx-auto px-4 lg:px-10 flex items-center gap-1">
          <Link
            to="/app/refill/catalog/services"
            className="inline-flex items-center gap-1.5 px-3 py-2 text-[12px] font-medium border-b-2 -mb-px border-transparent text-ink-soft hover:text-ink transition"
          >
            Services
          </Link>
          <Link
            to="/app/refill/catalog/products"
            className="inline-flex items-center gap-1.5 px-3 py-2 text-[12px] font-medium border-b-2 -mb-px border-transparent text-ink-soft hover:text-ink transition"
          >
            Products
          </Link>
          <Link
            to="/app/refill/catalog/brand-economics"
            className="inline-flex items-center gap-1.5 px-3 py-2 text-[12px] font-medium border-b-2 -mb-px border-emerald text-emerald-ink transition"
          >
            Brand economics
          </Link>
        </div>
      </div>

      <div className="px-6 lg:px-10 py-6 max-w-[960px] mx-auto space-y-6">
        {adding && (
          <form onSubmit={onSave} className="rounded-xl border border-rule bg-white p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-[15px] font-semibold text-ink">
                {draft.id ? "Edit incentive" : "Add incentive"}
              </h3>
              <button
                type="button"
                onClick={() => {
                  setAdding(false);
                  setDraft(EMPTY_DRAFT);
                }}
                className="text-ink-faint hover:text-ink"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <label className="block">
                <span className="text-[12px] font-medium text-ink-soft">Brand</span>
                <input
                  className={inputCls}
                  value={draft.brand}
                  onChange={(e) => setDraft((d) => ({ ...d, brand: e.target.value }))}
                  placeholder="Jeuveau"
                />
              </label>
              <label className="block">
                <span className="text-[12px] font-medium text-ink-soft">Manufacturer (optional)</span>
                <input
                  className={inputCls}
                  value={draft.manufacturer}
                  onChange={(e) => setDraft((d) => ({ ...d, manufacturer: e.target.value }))}
                  placeholder="evolus"
                />
              </label>
              <label className="block">
                <span className="text-[12px] font-medium text-ink-soft">Category</span>
                <select
                  className={inputCls}
                  value={draft.category}
                  onChange={(e) => setDraft((d) => ({ ...d, category: e.target.value }))}
                >
                  {Object.entries(CATEGORY_LABEL).map(([v, l]) => (
                    <option key={v} value={v}>{l}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <label className="block">
                <span className="text-[12px] font-medium text-ink-soft">Incentive type</span>
                <select
                  className={inputCls}
                  value={draft.incentiveType}
                  onChange={(e) => {
                    const t = e.target.value as IncentiveType;
                    setDraft((d) => ({ ...d, incentiveType: t, beneficiary: defaultBeneficiary(t) }));
                  }}
                >
                  {TYPE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-[12px] font-medium text-ink-soft">Accrues to</span>
                <select
                  className={inputCls}
                  value={draft.beneficiary}
                  onChange={(e) => setDraft((d) => ({ ...d, beneficiary: e.target.value as IncentiveBeneficiary }))}
                >
                  <option value="spa">You (lifts margin now)</option>
                  <option value="patient">Patient (value-feel)</option>
                </select>
              </label>
              <label className="block">
                <span className="text-[12px] font-medium text-ink-soft">Amount (USD)</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  className={inputCls}
                  value={draft.amountUsd}
                  onChange={(e) => setDraft((d) => ({ ...d, amountUsd: e.target.value }))}
                  placeholder="1.50"
                />
              </label>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
              <label className="flex items-center gap-2 text-[13px] font-medium text-ink-soft">
                <input
                  type="checkbox"
                  checked={draft.perUnit}
                  onChange={(e) => setDraft((d) => ({ ...d, perUnit: e.target.checked }))}
                  className="h-4 w-4 rounded border-rule text-emerald focus:ring-emerald/30"
                />
                Per unit (vs flat per treatment)
              </label>
              <label className="block">
                <span className="text-[12px] font-medium text-ink-soft">Starts (optional)</span>
                <input
                  type="date"
                  className={inputCls}
                  value={draft.startsOn}
                  onChange={(e) => setDraft((d) => ({ ...d, startsOn: e.target.value }))}
                />
              </label>
              <label className="block">
                <span className="text-[12px] font-medium text-ink-soft">Ends (optional)</span>
                <input
                  type="date"
                  className={inputCls}
                  value={draft.endsOn}
                  onChange={(e) => setDraft((d) => ({ ...d, endsOn: e.target.value }))}
                />
              </label>
            </div>
            <label className="block">
              <span className="text-[12px] font-medium text-ink-soft">Notes (optional)</span>
              <input
                className={inputCls}
                value={draft.notes}
                onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
                placeholder="Evolus Q2 loyalty push"
              />
            </label>
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={busy}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md bg-emerald px-4 py-2 text-[14px] font-semibold text-paper shadow-sm transition",
                  busy ? "opacity-60 cursor-wait" : "hover:opacity-95",
                )}
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                {draft.id ? "Save" : "Add"}
              </button>
            </div>
          </form>
        )}

        {loading ? (
          <div className="flex items-center gap-2 text-ink-soft text-sm py-12 justify-center">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading brand economics…
          </div>
        ) : !bundle || bundle.economics.length === 0 ? (
          <div className="rounded-xl border border-dashed border-rule bg-paper/40 p-8 text-center text-ink-soft text-sm">
            No products in your catalog yet. Add products (with cost + price) under the{" "}
            <Link to="/app/refill/catalog/products" className="text-emerald-ink font-medium underline">Products</Link>{" "}
            tab — margin economics compute from those, then you layer incentives on top here.
          </div>
        ) : (
          byCategory.map((g) => (
            <section key={g.category} className="rounded-xl border border-rule bg-white overflow-hidden">
              <div className="px-5 py-3 border-b border-rule bg-rule-soft/60">
                <div className="text-xs font-semibold uppercase tracking-wider text-ink-soft">
                  {CATEGORY_LABEL[g.category] ?? g.category}
                </div>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[11px] uppercase tracking-wider text-ink-faint">
                    <th className="px-5 py-2 text-left font-medium">Brand</th>
                    <th className="px-4 py-2 text-right font-medium">Base margin</th>
                    <th className="px-4 py-2 text-right font-medium">Active incentive</th>
                    <th className="px-4 py-2 text-right font-medium">Margin now</th>
                    <th className="px-4 py-2 text-right font-medium">Patient feels</th>
                  </tr>
                </thead>
                <tbody>
                  {g.rows.map((r, i) => {
                    const lift = r.spaIncentivePerUnit > 0;
                    const topOfCat = i === 0;
                    return (
                      <tr key={r.brand} className="border-t border-rule/60">
                        <td className="px-5 py-3">
                          <span className="font-medium text-ink">{r.brand}</span>
                          {topOfCat && (
                            <span
                              className="ml-2 inline-flex items-center rounded-full bg-emerald/10 text-emerald-ink px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider"
                              title="Highest margin-now in this category right now."
                            >
                              Best margin
                            </span>
                          )}
                          {r.manufacturer && (
                            <span className="ml-2 text-[11px] text-ink-faint">{r.manufacturer}</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-ink-soft">
                          {fmtUsd(r.baseMarginPerUnit)}/u
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {lift ? (
                            <span className="text-emerald-ink font-medium">+{fmtUsd(r.spaIncentivePerUnit)}/u</span>
                          ) : r.spaIncentiveFlat > 0 ? (
                            <span className="text-emerald-ink font-medium">+{fmtUsd(r.spaIncentiveFlat)} flat</span>
                          ) : (
                            <button type="button" onClick={() => openAddFor(r, "spa")} className={addBtnCls}>
                              <Plus className="h-3 w-3" /> Add
                            </button>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums font-semibold">
                          {fmtUsd(r.marginNowPerUnit)}/u
                          {r.marginNowPct != null && (
                            <span className="ml-1 text-[11px] font-normal text-ink-faint">
                              {Math.round(r.marginNowPct * 100)}%
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {r.patientValueFeel > 0 ? (
                            <span className="text-ink inline-flex items-center gap-1 justify-end">
                              <Sparkles className="h-3 w-3 text-emerald" />
                              {fmtUsd(r.patientValueFeel)}
                            </span>
                          ) : (
                            <button type="button" onClick={() => openAddFor(r, "patient")} className={addBtnCls}>
                              <Plus className="h-3 w-3" /> Add
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
          ))
        )}

        {/* The ledger — active + scheduled incentives, editable. */}
        {bundle && bundle.ledger.length > 0 && (
          <section className="rounded-xl border border-rule bg-white overflow-hidden">
            <div className="px-5 py-3 border-b border-rule bg-rule-soft/60">
              <div className="text-xs font-semibold uppercase tracking-wider text-ink-soft">
                Incentive ledger ({bundle.ledger.length})
              </div>
            </div>
            <ul className="divide-y divide-rule/60">
              {bundle.ledger.map((e) => {
                const active =
                  (!e.startsOn || bundle.todayIso >= e.startsOn) &&
                  (!e.endsOn || bundle.todayIso <= e.endsOn);
                return (
                  <li key={e.id} className="px-5 py-3 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-ink">{e.brand}</span>
                        <span className="text-[12px] text-ink-soft">
                          {e.incentiveType} · {fmtUsd(e.amountUsd)}{e.perUnit ? "/u" : " flat"} ·{" "}
                          {e.beneficiary === "spa" ? "your margin" : "patient value-feel"}
                        </span>
                        <span
                          className={cn(
                            "inline-flex items-center rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider",
                            active ? "bg-emerald/10 text-emerald-ink" : "bg-rule-soft text-ink-soft",
                          )}
                        >
                          {active ? "Active" : "Scheduled / ended"}
                        </span>
                      </div>
                      <div className="text-[11px] text-ink-faint">
                        {e.startsOn ?? "open"} → {e.endsOn ?? "ongoing"}
                        {e.notes ? ` · ${e.notes}` : ""}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => startEdit(e)}
                        className="text-[12px] font-medium text-ink-soft hover:text-ink"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => onDelete(e.id)}
                        disabled={busy}
                        className="text-ink-faint hover:text-rose"
                        title="Remove incentive"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
