/**
 * OfferComposer — the unified, agentic-native offer composer (v2.100+).
 *
 * One surface to author an offer, leading with plain-English intent. Two modes:
 *
 *  • "Author an offer" (mode='spa') — the owner writes their OWN offer; a single
 *    offer and an A/B test are the SAME intent (flip "Let SmartSpa find your best
 *    version" and add a version). On Activate: no extra versions → createSpaOffer;
 *    1+ → createAbExperiment.
 *  • "Deliver a manufacturer promo" (mode='mfr', v2.103) — the manufacturer owns
 *    the TERMS (locked, read-only); the owner authors only DELIVERY (who / when /
 *    where). On Activate → updateManufacturerOfferDelivery. This folds the inline
 *    MfrDeliveryEditor's job into the one agentic-native composer (hybrid model,
 *    project_manufacturer_ab_arbiter). The mode switch only appears once at least
 *    one manufacturer promo is loaded (KISS / additive-on-demand).
 *
 * KISS additive-on-demand: the resting view is plain-English; the controls live
 * behind one expander each. A live preview shows the patient-facing artifact.
 *
 * Self-contained (accessToken prop). onCreated lets the parent refresh its
 * offer / test lists.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ChevronRight, Eye, KeyRound, Loader2, Plus, Sparkles, Wand2, X } from "lucide-react";

import {
  createSpaOffer,
  listPromoOffers,
  updateManufacturerOfferDelivery,
} from "@/server/refill-promo-calendar.functions";
import { createAbExperiment } from "@/server/smart-ab.functions";
import { listServicesFn, type Service } from "@/server/refill-catalog";
import { groupServicesByCategory } from "@/lib/service-categories";
import { normalizeForMatch, productMatchesName, type OfferType, type OfferCohort, type PromoOffer } from "@/lib/promo-calendar";
import { cn } from "@/lib/utils";

type AbType = "dollars_off" | "percent_off" | "free_addon";

const TYPE_OPTIONS: Array<{ value: OfferType; label: string }> = [
  { value: "dollars_off", label: "$ off" },
  { value: "percent_off", label: "% off" },
  { value: "free_addon", label: "Free add-on" },
  { value: "discount_addon", label: "Add-on $ off" },
];
const COHORTS: Array<{ value: OfferCohort; label: string }> = [
  { value: "all", label: "Everyone" },
  { value: "lapsed", label: "Lapsed" },
  { value: "new", label: "New" },
  { value: "expiring", label: "Expiring reward" },
];
const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

type Version = { offerType: AbType; value: string; addon: string };
type Mode = "spa" | "mfr";

function titleCase(s: string | null | undefined): string {
  const t = (s ?? "").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : "";
}

/** Local yyyy-mm-dd (owner's day) — for filtering out expired mfr promos. */
function todayLocalIso(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
}

export function OfferComposer({
  accessToken,
  viewAsUserId,
  onCreated,
}: {
  accessToken: string | null;
  viewAsUserId?: string;
  onCreated?: () => void;
}) {
  const [services, setServices] = useState<Service[]>([]);
  // Mode + the manufacturer-promo catalog (delivery mode).
  const [mode, setMode] = useState<Mode>("spa");
  const [mfrOffers, setMfrOffers] = useState<PromoOffer[]>([]);
  const [selectedMfrId, setSelectedMfrId] = useState("");
  // The base offer (version 1) — spa-authored mode.
  const [offerType, setOfferType] = useState<OfferType>("dollars_off");
  const [serviceName, setServiceName] = useState("");
  const [discount, setDiscount] = useState("");
  const [pct, setPct] = useState("");
  const [addon, setAddon] = useState("");
  // Shared delivery (both modes): who / when.
  const [cohort, setCohort] = useState<OfferCohort>("all");
  const [weekdays, setWeekdays] = useState<Set<number>>(new Set());
  const [cap, setCap] = useState("");
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
  // A/B: alternate versions beyond the base (spa mode only for now).
  const [optimize, setOptimize] = useState(false);
  const [versions, setVersions] = useState<Version[]>([]);
  // Which expander is open (KISS: one at a time, resting view is plain English).
  const [openSec, setOpenSec] = useState<null | "offer" | "who" | "when">("offer");
  const [pvTab, setPvTab] = useState<"badge" | "deals" | "email" | "text">("badge");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!accessToken) return;
    try {
      const [svc, promos] = await Promise.all([
        listServicesFn({ data: { accessToken, viewAsUserId } }),
        listPromoOffers({ data: { accessToken, viewAsUserId } }).catch(() => [] as PromoOffer[]),
      ]);
      setServices(svc.filter((s) => s.onlineBookable));
      // Manufacturer promos still worth delivering (drop expired).
      const today = todayLocalIso();
      setMfrOffers(
        promos.filter((o) => o.source === "manufacturer" && !!o.id && !(o.endsOn && o.endsOn < today)),
      );
    } catch {
      /* leave empty */
    }
  }, [accessToken, viewAsUserId]);
  useEffect(() => {
    void load();
  }, [load]);

  const selectedMfr = useMemo(
    () => mfrOffers.find((o) => o.id === selectedMfrId) ?? null,
    [mfrOffers, selectedMfrId],
  );

  // When a manufacturer promo is selected, prefill the delivery controls from
  // its current saved delivery so the composer reflects (and edits) live state.
  useEffect(() => {
    if (mode !== "mfr" || !selectedMfr) return;
    setCohort(selectedMfr.targetCohort ?? "all");
    setWeekdays(new Set(selectedMfr.activeWeekdays ?? []));
    setCap(selectedMfr.quantityCap != null ? String(selectedMfr.quantityCap) : "");
  }, [mode, selectedMfr]);

  function switchMode(m: Mode) {
    setMode(m);
    setOpenSec("offer");
    if (m === "mfr" && !selectedMfrId && mfrOffers.length > 0) {
      setSelectedMfrId(mfrOffers[0].id as string);
    }
  }

  const needsDiscount = offerType === "dollars_off" || offerType === "discount_addon";
  const needsPct = offerType === "percent_off";
  const needsAddon = offerType === "free_addon" || offerType === "discount_addon";

  // The matching service for a manufacturer promo (same synonym-aware matcher as
  // the at-booking badge) — gives the preview a real price + display name.
  const mfrSvc = useMemo(() => {
    if (!selectedMfr) return null;
    return services.find((s) => productMatchesName(selectedMfr.product, normalizeForMatch(s.name))) ?? null;
  }, [selectedMfr, services]);

  // ── Mode-unified offer terms (drives the phrase + the live preview) ─────────
  const activeType: OfferType = mode === "mfr" ? selectedMfr?.offerType ?? "dollars_off" : offerType;
  const activeD = mode === "mfr" ? selectedMfr?.discountUsd ?? null : discount.trim() ? Number(discount) : null;
  const activeP = mode === "mfr" ? selectedMfr?.valuePct ?? null : pct.trim() ? Number(pct) : null;
  const activeAddon = mode === "mfr" ? selectedMfr?.addonLabel ?? "" : addon;
  const spaSvc = useMemo(() => services.find((s) => s.name === serviceName), [services, serviceName]);
  const activeSvc = mode === "mfr" ? mfrSvc : spaSvc;
  const svcDisplay =
    activeSvc?.displayName ||
    (mode === "mfr" ? titleCase(selectedMfr?.product) : serviceName) ||
    "your service";
  const price = activeSvc?.servicePrice ?? null;

  const offerLabel = useMemo(() => {
    if (activeType === "percent_off") return `${activeP ?? "—"}% off`;
    if (activeType === "free_addon") return `Free ${activeAddon || "add-on"}`;
    if (activeType === "discount_addon") return `$${activeD ?? "—"} off ${activeAddon || "add-on"}`;
    return `$${activeD ?? "—"} off`;
  }, [activeType, activeD, activeP, activeAddon]);

  // Plain-English offer phrase ("$50 off Tox" / "20% off Filler").
  const offerPhrase = useMemo(() => {
    if (activeType === "percent_off") return `${activeP ?? "—"}% off ${svcDisplay}`;
    if (activeType === "free_addon") return `Free ${activeAddon || "add-on"} with ${svcDisplay}`;
    if (activeType === "discount_addon") return `$${activeD ?? "—"} off ${activeAddon || "add-on"} with ${svcDisplay}`;
    return `$${activeD ?? "—"} off ${svcDisplay}`;
  }, [activeType, activeD, activeP, activeAddon, svcDisplay]);

  const discounted = useMemo(() => {
    if (price == null) return null;
    if (activeType === "percent_off" && activeP) return Math.max(0, Math.round(price * (1 - activeP / 100)));
    if (activeType === "dollars_off" && activeD) return Math.max(0, Math.round(price - activeD));
    return null;
  }, [price, activeType, activeP, activeD]);

  const whenPhrase = useMemo(() => {
    const days = weekdays.size ? [...weekdays].sort((a, b) => a - b).map((d) => WEEKDAYS[d]).join(", ") : "any day";
    const capTxt = cap.trim() ? `, cap ${cap}${weekdays.size ? "/wk" : ""}` : "";
    return `${days}${capTxt}`;
  }, [weekdays, cap]);

  const whoPhrase = cohort === "all" ? "everyone" : (COHORTS.find((c) => c.value === cohort)?.label ?? cohort).toLowerCase();
  const deliveryPhrase =
    cohort === "all" ? "badged at booking & on your Deals page" : "sent to your matching patients (their booking is the vote)";
  const isAb = mode === "spa" && optimize && versions.length >= 1;

  function setVersion(i: number, patch: Partial<Version>) {
    setVersions((prev) => prev.map((v, k) => (k === i ? { ...v, ...patch } : v)));
  }

  function resetSpa() {
    setServiceName(""); setDiscount(""); setPct(""); setAddon("");
    setWeekdays(new Set()); setCap(""); setStartsOn(""); setEndsOn("");
    setOptimize(false); setVersions([]); setCohort("all"); setOfferType("dollars_off");
  }

  async function activate() {
    if (!accessToken) return;
    const capN = cap.trim() ? Number(cap.trim()) : null;
    if (cap.trim() && (!Number.isInteger(capN) || (capN as number) <= 0)) return toast.error("Limit must be a whole number.");
    const weekdayArr = weekdays.size ? [...weekdays].sort((a, b) => a - b) : null;

    // ── Manufacturer-delivery mode: terms locked, only delivery is authored. ──
    if (mode === "mfr") {
      if (!selectedMfr?.id) return toast.error("Pick a manufacturer promo first.");
      setBusy(true);
      try {
        await updateManufacturerOfferDelivery({
          data: {
            accessToken,
            viewAsUserId,
            offerId: selectedMfr.id,
            targetCohort: cohort,
            activeWeekdays: weekdayArr,
            quantityCap: capN,
            isActive: true,
          },
        });
        toast.success("Delivery saved — the terms stay the manufacturer's; you set who, when & where.");
        await load();
        onCreated?.();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Couldn't save delivery.");
      } finally {
        setBusy(false);
      }
      return;
    }

    // ── Spa-authored mode (single offer or A/B). ──
    if (!serviceName) return toast.error("Pick a service first.");
    const d = discount.trim() ? Number(discount.trim()) : null;
    const p = pct.trim() ? Number(pct.trim()) : null;
    if (needsDiscount && (!d || d <= 0)) return toast.error("Enter a dollar amount.");
    if (needsPct && (!p || p <= 0 || p > 100)) return toast.error("Enter a percentage (1–100).");
    if (needsAddon && !addon.trim()) return toast.error("Name the add-on.");
    if (startsOn && endsOn && endsOn < startsOn) return toast.error("End date is before the start date.");

    setBusy(true);
    try {
      if (isAb) {
        // Base offer is version 1; the alternates differ only in terms.
        const baseVariant = {
          offerType: offerType as AbType,
          discountUsd: needsDiscount ? d : null,
          valuePct: needsPct ? p : null,
          addonLabel: needsAddon ? addon.trim() : null,
        };
        const altVariants = versions.map((v) => {
          const num = v.value.trim() ? Number(v.value.trim()) : null;
          return {
            offerType: v.offerType,
            discountUsd: v.offerType === "dollars_off" ? num : null,
            valuePct: v.offerType === "percent_off" ? num : null,
            addonLabel: v.offerType === "free_addon" ? v.addon.trim() || null : null,
          };
        });
        for (const av of altVariants) {
          if (av.offerType === "dollars_off" && (!av.discountUsd || av.discountUsd <= 0)) return toast.error("Each $-off version needs an amount."), setBusy(false);
          if (av.offerType === "percent_off" && (!av.valuePct || av.valuePct <= 0)) return toast.error("Each %-off version needs a percentage."), setBusy(false);
          if (av.offerType === "free_addon" && !av.addonLabel) return toast.error("Each free-add-on version needs a name."), setBusy(false);
        }
        await createAbExperiment({
          data: {
            accessToken,
            viewAsUserId,
            serviceName,
            targetCohort: cohort,
            activeWeekdays: weekdayArr,
            quantityCap: capN,
            startsOn: startsOn || null,
            endsOn: endsOn || null,
            variants: [baseVariant, ...altVariants],
          },
        });
        toast.success("Test created — SmartSpa will keep whichever version books best.");
      } else {
        await createSpaOffer({
          data: {
            accessToken,
            viewAsUserId,
            serviceName,
            offerType,
            targetCohort: cohort,
            discountUsd: needsDiscount ? d : null,
            valuePct: needsPct ? p : null,
            addonLabel: needsAddon ? addon.trim() : null,
            activeWeekdays: weekdayArr,
            quantityCap: capN,
            capPeriod: weekdays.size ? "weekly" : "total",
            startsOn: startsOn || null,
            endsOn: endsOn || null,
          },
        });
        toast.success("Offer added — it badges that service at booking.");
      }
      resetSpa();
      onCreated?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't create the offer.");
    } finally {
      setBusy(false);
    }
  }

  const mfrName = titleCase(selectedMfr?.manufacturer) || "the manufacturer";

  return (
    <div className="overflow-hidden rounded-2xl border border-emerald/30 bg-white shadow-sm">
      {/* Mode switch — only once a manufacturer promo exists (KISS) */}
      {mfrOffers.length > 0 && (
        <div className="flex gap-1 border-b border-rule bg-paper/50 p-1.5">
          <ModeTab on={mode === "spa"} onClick={() => switchMode("spa")}>Author an offer</ModeTab>
          <ModeTab on={mode === "mfr"} onClick={() => switchMode("mfr")}>Deliver a manufacturer promo</ModeTab>
        </div>
      )}

      {/* Hero — plain-English intent */}
      <div className="border-b border-rule bg-gradient-to-br from-emerald-soft/60 to-white px-5 py-4">
        <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.1em] text-emerald">
          <Sparkles className="h-3.5 w-3.5" /> {mode === "mfr" ? "This promo, delivered your way" : "Your offer, in plain English"}
        </div>
        <p className="mt-1.5 text-[16px] leading-relaxed text-ink">
          <span className="font-semibold text-emerald-ink">{offerPhrase}</span>{" "}
          <span className="text-ink-soft">for</span>{" "}
          <span className="font-semibold">{whoPhrase}</span>{" "}
          <span className="text-ink-soft">— {whenPhrase} — {deliveryPhrase}</span>
          {mode === "mfr" && selectedMfr && (
            <span className="text-ink-soft"> · <span className="font-semibold text-amber">terms set by {mfrName}</span></span>
          )}
          {isAb && (
            <span className="text-ink-soft">
              {" "}— <span className="font-semibold text-amber">testing {versions.length + 1} versions</span>, keeping the one that books best.
            </span>
          )}
        </p>
      </div>

      <div className="px-5 py-4 space-y-2">
        {/* THE OFFER */}
        <Section
          label={mode === "mfr" ? "The promo (terms locked)" : "The offer"}
          value={offerPhrase}
          open={openSec === "offer"}
          onToggle={() => setOpenSec((s) => (s === "offer" ? null : "offer"))}
        >
          {mode === "mfr" ? (
            <>
              <Field label="Manufacturer promo">
                <select
                  value={selectedMfrId}
                  onChange={(e) => setSelectedMfrId(e.target.value)}
                  className="w-full rounded border border-rule bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber/30"
                >
                  {mfrOffers.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.manufacturer ? `${titleCase(o.manufacturer)} — ` : ""}{o.title}
                    </option>
                  ))}
                </select>
              </Field>
              {selectedMfr && (
                <div className="rounded-lg border border-amber/30 bg-amber-soft/40 p-2.5">
                  <div className="flex items-center gap-1.5 text-[11px] font-semibold text-amber">
                    <KeyRound className="h-3.5 w-3.5" /> Terms set by {mfrName} — locked
                  </div>
                  <div className="mt-1 text-[13.5px] font-semibold text-ink">{offerPhrase}</div>
                  <div className="mt-0.5 text-[11px] text-ink-faint">
                    {selectedMfr.startsOn || "—"} – {selectedMfr.endsOn || "ongoing"}
                    {mfrSvc ? ` · applies to ${mfrSvc.displayName}` : " · no match in your menu yet"}
                  </div>
                </div>
              )}
            </>
          ) : (
            <>
              <Field label="Type">
                <div className="flex flex-wrap gap-1.5">
                  {TYPE_OPTIONS.map((t) => (
                    <Chip key={t.value} on={offerType === t.value} onClick={() => setOfferType(t.value)}>
                      {t.label}
                    </Chip>
                  ))}
                </div>
              </Field>
              <Field label="Applies to">
                <select
                  value={serviceName}
                  onChange={(e) => setServiceName(e.target.value)}
                  disabled={services.length === 0}
                  className="w-full rounded border border-rule bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald/30 disabled:opacity-60"
                >
                  <option value="">Choose a service…</option>
                  {groupServicesByCategory(services).map((g) => (
                    <optgroup key={g.value} label={g.label}>
                      {g.items.map((s) => (
                        <option key={s.id} value={s.name}>{s.displayName}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </Field>
              {needsAddon && (
                <Field label={offerType === "free_addon" ? "…get this free" : "…get $ off this add-on"}>
                  <input value={addon} onChange={(e) => setAddon(e.target.value)} placeholder="brow wax" className={inputCls} />
                </Field>
              )}
              {needsDiscount && (
                <Field label="Discount ($)">
                  <input type="number" min="0" value={discount} onChange={(e) => setDiscount(e.target.value)} placeholder="50" className={inputCls} />
                </Field>
              )}
              {needsPct && (
                <Field label="Percent (%)">
                  <input type="number" min="1" max="100" value={pct} onChange={(e) => setPct(e.target.value)} placeholder="20" className={inputCls} />
                </Field>
              )}
            </>
          )}
        </Section>

        {/* WHO */}
        <Section
          label="Who gets it"
          value={whoPhrase[0].toUpperCase() + whoPhrase.slice(1)}
          open={openSec === "who"}
          onToggle={() => setOpenSec((s) => (s === "who" ? null : "who"))}
        >
          <div className="flex flex-wrap gap-1.5">
            {COHORTS.map((c) => (
              <Chip key={c.value} on={cohort === c.value} onClick={() => setCohort(c.value)}>
                {c.label}
              </Chip>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-ink-faint">
            {cohort === "all"
              ? "Everyone — badges at booking + shows on your public Deals page."
              : "Targeted — won't show at public booking; it's pushed to these patients and earns the $5 only when an in-cohort patient books."}
          </p>
        </Section>

        {/* WHEN */}
        <Section
          label="When it runs"
          value={whenPhrase[0].toUpperCase() + whenPhrase.slice(1)}
          open={openSec === "when"}
          onToggle={() => setOpenSec((s) => (s === "when" ? null : "when"))}
        >
          <Field label="Days (optional)">
            <div className="flex flex-wrap gap-1">
              {WEEKDAYS.map((wl, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setWeekdays((prev) => { const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n; })}
                  className={cn("h-7 w-8 rounded text-[11px] font-semibold border transition", weekdays.has(i) ? "bg-emerald text-paper border-emerald" : "bg-white text-ink-soft border-rule hover:text-ink")}
                >
                  {wl}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[10.5px] text-ink-faint">Blank = every day. Pick Tue for &ldquo;Tox Tuesdays&rdquo; — repeats weekly.</p>
          </Field>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label={weekdays.size ? "Limit / week" : "Limit"}>
              <input type="number" min="1" value={cap} onChange={(e) => setCap(e.target.value)} placeholder="e.g. 20" className={inputCls} />
            </Field>
            {mode === "spa" && (
              <>
                <Field label="Starts (optional)">
                  <input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} className={inputCls} />
                </Field>
                <Field label="Ends (optional)">
                  <input type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} className={inputCls} />
                </Field>
              </>
            )}
          </div>
          {mode === "mfr" && (
            <p className="text-[10.5px] text-ink-faint">Start &amp; end dates come from the manufacturer&rsquo;s calendar — you can&rsquo;t change them.</p>
          )}
        </Section>
      </div>

      {/* LIVE PREVIEW — the patient-facing artifact, updating as you build */}
      <div className="border-t border-rule px-5 py-4">
        <div className="mb-2 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-ink-faint">
          <Eye className="h-3.5 w-3.5" /> Live preview — what patients see
        </div>
        <div className="mb-3 grid grid-cols-4 gap-1 rounded-lg bg-paper p-1">
          {([
            ["badge", "Badge"],
            ["deals", "Deals"],
            ["email", "Email"],
            ["text", "AI text"],
          ] as const).map(([t, lbl]) => (
            <button
              key={t}
              type="button"
              onClick={() => setPvTab(t)}
              className={cn(
                "rounded-md py-1.5 text-[11.5px] font-semibold transition",
                pvTab === t ? "bg-white text-ink shadow-sm" : "text-ink-soft hover:text-ink",
              )}
            >
              {lbl}
            </button>
          ))}
        </div>

        <div className="rounded-xl border border-rule bg-paper/50 p-3">
          {pvTab === "badge" && (
            <div className="rounded-lg border border-rule bg-white p-3 shadow-sm">
              <div className="text-[10px] uppercase tracking-wide text-ink-faint">Book online</div>
              <div className="mt-2 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-[13px] font-semibold text-ink">
                    <span className="truncate">{svcDisplay}</span>
                    <span className="shrink-0 rounded-full bg-amber-soft px-1.5 py-0.5 text-[10px] font-bold text-amber">{offerLabel}</span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-ink-faint">
                    {cohort === "all" ? "Badged at booking" : "Targeted — not shown at public booking"}
                  </div>
                </div>
                <div className="shrink-0 text-right text-[12.5px]">
                  {price != null ? (
                    discounted != null ? (
                      <>
                        <span className="mr-1 text-ink-faint line-through">${price}</span>
                        <span className="font-bold text-amber">${discounted}</span>
                      </>
                    ) : (
                      <span className="font-semibold text-ink">${price}</span>
                    )
                  ) : (
                    <span className="text-ink-faint">—</span>
                  )}
                </div>
              </div>
            </div>
          )}

          {pvTab === "deals" && (
            <div className="overflow-hidden rounded-lg border border-rule bg-white shadow-sm">
              <div className="flex h-12 items-end bg-gradient-to-br from-emerald to-emerald-ink p-2">
                <span className="text-[13px] font-bold text-white">{offerLabel} {svcDisplay}</span>
              </div>
              <div className="p-3">
                <div className="text-[12px] text-ink-soft">Book your {svcDisplay} and save{offerLabel.startsWith("Free") ? " with a free add-on" : ""}.</div>
                <div className="mt-2 rounded-md bg-emerald py-1.5 text-center text-[12px] font-semibold text-white">Book this deal →</div>
                {cohort !== "all" && (
                  <div className="mt-1.5 text-[10px] text-ink-faint">Targeted offers don&rsquo;t list on the public Deals page.</div>
                )}
              </div>
            </div>
          )}

          {pvTab === "email" && (
            <div className="overflow-hidden rounded-lg border border-rule bg-white shadow-sm">
              <div className="border-b border-rule p-2.5">
                <div className="text-[12px] font-bold text-ink">Your spa</div>
                <div className="text-[11px] text-ink-soft">We&rsquo;ve missed you — {offerLabel} your {svcDisplay} 💚</div>
              </div>
              <div className="p-3">
                <div className="text-[12px] text-ink">Hi Jordan,</div>
                <div className="mt-1 text-[15px] font-bold text-ink">
                  {offerLabel} <span className="text-emerald-ink">your next {svcDisplay}</span>.
                </div>
                <div className="mt-2 inline-block rounded-md bg-emerald px-3 py-1.5 text-[12px] font-semibold text-white">Book my {svcDisplay} →</div>
              </div>
            </div>
          )}

          {pvTab === "text" && (
            <div className="rounded-lg bg-paper p-3">
              <div className="ml-auto max-w-[88%] rounded-2xl bg-emerald px-3 py-2 text-[12.5px] leading-snug text-white">
                Hi Jordan! It&rsquo;s your spa — {offerLabel.toLowerCase()} your next {svcDisplay}{cohort !== "all" ? ", just for you" : ""}. Book here: smartspa.app/s/… 💚
              </div>
              <div className="mt-1.5 text-[10px] text-ink-faint">AI-drafted per patient · you review before it sends</div>
            </div>
          )}
        </div>
        {isAb && (
          <p className="mt-2 text-[10.5px] text-ink-faint">Preview shows your base version; the bandit tests all {versions.length + 1} on real patients.</p>
        )}
      </div>

      {/* OPTIMIZE — A/B as one intent (spa-authored only) */}
      {mode === "spa" && (
      <div className="border-t border-rule bg-emerald-soft/20 px-5 py-4">
        <div className="flex items-start gap-3">
          <span className="flex h-7 w-7 flex-none items-center justify-center rounded-lg bg-emerald text-paper">
            <Wand2 className="h-4 w-4" />
          </span>
          <div className="flex-1">
            <div className="text-[14px] font-semibold text-ink">Let SmartSpa find your best version</div>
            <div className="text-[12px] text-ink-soft">Test a few versions on the same patients; the impartial bandit keeps whichever books best — no math, no &ldquo;declare a winner.&rdquo;</div>
          </div>
          <button
            type="button"
            onClick={() => { setOptimize((o) => !o); if (!optimize && versions.length === 0) setVersions([{ offerType: "percent_off", value: "", addon: "" }]); }}
            className={cn("relative h-6 w-11 flex-none rounded-full transition", optimize ? "bg-emerald" : "bg-rule")}
            aria-pressed={optimize}
          >
            <span className={cn("absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all", optimize ? "left-[22px]" : "left-0.5")} />
          </button>
        </div>

        {optimize && (
          <div className="mt-3 pl-10">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11.5px] font-semibold text-ink-soft">Testing:</span>
              <span className="rounded-full border border-emerald/40 bg-white px-2.5 py-1 text-[12px] font-semibold text-emerald-ink">{offerPhrase} <span className="text-ink-faint">(base)</span></span>
              {versions.map((v, i) => (
                <span key={i} className="inline-flex items-center gap-1.5 rounded-full border border-emerald/40 bg-white py-1 pl-2.5 pr-1.5 text-[12px] font-semibold text-emerald-ink">
                  <select value={v.offerType} onChange={(e) => setVersion(i, { offerType: e.target.value as AbType })} className="bg-transparent text-[12px] font-semibold focus:outline-none">
                    <option value="dollars_off">$ off</option>
                    <option value="percent_off">% off</option>
                    <option value="free_addon">Free add-on</option>
                  </select>
                  {v.offerType === "free_addon" ? (
                    <input value={v.addon} onChange={(e) => setVersion(i, { addon: e.target.value })} placeholder="brow wax" className="w-20 rounded border border-rule px-1.5 py-0.5 text-[11px]" />
                  ) : (
                    <input type="number" value={v.value} onChange={(e) => setVersion(i, { value: e.target.value })} placeholder={v.offerType === "percent_off" ? "20" : "50"} className="w-14 rounded border border-rule px-1.5 py-0.5 text-[11px]" />
                  )}
                  <button type="button" onClick={() => setVersions((prev) => prev.filter((_, k) => k !== i))} className="text-ink-faint hover:text-rose"><X className="h-3.5 w-3.5" /></button>
                </span>
              ))}
              {versions.length < 4 && (
                <button type="button" onClick={() => setVersions((prev) => [...prev, { offerType: "dollars_off", value: "", addon: "" }])} className="rounded-full border border-dashed border-emerald/40 px-2.5 py-1 text-[12px] font-semibold text-ink-faint hover:text-emerald">
                  + version
                </button>
              )}
            </div>
            <p className="mt-2 text-[11px] text-ink-faint">Keeps the winner automatically · most spas know in ~2 weeks · stop anytime.</p>
          </div>
        )}
      </div>
      )}

      {/* Activate */}
      <div className="flex items-center justify-between gap-3 border-t border-rule px-5 py-3">
        <span className="text-[12px] text-ink-faint">
          {mode === "mfr"
            ? "Manufacturer terms · you choose who, when & where"
            : isAb
              ? `Testing ${versions.length + 1} versions · keeps the winner`
              : "One offer · badges at booking"}
        </span>
        <button
          type="button"
          onClick={() => void activate()}
          disabled={busy || (mode === "mfr" ? !selectedMfrId : !serviceName)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald px-4 py-2 text-sm font-semibold text-paper shadow-sm hover:opacity-95 transition disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          {mode === "mfr" ? "Save delivery" : isAb ? "Activate & start testing" : "Activate offer"}
        </button>
      </div>
    </div>
  );
}

const inputCls = "w-full rounded border border-rule bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald/30";

function ModeTab({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex-1 rounded-lg px-3 py-1.5 text-[12.5px] font-semibold transition",
        on ? "bg-white text-emerald-ink shadow-sm" : "text-ink-soft hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

function Section({
  label, value, open, onToggle, children,
}: {
  label: string; value: string; open: boolean; onToggle: () => void; children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-rule">
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-3 px-3 py-2.5 text-left">
        <ChevronRight className={cn("h-4 w-4 text-ink-faint transition-transform", open && "rotate-90")} />
        <span className="flex-1 min-w-0">
          <span className="block text-[10px] font-semibold uppercase tracking-wider text-ink-faint">{label}</span>
          <span className="block truncate text-[13.5px] font-medium text-ink">{value}</span>
        </span>
      </button>
      {open && <div className="border-t border-rule px-3 py-3 space-y-3">{children}</div>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-soft">{label}</div>
      {children}
    </div>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full px-3 py-1 text-[12px] font-semibold border transition",
        on ? "bg-emerald text-paper border-emerald" : "bg-white text-ink-soft border-rule hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}
