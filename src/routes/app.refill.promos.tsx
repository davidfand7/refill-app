/**
 * /app/refill/promos — Eligible manufacturer promotions surface (v1.14,
 * ported from openagenticv4 v341).
 *
 * The spa owner sees the manufacturer promotions she's eligible for, based
 * on which manufacturers' products she actually offers (matched at
 * claim-your-business via service.attachments.matchedProduct.manufacturer).
 * Each card shows the promo title, manufacturer, end date, tier range, and
 * an Express Interest / Dismiss action. Expressed interest signals the rep
 * who owns the promo (rep-side surface lives in openagenticv4's Liz CRM).
 *
 * Cross-tenant read happens server-side via the service-role admin client
 * (refill-promos.ts) — the spa never sees the rep's user_id or any
 * rep-private fields.
 *
 * Cleave changes from openagenticv4's v341:
 *   - Eyebrow "Emma(OS)" removed per feedback-emma-never-user-facing
 *     (Emma stays as the stealth codename, never user-surface)
 *   - All silently-broken shadcn tokens translated to brand tokens:
 *     bg-card → bg-white, border-border → border-rule, text-foreground
 *     → text-ink, bg-muted → bg-rule-soft, bg-background → bg-paper
 *   - bg-primary / text-primary references → bg-emerald / text-emerald
 *     per v1.11 sweep
 *   - bg-clay (expired badge) → bg-rose-soft; bg-sage (active badge)
 *     → bg-emerald-soft (agentiport's clay/sage tokens don't exist in
 *     refill-app's @theme)
 *   - Server fns import from @/server/refill-promos (the focused 3-fn
 *     spa-side subset) instead of @/server/promotions.functions (the
 *     2851-line Liz CRM bundle which intentionally stays openagenticv4-only)
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  AlertCircle,
  ArrowLeft,
  Calendar,
  Check,
  ExternalLink,
  Heart,
  Loader2,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { supabase } from "@/integrations/supabase/client";
import {
  dismissPromoForSpa,
  expressInterestInPromo,
  listEligiblePromosForSpa,
  type EligiblePromoForSpa,
} from "@/server/refill-promos";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/refill/promos")({
  component: RefillPromosPage,
});

type Filter = "active" | "all";

function RefillPromosPage() {
  const [rows, setRows] = useState<EligiblePromoForSpa[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<Filter>("active");

  async function load({ silent = false }: { silent?: boolean } = {}) {
    if (!silent) setLoading(true);
    setRefreshing(true);
    try {
      const { data: session } = await supabase.auth.getSession();
      const accessToken = session.session?.access_token;
      if (!accessToken) {
        toast.error("Please sign in.");
        return;
      }
      const fresh = await listEligiblePromosForSpa({ data: { accessToken } });
      setRows(fresh);
    } catch (e) {
      toast.error(`Couldn't load promos — ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const updateRow = (
    promotionId: string,
    next: Partial<EligiblePromoForSpa>,
  ) => {
    setRows((prev) =>
      prev.map((r) => (r.promotionId === promotionId ? { ...r, ...next } : r)),
    );
  };

  const visible = useMemo(() => {
    const filtered = filter === "active"
      ? rows.filter((r) => r.status === "active" || r.status === "upcoming")
      : rows;
    // Hide dismissed by default in the active filter (they're still in the
    // "all" view if the spa wants to un-dismiss).
    return filter === "active"
      ? filtered.filter((r) => r.spaInterestStatus !== "dismissed")
      : filtered;
  }, [rows, filter]);

  const activeUnseen = useMemo(
    () =>
      rows.filter(
        (r) =>
          r.status === "active" &&
          r.spaInterestStatus !== "dismissed" &&
          r.spaInterestStatus !== "interested",
      ).length,
    [rows],
  );

  return (
    <div>
      <PageHeader
        title="Eligible promos"
        description="Manufacturer offers based on the products you carry. Express interest to flag it for your rep."
      />

      <div className="px-6 lg:px-10 py-6 max-w-[1600px] mx-auto">
        {/* Summary strip */}
        <div className="mb-5 flex items-center justify-between rounded-xl border border-rule bg-white px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="rounded-full bg-emerald-soft p-2">
              <Sparkles className="h-4 w-4 text-emerald" />
            </div>
            <div>
              <div className="text-sm font-semibold text-ink">
                {loading
                  ? "Checking your manufacturers…"
                  : activeUnseen === 0
                    ? rows.length === 0
                      ? "No eligible promos yet"
                      : "You're up to date on active promos"
                    : `${activeUnseen} active ${activeUnseen === 1 ? "promo" : "promos"} to review`}
              </div>
              <div className="text-xs text-ink-soft">
                Promos surface here when you offer a service from that manufacturer's catalog.
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {rows.length > 0 && (
              <div className="flex rounded-lg border border-rule bg-paper p-0.5 text-xs">
                <button
                  type="button"
                  onClick={() => setFilter("active")}
                  className={cn(
                    "px-3 py-1 rounded-md transition-colors",
                    filter === "active" ? "bg-emerald text-paper" : "text-ink-soft hover:text-ink",
                  )}
                >
                  Active
                </button>
                <button
                  type="button"
                  onClick={() => setFilter("all")}
                  className={cn(
                    "px-3 py-1 rounded-md transition-colors",
                    filter === "all" ? "bg-emerald text-paper" : "text-ink-soft hover:text-ink",
                  )}
                >
                  All
                </button>
              </div>
            )}
            <button
              type="button"
              onClick={() => load({ silent: true })}
              disabled={refreshing}
              className="inline-flex items-center gap-1.5 rounded-lg border border-rule bg-paper px-3 py-1.5 text-xs font-medium text-ink-soft hover:text-ink hover:bg-rule-soft transition-colors disabled:opacity-60"
            >
              {refreshing ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
              Refresh
            </button>
          </div>
        </div>

        {/* Body */}
        {loading ? (
          <LoadingState />
        ) : visible.length === 0 ? (
          <EmptyState hasAny={rows.length > 0} />
        ) : (
          <div className="space-y-4">
            {visible.map((row) => (
              <PromoCard
                key={row.promotionId}
                row={row}
                onChange={(next) => updateRow(row.promotionId, next)}
              />
            ))}
          </div>
        )}

        {!loading && (
          <p className="mt-6 text-xs text-ink-soft text-center">
            Don't see a manufacturer you carry? Add it as a service from your{" "}
            <Link to="/app/refill" className="underline hover:text-emerald">dashboard</Link>{" "}
            and we'll match it against the live promos.
          </p>
        )}
      </div>
    </div>
  );
}

// ── PromoCard ─────────────────────────────────────────────────────────────

function PromoCard({
  row,
  onChange,
}: {
  row: EligiblePromoForSpa;
  onChange: (next: Partial<EligiblePromoForSpa>) => void;
}) {
  const [actioning, setActioning] = useState<"interest" | "dismiss" | null>(null);
  const [showMessageBox, setShowMessageBox] = useState(false);
  const [message, setMessage] = useState("");

  const handleInterest = async () => {
    setActioning("interest");
    try {
      const { data: session } = await supabase.auth.getSession();
      const accessToken = session.session?.access_token;
      if (!accessToken) throw new Error("Sign in required.");
      await expressInterestInPromo({
        data: {
          accessToken,
          promotionId: row.promotionId,
          message: message.trim() || undefined,
        },
      });
      onChange({
        spaInterestStatus: "interested",
        spaInterestUpdatedAt: new Date().toISOString(),
      });
      setShowMessageBox(false);
      setMessage("");
      toast.success("Your rep will see your interest the next time they check in.");
    } catch (e) {
      toast.error(`Couldn't save — ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setActioning(null);
    }
  };

  const handleDismiss = async () => {
    setActioning("dismiss");
    try {
      const { data: session } = await supabase.auth.getSession();
      const accessToken = session.session?.access_token;
      if (!accessToken) throw new Error("Sign in required.");
      await dismissPromoForSpa({
        data: { accessToken, promotionId: row.promotionId },
      });
      onChange({
        spaInterestStatus: "dismissed",
        spaInterestUpdatedAt: new Date().toISOString(),
      });
      toast.success(`Dismissed — ${row.title} won't show in your active list.`);
    } catch (e) {
      toast.error(`Couldn't dismiss — ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setActioning(null);
    }
  };

  const statusBadge = (() => {
    if (row.status === "upcoming") {
      return { label: "Upcoming", classes: "bg-rule-soft text-ink-soft" };
    }
    if (row.status === "expired") {
      return { label: "Ended", classes: "bg-rose-soft text-rose" };
    }
    if (row.daysToEnd !== null) {
      if (row.daysToEnd <= 7) return { label: `${row.daysToEnd}d left`, classes: "bg-amber-soft text-amber" };
      if (row.daysToEnd <= 30) return { label: `${row.daysToEnd}d left`, classes: "bg-emerald-soft text-emerald" };
      return { label: `${row.daysToEnd}d left`, classes: "bg-rule-soft text-ink-soft" };
    }
    return { label: "Active", classes: "bg-emerald-soft text-emerald" };
  })();

  return (
    <div className="rounded-xl border border-rule bg-white overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-rule">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-soft">
                {row.manufacturer}
              </span>
              <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold", statusBadge.classes)}>
                {statusBadge.label}
              </span>
              {row.spaInterestStatus === "interested" && (
                <span className="rounded-full bg-emerald-soft text-emerald px-2 py-0.5 text-[10px] font-semibold flex items-center gap-1">
                  <Heart className="h-2.5 w-2.5 fill-current" /> Interest noted
                </span>
              )}
              {row.spaInterestStatus === "dismissed" && (
                <span className="rounded-full bg-rule-soft text-ink-soft px-2 py-0.5 text-[10px] font-semibold">
                  Dismissed
                </span>
              )}
            </div>
            <h3 className="text-base font-semibold text-ink truncate">{row.title}</h3>
            {row.ends && (
              <div className="flex items-center gap-1.5 mt-1 text-xs text-ink-soft">
                <Calendar className="h-3 w-3" />
                Ends {formatDate(row.ends)}
                {row.sourceUrl && (
                  <>
                    <span className="text-ink-faint">·</span>
                    <a
                      href={row.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="hover:text-emerald inline-flex items-center gap-0.5"
                    >
                      Source <ExternalLink className="h-2.5 w-2.5" />
                    </a>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="px-5 py-4 space-y-3">
        {row.description && (
          <p className="text-sm text-ink leading-relaxed line-clamp-3">
            {row.description}
          </p>
        )}

        {/* Tier range chip */}
        {row.entryTier && row.bestTier && (
          <div className="rounded-lg border border-emerald/30 bg-emerald-soft px-3 py-2 space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-emerald">
                [VERIFIED]
              </span>
              <span className="text-[10px] text-ink-soft">
                {row.tierCount} {row.tierCount === 1 ? "tier" : "tiers"} from the manufacturer
              </span>
            </div>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <div className="text-[10px] uppercase tracking-wide text-ink-soft mb-0.5">Entry</div>
                <div className="font-mono font-semibold text-ink">{row.entryTier.code}</div>
                <div className="text-[11px] text-ink-soft mt-0.5">{row.entryTier.clause}</div>
              </div>
              {row.bestTier.code !== row.entryTier.code && (
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-ink-soft mb-0.5">Top tier</div>
                  <div className="font-mono font-semibold text-ink">{row.bestTier.code}</div>
                  <div className="text-[11px] text-ink-soft mt-0.5">{row.bestTier.clause}</div>
                </div>
              )}
            </div>
            <p className="text-[10px] text-ink-faint pt-0.5">
              Talk to your rep to confirm which tier matches your quarterly volume.
            </p>
          </div>
        )}

        {/* Optional message box for express-interest */}
        {showMessageBox && (
          <div className="space-y-1">
            <label className="text-[10px] font-semibold uppercase tracking-wide text-ink-soft">
              Note for your rep (optional)
            </label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="e.g. 'Interested in the upper tier — can you walk me through the volume math?'"
              rows={2}
              maxLength={500}
              className="w-full rounded-lg border border-rule bg-paper px-3 py-2 text-sm focus-visible:outline-none focus-visible:border-emerald resize-y"
            />
            <div className="text-[10px] text-ink-faint text-right">
              {message.length}/500
            </div>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-rule bg-rule-soft/40">
        {row.spaInterestStatus === "interested" ? (
          <div className="flex items-center gap-1.5 text-xs text-emerald">
            <Check className="h-3 w-3" />
            Your rep has been notified
          </div>
        ) : (
          <>
            <button
              type="button"
              onClick={handleDismiss}
              disabled={actioning !== null || row.spaInterestStatus === "dismissed"}
              className="inline-flex items-center gap-1.5 rounded-lg border border-rule bg-paper px-3 py-1.5 text-xs font-medium text-ink-soft hover:text-ink hover:bg-rule-soft transition-colors disabled:opacity-50"
            >
              {actioning === "dismiss" ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <X className="h-3 w-3" />
              )}
              {row.spaInterestStatus === "dismissed" ? "Dismissed" : "Not for me"}
            </button>
            {!showMessageBox ? (
              <button
                type="button"
                onClick={() => setShowMessageBox(true)}
                disabled={actioning !== null}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald px-3 py-1.5 text-xs font-medium text-paper hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                <Heart className="h-3 w-3" />
                I'm interested
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setShowMessageBox(false);
                    setMessage("");
                  }}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-rule bg-paper px-3 py-1.5 text-xs font-medium text-ink-soft hover:text-ink hover:bg-rule-soft transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleInterest}
                  disabled={actioning !== null}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald px-3 py-1.5 text-xs font-medium text-paper hover:opacity-90 transition-opacity disabled:opacity-50"
                >
                  {actioning === "interest" ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Heart className="h-3 w-3" />
                  )}
                  Notify my rep
                </button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Loading / empty states ────────────────────────────────────────────────

function LoadingState() {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-sm text-ink-soft">
      <Loader2 className="h-4 w-4 animate-spin" />
      Checking which promos match your services…
    </div>
  );
}

function EmptyState({ hasAny }: { hasAny: boolean }) {
  return (
    <div className="rounded-xl border border-dashed border-rule bg-white/50 px-6 py-12 text-center space-y-3">
      <div className="mx-auto h-12 w-12 rounded-full bg-emerald-soft flex items-center justify-center">
        {hasAny ? <Check className="h-6 w-6 text-emerald" /> : <AlertCircle className="h-6 w-6 text-emerald" />}
      </div>
      <div className="space-y-1">
        <p className="text-sm font-semibold text-ink">
          {hasAny ? "No active promos right now" : "No matched manufacturers yet"}
        </p>
        <p className="text-xs text-ink-soft max-w-md mx-auto">
          {hasAny
            ? "Switch to the All view to see upcoming or recently-ended promos. We'll surface new ones here as your rep adds them."
            : "Once you add services from a manufacturer's catalog (Botox, Juvederm, Sculptra, etc.) on your dashboard, we'll match you against the live promos for that manufacturer."}
        </p>
      </div>
      <Link
        to="/app/refill"
        className="inline-flex items-center gap-1.5 mt-2 text-xs text-ink-soft hover:text-emerald"
      >
        <ArrowLeft className="h-3 w-3" />
        Back to dashboard
      </Link>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}
