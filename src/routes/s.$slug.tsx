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
  listAvailableSlots,
  holdSlot,
  confirmBooking,
  type PublicBookingContext,
  type PublicServiceOption,
  type PublicSlot,
} from "@/server/scheduling.functions";

export const Route = createFileRoute("/s/$slug")({
  component: PublicBookingPage,
});

type Ctx = Extract<PublicBookingContext, { ok: true }>;

type Screen = "loading" | "error" | "service" | "provider" | "time" | "contact" | "confirmed";

const RANGE_DAYS = 30;
const FIRST = "first" as const; // "first available" sentinel for provider choice
const BEST = "best" as const; // "best deal" sentinel (cheapest provider with an opening)

function PublicBookingPage() {
  const { slug } = Route.useParams();
  const [screen, setScreen] = useState<Screen>("loading");
  const [errMsg, setErrMsg] = useState("");
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [providerChoice, setProviderChoice] = useState<string | null>(null); // FIRST | providerId
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
        if (r.services.length === 1) {
          setServiceId(r.services[0].id);
          startService(r.services[0]);
        } else {
          setScreen("service");
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

  /** Advance from a chosen service: skip the provider step for solo spas. */
  function startService(s: PublicServiceOption) {
    setServiceId(s.id);
    setBanner(null);
    if (s.providers.length <= 1) {
      setProviderChoice(s.providers[0]?.id ?? FIRST);
      setScreen("time");
    } else {
      setProviderChoice(null);
      setScreen("provider");
    }
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
  }, [ctx, serviceId, providerChoice]);

  // Load slots when we reach the time step (service + provider chosen).
  useEffect(() => {
    if (screen === "time") void loadSlots();
  }, [screen, loadSlots]);

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
        },
      });
      if (!r.ok) {
        setBanner(r.reason);
        await loadSlots(); // refresh — someone may have just taken it
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
    if (!form.name.trim() || !form.email.trim()) return;
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
        setScreen("time");
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

  return (
    <main className="min-h-screen bg-[#fafaf7] text-stone-900 flex items-start justify-center px-5 py-12 sm:py-16">
      <div className="w-full max-w-md">
        {screen === "loading" && (
          <div className="flex items-center gap-3 text-stone-500">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-sm">Loading…</span>
          </div>
        )}

        {screen === "error" && <ErrorCard title="Booking unavailable" body={errMsg} />}

        {/* ── Step 1: pick a service ── */}
        {screen === "service" && ctx && (
          <div className="bg-white border border-stone-200 rounded-xl p-7 shadow-sm">
            <div className="flex items-center gap-2 text-stone-400 text-xs uppercase tracking-wider font-medium mb-4">
              <CalendarCheck className="w-3.5 h-3.5" />
              Book with {ctx.spaName}
            </div>
            <h1 className="text-xl font-semibold text-stone-900 leading-tight mb-4">
              What would you like to book?
            </h1>
            <div className="space-y-2">
              {ctx.services.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => startService(s)}
                  className="w-full text-left rounded-lg border border-stone-200 bg-stone-50 px-4 py-3 hover:border-stone-900 hover:bg-white transition-colors flex items-center justify-between gap-3"
                >
                  <span className="min-w-0">
                    <span className="block text-[15px] font-medium text-stone-900 truncate">{s.name}</span>
                    <span className="block text-[13px] text-stone-500">
                      {s.durationMin} min · {priceLabel(s)}
                    </span>
                  </span>
                  <ChevronRight className="w-4 h-4 text-stone-400 shrink-0" />
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ── Step 2: pick a provider (only when >1) ── */}
        {screen === "provider" && ctx && selService && (
          <div className="bg-white border border-stone-200 rounded-xl p-7 shadow-sm">
            <BackLink
              show={ctx.services.length > 1}
              label="Back to services"
              onClick={() => setScreen("service")}
            />
            <h1 className="text-xl font-semibold text-stone-900 leading-tight mb-1">
              {selService.name}
            </h1>
            <p className="text-stone-500 text-sm mb-4">Who would you like to see?</p>

            <div className="space-y-2">
              {/* First available — the soonest opening across the team. */}
              <button
                type="button"
                onClick={() => {
                  setProviderChoice(FIRST);
                  setScreen("time");
                }}
                className="w-full text-left rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 hover:border-emerald-500 transition-colors flex items-center justify-between gap-3"
              >
                <span className="flex items-center gap-2.5 min-w-0">
                  <Sparkles className="w-4 h-4 text-emerald-600 shrink-0" />
                  <span className="min-w-0">
                    <span className="block text-[15px] font-medium text-stone-900">First available</span>
                    <span className="block text-[13px] text-emerald-700">
                      Soonest opening with any of our team
                    </span>
                  </span>
                </span>
                <span className="text-[13px] text-stone-500 shrink-0">from ${selService.fromPrice}</span>
              </button>

              {/* Best deal — only when providers actually price this differently. */}
              {pricesVary && (
                <button
                  type="button"
                  onClick={() => {
                    setProviderChoice(BEST);
                    setScreen("time");
                  }}
                  className="w-full text-left rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 hover:border-amber-500 transition-colors flex items-center justify-between gap-3"
                >
                  <span className="flex items-center gap-2.5 min-w-0">
                    <BadgeDollarSign className="w-4 h-4 text-amber-600 shrink-0" />
                    <span className="min-w-0">
                      <span className="block text-[15px] font-medium text-stone-900">Best deal</span>
                      <span className="block text-[13px] text-amber-700">
                        Lowest price with an opening
                      </span>
                    </span>
                  </span>
                  <span className="text-[13px] text-stone-600 font-medium shrink-0">${bestPrice}</span>
                </button>
              )}

              {providers.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    setProviderChoice(p.id);
                    setScreen("time");
                  }}
                  className="w-full text-left rounded-lg border border-stone-200 bg-stone-50 px-4 py-3 hover:border-stone-900 hover:bg-white transition-colors flex items-center justify-between gap-3"
                >
                  <span className="flex items-center gap-2.5 min-w-0">
                    <span className="w-7 h-7 rounded-full bg-stone-200 flex items-center justify-center shrink-0">
                      <User className="w-3.5 h-3.5 text-stone-500" />
                    </span>
                    <span className="block text-[15px] font-medium text-stone-900 truncate">{p.name}</span>
                  </span>
                  <span className="text-[13px] text-stone-500 shrink-0">
                    ${p.price}
                    {p.durationMin !== selService.durationMin && ` · ${p.durationMin} min`}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ── Step 3: pick a time ── */}
        {screen === "time" && ctx && selService && (
          <div className="bg-white border border-stone-200 rounded-xl p-7 shadow-sm">
            <BackLink
              show={multiProvider || ctx.services.length > 1}
              label={multiProvider ? "Back to providers" : "Back to services"}
              onClick={() => setScreen(multiProvider ? "provider" : "service")}
            />
            <h1 className="text-xl font-semibold text-stone-900 leading-tight mb-0.5">
              {selService.name}
            </h1>
            <p className="text-stone-500 text-sm mb-4">
              {providerChoice === FIRST
                ? "First available"
                : providerChoice === BEST
                  ? "Best deal"
                  : `with ${nameOf(providerChoice) ?? "your provider"}`}{" "}
              · {selService.durationMin} min
            </p>

            {banner && (
              <div className="mb-3 text-[13px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                {banner}
              </div>
            )}

            {slotsLoading ? (
              <div className="flex items-center gap-2 text-stone-500 text-sm py-4">
                <Loader2 className="w-4 h-4 animate-spin" /> Finding open times…
              </div>
            ) : dayGroups.length === 0 ? (
              <p className="text-stone-500 text-sm py-4">
                No open times in the next {RANGE_DAYS} days. Please check back soon.
              </p>
            ) : (
              <div className="space-y-5 max-h-[60vh] overflow-y-auto pr-1">
                {dayGroups.map((g) => (
                  <div key={g.key}>
                    <div className="text-[13px] font-semibold text-stone-700 mb-2">{g.heading}</div>
                    <div className="grid grid-cols-3 gap-2">
                      {g.slots.map((s) => (
                        <button
                          key={`${s.startIso}-${s.providerId}`}
                          type="button"
                          onClick={() => onPickSlot(s)}
                          className="rounded-lg border border-stone-200 bg-stone-50 px-2 py-2 text-[14px] text-stone-800 hover:border-stone-900 hover:bg-white transition-colors tabular-nums"
                        >
                          {fmtTime(s.startIso, tz)}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Step 4: contact ── */}
        {screen === "contact" && ctx && held && (
          <form onSubmit={onConfirm} className="bg-white border border-stone-200 rounded-xl p-7 shadow-sm">
            <BackLink
              show
              label="Choose a different time"
              onClick={() => {
                setHeld(null);
                setScreen("time");
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
              <div className="text-emerald-700 text-[12px] mt-0.5">
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
                  className="w-full bg-stone-50 border border-stone-200 rounded-lg px-3 py-2.5 text-[15px] text-stone-900 focus:border-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-200"
                />
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
              disabled={submitting || !form.name.trim() || !form.email.trim()}
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
          <div className="bg-white border border-stone-200 rounded-xl p-7 shadow-sm">
            <div className="w-10 h-10 rounded-full bg-emerald-100 flex items-center justify-center mb-4">
              <CheckCircle2 className="w-5 h-5 text-emerald-700" />
            </div>
            <h1 className="text-2xl font-semibold text-stone-900 leading-tight">You're booked!</h1>
            <p className="mt-3 text-stone-600 leading-relaxed text-[15px]">
              {fmtDayHeading(confirmed.startIso, tz)} at {fmtTime(confirmed.startIso, tz)}
              {confirmed.providerName ? ` with ${confirmed.providerName}` : ` with ${ctx.spaName}`}.
              A confirmation is on its way to your email.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}

/** "$350" or "from $320" when providers price the service differently. */
function priceLabel(s: PublicServiceOption): string {
  const prices = s.providers.map((p) => p.price);
  const varies = prices.length > 1 && new Set(prices).size > 1;
  return varies ? `from $${s.fromPrice}` : `$${s.fromPrice}`;
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

function dayKey(iso: string, tz: string): string {
  // Stable per-day grouping key in the practice tz (YYYY-MM-DD-ish).
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
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
