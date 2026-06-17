/**
 * /s/<slug> — public patient self-booking page (v1.48.0).
 *
 * The native-scheduler conversion surface. No auth (slug = capability, same
 * spirit as /book's token). Multi-step: pick service → pick a live slot →
 * (HOLD) → contact details → (CONFIRM) → done. Slots are computed on read by
 * the slot engine; the HOLD→CONFIRM flow is race-safe at the DB layer (a slot
 * taken mid-checkout surfaces a friendly "just taken" and refreshes).
 *
 * Design vocabulary matches /book + /order + /unsubscribe: light-bg, dark-ink,
 * mobile-first (patients open this on a phone).
 */

import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  BadgeDollarSign,
  CalendarCheck,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Loader2,
  Sparkles,
  User,
} from "lucide-react";
import {
  getPublicBookingContextFn,
  getPublicBookingBrandFn,
  listAvailableSlots,
  holdSlot,
  confirmBooking,
  type PublicBookingContext,
  type PublicServiceOption,
  type PublicSlot,
} from "@/server/scheduling.functions";
import { categoryLabel, orderedCategoryRank } from "@/lib/service-categories";

export const Route = createFileRoute("/s/$slug")({
  component: PublicBookingPage,
  // ?service=<name> lets the Deals page deep-link a tapped Special straight here
  // with that service preselected. Optional + tolerant — an unknown value just
  // falls through to the normal service menu.
  validateSearch: (search: Record<string, unknown>): { service?: string } => ({
    service: typeof search.service === "string" ? search.service : undefined,
  }),
  // v2.66.0 — resolve the spa's brand name server-side so the booking link's
  // preview (og:site_name) carries the spa's brand when white-labeled. The page
  // had no head meta before this. Degrades to SmartSpa on any failure.
  loader: async ({ params }) => {
    try {
      const brand = await getPublicBookingBrandFn({ data: { slug: params.slug } });
      return { brandName: brand?.name ?? "SmartSpa" };
    } catch {
      return { brandName: "SmartSpa" };
    }
  },
  head: ({ loaderData }) => {
    const siteName = loaderData?.brandName ?? "SmartSpa";
    return {
      meta: [
        { title: `Book with ${siteName}` },
        { name: "description", content: "Pick a time that works for you — book online in under a minute." },
        { property: "og:title", content: `Book with ${siteName}` },
        { property: "og:description", content: "Pick a time that works for you — book online in under a minute." },
        { property: "og:site_name", content: siteName },
        { property: "og:type", content: "website" },
        { name: "twitter:card", content: "summary" },
      ],
    };
  },
});

type Ctx = Extract<PublicBookingContext, { ok: true }>;

type Screen = "loading" | "error" | "choose" | "contact" | "confirmed";
type Section = "service" | "provider" | "addons" | "when";
type ScheduleMode = "soonest" | "day";

const RANGE_DAYS = 30;
const FIRST = "first" as const; // "first available" sentinel for provider choice
const BEST = "best" as const; // "best deal" sentinel (cheapest provider with an opening)

function PublicBookingPage() {
  const { slug } = Route.useParams();
  const { service: preselectService } = Route.useSearch();
  const [screen, setScreen] = useState<Screen>("loading");
  const [errMsg, setErrMsg] = useState("");
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [providerChoice, setProviderChoice] = useState<string | null>(null); // FIRST | BEST | providerId
  const [selectedAddons, setSelectedAddons] = useState<Set<string>>(new Set());
  const [addonsTouched, setAddonsTouched] = useState(false); // patient has visited the add-ons step
  // Accordion: which of the two collapsed selections (+ When) is open.
  const [openSection, setOpenSection] = useState<Section>("service");
  // Smart Schedule: how the patient wants to find a time.
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode | null>(null);
  const [pickedDay, setPickedDay] = useState<string>(""); // YYYY-MM-DD for "Pick a day"
  const [slots, setSlots] = useState<PublicSlot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [held, setHeld] = useState<{ token: string; slot: PublicSlot } | null>(null);
  const [confirmed, setConfirmed] = useState<{ startIso: string; providerName: string | null } | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", email: "", phone: "" });
  const [submitting, setSubmitting] = useState(false);

  const tz = ctx?.timezone ?? "America/Los_Angeles";
  const selService = useMemo(
    () => ctx?.services.find((s) => s.id === serviceId) ?? null,
    [ctx, serviceId],
  );
  const providers = selService?.providers ?? [];
  const multiProvider = providers.length > 1;
  const showPrices = ctx?.showPrices !== false;

  // Add-ons offered with the chosen service. Each selection extends the visit
  // (combined duration drives the slot engine; combined price shows on confirm).
  const addOns = selService?.addOns ?? [];
  const hasAddons = addOns.length > 0;
  const chosenAddons = useMemo(
    () => addOns.filter((a) => selectedAddons.has(a.id)),
    [addOns, selectedAddons],
  );
  const extraMinutes = useMemo(
    () => chosenAddons.reduce((sum, a) => sum + a.durationMin, 0),
    [chosenAddons],
  );
  const addonPriceTotal = useMemo(
    () => chosenAddons.reduce((sum, a) => sum + (a.isFree ? 0 : a.price), 0),
    [chosenAddons],
  );
  // Step numbers shift with which sections are present.
  const stepProvider = 2;
  const stepAddons = multiProvider ? 3 : 2;
  const stepWhen = 2 + (multiProvider ? 1 : 0) + (hasAddons ? 1 : 0);

  // Group the service menu by category (collapsible turndowns). Built-ins keep
  // their canonical order; custom categories follow.
  const serviceGroups = useMemo(() => {
    const m = new Map<string, PublicServiceOption[]>();
    for (const s of ctx?.services ?? []) {
      const c = s.category?.trim() || "other";
      const arr = m.get(c) ?? [];
      arr.push(s);
      m.set(c, arr);
    }
    return [...m.entries()]
      .map(([cat, rows]) => ({
        cat,
        rows: [...rows].sort(
          (a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity) || a.name.localeCompare(b.name),
        ),
      }))
      .sort(
        (a, b) =>
          orderedCategoryRank(a.cat, ctx?.categoryOrder ?? []) -
            orderedCategoryRank(b.cat, ctx?.categoryOrder ?? []) || a.cat.localeCompare(b.cat),
      );
  }, [ctx]);
  const [expandedCats, setExpandedCats] = useState<Set<string>>(new Set());
  function toggleCat(cat: string) {
    setExpandedCats((p) => {
      const n = new Set(p);
      if (n.has(cat)) n.delete(cat);
      else n.add(cat);
      return n;
    });
  }
  const pricesVary = useMemo(() => new Set(providers.map((p) => p.price)).size > 1, [providers]);
  const bestPrice = providers.length ? Math.min(...providers.map((p) => p.price)) : 0;

  /** Resolve a provider name from an id (for "with X" copy). */
  const nameOf = useCallback(
    (pid: string | null) => providers.find((p) => p.id === pid)?.name ?? null,
    [providers],
  );

  // Load the practice context.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await getPublicBookingContextFn({ data: { slug } });
        if (cancelled) return;
        if (!r.ok) {
          setErrMsg(r.reason);
          setScreen("error");
          return;
        }
        setCtx(r);
        if (r.services.length === 0) {
          setErrMsg("This practice has no services available to book online yet.");
          setScreen("error");
          return;
        }
        setScreen("choose");
        // Single service → preselect it and jump to the next open selection.
        // Otherwise honor a ?service= deep-link from the Deals page (tap a
        // Special → land here with that service chosen), matching by name the
        // same way the badge matcher links offers to services. Unknown value →
        // fall through to the normal service menu (graceful, never errors).
        if (r.services.length === 1) {
          startService(r.services[0]);
        } else {
          const wanted = preselectService?.trim().toLowerCase();
          const match = wanted
            ? r.services.find((s) => {
                const n = s.name.trim().toLowerCase();
                return n === wanted || n.includes(wanted) || wanted.includes(n);
              })
            : undefined;
          if (match) startService(match);
          else setOpenSection("service");
        }
      } catch (e) {
        if (!cancelled) {
          setErrMsg(e instanceof Error ? e.message : "Couldn't load this page.");
          setScreen("error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  /** Pick a service → collapse section 1, open the next needed selection. Solo
   *  spas (≤1 provider for the service) skip straight to the When section. */
  function startService(s: PublicServiceOption) {
    setServiceId(s.id);
    setBanner(null);
    setScheduleMode(null);
    setSlots([]);
    setSelectedAddons(new Set());
    setAddonsTouched(false);
    const serviceHasAddons = s.addOns.length > 0;
    if (s.providers.length <= 1) {
      setProviderChoice(s.providers[0]?.id ?? FIRST);
      setOpenSection(serviceHasAddons ? "addons" : "when");
    } else {
      setProviderChoice(null);
      setOpenSection("provider");
    }
  }

  /** Pick a provider (or a smart option) → collapse section 2, open the next
   *  needed section (Add-ons if the service has any, else When). */
  function chooseProvider(choice: string) {
    setProviderChoice(choice);
    setBanner(null);
    setScheduleMode(null);
    setSlots([]);
    setOpenSection(hasAddons ? "addons" : "when");
  }

  /** Toggle an add-on; changing the selection invalidates loaded slots (the
   *  combined duration changed) so When recomputes when reopened. */
  function toggleAddon(id: string) {
    setSelectedAddons((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setScheduleMode(null);
    setSlots([]);
  }

  /** Continue past the Add-ons step → open When. */
  function continueAddons() {
    setAddonsTouched(true);
    setOpenSection("when");
  }

  const loadSlots = useCallback(async () => {
    if (!ctx || !serviceId || !providerChoice) return;
    setSlotsLoading(true);
    setBanner(null);
    try {
      const now = new Date();
      const to = new Date(now.getTime() + RANGE_DAYS * 24 * 60 * 60_000);
      const r = await listAvailableSlots({
        data: {
          tenantId: ctx.tenantId,
          serviceId,
          providerId:
            providerChoice === FIRST || providerChoice === BEST ? undefined : providerChoice,
          cheapestOnly: providerChoice === BEST ? true : undefined,
          extraMinutes: extraMinutes || undefined,
          fromIso: now.toISOString(),
          toIso: to.toISOString(),
        },
      });
      setSlots(r.ok ? r.slots : []);
      if (!r.ok) setBanner(r.reason);
    } catch (e) {
      setBanner(e instanceof Error ? e.message : "Couldn't load times.");
    } finally {
      setSlotsLoading(false);
    }
  }, [ctx, serviceId, providerChoice, extraMinutes]);

  // Load slots once the patient chooses how to schedule (Smart Schedule).
  useEffect(() => {
    if (screen === "choose" && scheduleMode && serviceId && providerChoice) void loadSlots();
  }, [screen, scheduleMode, serviceId, providerChoice, loadSlots]);

  // Group slots by local day for rendering.
  const dayGroups = useMemo(() => {
    const groups: Array<{ key: string; heading: string; slots: PublicSlot[] }> = [];
    const byKey = new Map<string, { heading: string; slots: PublicSlot[] }>();
    for (const s of slots) {
      const key = dayKey(s.startIso, tz);
      let g = byKey.get(key);
      if (!g) {
        g = { heading: fmtDayHeading(s.startIso, tz), slots: [] };
        byKey.set(key, g);
        groups.push({ key, heading: g.heading, slots: g.slots });
      }
      g.slots.push(s);
    }
    return groups;
  }, [slots, tz]);

  // "Pick a day": default the date to the soonest day that has openings.
  useEffect(() => {
    if (scheduleMode === "day" && !pickedDay && dayGroups.length > 0) {
      setPickedDay(dayGroups[0].key);
    }
  }, [scheduleMode, pickedDay, dayGroups]);

  // "Pick a day" filters the day groups to the chosen date; "Soonest" shows all.
  const visibleDayGroups = useMemo(() => {
    if (scheduleMode !== "day") return dayGroups;
    if (!pickedDay) return dayGroups.slice(0, 1);
    return dayGroups.filter((g) => g.key === pickedDay);
  }, [dayGroups, scheduleMode, pickedDay]);

  // Date-input bounds (today → RANGE_DAYS out), in the practice timezone.
  const todayKey = dayKey(new Date().toISOString(), tz);
  const maxKey = dayKey(new Date(Date.now() + RANGE_DAYS * 86_400_000).toISOString(), tz);

  // Collapsed-header summaries.
  const providerLabel =
    providerChoice === FIRST
      ? "Anyone"
      : providerChoice === BEST
        ? "Best value"
        : nameOf(providerChoice) ?? "Choose…";
  const whenLabel =
    scheduleMode === "soonest"
      ? "Soonest available"
      : scheduleMode === "day"
        ? pickedDay
          ? `Pick a day · ${shortDate(pickedDay)}`
          : "Pick a day"
        : "Choose…";
  // Basic email shape check (browser type=email is permissive; this gates submit).
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim());

  async function onPickSlot(slot: PublicSlot) {
    if (!ctx || !serviceId) return;
    setBanner(null);
    try {
      const r = await holdSlot({
        data: {
          tenantId: ctx.tenantId,
          serviceId,
          providerId: slot.providerId,
          startIso: slot.startIso,
          addonServiceIds: chosenAddons.map((a) => a.id),
        },
      });
      if (!r.ok) {
        // Only "time's gone" cases need a fresh list. Reload first, THEN set the
        // banner — loadSlots() clears it, so setting after keeps the reason on
        // screen (otherwise a hold failure silently flashes and vanishes).
        if (r.code === "taken" || r.code === "stale") await loadSlots();
        setBanner(r.reason);
        return;
      }
      setHeld({ token: r.token, slot });
      setScreen("contact");
    } catch (e) {
      setBanner(e instanceof Error ? e.message : "Couldn't hold that time.");
    }
  }

  async function onConfirm(e: FormEvent) {
    e.preventDefault();
    if (!held || submitting) return;
    if (!form.name.trim() || !emailValid) return;
    setSubmitting(true);
    try {
      const r = await confirmBooking({
        data: {
          token: held.token,
          name: form.name.trim(),
          email: form.email.trim(),
          phone: form.phone.trim() || undefined,
        },
      });
      if (!r.ok) {
        setBanner(r.reason);
        setScreen("choose");
        setOpenSection("when");
        setHeld(null);
        await loadSlots();
        return;
      }
      setConfirmed({ startIso: r.startIso, providerName: nameOf(held.slot.providerId) });
      setScreen("confirmed");
    } catch (err) {
      setBanner(err instanceof Error ? err.message : "Couldn't confirm the booking.");
    } finally {
      setSubmitting(false);
    }
  }

  const heldProviderName = held ? nameOf(held.slot.providerId) : null;
  const heldBasePrice = held
    ? providers.find((p) => p.id === held.slot.providerId)?.price ?? selService?.fromPrice ?? 0
    : 0;
  const heldTotalPrice = (selService?.isFree ? 0 : heldBasePrice) + addonPriceTotal;
  const heldTotalDuration = (selService?.durationMin ?? 0) + extraMinutes;

  return (
    <main className="min-h-screen bg-[#fafaf7] text-stone-900 flex items-start justify-center px-5 py-12 sm:py-16">
      <div className="w-full max-w-md sm:max-w-4xl">
        {/* v2.66.0 — "Your Brand" white-label header (logo or letter mark + name),
            shown on every screen once the context (and its brand) has loaded. */}
        {ctx?.brand && (
          <div className="flex items-center justify-center mb-5">
            {ctx.brand.logoUrl ? (
              <img
                src={ctx.brand.logoUrl}
                alt={ctx.brand.name}
                className="h-9 max-w-[200px] object-contain"
              />
            ) : (
              <div className="inline-flex items-center gap-2">
                <span
                  className="h-7 w-7 rounded-full flex items-center justify-center text-white font-bold text-sm"
                  style={{ backgroundColor: ctx.brand.accent }}
                >
                  {ctx.brand.logoMark}
                </span>
                <span className="text-[15px] font-semibold text-stone-900">
                  {ctx.brand.name}
                </span>
              </div>
            )}
          </div>
        )}

        {screen === "loading" && (
          <div className="flex items-center gap-3 text-stone-500">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-sm">Loading…</span>
          </div>
        )}

        {screen === "error" && <ErrorCard title="Booking unavailable" body={errMsg} />}

        {/* ── Booking accordion: Service → Provider → Smart Schedule ── */}
        {screen === "choose" && ctx && (
          <div className="bg-white border border-stone-200 rounded-xl p-5 sm:p-7 shadow-sm">
            <div className="flex items-center gap-2 text-stone-400 text-xs uppercase tracking-wider font-medium mb-4">
              <CalendarCheck className="w-3.5 h-3.5" />
              Book with {ctx.spaName}
            </div>

            <div className="border border-stone-200 rounded-xl divide-y divide-stone-200 overflow-hidden">
              {/* ── 1. Choose a service ── */}
              <SectionRow
                n={1}
                label="Service"
                value={selService?.name ?? null}
                placeholder="Choose a service"
                done={!!selService}
                open={openSection === "service"}
                onToggle={() => setOpenSection("service")}
              />
              {openSection === "service" && (
                <div className="px-4 py-4 space-y-2 bg-stone-50/40">
                  {serviceGroups.map(({ cat, rows }) => {
                // Single category → no turndown; just list the services.
                const single = serviceGroups.length === 1;
                const open = single || expandedCats.has(cat);
                return (
                  <div key={cat} className={single ? "space-y-2" : "rounded-lg border border-stone-200 overflow-hidden"}>
                    {!single && (
                      <button
                        type="button"
                        onClick={() => toggleCat(cat)}
                        className="w-full flex items-center gap-2 px-4 py-2.5 bg-stone-50 hover:bg-stone-100 transition-colors"
                      >
                        <ChevronRight
                          className={`w-4 h-4 text-stone-400 transition-transform ${open ? "rotate-90" : ""}`}
                        />
                        <span className="text-[14px] font-semibold text-stone-900">{categoryLabel(cat)}</span>
                        <span className="text-[12px] text-stone-400 tabular-nums">{rows.length}</span>
                      </button>
                    )}
                    {open && (
                      <div className={single ? "space-y-2" : "divide-y divide-stone-100"}>
                        {rows.map((s) => (
                          <button
                            key={s.id}
                            type="button"
                            onClick={() => startService(s)}
                            className={
                              single
                                ? "w-full text-left rounded-lg border border-stone-200 bg-stone-50 px-4 py-3 hover:border-stone-900 hover:bg-white transition-colors flex items-start justify-between gap-3"
                                : "w-full text-left px-4 py-3 hover:bg-stone-50 transition-colors flex items-start justify-between gap-3"
                            }
                          >
                            <span className="min-w-0 flex-1">
                              <span className="block text-[15px] font-medium text-stone-900 truncate">{s.name}</span>
                              {s.activeOffer && (
                                <span className="inline-block mt-0.5 rounded-full bg-amber-100 text-amber-800 text-[11px] font-semibold px-2 py-0.5">
                                  {s.activeOffer.label}
                                </span>
                              )}
                              {s.notes && s.notes.trim().toLowerCase() !== s.name.trim().toLowerCase() && (
                                <span className="block text-[13px] text-stone-500 mt-0.5 leading-snug whitespace-pre-line">
                                  {s.notes}
                                </span>
                              )}
                              {showPrices && s.feeCredit && !s.isFree && (
                                <span className="block text-[12px] text-emerald-700 mt-0.5">
                                  Fee applied toward your treatment
                                </span>
                              )}
                            </span>
                            <span className="shrink-0 text-[13px] text-stone-500 tabular-nums whitespace-nowrap">
                              {s.durationMin} min{showPrices ? ` · ${priceLabel(s)}` : ""}
                            </span>
                            <ChevronRight className="w-4 h-4 text-stone-400 shrink-0 mt-0.5" />
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
                </div>
              )}

              {/* ── 2. Choose a provider (only when the service has options) ── */}
              {selService && multiProvider && (
                <>
                  <SectionRow
                    n={2}
                    label="Provider"
                    value={providerChoice ? providerLabel : null}
                    placeholder="Choose a provider"
                    done={!!providerChoice}
                    open={openSection === "provider"}
                    onToggle={() => setOpenSection("provider")}
                  />
                  {openSection === "provider" && (
                    <div className="px-4 py-4 space-y-2 bg-stone-50/40">
                      {(() => {
                        const firstCard = (
                          <button
                            key="first"
                            type="button"
                            onClick={() => chooseProvider(FIRST)}
                            className="w-full text-left rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 hover:border-emerald-500 transition-colors flex items-center justify-between gap-3"
                          >
                            <span className="flex items-center gap-2.5 min-w-0">
                              <Sparkles className="w-4 h-4 text-emerald-600 shrink-0" />
                              <span className="min-w-0">
                                <span className="block text-[15px] font-medium text-stone-900">Anyone</span>
                                <span className="block text-[13px] text-emerald-700">Any available provider</span>
                              </span>
                            </span>
                            {showPrices && (
                              <span className="text-[13px] text-stone-500 shrink-0">{priceLabel(selService)}</span>
                            )}
                          </button>
                        );
                        const bestCard = pricesVary && showPrices ? (
                          <button
                            key="best"
                            type="button"
                            onClick={() => chooseProvider(BEST)}
                            className="w-full text-left rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 hover:border-amber-500 transition-colors flex items-center justify-between gap-3"
                          >
                            <span className="flex items-center gap-2.5 min-w-0">
                              <BadgeDollarSign className="w-4 h-4 text-amber-600 shrink-0" />
                              <span className="min-w-0">
                                <span className="block text-[15px] font-medium text-stone-900">Best value</span>
                                <span className="block text-[13px] text-amber-700">Lowest price with an opening</span>
                              </span>
                            </span>
                            <span className="text-[13px] text-stone-600 font-medium shrink-0">${bestPrice}</span>
                          </button>
                        ) : null;
                        return ctx.leadOption === "best_deal" ? [bestCard, firstCard] : [firstCard, bestCard];
                      })()}
                      {providers.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => chooseProvider(p.id)}
                          className="w-full text-left rounded-lg border border-stone-200 bg-white px-4 py-3 hover:border-stone-900 transition-colors flex items-center justify-between gap-3"
                        >
                          <span className="flex items-center gap-2.5 min-w-0">
                            <span className="w-7 h-7 rounded-full bg-stone-200 flex items-center justify-center shrink-0">
                              <User className="w-3.5 h-3.5 text-stone-500" />
                            </span>
                            <span className="block text-[15px] font-medium text-stone-900 truncate">{p.name}</span>
                          </span>
                          <span className="text-[13px] text-stone-500 shrink-0">
                            {showPrices && `$${p.price}`}
                            {p.durationMin !== selService.durationMin &&
                              `${showPrices ? " · " : ""}${p.durationMin} min`}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}

              {/* ── Add-ons (only when the chosen service offers any) ── */}
              {selService && providerChoice && hasAddons && (
                <>
                  <SectionRow
                    n={stepAddons}
                    label="Add-ons"
                    value={
                      addonsTouched
                        ? chosenAddons.length
                          ? `${chosenAddons.length} added${showPrices && addonPriceTotal > 0 ? ` · +$${addonPriceTotal}` : ""}`
                          : "None"
                        : null
                    }
                    placeholder="Enhance your visit (optional)"
                    done={addonsTouched}
                    open={openSection === "addons"}
                    onToggle={() => setOpenSection("addons")}
                  />
                  {openSection === "addons" && (
                    <div className="px-4 py-4 space-y-2 bg-stone-50/40">
                      <p className="text-[13px] text-stone-500">
                        Optional — add any to your appointment.
                      </p>
                      {addOns.map((a) => {
                        const checked = selectedAddons.has(a.id);
                        return (
                          <button
                            key={a.id}
                            type="button"
                            onClick={() => toggleAddon(a.id)}
                            className={`w-full text-left rounded-lg border px-4 py-3 transition-colors flex items-center justify-between gap-3 ${
                              checked
                                ? "border-emerald-500 bg-emerald-50"
                                : "border-stone-200 bg-white hover:border-stone-900"
                            }`}
                          >
                            <span className="flex items-center gap-2.5 min-w-0">
                              <span
                                className={`w-5 h-5 rounded-md border flex items-center justify-center shrink-0 ${
                                  checked ? "border-emerald-600 bg-emerald-600" : "border-stone-300 bg-white"
                                }`}
                              >
                                {checked && <CheckCircle2 className="w-3.5 h-3.5 text-white" />}
                              </span>
                              <span className="min-w-0">
                                <span className="block text-[15px] font-medium text-stone-900 truncate">{a.name}</span>
                                {a.activeOffer && (
                                  <span className="inline-block mt-0.5 rounded-full bg-amber-100 text-amber-800 text-[11px] font-semibold px-2 py-0.5">
                                    {a.activeOffer.label}
                                  </span>
                                )}
                              </span>
                            </span>
                            <span className="shrink-0 text-[13px] text-stone-500 tabular-nums whitespace-nowrap">
                              +{a.durationMin} min
                              {showPrices ? ` · ${a.isFree ? "Free" : `+$${a.price}`}` : ""}
                            </span>
                          </button>
                        );
                      })}
                      <button
                        type="button"
                        onClick={continueAddons}
                        className="mt-1 w-full inline-flex items-center justify-center gap-2 bg-stone-900 text-white font-medium text-[14px] rounded-lg px-5 py-2.5 hover:bg-stone-800 transition-colors"
                      >
                        {chosenAddons.length
                          ? `Continue${showPrices && addonPriceTotal > 0 ? ` · +$${addonPriceTotal}` : ""} (+${extraMinutes} min)`
                          : "Continue without add-ons"}
                      </button>
                    </div>
                  )}
                </>
              )}

              {/* ── Smart Schedule: when? ── */}
              {selService && providerChoice && (!hasAddons || addonsTouched) && (
                <>
                  <SectionRow
                    n={stepWhen}
                    label="When"
                    value={scheduleMode ? whenLabel : null}
                    placeholder="Pick a time"
                    done={!!scheduleMode}
                    open={openSection === "when"}
                    onToggle={() => setOpenSection("when")}
                  />
                  {openSection === "when" && (
                    <div className="px-4 py-4 space-y-3 bg-stone-50/40">
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setScheduleMode("soonest");
                            setPickedDay("");
                          }}
                          className={`rounded-lg border px-3 py-3 text-left transition-colors ${scheduleMode === "soonest" ? "border-emerald-500 bg-emerald-50" : "border-stone-200 bg-white hover:border-stone-900"}`}
                        >
                          <Sparkles className="w-4 h-4 text-emerald-600 mb-1" />
                          <span className="block text-[14px] font-medium text-stone-900">Soonest available</span>
                          <span className="block text-[12px] text-stone-500">First openings, all days</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setScheduleMode("day")}
                          className={`rounded-lg border px-3 py-3 text-left transition-colors ${scheduleMode === "day" ? "border-emerald-500 bg-emerald-50" : "border-stone-200 bg-white hover:border-stone-900"}`}
                        >
                          <CalendarCheck className="w-4 h-4 text-stone-600 mb-1" />
                          <span className="block text-[14px] font-medium text-stone-900">Pick a day</span>
                          <span className="block text-[12px] text-stone-500">Choose a specific date</span>
                        </button>
                      </div>

                      {scheduleMode === "day" && (
                        <div className="space-y-3">
                          <input
                            type="date"
                            value={pickedDay}
                            min={todayKey}
                            max={maxKey}
                            onChange={(e) => setPickedDay(e.target.value)}
                            className="w-full rounded-lg border border-stone-300 px-3 py-2 text-[14px] text-stone-900 outline-none focus:border-stone-900"
                          />
                          {pickedDay && (
                            <div className="flex items-center justify-between gap-2">
                              <button
                                type="button"
                                aria-label="Previous day"
                                disabled={pickedDay <= todayKey}
                                onClick={() => setPickedDay(addDays(pickedDay, -1))}
                                className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-stone-200 bg-white text-stone-700 transition-colors hover:border-stone-900 disabled:opacity-30 disabled:hover:border-stone-200"
                              >
                                <ChevronLeft className="w-5 h-5" />
                              </button>
                              <span className="text-[15px] font-semibold text-stone-900">
                                {dayLabelFromKey(pickedDay)}
                              </span>
                              <button
                                type="button"
                                aria-label="Next day"
                                disabled={pickedDay >= maxKey}
                                onClick={() => setPickedDay(addDays(pickedDay, 1))}
                                className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-stone-200 bg-white text-stone-700 transition-colors hover:border-stone-900 disabled:opacity-30 disabled:hover:border-stone-200"
                              >
                                <ChevronRight className="w-5 h-5" />
                              </button>
                            </div>
                          )}
                        </div>
                      )}

                      {banner && (
                        <div className="text-[13px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                          {banner}
                        </div>
                      )}

                      {scheduleMode &&
                        (slotsLoading ? (
                          <div className="flex items-center gap-2 text-stone-500 text-sm py-4">
                            <Loader2 className="w-4 h-4 animate-spin" /> Finding open times…
                          </div>
                        ) : visibleDayGroups.length === 0 ? (
                          <p className="text-stone-500 text-sm py-4">
                            {scheduleMode === "day"
                              ? "No openings that day — try another date."
                              : `No open times in the next ${RANGE_DAYS} days. Please check back soon.`}
                          </p>
                        ) : scheduleMode === "day" ? (
                          // One chosen day — fan the times across the full width, no scroll.
                          <div className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-7 lg:grid-cols-8 gap-2">
                            {(visibleDayGroups[0]?.slots ?? []).map((s) => (
                              <button
                                key={`${s.startIso}-${s.providerId}`}
                                type="button"
                                onClick={() => onPickSlot(s)}
                                className="rounded-lg border border-stone-200 bg-white px-2 py-2 text-center text-[14px] text-stone-800 transition-colors hover:border-stone-900 hover:bg-stone-50 tabular-nums"
                              >
                                {fmtTime(s.startIso, tz)}
                              </button>
                            ))}
                          </div>
                        ) : (
                          // Soonest — one column per upcoming day.
                          <div className="flex flex-col sm:flex-row gap-y-5 sm:gap-x-4 max-h-[60vh] overflow-y-auto sm:overflow-y-hidden sm:overflow-x-auto pr-1 sm:pb-2">
                            {visibleDayGroups.map((g) => (
                              <div key={g.key} className="sm:shrink-0 sm:w-36 sm:max-h-[56vh] sm:overflow-y-auto">
                                <div className="text-[13px] font-semibold text-stone-700 mb-2 sm:text-center sm:sticky sm:top-0 sm:bg-stone-50 sm:pb-1">
                                  {g.heading}
                                </div>
                                <div className="grid grid-cols-3 sm:grid-cols-1 gap-2">
                                  {g.slots.map((s) => (
                                    <button
                                      key={`${s.startIso}-${s.providerId}`}
                                      type="button"
                                      onClick={() => onPickSlot(s)}
                                      className="rounded-lg border border-stone-200 bg-white px-2 py-2 text-[14px] text-stone-800 hover:border-stone-900 transition-colors tabular-nums sm:text-center"
                                    >
                                      {fmtTime(s.startIso, tz)}
                                    </button>
                                  ))}
                                </div>
                              </div>
                            ))}
                          </div>
                        ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {/* ── Step 4: contact ── */}
        {screen === "contact" && ctx && held && (
          <form onSubmit={onConfirm} className="bg-white border border-stone-200 rounded-xl p-7 shadow-sm sm:max-w-lg sm:mx-auto">
            <BackLink
              show
              label="Choose a different time"
              onClick={() => {
                setHeld(null);
                setScreen("choose");
                setOpenSection("when");
              }}
            />

            <div className="rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3 mb-5">
              <div className="flex items-center gap-2 text-emerald-900 text-[13px] font-medium">
                <Clock className="w-3.5 h-3.5" />
                {selService?.name}
                {heldProviderName && <span className="text-emerald-700 font-normal">· with {heldProviderName}</span>}
              </div>
              <div className="text-emerald-800 text-[15px] font-semibold mt-0.5">
                {fmtDayHeading(held.slot.startIso, tz)} at {fmtTime(held.slot.startIso, tz)}
              </div>
              {chosenAddons.length > 0 && (
                <div className="mt-2 pt-2 border-t border-emerald-200 space-y-0.5">
                  {chosenAddons.map((a) => (
                    <div key={a.id} className="flex items-center justify-between text-emerald-800 text-[12px]">
                      <span>+ {a.name}</span>
                      <span className="tabular-nums">
                        +{a.durationMin} min{showPrices ? ` · ${a.isFree ? "Free" : `$${a.price}`}` : ""}
                      </span>
                    </div>
                  ))}
                  <div className="flex items-center justify-between text-emerald-900 text-[12px] font-semibold pt-0.5">
                    <span>{heldTotalDuration} min total</span>
                    {showPrices && <span className="tabular-nums">${heldTotalPrice}</span>}
                  </div>
                </div>
              )}
              <div className="text-emerald-700 text-[12px] mt-1.5">
                Held for you for a few minutes — finish below to confirm.
              </div>
            </div>

            <div className="space-y-4">
              <Field label="Your name">
                <input
                  type="text"
                  required
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  className="w-full bg-stone-50 border border-stone-200 rounded-lg px-3 py-2.5 text-[15px] text-stone-900 focus:border-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-200"
                />
              </Field>
              <Field label="Email">
                <input
                  type="email"
                  required
                  value={form.email}
                  onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                  className={`w-full bg-stone-50 border rounded-lg px-3 py-2.5 text-[15px] text-stone-900 focus:outline-none focus:ring-2 ${
                    form.email.trim() && !emailValid
                      ? "border-rose-300 focus:border-rose-400 focus:ring-rose-100"
                      : "border-stone-200 focus:border-stone-400 focus:ring-stone-200"
                  }`}
                />
                {form.email.trim() && !emailValid && (
                  <span className="block text-[12px] text-rose-600 mt-1">Enter a valid email address.</span>
                )}
              </Field>
              <Field label="Phone (optional)">
                <input
                  type="tel"
                  value={form.phone}
                  onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                  className="w-full bg-stone-50 border border-stone-200 rounded-lg px-3 py-2.5 text-[15px] text-stone-900 focus:border-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-200"
                />
              </Field>
            </div>

            {banner && (
              <div className="mt-3 text-[13px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                {banner}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting || !form.name.trim() || !emailValid}
              className="mt-6 w-full inline-flex items-center justify-center gap-2 bg-stone-900 text-white font-medium text-[15px] rounded-lg px-5 py-3 hover:bg-stone-800 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
            >
              {submitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" /> Confirming…
                </>
              ) : (
                "Confirm appointment"
              )}
            </button>
          </form>
        )}

        {/* ── Done ── */}
        {screen === "confirmed" && ctx && confirmed && (
          <div className="bg-white border border-stone-200 rounded-xl p-7 shadow-sm sm:max-w-lg sm:mx-auto">
            <div className="w-10 h-10 rounded-full bg-emerald-100 flex items-center justify-center mb-4">
              <CheckCircle2 className="w-5 h-5 text-emerald-700" />
            </div>
            <h1 className="text-2xl font-semibold text-stone-900 leading-tight">You're booked!</h1>
            <p className="mt-3 text-stone-600 leading-relaxed text-[15px]">
              {fmtDayHeading(confirmed.startIso, tz)} at {fmtTime(confirmed.startIso, tz)}
              {confirmed.providerName ? ` with ${confirmed.providerName}` : ` with ${ctx.spaName}`}.
              A confirmation is on its way to your email.
            </p>
            {(() => {
              const addonTitle = chosenAddons.length
                ? ` + ${chosenAddons.map((a) => a.name).join(", ")}`
                : "";
              const links = buildCalendarLinks({
                title: `${selService?.name ?? "Appointment"}${addonTitle} — ${ctx.spaName}`,
                startIso: confirmed.startIso,
                durationMin: (selService?.durationMin ?? 30) + extraMinutes,
                details: `${confirmed.providerName ? `With ${confirmed.providerName}. ` : ""}${chosenAddons.length ? `Add-ons: ${chosenAddons.map((a) => a.name).join(", ")}. ` : ""}Booked with ${ctx.spaName}.`,
                location: ctx.spaName,
              });
              return (
                <div className="mt-5 flex flex-wrap items-center gap-2">
                  <span className="text-[13px] text-stone-500 mr-1">Add to calendar:</span>
                  <a
                    href={links.google}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-[13px] font-medium text-stone-700 hover:border-stone-900 transition-colors"
                  >
                    <CalendarCheck className="w-3.5 h-3.5" /> Google
                  </a>
                  <a
                    href={links.icsHref}
                    download="appointment.ics"
                    className="inline-flex items-center gap-1.5 rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-[13px] font-medium text-stone-700 hover:border-stone-900 transition-colors"
                  >
                    <CalendarCheck className="w-3.5 h-3.5" /> Apple / Outlook
                  </a>
                </div>
              );
            })()}
          </div>
        )}

        {/* v2.66.0 — "powered by SmartSpa", suppressed when white-label removes it. */}
        {ctx?.brand && !ctx.brand.removePoweredBy && (
          <p className="text-[11px] text-stone-400 text-center mt-6">
            powered by SmartSpa
          </p>
        )}
      </div>
    </main>
  );
}

/** "Free", "$350", or "from $320" when providers price the service differently. */
function priceLabel(s: PublicServiceOption): string {
  if (s.isFree) return "Free";
  const prices = s.providers.map((p) => p.price);
  const varies = prices.length > 1 && new Set(prices).size > 1;
  return varies ? `from $${s.fromPrice}` : `$${s.fromPrice}`;
}

function SectionRow({
  n,
  label,
  value,
  placeholder,
  done,
  open,
  onToggle,
}: {
  n: number;
  label: string;
  value: string | null;
  placeholder: string;
  done: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="w-full flex items-center justify-between gap-3 px-4 py-3.5 hover:bg-stone-50 transition-colors text-left"
    >
      <span className="flex items-center gap-3 min-w-0">
        <span
          className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 text-[12px] font-semibold tabular-nums ${
            done ? "bg-emerald-600 text-white" : open ? "bg-stone-900 text-white" : "bg-stone-200 text-stone-500"
          }`}
        >
          {n}
        </span>
        <span className="min-w-0">
          <span className="block text-[11px] uppercase tracking-wider text-stone-400 font-semibold">{label}</span>
          <span
            className={`block text-[15px] font-medium truncate ${value ? "text-stone-900" : "text-stone-400"}`}
          >
            {value ?? placeholder}
          </span>
        </span>
      </span>
      <ChevronRight className={`w-4 h-4 text-stone-400 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
    </button>
  );
}

function BackLink({ show, label, onClick }: { show: boolean; label: string; onClick: () => void }) {
  if (!show) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 text-stone-500 hover:text-stone-800 text-[13px] mb-3"
    >
      <ChevronLeft className="w-3.5 h-3.5" /> {label}
    </button>
  );
}

// ── Date/time formatting in the practice timezone ────────────────────────────

function fmtTime(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

function fmtDayHeading(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
    month: "short",
    day: "numeric",
  }).format(new Date(iso));
}

/** "2026-06-24" → "Tue, Jun 24" (parsed as a plain calendar date, no tz drift). */
function shortDate(d: string): string {
  const [y, m, day] = d.split("-").map((n) => parseInt(n, 10));
  if (!y || !m || !day) return d;
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function dayKey(iso: string, tz: string): string {
  // Stable per-day grouping key in the practice tz (YYYY-MM-DD-ish).
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

/** Step a "YYYY-MM-DD" day key by ±n calendar days (UTC math, no tz drift). */
function addDays(key: string, n: number): string {
  const [y, m, d] = key.split("-").map((x) => parseInt(x, 10));
  if (!y || !m || !d) return key;
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

/** "2026-06-17" → "Wednesday, Jun 17" (parsed as a plain calendar date). */
function dayLabelFromKey(key: string): string {
  const [y, m, d] = key.split("-").map((x) => parseInt(x, 10));
  if (!y || !m || !d) return key;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}

/** Escape a value for an ICS text field. */
function icsEscape(s: string): string {
  return s.replace(/[\\,;]/g, (m) => "\\" + m).replace(/\n/g, "\\n");
}

/** Build "add to calendar" targets for a confirmed appointment. Returns a
 *  Google Calendar template URL and a downloadable .ics data URI (Apple/Outlook). */
function buildCalendarLinks(opts: {
  title: string;
  startIso: string;
  durationMin: number;
  details: string;
  location: string;
}): { google: string; icsHref: string } {
  const startMs = new Date(opts.startIso).getTime();
  // Canonicalize BOTH ends through toISOString() → always UTC "…Z". The DB
  // hands back scheduled_at as "2026-06-18T20:00:00+00:00" (no Z); stamping
  // that raw left a tz-less "20260618T200000+0000", which calendars read as
  // FLOATING local time (a +6h shift in MDT). Derive from the epoch instead.
  const startIsoUtc = new Date(startMs).toISOString();
  const endIso = new Date(startMs + opts.durationMin * 60_000).toISOString();
  // Calendar timestamps: UTC basic format, e.g. 20260624T170000Z.
  const stamp = (iso: string) => iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const start = stamp(startIsoUtc);
  const end = stamp(endIso);
  const google =
    "https://calendar.google.com/calendar/render?action=TEMPLATE" +
    `&text=${encodeURIComponent(opts.title)}` +
    `&dates=${start}/${end}` +
    `&details=${encodeURIComponent(opts.details)}` +
    `&location=${encodeURIComponent(opts.location)}`;
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//SmartSpa//Booking//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${start}-${startMs}@getrefill.app`,
    `DTSTAMP:${start}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SUMMARY:${icsEscape(opts.title)}`,
    `DESCRIPTION:${icsEscape(opts.details)}`,
    `LOCATION:${icsEscape(opts.location)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const icsHref = `data:text/calendar;charset=utf-8,${encodeURIComponent(ics)}`;
  return { google, icsHref };
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-stone-700 mb-1.5">{label}</span>
      {children}
    </label>
  );
}

function ErrorCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="bg-white border border-stone-200 rounded-xl p-7 shadow-sm">
      <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center mb-4">
        <AlertTriangle className="w-5 h-5 text-amber-700" />
      </div>
      <h1 className="text-2xl font-semibold text-stone-900 leading-tight">{title}</h1>
      <p className="mt-3 text-stone-600 leading-relaxed text-[15px]">{body}</p>
    </div>
  );
}
