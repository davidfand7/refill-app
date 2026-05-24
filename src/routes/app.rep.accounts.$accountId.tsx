/**
 * /app/rep/accounts/$accountId — per-account drill-down (v327, hotfixed v328).
 *
 * The "everything I know about this practice" view. Reps live in this kind
 * of page in every CRM they've ever touched; we didn't have one. Until v327
 * the accounts list was a dead-end — you could see a row, you couldn't drill
 * in. This page closes that gap.
 *
 * v328 changed the URL param from `lookupKey` to `accountId` (the row's
 * UUID) so the v316 report projector's colon-separated keys
 * (`report:galderma-accounts-l-territory:rejuv-skin-spa`) don't have to
 * survive URL encoding round-trips, and so duplicate-named accounts get
 * disambiguated by id instead of fuzzy by lookup key.
 *
 * What it shows (all from data we already have, no synthetic seed):
 *   - Header: practice name, address, contact, primary manufacturer.
 *   - Tier strip: per-family tier + QTD volume + threshold + qtr end.
 *   - Activity metrics: order count, YTD purchases, last order date, last
 *     send + last confirmation timestamps.
 *   - Recent orders table: real purchases from the v316/v317 projectors,
 *     sortable, with kind chips for points adjustments.
 *   - Sample-order activity: this account's `sample_order_intents` with
 *     state chips, links back to the chat thread + public landing page.
 *   - Editable rep notes: free-text field persisted to knowledge_nodes.
 *     Autosave on blur with a small "Saved 2s ago" confirmation.
 *
 * Entry points: clickable cards in /app/rep/accounts, practice-name
 * cells in /app/rep/sends.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  ArrowLeft,
  BadgeCheck,
  Building2,
  Calendar,
  CheckCircle2,
  Eye,
  ExternalLink,
  FileText,
  Loader2,
  Mail,
  MapPin,
  MessageSquare,
  Package,
  Phone,
  RefreshCw,
  Save,
  Sparkles,
  TrendingUp,
  User,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { supabase } from "@/integrations/supabase/client";
import {
  getLizAccountDetail,
  updateLizAccountNotes,
  type LizAccountDetail,
  type LizAccountOrder,
  type LizAccountSendIntent,
} from "@/server/liz-accounts.functions";
import { useDemoMode, useViewAs } from "@/lib/demo-mode";
import { familyLabel } from "@/lib/liz-csv";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/rep/accounts/$accountId")({
  component: AccountDetailPage,
});

function AccountDetailPage() {
  const { accountId } = Route.useParams();
  const viewAs = useViewAs();
  const { isDemo } = useDemoMode();
  const [data, setData] = useState<LizAccountDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  async function load({ silent = false }: { silent?: boolean } = {}) {
    if (!silent) setLoading(true);
    setRefreshing(true);
    try {
      const { data: session } = await supabase.auth.getSession();
      const accessToken = session.session?.access_token;
      if (!accessToken) {
        setLoadError("Please sign in to view this account.");
        setLoading(false);
        setRefreshing(false);
        return;
      }
      const result = await getLizAccountDetail({
        data: { accessToken, accountId, viewAs },
      });
      setData(result);
      setLoadError(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Couldn't load this account.";
      setLoadError(msg);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, viewAs]);

  return (
    <div className="flex flex-col min-h-screen bg-background">
      <PageHeader
        eyebrow="Lizzie(OS) · Account"
        title={data?.account.accountName ?? (loading ? "Loading…" : "Account")}
        description={data?.account.address ?? undefined}
        breadcrumbs={[
          { label: "Liz", to: "/app/rep" },
          { label: "Accounts", to: "/app/rep/accounts" },
          { label: data?.account.accountName ?? "Account" },
        ]}
        actions={
          <div className="flex items-center gap-2">
            <Link
              to="/app/rep/accounts"
              className="inline-flex items-center gap-1.5 text-xs text-ink-soft hover:text-foreground rounded-full border border-border px-3 py-1.5"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              All accounts
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

      <div className="flex-1 px-4 py-6 lg:px-10 max-w-5xl w-full mx-auto space-y-5">
        {loading ? (
          <div className="flex items-center justify-center text-sm text-ink-soft py-16">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            Loading account…
          </div>
        ) : loadError ? (
          <ErrorCard message={loadError} />
        ) : data ? (
          <>
            <ContactCard detail={data} />
            <TierCard detail={data} />
            <MetricsRow detail={data} />
            <OrdersSection orders={data.orders} />
            <SendActivitySection intents={data.intents} />
            <NotesCard
              accountId={accountId}
              initialNotes={data.account.notes ?? ""}
              accountUpdatedAt={data.account.updatedAt}
              readOnly={isDemo}
            />
          </>
        ) : null}
      </div>
    </div>
  );
}

// ── Contact card ───────────────────────────────────────────────────────────

function ContactCard({ detail }: { detail: LizAccountDetail }) {
  const { account } = detail;
  const hasContact =
    account.contactName || account.contactEmail || account.contactPhone;
  if (!account.address && !hasContact && !account.repAssignment) return null;
  return (
    <section className="rounded-xl border border-border bg-card px-5 py-4">
      <div className="flex flex-wrap items-start gap-x-8 gap-y-3">
        {account.address && (
          <Pair icon={<MapPin className="h-3.5 w-3.5" />} label="Address" value={account.address} />
        )}
        {account.contactName && (
          <Pair icon={<User className="h-3.5 w-3.5" />} label="Primary contact" value={account.contactName} />
        )}
        {account.contactEmail && (
          <Pair
            icon={<Mail className="h-3.5 w-3.5" />}
            label="Email"
            value={
              <a
                href={`mailto:${account.contactEmail}`}
                className="text-primary hover:underline"
              >
                {account.contactEmail}
              </a>
            }
          />
        )}
        {account.contactPhone && (
          <Pair
            icon={<Phone className="h-3.5 w-3.5" />}
            label="Phone"
            value={
              <a href={`tel:${account.contactPhone}`} className="text-primary hover:underline">
                {account.contactPhone}
              </a>
            }
          />
        )}
        {account.repAssignment && (
          <Pair
            icon={<Building2 className="h-3.5 w-3.5" />}
            label="Territory"
            value={prettyRepAssignment(account.repAssignment)}
          />
        )}
      </div>
    </section>
  );
}

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
    <div className="min-w-0">
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider font-medium text-ink-soft mb-0.5">
        {icon}
        <span>{label}</span>
      </div>
      <div className="text-sm text-foreground">{value}</div>
    </div>
  );
}

// ── Tier card ──────────────────────────────────────────────────────────────

function TierCard({ detail }: { detail: LizAccountDetail }) {
  const tiers = detail.account.tiers;
  if (tiers.length === 0) {
    return (
      <section className="rounded-xl border border-dashed border-border bg-card/40 px-5 py-4 text-xs text-ink-soft">
        No tier data on file for this account yet. Import a CSV with tier
        columns or upload a Galderma orders report — Liz will populate tiers
        on the next refresh.
      </section>
    );
  }
  return (
    <section className="rounded-xl border border-border bg-card px-5 py-4">
      <div className="text-[11px] uppercase tracking-wider font-semibold text-ink-soft mb-3">
        Tier position
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {tiers.map((t, i) => (
          <div
            key={`${t.family}-${i}`}
            className="rounded-lg border border-border bg-background px-4 py-3"
          >
            <div className="flex items-baseline justify-between gap-2 mb-1">
              <span className="text-xs font-medium text-ink-soft">
                {familyLabel(t.family)}
              </span>
              <span className="text-[11px] tabular-nums text-ink-soft">
                {t.qtr_end ? `Q ending ${t.qtr_end}` : ""}
              </span>
            </div>
            <div className="text-base font-semibold text-foreground">{t.tier}</div>
            <div className="mt-2 grid grid-cols-2 gap-x-3 text-[11px] text-ink-soft">
              {typeof t.qtd_volume === "number" && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider font-medium">QTD</div>
                  <div className="tabular-nums text-foreground">{usd(t.qtd_volume)}</div>
                </div>
              )}
              {typeof t.threshold_to_advance === "number" && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider font-medium">Next at</div>
                  <div className="tabular-nums text-foreground">{usd(t.threshold_to_advance)}</div>
                </div>
              )}
              {typeof t.threshold_to_maintain === "number" && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider font-medium">Maintain</div>
                  <div className="tabular-nums text-foreground">{usd(t.threshold_to_maintain)}</div>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// ── Metrics row ────────────────────────────────────────────────────────────

function MetricsRow({ detail }: { detail: LizAccountDetail }) {
  const { metrics, intents } = detail;
  const opened = intents.filter((i) => i.state === "viewed" || i.state === "confirmed").length;
  const confirmed = intents.filter((i) => i.state === "confirmed").length;
  return (
    <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <Metric
        label="YTD purchases"
        value={usd(metrics.ytdOrdersSumUsd)}
        sub={metrics.orderCount > 0 ? `${metrics.orderCount} orders` : "no orders yet"}
        icon={<TrendingUp className="h-4 w-4" />}
        accent="info"
      />
      <Metric
        label="Last order"
        value={metrics.lastOrderDate ? formatDate(metrics.lastOrderDate) : "—"}
        sub={metrics.lastOrderDate ? formatRelative(metrics.lastOrderDate) : "no purchases on file"}
        icon={<Package className="h-4 w-4" />}
        accent="default"
      />
      <Metric
        label="Sample orders sent"
        value={intents.length.toString()}
        sub={
          intents.length === 0
            ? "none yet"
            : `${opened} opened · ${confirmed} confirmed`
        }
        icon={<Mail className="h-4 w-4" />}
        accent="default"
      />
      <Metric
        label="Last confirmed"
        value={metrics.lastConfirmAt ? formatRelative(metrics.lastConfirmAt) : "—"}
        sub={metrics.lastConfirmAt ? formatDate(metrics.lastConfirmAt) : "awaiting first confirm"}
        icon={<BadgeCheck className="h-4 w-4" />}
        accent={metrics.lastConfirmAt ? "success" : "default"}
      />
    </section>
  );
}

function Metric({
  label,
  value,
  sub,
  icon,
  accent,
}: {
  label: string;
  value: string;
  sub: string;
  icon: React.ReactNode;
  accent: "default" | "info" | "success";
}) {
  const bg = {
    default: "bg-card",
    info: "bg-slate-50/60",
    success: "bg-emerald-50/40",
  }[accent];
  const valueClass = {
    default: "text-foreground",
    info: "text-slate-700",
    success: "text-emerald-700",
  }[accent];
  return (
    <div className={cn("rounded-xl border border-border px-4 py-3", bg)}>
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-ink-soft font-medium">
        {icon}
        <span>{label}</span>
      </div>
      <div className={cn("mt-1.5 text-xl font-semibold tabular-nums", valueClass)}>{value}</div>
      <div className="text-[11px] text-ink-soft mt-0.5">{sub}</div>
    </div>
  );
}

// ── Orders ─────────────────────────────────────────────────────────────────

function OrdersSection({ orders }: { orders: LizAccountOrder[] }) {
  const purchases = orders.filter((o) => o.kind === "purchase");
  if (purchases.length === 0) {
    return (
      <section className="rounded-xl border border-border bg-card px-5 py-4">
        <SectionHeader
          icon={<Package className="h-3.5 w-3.5" />}
          title="Order history"
          count={0}
        />
        <div className="text-sm text-ink-soft py-6 text-center">
          No purchases on file. Upload a Galderma orders or purchase-history
          report from the Knowledge Base to populate this view.
        </div>
      </section>
    );
  }
  const totals = useMemoTotals(purchases);
  return (
    <section className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="px-5 py-4">
        <SectionHeader
          icon={<Package className="h-3.5 w-3.5" />}
          title="Order history"
          count={purchases.length}
          sub={
            <span className="tabular-nums">
              {usd(totals.allTime)} all-time · {usd(totals.ytd)} YTD
            </span>
          }
        />
      </div>
      <div className="border-t border-border">
        <ul className="divide-y divide-border">
          {purchases.slice(0, 25).map((o) => (
            <li key={o.id} className="px-5 py-2.5">
              <div className="grid grid-cols-[auto_1fr_auto] gap-3 items-center">
                <div className="text-[11px] tabular-nums text-ink-soft w-20">
                  {o.dateOrdered ? formatDate(o.dateOrdered) : "—"}
                </div>
                <div className="min-w-0">
                  <div className="text-sm text-foreground truncate">{o.productName}</div>
                  {(o.quantity != null || o.invoiceNumber) && (
                    <div className="text-[11px] text-ink-soft mt-0.5">
                      {o.quantity != null ? `${o.quantity} units` : null}
                      {o.invoiceNumber ? ` · #${o.invoiceNumber}` : ""}
                    </div>
                  )}
                </div>
                <div className="text-right">
                  <div className="text-sm font-medium tabular-nums text-foreground">
                    {o.invoiceAmountUsd != null ? usd(o.invoiceAmountUsd) : "—"}
                  </div>
                  {o.pointsEarned != null && o.pointsEarned > 0 && (
                    <div className="text-[10px] tabular-nums text-emerald-700">
                      +{o.pointsEarned.toLocaleString()} pts
                    </div>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
        {purchases.length > 25 && (
          <div className="px-5 py-3 text-[11px] text-ink-soft text-center border-t border-border">
            Showing 25 of {purchases.length} orders.
          </div>
        )}
      </div>
    </section>
  );
}

function useMemoTotals(orders: LizAccountOrder[]) {
  return useMemo(() => {
    const ytdStart = new Date(new Date().getFullYear(), 0, 1).toISOString().slice(0, 10);
    let allTime = 0;
    let ytd = 0;
    for (const o of orders) {
      const amount = o.invoiceAmountUsd ?? 0;
      allTime += amount;
      if (o.dateOrdered && o.dateOrdered >= ytdStart) ytd += amount;
    }
    return { allTime, ytd };
  }, [orders]);
}

// ── Sample-order activity ──────────────────────────────────────────────────

function SendActivitySection({ intents }: { intents: LizAccountSendIntent[] }) {
  if (intents.length === 0) {
    return (
      <section className="rounded-xl border border-dashed border-border bg-card/40 px-5 py-6">
        <SectionHeader
          icon={<Mail className="h-3.5 w-3.5" />}
          title="Sample-order activity"
          count={0}
        />
        <p className="text-sm text-ink-soft mt-2">
          No sample orders sent to this practice yet.{" "}
          <Link to="/app/rep" className="text-primary hover:underline">
            Ask Liz to build one →
          </Link>
        </p>
      </section>
    );
  }
  return (
    <section className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="px-5 py-4">
        <SectionHeader
          icon={<Mail className="h-3.5 w-3.5" />}
          title="Sample-order activity"
          count={intents.length}
        />
      </div>
      <div className="border-t border-border">
        <ul className="divide-y divide-border">
          {intents.map((it) => (
            <IntentRow key={it.token} intent={it} />
          ))}
        </ul>
      </div>
    </section>
  );
}

function IntentRow({ intent }: { intent: LizAccountSendIntent }) {
  return (
    <li className="px-5 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <IntentStateChip state={intent.state} />
            <span className="text-[11px] text-ink-soft">
              {formatRelative(intent.sentAt)} · to {intent.practiceEmail}
            </span>
          </div>
          {intent.putsThemAtTier && (
            <div className="text-[11px] text-ink-soft mt-1 flex items-center gap-1">
              <Sparkles className="h-3 w-3" />
              Reaches {intent.putsThemAtTier}
            </div>
          )}
        </div>
        <div className="flex items-center gap-3">
          <div className="text-sm font-semibold tabular-nums text-foreground">
            {usd(intent.totalUsd)}
          </div>
          <div className="flex items-center gap-1">
            <a
              href={`/order/${intent.token}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[11px] text-ink-soft hover:text-foreground rounded-md px-2 py-1.5 hover:bg-sidebar-accent/30"
              title="View as the practice sees it"
            >
              <ExternalLink className="h-3 w-3" />
              <span className="hidden lg:inline">View page</span>
            </a>
            {intent.turnId && (
              <Link
                to="/app/rep"
                search={{ turn: intent.turnId }}
                className="inline-flex items-center gap-1 text-[11px] text-ink-soft hover:text-foreground rounded-md px-2 py-1.5 hover:bg-sidebar-accent/30"
                title="Jump to the chat reply"
              >
                <MessageSquare className="h-3 w-3" />
                <span className="hidden lg:inline">Open chat</span>
              </Link>
            )}
          </div>
        </div>
      </div>
      {intent.confirmedNote && (
        <div className="mt-2 text-[12px] text-emerald-900/80 bg-emerald-50/40 border border-emerald-100 rounded-md px-3 py-2 leading-snug">
          <span className="font-medium text-emerald-700">
            {intent.confirmedByName ? `${intent.confirmedByName} said:` : "They wrote back:"}
          </span>{" "}
          <span className="italic">"{intent.confirmedNote}"</span>
        </div>
      )}
    </li>
  );
}

function IntentStateChip({ state }: { state: LizAccountSendIntent["state"] }) {
  if (state === "confirmed") {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-emerald-700 font-medium">
        <BadgeCheck className="h-3 w-3" />
        Confirmed
      </span>
    );
  }
  if (state === "viewed") {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-slate-700 font-medium">
        <Eye className="h-3 w-3" />
        Opened
      </span>
    );
  }
  if (state === "revoked") {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-rose-700">
        Revoked
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-ink-soft">
      <CheckCircle2 className="h-3 w-3 text-emerald-600" />
      Sent
    </span>
  );
}

// ── Notes ──────────────────────────────────────────────────────────────────

function NotesCard({
  accountId,
  initialNotes,
  accountUpdatedAt,
  readOnly = false,
}: {
  accountId: string;
  initialNotes: string;
  accountUpdatedAt: string;
  readOnly?: boolean;
}) {
  const [notes, setNotes] = useState(initialNotes);
  const [savedAt, setSavedAt] = useState<string | null>(accountUpdatedAt);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const initialRef = useRef(initialNotes);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setNotes(initialNotes);
    initialRef.current = initialNotes;
    setDirty(false);
  }, [initialNotes, accountId]);

  async function persist(next: string) {
    setSaving(true);
    try {
      const { data: session } = await supabase.auth.getSession();
      const accessToken = session.session?.access_token;
      if (!accessToken) {
        toast.error("Please sign in to save notes.");
        return;
      }
      const res = await updateLizAccountNotes({
        data: { accessToken, accountId, notes: next },
      });
      setSavedAt(res.updatedAt);
      initialRef.current = next;
      setDirty(false);
    } catch (e) {
      toast.error("Couldn't save notes", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSaving(false);
    }
  }

  function handleChange(v: string) {
    setNotes(v);
    setDirty(v !== initialRef.current);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      if (v !== initialRef.current) void persist(v);
    }, 1200);
  }

  function handleBlur() {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (notes !== initialRef.current) void persist(notes);
  }

  return (
    <section className="rounded-xl border border-border bg-card px-5 py-4">
      <div className="flex items-center justify-between mb-2">
        <SectionHeader icon={<FileText className="h-3.5 w-3.5" />} title="Rep notes" />
        <div className="text-[11px] text-ink-soft inline-flex items-center gap-1">
          {saving ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin" />
              Saving…
            </>
          ) : dirty ? (
            <span className="text-amber-600">Unsaved</span>
          ) : savedAt ? (
            <>
              <Save className="h-3 w-3" />
              Saved {formatRelative(savedAt)}
            </>
          ) : null}
        </div>
      </div>
      <textarea
        value={notes}
        onChange={(e) => handleChange(e.target.value)}
        onBlur={handleBlur}
        readOnly={readOnly}
        rows={5}
        placeholder={readOnly
          ? "Notes are read-only in demo mode. Exit demo to edit your own."
          : "Things to remember about this practice — preferences, contacts beyond the listed one, off-the-record context, follow-up commitments. Saves automatically."}
        className={cn(
          "w-full rounded-md border border-border bg-background px-3 py-2 text-sm leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:border-primary/40 resize-y",
          readOnly && "opacity-60 cursor-not-allowed",
        )}
      />
    </section>
  );
}

// ── Section header + Error ─────────────────────────────────────────────────

function SectionHeader({
  icon,
  title,
  count,
  sub,
}: {
  icon: React.ReactNode;
  title: string;
  count?: number;
  sub?: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 flex-wrap">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider font-semibold text-ink-soft">
        {icon}
        <span>{title}</span>
        {typeof count === "number" && (
          <span className="ml-1 text-foreground/70 normal-case tracking-normal">
            ({count})
          </span>
        )}
      </div>
      {sub && <div className="text-[11px] text-ink-soft">{sub}</div>}
    </div>
  );
}

function ErrorCard({ message }: { message: string }) {
  return (
    <div className="rounded-2xl border border-rose-200 bg-rose-50/40 px-6 py-10 text-center">
      <Calendar className="h-7 w-7 mx-auto text-rose-600" />
      <h2 className="mt-3 text-base font-semibold text-rose-900">
        Couldn't load this account
      </h2>
      <p className="mt-1 text-sm text-rose-900/80 leading-relaxed">{message}</p>
      <Link
        to="/app/rep/accounts"
        className="mt-4 inline-flex items-center gap-1.5 text-xs text-rose-700 hover:text-rose-900 rounded-full border border-rose-200 px-3 py-1.5"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to accounts
      </Link>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function usd(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatRelative(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diff = now - then;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function prettyRepAssignment(rep: string): string {
  return rep
    .replace(/-rep$/, "")
    .replace(/^([a-z])/, (m) => m.toUpperCase())
    .concat(" rep");
}
