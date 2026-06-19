/**
 * RepPromosCard — the rep-interest loop, folded into the unified Rewards
 * offers surface (v2.94, manufacturer-consolidation step 3).
 *
 * Was the standalone /app/refill/recognition/brand-promos page; the loop now
 * lives here as one more card on Rewards, alongside the manufacturer-promo
 * calendar + the spa's own offers. The spa sees manufacturer promos it's
 * eligible for (matched by the products it carries), the [VERIFIED] tier
 * ladder, and an "I'm interested → ping my rep" + dismiss loop.
 *
 * Ships DARK: the parent only mounts this when `rep_loop_enabled` is ON
 * (getRepLoopEnabled). The eligible promos come from the rep-side CRM (Liz /
 * openagenticv4), which isn't feeding SmartSpa standalone yet — so this is
 * built + gated, flipped on once a rep pipeline exists.
 *
 * Self-contained (accessToken prop) so it mounts as a Rewards card.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Calendar,
  Check,
  ChevronDown,
  ExternalLink,
  Heart,
  Loader2,
  X,
} from "lucide-react";

import {
  dismissPromoForSpa,
  expressInterestInPromo,
  listEligiblePromosForSpa,
  type EligiblePromoForSpa,
} from "@/server/refill-promos";
import { cn } from "@/lib/utils";

type Filter = "active" | "all";

export function RepPromosCard({
  accessToken,
}: {
  accessToken: string | null;
  viewAsUserId?: string;
}) {
  const [rows, setRows] = useState<EligiblePromoForSpa[]>([]);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const [filter, setFilter] = useState<Filter>("active");

  const load = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    try {
      const fresh = await listEligiblePromosForSpa({ data: { accessToken } });
      setRows(fresh);
    } catch {
      /* leave list empty on error — the loop is best-effort + dark */
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    void load();
  }, [load]);

  const updateRow = (promotionId: string, next: Partial<EligiblePromoForSpa>) => {
    setRows((prev) => prev.map((r) => (r.promotionId === promotionId ? { ...r, ...next } : r)));
  };

  const visible = useMemo(() => {
    const filtered =
      filter === "active"
        ? rows.filter((r) => r.status === "active" || r.status === "upcoming")
        : rows;
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
    <div className="rounded-2xl border border-rule bg-paper/30 p-5">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="flex items-center gap-2 text-sm font-semibold text-ink"
        >
          <Heart className="h-4 w-4 text-emerald" />
          Brand promos for you
          {activeUnseen > 0 && (
            <span className="rounded-full bg-emerald-soft px-2 py-0.5 text-[10.5px] font-semibold text-emerald">
              {activeUnseen}
            </span>
          )}
        </button>
        {rows.length > 0 && !collapsed && (
          <div className="ml-auto flex rounded-lg border border-rule bg-paper p-0.5 text-[11px]">
            {(["active", "all"] as Filter[]).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={cn(
                  "px-2.5 py-1 rounded-md transition-colors capitalize",
                  filter === f ? "bg-emerald text-paper" : "text-ink-soft hover:text-ink",
                )}
              >
                {f}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? "Expand brand promos" : "Collapse brand promos"}
          className={cn("text-ink-faint hover:text-ink transition", rows.length > 0 && !collapsed ? "" : "ml-auto")}
        >
          <ChevronDown className={cn("h-4 w-4 transition-transform", collapsed && "-rotate-90")} />
        </button>
      </div>

      {!collapsed && (
        <>
          <p className="mt-2 text-[11px] text-ink-faint">
            Manufacturer offers based on the products you carry. Tell your rep
            you&apos;re interested in one tap — they&apos;ll see it at their next check-in.
          </p>

          {loading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-[12px] text-ink-faint">
              <Loader2 className="h-4 w-4 animate-spin" />
              Checking which promos match your services…
            </div>
          ) : visible.length === 0 ? (
            <p className="mt-4 text-[12px] text-ink-faint">
              {rows.length > 0
                ? "No active promos right now — switch to All to see upcoming or recently-ended ones."
                : "No matched manufacturers yet. Add services from a manufacturer's catalog (Botox, Juvéderm, Sculptra…) and we'll match you against live promos."}
            </p>
          ) : (
            <div className="mt-4 space-y-3">
              {visible.map((row) => (
                <RepPromoRow
                  key={row.promotionId}
                  row={row}
                  accessToken={accessToken}
                  onChange={(next) => updateRow(row.promotionId, next)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function RepPromoRow({
  row,
  accessToken,
  onChange,
}: {
  row: EligiblePromoForSpa;
  accessToken: string | null;
  onChange: (next: Partial<EligiblePromoForSpa>) => void;
}) {
  const [actioning, setActioning] = useState<"interest" | "dismiss" | null>(null);
  const [showMessageBox, setShowMessageBox] = useState(false);
  const [message, setMessage] = useState("");

  const handleInterest = async () => {
    if (!accessToken) return;
    setActioning("interest");
    try {
      await expressInterestInPromo({
        data: { accessToken, promotionId: row.promotionId, message: message.trim() || undefined },
      });
      onChange({ spaInterestStatus: "interested", spaInterestUpdatedAt: new Date().toISOString() });
      setShowMessageBox(false);
      setMessage("");
      toast.success("Your rep will see your interest at their next check-in.");
    } catch (e) {
      toast.error(`Couldn't save — ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setActioning(null);
    }
  };

  const handleDismiss = async () => {
    if (!accessToken) return;
    setActioning("dismiss");
    try {
      await dismissPromoForSpa({ data: { accessToken, promotionId: row.promotionId } });
      onChange({ spaInterestStatus: "dismissed", spaInterestUpdatedAt: new Date().toISOString() });
      toast.success(`Dismissed — ${row.title} won't show in your active list.`);
    } catch (e) {
      toast.error(`Couldn't dismiss — ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setActioning(null);
    }
  };

  const statusBadge = (() => {
    if (row.status === "upcoming") return { label: "Upcoming", classes: "bg-rule-soft text-ink-soft" };
    if (row.status === "expired") return { label: "Ended", classes: "bg-rose-soft text-rose" };
    if (row.daysToEnd !== null) {
      if (row.daysToEnd <= 7) return { label: `${row.daysToEnd}d left`, classes: "bg-amber-soft text-amber" };
      if (row.daysToEnd <= 30) return { label: `${row.daysToEnd}d left`, classes: "bg-emerald-soft text-emerald" };
      return { label: `${row.daysToEnd}d left`, classes: "bg-rule-soft text-ink-soft" };
    }
    return { label: "Active", classes: "bg-emerald-soft text-emerald" };
  })();

  return (
    <div className="rounded-xl border border-rule bg-white overflow-hidden">
      <div className="px-4 py-3">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-soft capitalize">
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
        <div className="text-[13px] font-semibold text-ink truncate">{row.title}</div>
        {row.ends && (
          <div className="flex items-center gap-1.5 mt-1 text-[11px] text-ink-soft">
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

        {row.description && (
          <p className="mt-2 text-[12px] text-ink leading-relaxed line-clamp-2">{row.description}</p>
        )}

        {/* Tier ladder ([VERIFIED]) */}
        {row.entryTier && row.bestTier && (
          <div className="mt-2 rounded-lg border border-emerald/30 bg-emerald-soft px-3 py-2 space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-emerald">[VERIFIED]</span>
              <span className="text-[10px] text-ink-soft">
                {row.tierCount} {row.tierCount === 1 ? "tier" : "tiers"} from the manufacturer
              </span>
            </div>
            <div className="grid grid-cols-2 gap-3 text-[11px]">
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

        {showMessageBox && (
          <div className="mt-2 space-y-1">
            <label className="text-[10px] font-semibold uppercase tracking-wide text-ink-soft">
              Note for your rep (optional)
            </label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="e.g. 'Interested in the upper tier — can you walk me through the volume math?'"
              rows={2}
              maxLength={500}
              className="w-full rounded-lg border border-rule bg-paper px-3 py-2 text-[13px] focus-visible:outline-none focus-visible:border-emerald resize-y"
            />
            <div className="text-[10px] text-ink-faint text-right">{message.length}/500</div>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-rule bg-rule-soft/40">
        {row.spaInterestStatus === "interested" ? (
          <div className="flex items-center gap-1.5 text-[11px] text-emerald">
            <Check className="h-3 w-3" /> Your rep has been notified
          </div>
        ) : (
          <>
            <button
              type="button"
              onClick={handleDismiss}
              disabled={actioning !== null || row.spaInterestStatus === "dismissed"}
              className="inline-flex items-center gap-1.5 rounded-lg border border-rule bg-paper px-3 py-1.5 text-[11px] font-medium text-ink-soft hover:text-ink hover:bg-rule-soft transition-colors disabled:opacity-50"
            >
              {actioning === "dismiss" ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
              {row.spaInterestStatus === "dismissed" ? "Dismissed" : "Not for me"}
            </button>
            {!showMessageBox ? (
              <button
                type="button"
                onClick={() => setShowMessageBox(true)}
                disabled={actioning !== null}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald px-3 py-1.5 text-[11px] font-medium text-paper hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                <Heart className="h-3 w-3" /> I&apos;m interested
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setShowMessageBox(false);
                    setMessage("");
                  }}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-rule bg-paper px-3 py-1.5 text-[11px] font-medium text-ink-soft hover:text-ink hover:bg-rule-soft transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleInterest}
                  disabled={actioning !== null}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald px-3 py-1.5 text-[11px] font-medium text-paper hover:opacity-90 transition-opacity disabled:opacity-50"
                >
                  {actioning === "interest" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Heart className="h-3 w-3" />}
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

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return iso;
  }
}
