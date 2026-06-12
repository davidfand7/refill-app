/**
 * Spa-authored offers — the owner writes their OWN cross-sell offers, a
 * first-class peer to manufacturer promos. Same unified offers table, same
 * at-booking badge, same $5 cross_sell_addon win pipeline. Match is by the
 * trigger service's name.
 *
 * v2.4.2 — the offer ENGINE: beyond a fixed $-off, the owner can author
 *   • $ off a service       • % off a service
 *   • a free add-on with a service ("book Botox, get a free brow wax")
 *   • $ off an add-on with a service
 * (bundle / BOGO / series / first-visit / spend-get are reserved for later
 * slices — schema + matcher already carry them.)
 *
 * Self-contained card (accessToken + viewAsUserId props) so it mounts in more
 * than one Solution — Promos → Reward signals AND the Calendar Solution.
 */

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ChevronDown, Loader2, Pause, Play, Plus, Send, Sparkles, Tag, Trash2 } from "lucide-react";
import {
  listPromoOffers,
  createSpaOffer,
  deleteSpaOffer,
  setSpaOfferActive,
  draftOfferPushFn,
} from "@/server/refill-promo-calendar.functions";
import { listServicesFn, type Service } from "@/server/refill-catalog";
import type { PromoOffer, OfferType, OfferCohort } from "@/lib/promo-calendar";
import { cn } from "@/lib/utils";

function Lbl({ children }: { children: React.ReactNode }) {
  return (
    <label className="block text-[10px] font-semibold uppercase tracking-wider text-ink-soft mb-1">
      {children}
    </label>
  );
}

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map((n) => parseInt(n, 10));
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "2-digit",
    day: "2-digit",
    year: "2-digit",
  });
}

function fmtWindow(startsOn: string | null, endsOn: string | null): string {
  if (!startsOn && !endsOn) return "· ongoing";
  if (startsOn && endsOn) return `· ${fmtDate(startsOn)}–${fmtDate(endsOn)}`;
  if (endsOn) return `· through ${fmtDate(endsOn)}`;
  return `· from ${fmtDate(startsOn!)}`;
}

// The four authorable offer types (slice 1).
const TYPE_OPTIONS: Array<{ value: OfferType; label: string }> = [
  { value: "dollars_off", label: "$ off" },
  { value: "percent_off", label: "% off" },
  { value: "free_addon", label: "Free add-on" },
  { value: "discount_addon", label: "Add-on $ off" },
];

const TYPE_CHIP: Record<string, string> = {
  dollars_off: "$ off",
  percent_off: "% off",
  free_addon: "Free add-on",
  discount_addon: "Add-on $ off",
};

const COHORT_OPTIONS: Array<{ value: OfferCohort; label: string }> = [
  { value: "all", label: "All patients" },
  { value: "lapsed", label: "Lapsed" },
  { value: "new", label: "New" },
  { value: "expiring", label: "Expiring reward" },
];

const COHORT_CHIP: Record<string, string> = {
  lapsed: "Lapsed",
  new: "New",
  expiring: "Expiring",
};

const WEEKDAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

export function SpaOffersCard({
  accessToken,
  viewAsUserId,
}: {
  accessToken: string | null;
  viewAsUserId?: string;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [open, setOpen] = useState(false);
  const [offers, setOffers] = useState<PromoOffer[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [offerType, setOfferType] = useState<OfferType>("dollars_off");
  const [cohort, setCohort] = useState<OfferCohort>("all");
  const [serviceName, setServiceName] = useState("");
  const [discount, setDiscount] = useState("");
  const [pct, setPct] = useState("");
  const [addonLabel, setAddonLabel] = useState("");
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [weekdays, setWeekdays] = useState<Set<number>>(new Set());
  const [cap, setCap] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [pushingId, setPushingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accessToken) return;
    try {
      const [all, svc] = await Promise.all([
        listPromoOffers({ data: { accessToken, viewAsUserId } }),
        listServicesFn({ data: { accessToken, viewAsUserId } }),
      ]);
      setOffers(all.filter((o) => o.source === "spa"));
      // Only services a patient can actually book can carry a cross-sell offer
      // that fires — exclude non-bookable rows (e.g. category placeholders).
      setServices(svc.filter((s) => s.onlineBookable));
    } catch {
      /* leave card empty on error */
    }
  }, [accessToken, viewAsUserId]);

  useEffect(() => {
    void load();
  }, [load]);

  const needsDiscount = offerType === "dollars_off" || offerType === "discount_addon";
  const needsPct = offerType === "percent_off";
  const needsAddon = offerType === "free_addon" || offerType === "discount_addon";

  function resetForm() {
    setServiceName("");
    setDiscount("");
    setPct("");
    setAddonLabel("");
    setStartsOn("");
    setEndsOn("");
    setWeekdays(new Set());
    setCap("");
    setLabel("");
    setOfferType("dollars_off");
    setCohort("all");
  }

  async function create() {
    if (!accessToken || !serviceName) {
      toast.error("Pick a service for the offer.");
      return;
    }
    const d = discount.trim() ? Number(discount.trim()) : null;
    const p = pct.trim() ? Number(pct.trim()) : null;
    if (needsDiscount && (!Number.isFinite(d) || (d as number) <= 0)) {
      toast.error("Enter a dollar amount.");
      return;
    }
    if (needsPct && (!Number.isFinite(p) || (p as number) <= 0 || (p as number) > 100)) {
      toast.error("Enter a percentage between 1 and 100.");
      return;
    }
    if (needsAddon && !addonLabel.trim()) {
      toast.error("Name the add-on this offer applies to.");
      return;
    }
    if (startsOn && endsOn && endsOn < startsOn) {
      toast.error("The end date is before the start date.");
      return;
    }
    const capN = cap.trim() ? Number(cap.trim()) : null;
    if (cap.trim() && (!Number.isInteger(capN) || (capN as number) <= 0)) {
      toast.error("Limit must be a whole number.");
      return;
    }
    setBusy(true);
    try {
      await createSpaOffer({
        data: {
          accessToken,
          viewAsUserId,
          serviceName,
          offerType,
          targetCohort: cohort,
          discountUsd: needsDiscount ? d : null,
          valuePct: needsPct ? p : null,
          addonLabel: needsAddon ? addonLabel.trim() : null,
          activeWeekdays: weekdays.size ? [...weekdays].sort((a, b) => a - b) : null,
          quantityCap: capN,
          startsOn: startsOn || null,
          endsOn: endsOn || null,
          title: label.trim() || undefined,
        },
      });
      toast.success("Offer added — it badges that service at booking.");
      resetForm();
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't add the offer.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id?: string) {
    if (!accessToken || !id) return;
    try {
      await deleteSpaOffer({ data: { accessToken, viewAsUserId, offerId: id } });
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't remove the offer.");
    }
  }

  async function pushOffer(o: PromoOffer) {
    if (!accessToken || !o.id) return;
    setPushingId(o.id);
    try {
      const res = await draftOfferPushFn({
        data: { accessToken, viewAsUserId, offerId: o.id },
      });
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success(
        `Staged ${res.drafted} draft${res.drafted === 1 ? "" : "s"} to ${res.sentTo} — review & send in Messages.${
          res.skippedNoPhone ? ` (${res.skippedNoPhone} had no phone)` : ""
        }`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't draft the push.");
    } finally {
      setPushingId(null);
    }
  }

  async function toggleActive(o: PromoOffer) {
    if (!accessToken || !o.id) return;
    try {
      await setSpaOfferActive({
        data: { accessToken, viewAsUserId, offerId: o.id, isActive: o.isActive === false },
      });
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't update the offer.");
    }
  }

  return (
    <div className="rounded-2xl border border-rule bg-paper/30 p-5">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="flex w-full items-center gap-2 text-sm font-semibold text-ink"
      >
        <Sparkles className="h-4 w-4 text-amber" />
        Your own offers — author a cross-sell
        {offers.length > 0 && (
          <span className="rounded-full bg-amber-soft px-2 py-0.5 text-[10.5px] font-semibold text-amber">
            {offers.length}
          </span>
        )}
        <ChevronDown
          className={cn(
            "ml-auto h-4 w-4 text-ink-faint transition-transform",
            collapsed && "-rotate-90",
          )}
        />
      </button>

      {!collapsed && (
        <>
      <p className="mt-2 text-[11px] text-ink-faint">
        Your own loyalty program — not a manufacturer's. Dollar or percent off a
        service, or a free / discounted add-on with it. It badges that service
        at booking and earns the same $5 when a matched patient books it.
      </p>

      <div className="mt-3">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="inline-flex items-center gap-1 text-[12px] font-semibold text-amber hover:opacity-80"
        >
          <Plus className="h-3.5 w-3.5" />
          {open ? "Close form" : "New offer"}
        </button>
      </div>

      {open && (
        <div className="mt-3 space-y-3">
          {/* Offer type selector */}
          <div>
            <Lbl>Offer type</Lbl>
            <div className="flex flex-wrap gap-1.5">
              {TYPE_OPTIONS.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => setOfferType(t.value)}
                  className={cn(
                    "rounded-full px-3 py-1 text-[12px] font-semibold border transition",
                    offerType === t.value
                      ? "bg-amber text-paper border-amber"
                      : "bg-white text-ink-soft border-rule hover:text-ink",
                  )}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {/* Who's this for? — cohort targeting */}
          <div>
            <Lbl>Who's this for?</Lbl>
            <div className="flex flex-wrap gap-1.5">
              {COHORT_OPTIONS.map((c) => (
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
                A targeted offer won't show at public booking — it's delivered to
                your matching patients (push coming in a later slice) and earns
                the $5 only when an in-cohort patient books it.
              </p>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="sm:col-span-2">
              <Lbl>{needsAddon ? "Book this service…" : "Service"}</Lbl>
              <select
                value={serviceName}
                onChange={(e) => setServiceName(e.target.value)}
                disabled={services.length === 0}
                className="w-full rounded border border-rule bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber/30 disabled:opacity-60"
              >
                <option value="">Choose a service…</option>
                {services.map((s) => (
                  <option key={s.id} value={s.name}>
                    {s.name}
                  </option>
                ))}
              </select>
              {services.length === 0 && (
                <p className="mt-1 text-[11px] text-ink-faint">
                  No bookable services yet — turn on online booking for a service
                  (Calendar → Online booking) and it'll show up here.
                </p>
              )}
            </div>

            {needsAddon && (
              <div className="sm:col-span-2">
                <Lbl>{offerType === "free_addon" ? "…get this free" : "…get $ off this add-on"}</Lbl>
                <input
                  type="text"
                  value={addonLabel}
                  onChange={(e) => setAddonLabel(e.target.value)}
                  placeholder="brow wax"
                  className="w-full rounded border border-rule bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber/30"
                />
              </div>
            )}

            {needsDiscount && (
              <div>
                <Lbl>Discount ($)</Lbl>
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="1"
                  value={discount}
                  onChange={(e) => setDiscount(e.target.value)}
                  placeholder="50"
                  className="w-full rounded border border-rule bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber/30"
                />
              </div>
            )}

            {needsPct && (
              <div>
                <Lbl>Percent (%)</Lbl>
                <input
                  type="number"
                  inputMode="decimal"
                  min="1"
                  max="100"
                  step="1"
                  value={pct}
                  onChange={(e) => setPct(e.target.value)}
                  placeholder="20"
                  className="w-full rounded border border-rule bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber/30"
                />
              </div>
            )}

            <div>
              <Lbl>Custom label (optional)</Lbl>
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="auto from the offer"
                className="w-full rounded border border-rule bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber/30"
              />
            </div>
            <div>
              <Lbl>Starts (optional)</Lbl>
              <input
                type="date"
                value={startsOn}
                onChange={(e) => setStartsOn(e.target.value)}
                className="w-full rounded border border-rule bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber/30"
              />
            </div>
            <div>
              <Lbl>Ends (optional)</Lbl>
              <input
                type="date"
                value={endsOn}
                onChange={(e) => setEndsOn(e.target.value)}
                className="w-full rounded border border-rule bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber/30"
              />
            </div>
          </div>
          {/* Recurrence: which days + how many */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Lbl>Days (optional)</Lbl>
              <div className="flex flex-wrap gap-1">
                {WEEKDAY_LABELS.map((wl, i) => {
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
              <p className="mt-1 text-[10.5px] text-ink-faint">
                Blank = every day. Pick Tue for &ldquo;Tox Tuesdays.&rdquo;
              </p>
            </div>
            <div>
              <Lbl>Limit (optional)</Lbl>
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
                Stops after this many redemptions.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => void create()}
            disabled={busy || !serviceName}
            className="inline-flex items-center gap-1.5 rounded-lg bg-amber px-4 py-2 text-sm font-semibold text-paper shadow-sm hover:opacity-95 transition disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Add offer
          </button>
        </div>
      )}

      {offers.length > 0 && (
        <ul className="mt-4 space-y-1.5">
          {offers.map((o) => {
            const paused = o.isActive === false;
            return (
              <li
                key={o.id}
                className={cn(
                  "flex items-center gap-2 rounded-lg border border-rule bg-white px-3 py-2 text-[12.5px]",
                  paused && "opacity-60",
                )}
              >
                <Tag className="h-3.5 w-3.5 text-amber shrink-0" />
                <span className="font-medium text-ink">{o.title}</span>
                {o.offerType && o.offerType !== "dollars_off" && (
                  <span className="rounded-full bg-amber-soft px-1.5 py-0.5 text-[10px] font-semibold text-amber">
                    {TYPE_CHIP[o.offerType] ?? o.offerType}
                  </span>
                )}
                {o.targetCohort && o.targetCohort !== "all" && (
                  <span className="rounded-full bg-emerald-soft px-1.5 py-0.5 text-[10px] font-semibold text-emerald">
                    {COHORT_CHIP[o.targetCohort] ?? o.targetCohort}
                  </span>
                )}
                {paused && (
                  <span className="rounded-full bg-rule px-1.5 py-0.5 text-[10px] font-semibold text-ink-faint">
                    paused
                  </span>
                )}
                <span className="text-ink-faint">{fmtWindow(o.startsOn, o.endsOn)}</span>
                <div className="ml-auto flex items-center gap-2">
                  {o.targetCohort && o.targetCohort !== "all" && (
                    <button
                      type="button"
                      onClick={() => void pushOffer(o)}
                      disabled={pushingId === o.id || paused}
                      className="inline-flex items-center gap-1 rounded-md border border-rule px-2 py-0.5 text-[11px] font-semibold text-emerald hover:bg-emerald-soft transition disabled:opacity-50"
                      title={paused ? "Resume to push" : "Draft a push to matching patients"}
                    >
                      {pushingId === o.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Send className="h-3 w-3" />
                      )}
                      Push
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void toggleActive(o)}
                    className="text-ink-faint hover:text-ink transition"
                    aria-label={paused ? "Resume offer" : "Pause offer"}
                    title={paused ? "Resume" : "Pause"}
                  >
                    {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(o.id)}
                    className="text-ink-faint hover:text-rose transition"
                    aria-label="Remove offer"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
        </>
      )}
    </div>
  );
}
