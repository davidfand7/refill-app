/**
 * /app/rep/promotions — Promotions list view (v338.2 split).
 *
 * The first user-visible Promotions Engine surface. Shows every active +
 * upcoming + recently-expired promo in the rep's territory, ordered by
 * "soonest to end" so the urgent ones surface first.
 *
 * Each row: title · manufacturer · status chip · ends-in countdown · tier
 * count · eligible-accounts count · click-through to detail.
 *
 * Empty state for new users with no promos seeded.
 *
 * Demo-mode aware via useViewAs(). The two Evolus 2026-Q2 promos are
 * pre-seeded for both real and demo tenants.
 *
 * v338.2 split: was app.lizzie.promotions.tsx; renamed to index.tsx so the
 * parent app.lizzie.promotions.tsx can be a pure Outlet shell. Without that
 * split, TanStack file-routing treated the list as a layout that ate the
 * $promotionId child — the detail page was unreachable from the deployed
 * app. Same fix pattern as v331 at the /app/rep level.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  Layers,
  Loader2,
  RefreshCw,
  Sparkles,
  Users,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { supabase } from "@/integrations/supabase/client";
import { listPromotions, type PromoListRow } from "@/server/promotions.functions";
import { useViewAs } from "@/lib/demo-mode";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/rep/promotions/")({
  component: PromotionsListPage,
});

function PromotionsListPage() {
  const viewAs = useViewAs();
  const [rows, setRows] = useState<PromoListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  async function load({ silent = false }: { silent?: boolean } = {}) {
    if (!silent) setLoading(true);
    setRefreshing(true);
    try {
      const { data: session } = await supabase.auth.getSession();
      const accessToken = session.session?.access_token;
      if (!accessToken) {
        toast.error("Please sign in.");
        setLoading(false);
        setRefreshing(false);
        return;
      }
      const fresh = await listPromotions({ data: { accessToken, viewAs } });
      setRows(fresh);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't load promos.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewAs]);

  return (
    <div className="flex flex-col min-h-screen bg-background">
      <PageHeader
        eyebrow="Lizzie(OS)"
        title="Promotions"
        description="Every active, upcoming, and recently-expired promo across your territory."
        breadcrumbs={[{ label: "Liz", to: "/app/rep" }, { label: "Promotions" }]}
        actions={
          <div className="flex items-center gap-2">
            <Link
              to="/app/rep"
              className="inline-flex items-center gap-1.5 text-xs text-ink-soft hover:text-foreground rounded-full border border-border px-3 py-1.5"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back to chat
            </Link>
            <button
              type="button"
              onClick={() => void load({ silent: true })}
              disabled={refreshing}
              className="inline-flex items-center gap-1.5 text-xs text-ink-soft hover:text-foreground rounded-full border border-border px-3 py-1.5 disabled:opacity-50"
              aria-label="Refresh"
              title="Refresh"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
              Refresh
            </button>
          </div>
        }
      />

      <div className="flex-1 px-4 py-6 lg:px-10 max-w-6xl w-full mx-auto">
        {loading ? (
          <div className="flex items-center justify-center text-sm text-ink-soft py-16">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            Loading promotions…
          </div>
        ) : rows.length === 0 ? (
          <EmptyState />
        ) : (
          <PromoTable rows={rows} />
        )}
      </div>
    </div>
  );
}

// ── Table ──────────────────────────────────────────────────────────────────

function PromoTable({ rows }: { rows: PromoListRow[] }) {
  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="hidden md:grid grid-cols-[1.8fr_auto_auto_auto_auto] gap-3 px-5 py-2.5 border-b border-border bg-sidebar-accent/20 text-[10px] uppercase tracking-wider font-semibold text-ink-soft">
        <div>Promotion</div>
        <div>Status</div>
        <div>Ends</div>
        <div>Tiers</div>
        <div className="text-right">Accounts</div>
      </div>
      <ul className="divide-y divide-border">
        {rows.map((r) => (
          <PromoRow key={r.id} row={r} />
        ))}
      </ul>
    </div>
  );
}

function PromoRow({ row }: { row: PromoListRow }) {
  return (
    <li>
      <Link
        to="/app/rep/promotions/$promotionId"
        params={{ promotionId: row.id }}
        className="block px-5 py-3 hover:bg-sidebar-accent/10 transition"
      >
        <div className="grid grid-cols-1 md:grid-cols-[1.8fr_auto_auto_auto_auto] gap-3 items-center">
          <div className="min-w-0">
            <div className="font-medium text-foreground truncate">{row.title}</div>
            <div className="text-[11px] text-ink-soft mt-0.5 flex items-center gap-1.5">
              {row.manufacturer && (
                <ManufacturerChip manufacturer={row.manufacturer} />
              )}
              {row.promoKind && (
                <>
                  <span className="text-ink-soft/40">·</span>
                  <span className="capitalize">{row.promoKind.replace("-", " ")}</span>
                </>
              )}
            </div>
          </div>
          <div className="md:text-center">
            <StatusChip status={row.status} />
          </div>
          <div className="md:text-center text-[11px] text-ink-soft tabular-nums">
            <EndsCell ends={row.ends} daysToEnd={row.daysToEnd} status={row.status} />
          </div>
          <div className="md:text-center text-[12px] text-foreground">
            <span className="inline-flex items-center gap-1">
              <Layers className="h-3 w-3 text-ink-soft" />
              {row.tierCount}
            </span>
          </div>
          <div className="md:text-right text-[12px] text-foreground inline-flex items-center justify-end gap-2">
            <Users className="h-3 w-3 text-ink-soft" />
            <span className="tabular-nums">{row.eligibleAccountCount}</span>
            <ChevronRight className="h-4 w-4 text-ink-soft/60" />
          </div>
        </div>
      </Link>
    </li>
  );
}

function StatusChip({ status }: { status: PromoListRow["status"] }) {
  const variants = {
    active: { label: "Active", classes: "bg-emerald-50 text-emerald-700 border-emerald-200" },
    upcoming: { label: "Upcoming", classes: "bg-slate-50 text-slate-700 border-slate-200" },
    expired: { label: "Expired", classes: "bg-rose-50 text-rose-700 border-rose-200" },
    unknown: { label: "Undated", classes: "bg-amber-50 text-amber-700 border-amber-200" },
  };
  const v = variants[status];
  return (
    <span
      className={cn(
        "inline-flex items-center text-[10px] uppercase tracking-wider font-semibold rounded-full px-2 py-0.5 border",
        v.classes,
      )}
    >
      {v.label}
    </span>
  );
}

function ManufacturerChip({ manufacturer }: { manufacturer: string }) {
  const colors: Record<string, string> = {
    evolus: "bg-rose-50 text-rose-700",
    galderma: "bg-blue-50 text-blue-700",
    allergan: "bg-violet-50 text-violet-700",
    abbvie: "bg-violet-50 text-violet-700",
    merz: "bg-amber-50 text-amber-800",
    "merz-aesthetics": "bg-amber-50 text-amber-800",
  };
  const colorClass = colors[manufacturer.toLowerCase()] ?? "bg-slate-100 text-slate-700";
  return (
    <span className={cn("inline-block rounded-md px-1.5 py-px text-[10px] font-medium capitalize", colorClass)}>
      {manufacturer.replace("-", " ")}
    </span>
  );
}

function EndsCell({
  ends,
  daysToEnd,
  status,
}: {
  ends: string | null;
  daysToEnd: number | null;
  status: PromoListRow["status"];
}) {
  if (!ends) return <span className="text-ink-soft">—</span>;
  const formatted = new Date(ends + "T00:00:00").toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  if (status === "expired") {
    return <span>{formatted} <span className="text-ink-soft/70">· ended</span></span>;
  }
  if (daysToEnd !== null) {
    const tone = daysToEnd <= 7 ? "text-amber-700 font-medium" : "text-ink-soft";
    return (
      <span>
        {formatted}{" "}
        <span className={tone}>
          · {daysToEnd === 0 ? "today" : daysToEnd === 1 ? "tomorrow" : `${daysToEnd}d`}
        </span>
      </span>
    );
  }
  return <span>{formatted}</span>;
}

// ── Empty state ────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="rounded-2xl border border-dashed border-border bg-card/40 px-8 py-16 text-center">
      <Sparkles className="h-7 w-7 text-ink-soft mx-auto" />
      <h2 className="mt-3 text-base font-semibold text-foreground">No promotions yet</h2>
      <p className="mt-1 text-sm text-ink-soft max-w-md mx-auto leading-relaxed">
        When a manufacturer launches a new promotion, it shows up here.
        For now, you can demo the experience by switching to demo data.
      </p>
      <Link
        to="/app/rep/today"
        className="inline-flex items-center gap-1.5 mt-5 rounded-full bg-primary px-4 py-2 text-xs font-medium text-white hover:opacity-90"
      >
        Open Today
        <ArrowRight className="h-3.5 w-3.5" />
      </Link>
    </div>
  );
}
