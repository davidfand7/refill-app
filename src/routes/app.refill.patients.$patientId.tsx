/**
 * /app/refill/patients/$patientId — Patient Architecture P2 detail page.
 *
 * The "everything Emma knows about this patient" view. Mirrors the shape of
 * app.lizzie.accounts.$accountId.tsx (the rep-side analogue) on purpose —
 * symmetry between Lizzie(OS) and Emma(OS) makes the platform feel one,
 * even though the products are standalone (see project_emma_lizzie_independence).
 *
 * Sections, top to bottom:
 *   1. ContactCard         — phone, email, days-since-last, banned chip
 *   2. SummaryCard         — lifetime spend (gross + net), visits, first/last
 *   3. ManufacturerMixCard — line-count per manufacturer with brand chips
 *   4. LoyaltyCard         — rewards redemptions per program
 *   5. TransactionsSection — full table with kind chips + 12mo / all-time toggle
 *
 * URL key: patient_node uuid (mirrors v328's switch from lookupKey →
 * accountId — UUIDs survive name normalization changes cleanly).
 *
 * Established 2026-05-15 (Patient Architecture P2).
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Ban,
  Calendar,
  CalendarClock,
  Gift,
  Loader2,
  Mail,
  Phone,
  Sparkles,
  TrendingUp,
  Users,
  Wallet,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { supabase } from "@/integrations/supabase/client";
import {
  getPatientById,
  type PatientDetail,
  type PatientListRow,
  type PatientTransactionRow,
} from "@/server/patient-ingest.functions";
import type {
  ProductKind,
  ProductManufacturer,
} from "@/lib/product-manufacturer-map";

export const Route = createFileRoute("/app/refill/patients/$patientId")({
  component: PatientDetailPage,
});

type Window = "12mo" | "all";

function PatientDetailPage() {
  const { patientId } = Route.useParams();
  const [data, setData] = useState<PatientDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [windowMode, setWindowMode] = useState<Window>("12mo");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token;
        if (!token) {
          if (!cancelled) {
            setLoading(false);
            setLoadError("Please sign in to view this patient.");
          }
          return;
        }
        const detail = await getPatientById({
          data: { accessToken: token, patientId },
        });
        if (!cancelled) {
          setData(detail);
          setLoading(false);
          if (!detail) setLoadError("Patient not found.");
        }
      } catch (e) {
        if (!cancelled) {
          setLoading(false);
          setLoadError(e instanceof Error ? e.message : "Couldn't load patient.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [patientId]);

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <PageHeader
        title={data?.patient.displayName ?? (loading ? "Loading…" : "Patient")}
        description={
          data?.patient.firstVisit
            ? `Seen at your practice since ${formatDate(data.patient.firstVisit)}.`
            : undefined
        }
        breadcrumbs={[
          { label: "Refill", to: "/app/refill" },
          { label: "Patients", to: "/app/refill/patients" },
          { label: data?.patient.displayName ?? "Patient" },
        ]}
        actions={
          <Link
            to="/app/refill/patients"
            className="inline-flex items-center gap-1.5 rounded-lg border border-rule bg-white px-3 py-1.5 text-xs font-medium text-ink hover:bg-rule-soft transition"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            All patients
          </Link>
        }
      />

      <div className="flex-1 px-4 py-6 lg:px-10 max-w-5xl w-full mx-auto space-y-5">
        {loading ? (
          <div className="flex items-center justify-center text-sm text-ink-soft py-16">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            Loading patient…
          </div>
        ) : loadError ? (
          <div className="rounded-2xl border border-rose/30 bg-rose-soft p-5 text-sm">
            <div className="font-semibold text-rose">
              Couldn't load this patient
            </div>
            <p className="text-xs text-ink-soft mt-1">{loadError}</p>
            <Link
              to="/app/refill/patients"
              className="inline-flex items-center gap-1.5 mt-3 rounded-lg border border-rule bg-white px-3 py-1.5 text-xs font-medium hover:bg-rule-soft transition"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back to patient list
            </Link>
          </div>
        ) : data ? (
          <>
            <ContactCard patient={data.patient} />
            <SummaryCard patient={data.patient} />
            <ManufacturerMixCard patient={data.patient} />
            <LoyaltyCard patient={data.patient} />
            <TransactionsSection
              transactions={data.transactions}
              windowMode={windowMode}
              onWindowChange={setWindowMode}
            />
          </>
        ) : null}
      </div>
    </div>
  );
}

// ─── Contact card ─────────────────────────────────────────────────────────

function ContactCard({ patient }: { patient: PatientListRow }) {
  const hasAny = patient.phone || patient.email || patient.banned;
  if (!hasAny) {
    return (
      <section className="rounded-xl border border-dashed border-rule bg-white/50 px-5 py-4 text-xs text-ink-soft flex items-center justify-between gap-3">
        <span>
          No contact info on file for this patient.
        </span>
        <Link
          to="/app/refill/patients/contacts"
          className="inline-flex items-center gap-1.5 rounded-lg border border-rule bg-white px-3 py-1.5 text-xs font-medium hover:bg-rule-soft transition"
        >
          <Sparkles className="h-3.5 w-3.5" />
          Find a match
        </Link>
      </section>
    );
  }
  return (
    <section className="rounded-xl border border-rule bg-white px-5 py-4">
      <div className="flex flex-wrap items-start gap-x-8 gap-y-3">
        {patient.phone && (
          <Pair
            icon={<Phone className="h-3.5 w-3.5" />}
            label="Phone"
            value={
              <a
                href={`tel:${patient.phone}`}
                className="text-emerald hover:underline"
              >
                {formatPhone(patient.phone)}
              </a>
            }
          />
        )}
        {patient.email && (
          <Pair
            icon={<Mail className="h-3.5 w-3.5" />}
            label="Email"
            value={
              <a
                href={`mailto:${patient.email}`}
                className="text-emerald hover:underline"
              >
                {patient.email}
              </a>
            }
          />
        )}
        {patient.daysSinceLastAppointment !== null && (
          <Pair
            icon={<CalendarClock className="h-3.5 w-3.5" />}
            label="Days since last appt"
            value={patient.daysSinceLastAppointment.toLocaleString()}
          />
        )}
        {patient.banned && (
          <div className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-rose-soft text-rose px-3 py-1 text-[11px] font-semibold uppercase tracking-wider">
            <Ban className="h-3 w-3" />
            Banned — no outbound
          </div>
        )}
      </div>
    </section>
  );
}

// ─── Summary card ─────────────────────────────────────────────────────────

function SummaryCard({ patient }: { patient: PatientListRow }) {
  return (
    <section className="rounded-xl border border-rule bg-white overflow-hidden">
      <div className="px-5 py-3 border-b border-rule bg-rule-soft/60">
        <div className="text-xs font-semibold uppercase tracking-wider text-ink-soft">
          Lifetime
        </div>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 divide-x divide-rule">
        <Stat
          icon={<Users className="h-3.5 w-3.5" />}
          label="Total visits"
          value={patient.totalVisits.toLocaleString()}
        />
        <Stat
          icon={<Wallet className="h-3.5 w-3.5" />}
          label="Lifetime spend"
          value={formatCurrency(patient.lifetimeSpendUsd)}
          note={
            patient.lifetimeSpendUsd !== patient.netSpendUsd
              ? `net ${formatCurrency(patient.netSpendUsd)}`
              : undefined
          }
        />
        <Stat
          icon={<Calendar className="h-3.5 w-3.5" />}
          label="First visit"
          value={patient.firstVisit ? formatDate(patient.firstVisit) : "—"}
        />
        <Stat
          icon={<TrendingUp className="h-3.5 w-3.5" />}
          label="Last visit"
          value={patient.lastVisit ? formatDate(patient.lastVisit) : "—"}
        />
      </div>
    </section>
  );
}

// ─── Manufacturer mix card ────────────────────────────────────────────────

function ManufacturerMixCard({ patient }: { patient: PatientListRow }) {
  const entries = useMemo(
    () =>
      Object.entries(patient.productMix).sort(
        (a, b) => (b[1] ?? 0) - (a[1] ?? 0),
      ) as Array<[ProductManufacturer, number]>,
    [patient.productMix],
  );
  if (entries.length === 0) return null;
  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  return (
    <section className="rounded-xl border border-rule bg-white overflow-hidden">
      <div className="px-5 py-3 border-b border-rule bg-rule-soft/60 flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wider text-ink-soft">
          Brand mix
        </div>
        {patient.primaryManufacturer && (
          <span className="text-[11px] text-ink-soft">
            primary{" "}
            <ManufacturerChip mfr={patient.primaryManufacturer} compact />
          </span>
        )}
      </div>
      <div className="px-5 py-4 flex flex-wrap gap-2">
        {entries.map(([mfr, count]) => (
          <ManufacturerCount
            key={mfr}
            mfr={mfr}
            count={count}
            share={count / total}
          />
        ))}
      </div>
    </section>
  );
}

function ManufacturerCount({
  mfr,
  count,
  share,
}: {
  mfr: ProductManufacturer;
  count: number;
  share: number;
}) {
  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-rule bg-white px-3 py-1.5 text-xs">
      <ManufacturerChip mfr={mfr} compact />
      <span className="font-medium tabular-nums">{count.toLocaleString()}</span>
      <span className="text-ink-faint tabular-nums">
        ({Math.round(share * 100)}%)
      </span>
    </div>
  );
}

// ─── Loyalty card ─────────────────────────────────────────────────────────

function LoyaltyCard({ patient }: { patient: PatientListRow }) {
  const entries = useMemo(
    () =>
      Object.entries(patient.loyaltyEngagement).sort(
        (a, b) => (b[1] ?? 0) - (a[1] ?? 0),
      ) as Array<[ProductManufacturer, number]>,
    [patient.loyaltyEngagement],
  );
  if (entries.length === 0) return null;
  return (
    <section className="rounded-xl border border-rule bg-white overflow-hidden">
      <div className="px-5 py-3 border-b border-rule bg-rule-soft/60 flex items-center gap-2">
        <Gift className="h-3.5 w-3.5 text-ink-soft" />
        <div className="text-xs font-semibold uppercase tracking-wider text-ink-soft">
          Loyalty redemptions
        </div>
      </div>
      <div className="px-5 py-4 flex flex-wrap gap-3">
        {entries.map(([mfr, count]) => (
          <div
            key={mfr}
            className="inline-flex items-center gap-2 rounded-lg border border-rule bg-white px-3 py-2"
          >
            <ManufacturerChip mfr={mfr} compact />
            <div>
              <div className="text-sm font-semibold tabular-nums">
                {count.toLocaleString()}{" "}
                <span className="text-[11px] font-normal text-ink-soft">
                  redemption{count === 1 ? "" : "s"}
                </span>
              </div>
              <div className="text-[10px] text-ink-faint uppercase tracking-wider">
                {rewardProgramLabel(mfr)}
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// ─── Transactions section ─────────────────────────────────────────────────

function TransactionsSection({
  transactions,
  windowMode,
  onWindowChange,
}: {
  transactions: PatientTransactionRow[];
  windowMode: Window;
  onWindowChange: (w: Window) => void;
}) {
  const cutoffDate = useMemo(() => {
    if (windowMode === "all") return null;
    const d = new Date();
    d.setMonth(d.getMonth() - 12);
    return d.toISOString().slice(0, 10);
  }, [windowMode]);

  const filtered = useMemo(() => {
    if (!cutoffDate) return transactions;
    return transactions.filter((t) => t.transactionDate >= cutoffDate);
  }, [transactions, cutoffDate]);

  const grouped = useMemo(() => groupByDateInvoice(filtered), [filtered]);

  return (
    <section className="rounded-xl border border-rule bg-white overflow-hidden">
      <div className="px-5 py-3 border-b border-rule bg-rule-soft/60 flex items-center justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-ink-soft">
            Transactions
          </div>
          <div className="text-[11px] text-ink-faint mt-0.5">
            {filtered.length.toLocaleString()} line
            {filtered.length === 1 ? "" : "s"} ·{" "}
            {grouped.length.toLocaleString()} invoice
            {grouped.length === 1 ? "" : "s"} ·{" "}
            {windowMode === "12mo" ? "Last 12 months" : "All time"}
          </div>
        </div>
        <WindowToggle value={windowMode} onChange={onWindowChange} />
      </div>
      {filtered.length === 0 ? (
        <div className="px-5 py-10 text-center text-sm text-ink-soft">
          No transactions in this window.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-rule-soft/60">
              <tr className="text-left text-[10px] uppercase tracking-wider text-ink-soft">
                <th className="px-4 py-3 font-semibold">Date</th>
                <th className="px-4 py-3 font-semibold">Product</th>
                <th className="px-4 py-3 font-semibold">Brand</th>
                <th className="px-4 py-3 font-semibold text-right">Qty</th>
                <th className="px-4 py-3 font-semibold text-right">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {grouped.map((group) => (
                <InvoiceGroup key={group.key} group={group} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

type InvoiceGroupData = {
  key: string;
  date: string;
  invoiceNum: string | null;
  lines: PatientTransactionRow[];
  totalAmount: number;
};

function groupByDateInvoice(
  txns: PatientTransactionRow[],
): InvoiceGroupData[] {
  const byKey = new Map<string, InvoiceGroupData>();
  for (const t of txns) {
    const key = `${t.transactionDate}::${t.invoiceNum ?? ""}`;
    let g = byKey.get(key);
    if (!g) {
      g = {
        key,
        date: t.transactionDate,
        invoiceNum: t.invoiceNum,
        lines: [],
        totalAmount: 0,
      };
      byKey.set(key, g);
    }
    g.lines.push(t);
    g.totalAmount += t.amountUsd;
  }
  // Already date-desc from the server fn; keep the order.
  return Array.from(byKey.values());
}

function InvoiceGroup({ group }: { group: InvoiceGroupData }) {
  return (
    <>
      {group.lines.map((line, idx) => (
        <tr
          key={line.id}
          className={
            "hover:bg-rule-soft/40 transition " +
            (idx === 0 ? "border-t-2 border-rule" : "")
          }
        >
          <td className="px-4 py-3 align-top">
            {idx === 0 ? (
              <div>
                <div className="text-sm font-medium">
                  {formatDate(group.date)}
                </div>
                {group.invoiceNum && (
                  <div className="text-[11px] text-ink-faint">
                    Invoice #{group.invoiceNum}
                  </div>
                )}
              </div>
            ) : (
              <span className="text-ink-faint">·</span>
            )}
          </td>
          <td className="px-4 py-3">
            <div className="font-medium">{line.productName}</div>
            {line.description && line.description !== line.productName && (
              <div className="text-[11px] text-ink-faint">
                {line.description}
              </div>
            )}
            {line.productKind && (
              <div className="mt-1">
                <KindChip kind={line.productKind} />
              </div>
            )}
          </td>
          <td className="px-4 py-3">
            {line.productManufacturer ? (
              <ManufacturerChip mfr={line.productManufacturer} compact />
            ) : (
              <span className="text-ink-faint text-[11px]">—</span>
            )}
          </td>
          <td className="px-4 py-3 text-right tabular-nums text-ink-soft">
            {line.quantity !== null ? line.quantity.toLocaleString() : "—"}
          </td>
          <td
            className={
              "px-4 py-3 text-right tabular-nums font-medium " +
              (line.amountUsd < 0 ? "text-emerald-700 dark:text-emerald-400" : "")
            }
          >
            {formatCurrency(line.amountUsd)}
          </td>
        </tr>
      ))}
      {group.lines.length > 1 && (
        <tr className="bg-rule/20 text-[11px] text-ink-soft">
          <td className="px-4 py-2" colSpan={4}>
            Invoice total
          </td>
          <td className="px-4 py-2 text-right tabular-nums font-semibold">
            {formatCurrency(group.totalAmount)}
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Building blocks ──────────────────────────────────────────────────────

function Pair({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2">
      <div className="mt-0.5 text-ink-faint">{icon}</div>
      <div>
        <div className="text-[10px] uppercase tracking-wider text-ink-soft font-semibold">
          {label}
        </div>
        <div className="text-sm">{value}</div>
      </div>
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  note,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="px-5 py-4">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-ink-soft font-semibold mb-1">
        {icon}
        {label}
      </div>
      <div className="text-xl font-semibold tabular-nums">{value}</div>
      {note && <div className="text-[11px] text-ink-faint mt-0.5">{note}</div>}
    </div>
  );
}

function WindowToggle({
  value,
  onChange,
}: {
  value: Window;
  onChange: (w: Window) => void;
}) {
  return (
    <div className="inline-flex items-center rounded-lg border border-rule bg-white p-0.5 text-xs">
      <button
        type="button"
        onClick={() => onChange("12mo")}
        className={
          "px-3 py-1 rounded-md font-medium transition " +
          (value === "12mo"
            ? "bg-emerald text-paper"
            : "text-ink-soft hover:text-ink")
        }
      >
        Last 12mo
      </button>
      <button
        type="button"
        onClick={() => onChange("all")}
        className={
          "px-3 py-1 rounded-md font-medium transition " +
          (value === "all"
            ? "bg-emerald text-paper"
            : "text-ink-soft hover:text-ink")
        }
      >
        All time
      </button>
    </div>
  );
}

function ManufacturerChip({
  mfr,
  compact = false,
}: {
  mfr: ProductManufacturer;
  compact?: boolean;
}) {
  const palette =
    MANUFACTURER_COLORS[mfr] ?? "bg-rule text-ink";
  return (
    <span
      className={
        "inline-flex items-center rounded-full font-semibold uppercase tracking-wider " +
        (compact
          ? "px-2 py-0.5 text-[10px] "
          : "px-2.5 py-1 text-[11px] ") +
        palette
      }
    >
      {manufacturerLabel(mfr)}
    </span>
  );
}

function KindChip({ kind }: { kind: ProductKind }) {
  const cls = KIND_COLORS[kind] ?? "bg-rule text-ink";
  return (
    <span
      className={
        "inline-flex items-center rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider " +
        cls
      }
    >
      {kindLabel(kind)}
    </span>
  );
}

const MANUFACTURER_COLORS: Partial<Record<ProductManufacturer, string>> = {
  evolus: "bg-blue-100 text-blue-800 dark:bg-blue-500/20 dark:text-blue-200",
  abbvie: "bg-rose-100 text-rose-800 dark:bg-rose-500/20 dark:text-rose-200",
  merz: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200",
  galderma: "bg-amber-100 text-amber-900 dark:bg-amber-500/20 dark:text-amber-200",
  "abbvie-coolsculpting":
    "bg-purple-100 text-purple-800 dark:bg-purple-500/20 dark:text-purple-200",
  skinceuticals:
    "bg-stone-100 text-stone-800 dark:bg-stone-500/20 dark:text-stone-200",
  eltamd: "bg-sky-100 text-sky-800 dark:bg-sky-500/20 dark:text-sky-200",
  neocutis: "bg-teal-100 text-teal-800 dark:bg-teal-500/20 dark:text-teal-200",
  obagi: "bg-indigo-100 text-indigo-800 dark:bg-indigo-500/20 dark:text-indigo-200",
  sciton: "bg-orange-100 text-orange-800 dark:bg-orange-500/20 dark:text-orange-200",
};

const KIND_COLORS: Partial<Record<ProductKind, string>> = {
  toxin: "bg-blue-100 text-blue-800 dark:bg-blue-500/20 dark:text-blue-200",
  filler: "bg-violet-100 text-violet-800 dark:bg-violet-500/20 dark:text-violet-200",
  biostimulator:
    "bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-500/20 dark:text-fuchsia-200",
  device: "bg-orange-100 text-orange-800 dark:bg-orange-500/20 dark:text-orange-200",
  retail: "bg-stone-100 text-stone-800 dark:bg-stone-500/20 dark:text-stone-200",
  reward: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200",
  payment: "bg-slate-100 text-slate-700 dark:bg-slate-500/20 dark:text-slate-300",
  discount: "bg-amber-100 text-amber-900 dark:bg-amber-500/20 dark:text-amber-200",
  service: "bg-sky-100 text-sky-800 dark:bg-sky-500/20 dark:text-sky-200",
  note: "bg-rule text-ink",
};

function manufacturerLabel(mfr: ProductManufacturer): string {
  switch (mfr) {
    case "evolus":
      return "Evolus";
    case "abbvie":
      return "AbbVie";
    case "merz":
      return "Merz";
    case "galderma":
      return "Galderma";
    case "abbvie-coolsculpting":
      return "CoolSculpting";
    case "skinceuticals":
      return "SkinCeuticals";
    case "eltamd":
      return "EltaMD";
    case "neocutis":
      return "Neocutis";
    case "obagi":
      return "Obagi";
    case "revance":
      return "Revance";
    case "rha":
      return "RHA";
    case "sciton":
      return "Sciton";
    default:
      return mfr;
  }
}

function rewardProgramLabel(mfr: ProductManufacturer): string {
  switch (mfr) {
    case "evolus":
      return "Evolus Rewards";
    case "abbvie":
      return "Alle";
    case "merz":
      return "Merz Rewards";
    case "galderma":
      return "Aspire";
    default:
      return manufacturerLabel(mfr);
  }
}

function kindLabel(kind: ProductKind): string {
  switch (kind) {
    case "toxin":
      return "Toxin";
    case "filler":
      return "Filler";
    case "biostimulator":
      return "Biostim";
    case "device":
      return "Device";
    case "retail":
      return "Retail";
    case "reward":
      return "Reward";
    case "payment":
      return "Payment";
    case "discount":
      return "Discount";
    case "service":
      return "Service";
    case "note":
      return "Note";
    default:
      return kind;
  }
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/Denver",
  });
}

function formatPhone(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  if (!m) return e164;
  return `(${m[1]}) ${m[2]}-${m[3]}`;
}

function formatCurrency(usd: number): string {
  return usd.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

