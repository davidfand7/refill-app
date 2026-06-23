/**
 * PromoIntelligenceCard — manufacturer-promo feed + manager (v2.153.0).
 *
 * Extracted from the Rewards page during the island cleanup so manufacturer
 * promos have ONE management home. Two render modes via props:
 *   - showImport (Rewards): the CSV-calendar upload — the "feed" stays where the
 *     other manufacturer-export uploads live.
 *   - showManage (Incentives): the list + on-Deals toggle + per-offer delivery
 *     editor — the single place to manage a promo.
 * A crossLink points each surface at the other ("Manage in Incentives →" /
 * "Import on Rewards →"). Both modes share the same offer-loading logic; only
 * the rendered sections differ. See project_rep_dealmaker sibling cleanup.
 */

import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  ArrowRight,
  Check,
  ChevronDown,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  SlidersHorizontal,
  Tag,
  Upload,
} from "lucide-react";

import { cn } from "@/lib/utils";
import {
  ingestPromoCalendar,
  listPromoOffers,
  setPromoOfferOnDeals,
  updateManufacturerOfferDelivery,
} from "@/server/refill-promo-calendar.functions";
import {
  normalizeForMatch,
  productMatchesName,
  type OfferCohort,
  type PromoOffer,
} from "@/lib/promo-calendar";
import { listServicesFn, type Service } from "@/server/refill-catalog";

const MFR_COHORT_OPTIONS: Array<{ value: OfferCohort; label: string }> = [
  { value: "all", label: "Everyone" },
  { value: "lapsed", label: "Lapsed" },
  { value: "new", label: "New" },
  { value: "vip", label: "VIP / A-list" },
  { value: "waitlist", label: "Waitlist" },
  { value: "expiring", label: "Expiring reward" },
];
const MFR_WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return iso;
  return `${m}/${d}/${y.slice(2)}`;
}

function deliverySummary(o: PromoOffer): string {
  const who =
    o.targetCohort && o.targetCohort !== "all"
      ? MFR_COHORT_OPTIONS.find((c) => c.value === o.targetCohort)?.label ?? o.targetCohort
      : "Everyone";
  const days =
    o.activeWeekdays && o.activeWeekdays.length > 0
      ? o.activeWeekdays
          .slice()
          .sort((a, b) => a - b)
          .map((d) => MFR_WEEKDAYS[d])
          .join(", ")
      : "every day";
  const cap = o.quantityCap != null ? ` · cap ${o.quantityCap}${o.activeWeekdays?.length ? "/wk" : ""}` : "";
  return `${who} · ${days}${cap}`;
}

function MfrDeliveryEditor({
  offer,
  accessToken,
  viewAsUserId,
  onSaved,
}: {
  offer: PromoOffer;
  accessToken: string | null;
  viewAsUserId?: string;
  onSaved: () => void;
}) {
  const [cohort, setCohort] = useState<OfferCohort>(offer.targetCohort ?? "all");
  const [weekdays, setWeekdays] = useState<Set<number>>(new Set(offer.activeWeekdays ?? []));
  const [cap, setCap] = useState(offer.quantityCap != null ? String(offer.quantityCap) : "");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!accessToken || !offer.id) return;
    const capN = cap.trim() ? Number(cap.trim()) : null;
    if (cap.trim() && (!Number.isInteger(capN) || (capN as number) <= 0)) {
      toast.error("Limit must be a whole number.");
      return;
    }
    setSaving(true);
    try {
      await updateManufacturerOfferDelivery({
        data: {
          accessToken,
          viewAsUserId,
          offerId: offer.id,
          targetCohort: cohort,
          activeWeekdays: weekdays.size ? [...weekdays].sort((a, b) => a - b) : null,
          quantityCap: capN,
        },
      });
      toast.success("Delivery saved — kept even when you re-import the calendar.");
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save delivery.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-2 rounded-xl border border-rule bg-paper/40 p-3 space-y-3">
      <div className="flex items-center gap-1.5 text-[11px] text-ink-faint">
        <KeyRound className="h-3 w-3" />
        Terms set by {offer.manufacturer || "the manufacturer"} — you choose who, when &amp; where.
      </div>

      <div>
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-soft">
          Who it&apos;s for
        </div>
        <div className="flex flex-wrap gap-1.5">
          {MFR_COHORT_OPTIONS.map((c) => (
            <button
              key={c.value}
              type="button"
              onClick={() => setCohort(c.value)}
              className={cn(
                "rounded-full px-3 py-1 text-[12px] font-semibold border transition",
                cohort === c.value
                  ? "bg-amber text-paper border-amber"
                  : "bg-white text-ink-soft border-rule hover:text-ink",
              )}
            >
              {c.label}
            </button>
          ))}
        </div>
        {cohort !== "all" && (
          <p className="mt-1.5 text-[11px] text-ink-faint leading-relaxed">
            Targeted: it won&apos;t show at public booking — it reaches your matching
            patients (push it from your offers list) and earns the $5 only when an
            in-cohort patient books it.
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-soft">
            Days (optional)
          </div>
          <div className="flex flex-wrap gap-1">
            {MFR_WEEKDAYS.map((wl, i) => {
              const on = weekdays.has(i);
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() =>
                    setWeekdays((prev) => {
                      const n = new Set(prev);
                      if (n.has(i)) n.delete(i);
                      else n.add(i);
                      return n;
                    })
                  }
                  className={cn(
                    "h-7 w-8 rounded text-[11px] font-semibold border transition",
                    on
                      ? "bg-amber text-paper border-amber"
                      : "bg-white text-ink-soft border-rule hover:text-ink",
                  )}
                >
                  {wl}
                </button>
              );
            })}
          </div>
          <p className="mt-1 text-[10.5px] text-ink-faint">Blank = every day.</p>
        </div>
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-soft">
            {weekdays.size > 0 ? "Limit / week (optional)" : "Limit (optional)"}
          </div>
          <input
            type="number"
            inputMode="numeric"
            min="1"
            step="1"
            value={cap}
            onChange={(e) => setCap(e.target.value)}
            placeholder="e.g. 20"
            className="w-full rounded border border-rule bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber/30"
          />
          <p className="mt-1 text-[10.5px] text-ink-faint">
            {weekdays.size > 0 ? "Resets each week." : "Stops after this many redemptions."}
          </p>
        </div>
      </div>

      <button
        type="button"
        onClick={() => void save()}
        disabled={saving}
        className="inline-flex items-center gap-1.5 rounded-lg bg-amber px-4 py-1.5 text-[12px] font-semibold text-paper shadow-sm hover:opacity-95 transition disabled:opacity-50"
      >
        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
        Save delivery
      </button>
    </div>
  );
}

/**
 * Manufacturer-promo card. `showImport` renders the calendar upload (Rewards);
 * `showManage` renders the list + toggles + delivery editor (Incentives).
 * `crossLink` points to the other half.
 */
export function PromoIntelligenceCard({
  accessToken,
  viewAsUserId,
  showImport = true,
  showManage = true,
  crossLink,
}: {
  accessToken: string | null;
  viewAsUserId?: string;
  showImport?: boolean;
  showManage?: boolean;
  crossLink?: { label: string; to: string };
}) {
  const [offers, setOffers] = useState<PromoOffer[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    if (!accessToken) return;
    try {
      const [all, svc] = await Promise.all([
        listPromoOffers({ data: { accessToken, viewAsUserId } }),
        listServicesFn({ data: { accessToken, viewAsUserId } }).catch(() => [] as Service[]),
      ]);
      setOffers(all.filter((o) => o.source === "manufacturer"));
      setServices(svc);
    } catch {
      /* leave list empty on error */
    }
  }, [accessToken, viewAsUserId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleFile(file: File) {
    if (!accessToken) return;
    setBusy(true);
    try {
      const csv = await file.text();
      const r = await ingestPromoCalendar({ data: { accessToken, viewAsUserId, csv } });
      toast.success(
        `${r.offers} promo offer${r.offers === 1 ? "" : "s"} imported${r.skipped ? ` · ${r.skipped} skipped` : ""}`,
      );
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Import failed.");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function toggleOnDeals(o: PromoOffer) {
    if (!accessToken || !o.id) return;
    const offerId = o.id;
    const next = !o.showOnDeals;
    setTogglingId(offerId);
    setOffers((prev) => prev.map((x) => (x.id === offerId ? { ...x, showOnDeals: next } : x)));
    try {
      await setPromoOfferOnDeals({
        data: { accessToken, viewAsUserId, offerId, showOnDeals: next },
      });
    } catch (e) {
      setOffers((prev) =>
        prev.map((x) => (x.id === offerId ? { ...x, showOnDeals: o.showOnDeals } : x)),
      );
      toast.error(e instanceof Error ? e.message : "Couldn't update.");
    } finally {
      setTogglingId(null);
    }
  }

  const now = new Date();
  const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  function statusOf(o: PromoOffer): "active" | "upcoming" | "expired" {
    if (o.endsOn && o.endsOn < todayIso) return "expired";
    if (o.startsOn && o.startsOn > todayIso) return "upcoming";
    return "active";
  }

  function matchedServiceNames(o: PromoOffer): string[] {
    if (!o.product) return [];
    return services
      .filter((s) => productMatchesName(o.product, normalizeForMatch(s.name)))
      .map((s) => s.name);
  }

  const buckets = {
    active: offers.filter((o) => statusOf(o) === "active"),
    upcoming: offers.filter((o) => statusOf(o) === "upcoming"),
    expired: offers.filter((o) => statusOf(o) === "expired"),
  };
  const bucketMeta = [
    { key: "active" as const, label: "Active now" },
    { key: "upcoming" as const, label: "Upcoming" },
    { key: "expired" as const, label: "Expired" },
  ];

  return (
    <div className="rounded-2xl border border-rule bg-paper/30 p-5">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => showManage && setCollapsed((c) => !c)}
          className="flex items-center gap-2 text-sm font-semibold text-ink"
        >
          <Tag className="h-4 w-4 text-amber" />
          Manufacturer promos
          {offers.length > 0 && (
            <span className="rounded-full bg-amber-soft px-2 py-0.5 text-[10.5px] font-semibold text-amber">
              {offers.length}
            </span>
          )}
        </button>

        {crossLink && (
          <Link
            to={crossLink.to}
            className="inline-flex items-center gap-1 text-[12px] font-medium text-amber hover:underline"
          >
            {crossLink.label}
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        )}

        {showImport && (
          <>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={busy}
              className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-amber/40 px-3 py-1.5 text-[12px] font-semibold text-amber hover:bg-amber-soft transition disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
              Upload calendar CSV
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFile(f);
              }}
            />
          </>
        )}

        {showManage && (
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? "Expand manufacturer promos" : "Collapse manufacturer promos"}
            className={cn("text-ink-faint hover:text-ink transition", !showImport && "ml-auto")}
          >
            <ChevronDown className={`h-4 w-4 transition-transform ${collapsed ? "-rotate-90" : ""}`} />
          </button>
        )}
      </div>

      {showImport && !showManage && (
        <p className="mt-2 text-[11px] text-ink-faint">
          Upload your manufacturer&apos;s promotions calendar (e.g. Allergan &ldquo;Dollars
          Off&rdquo;) here. Manage how each one delivers over in Incentives.
        </p>
      )}

      {showManage && !collapsed && (
        <>
          <p className="mt-2 text-[11px] text-ink-faint">
            Your manufacturer&apos;s active patient offers, matched to your own menu. Active
            offers badge the matching add-on at booking; toggle the eye to show or hide
            each on your public Deals page.
          </p>

          {offers.length === 0 ? (
            <p className="mt-4 text-[12px] text-ink-faint">
              No promos loaded yet. Upload your manufacturer&apos;s promotions calendar
              (Allergan &ldquo;Dollars Off&rdquo;){" "}
              {crossLink ? "on the Rewards tab" : "above"} — soon SmartSpa will pull these
              for you automatically.
            </p>
          ) : (
            <div className="mt-4 space-y-4">
              {bucketMeta.map(({ key, label }) =>
                buckets[key].length === 0 ? null : (
                  <div key={key}>
                    <div className="mb-1.5 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
                      {label}
                      <span className="text-ink-faint/70">{buckets[key].length}</span>
                    </div>
                    <div className="space-y-1.5">
                      {buckets[key].map((o) => {
                        const matches = matchedServiceNames(o);
                        const expired = key === "expired";
                        const editing = editingId === o.id;
                        return (
                          <div
                            key={o.id}
                            className={`rounded-xl border border-rule bg-white px-3 py-2.5 ${expired ? "opacity-60" : ""}`}
                          >
                            <div className="flex items-start gap-3">
                              <div className="min-w-0 flex-1">
                                <div className="text-[13px] font-semibold text-ink truncate">
                                  {o.title}
                                </div>
                                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-ink-faint">
                                  {o.manufacturer && <span className="capitalize">{o.manufacturer}</span>}
                                  {o.discountUsd != null && (
                                    <span className="font-semibold text-emerald-ink">
                                      ${Math.round(o.discountUsd)} off
                                    </span>
                                  )}
                                  <span className="tabular-nums">
                                    {o.startsOn ? fmtDate(o.startsOn) : "—"} –{" "}
                                    {o.endsOn ? fmtDate(o.endsOn) : "ongoing"}
                                  </span>
                                </div>
                                <div className="mt-1 text-[11px]">
                                  {matches.length > 0 ? (
                                    <span className="text-emerald-ink">
                                      Applies to {matches.slice(0, 3).join(", ")}
                                      {matches.length > 3 ? ` +${matches.length - 3}` : ""}
                                    </span>
                                  ) : (
                                    <span className="text-ink-faint/80">No match in your menu yet</span>
                                  )}
                                </div>
                                {!expired && (
                                  <div className="mt-1 flex items-center gap-1.5 text-[11px] text-ink-faint">
                                    <SlidersHorizontal className="h-3 w-3" />
                                    <span>
                                      Delivers to {deliverySummary(o)} ·{" "}
                                      {o.showOnDeals ? "on Deals" : "hidden"}
                                    </span>
                                  </div>
                                )}
                              </div>
                              {!expired && (
                                <div className="flex shrink-0 flex-col items-stretch gap-1.5">
                                  <button
                                    type="button"
                                    onClick={() => void toggleOnDeals(o)}
                                    disabled={togglingId === o.id}
                                    title={
                                      o.showOnDeals
                                        ? "Showing on your Deals page — click to hide"
                                        : "Hidden from your Deals page — click to show"
                                    }
                                    className={`inline-flex items-center justify-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-semibold transition disabled:opacity-50 ${
                                      o.showOnDeals
                                        ? "border-emerald-ink/30 bg-emerald-soft text-emerald-ink"
                                        : "border-rule bg-white text-ink-faint hover:text-ink"
                                    }`}
                                  >
                                    {togglingId === o.id ? (
                                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    ) : o.showOnDeals ? (
                                      <Eye className="h-3.5 w-3.5" />
                                    ) : (
                                      <EyeOff className="h-3.5 w-3.5" />
                                    )}
                                    {o.showOnDeals ? "On Deals" : "Hidden"}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setEditingId(editing ? null : (o.id ?? null))}
                                    title="Choose who, when & where this promo is delivered"
                                    className={`inline-flex items-center justify-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-semibold transition ${
                                      editing
                                        ? "border-amber/50 bg-amber-soft text-amber"
                                        : "border-rule bg-white text-ink-soft hover:text-ink"
                                    }`}
                                  >
                                    <SlidersHorizontal className="h-3.5 w-3.5" />
                                    {editing ? "Close" : "Delivery"}
                                  </button>
                                </div>
                              )}
                            </div>
                            {editing && !expired && (
                              <MfrDeliveryEditor
                                offer={o}
                                accessToken={accessToken}
                                viewAsUserId={viewAsUserId}
                                onSaved={() => {
                                  setEditingId(null);
                                  void load();
                                }}
                              />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ),
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
