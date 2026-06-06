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
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  CalendarCheck,
  CheckCircle2,
  ChevronLeft,
  Clock,
  Loader2,
} from "lucide-react";
import {
  getPublicBookingContextFn,
  listAvailableSlots,
  holdSlot,
  confirmBooking,
  type PublicBookingContext,
} from "@/server/scheduling.functions";
import type { Slot } from "@/lib/scheduling-slots";

export const Route = createFileRoute("/s/$slug")({
  component: PublicBookingPage,
});

type Ctx = Extract<PublicBookingContext, { ok: true }>;

type Step =
  | { k: "loading" }
  | { k: "error"; msg: string }
  | { k: "pick" }
  | { k: "contact"; token: string; slot: Slot; serviceName: string }
  | { k: "confirmed"; startIso: string };

const RANGE_DAYS = 30;

function PublicBookingPage() {
  const { slug } = Route.useParams();
  const [step, setStep] = useState<Step>({ k: "loading" });
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", email: "", phone: "" });
  const [submitting, setSubmitting] = useState(false);

  // Load the practice context.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await getPublicBookingContextFn({ data: { slug } });
        if (cancelled) return;
        if (!r.ok) {
          setStep({ k: "error", msg: r.reason });
          return;
        }
        setCtx(r);
        if (r.services.length === 0) {
          setStep({ k: "error", msg: "This practice has no services available to book online yet." });
          return;
        }
        if (r.services.length === 1) setServiceId(r.services[0].id);
        setStep({ k: "pick" });
      } catch (e) {
        if (!cancelled) {
          setStep({ k: "error", msg: e instanceof Error ? e.message : "Couldn't load this page." });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  // Load slots whenever a service is selected.
  useEffect(() => {
    if (!ctx || !serviceId) return;
    let cancelled = false;
    setSlotsLoading(true);
    setBanner(null);
    void (async () => {
      try {
        const now = new Date();
        const to = new Date(now.getTime() + RANGE_DAYS * 24 * 60 * 60_000);
        const r = await listAvailableSlots({
          data: {
            tenantId: ctx.tenantId,
            serviceId,
            fromIso: now.toISOString(),
            toIso: to.toISOString(),
          },
        });
        if (cancelled) return;
        setSlots(r.ok ? r.slots : []);
        if (!r.ok) setBanner(r.reason);
      } catch (e) {
        if (!cancelled) setBanner(e instanceof Error ? e.message : "Couldn't load times.");
      } finally {
        if (!cancelled) setSlotsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ctx, serviceId]);

  const tz = ctx?.timezone ?? "America/Los_Angeles";
  const selectedService = useMemo(
    () => ctx?.services.find((s) => s.id === serviceId) ?? null,
    [ctx, serviceId],
  );

  // Group slots by local day for rendering.
  const dayGroups = useMemo(() => {
    const groups: Array<{ key: string; heading: string; slots: Slot[] }> = [];
    const byKey = new Map<string, { heading: string; slots: Slot[] }>();
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

  async function onPickSlot(slot: Slot) {
    if (!ctx || !serviceId || !selectedService) return;
    setBanner(null);
    try {
      const r = await holdSlot({ data: { tenantId: ctx.tenantId, serviceId, startIso: slot.startIso } });
      if (!r.ok) {
        // Slot taken / no longer available → refresh and tell them gently.
        setBanner(r.reason);
        // Re-trigger slot load by nudging the effect.
        setServiceId((id) => id); // no-op; explicit reload below
        const now = new Date();
        const to = new Date(now.getTime() + RANGE_DAYS * 24 * 60 * 60_000);
        const fresh = await listAvailableSlots({
          data: { tenantId: ctx.tenantId, serviceId, fromIso: now.toISOString(), toIso: to.toISOString() },
        });
        setSlots(fresh.ok ? fresh.slots : []);
        return;
      }
      setStep({ k: "contact", token: r.token, slot, serviceName: selectedService.name });
    } catch (e) {
      setBanner(e instanceof Error ? e.message : "Couldn't hold that time.");
    }
  }

  async function onConfirm(e: FormEvent) {
    e.preventDefault();
    if (step.k !== "contact" || submitting) return;
    if (!form.name.trim() || !form.email.trim()) return;
    setSubmitting(true);
    try {
      const r = await confirmBooking({
        data: {
          token: step.token,
          name: form.name.trim(),
          email: form.email.trim(),
          phone: form.phone.trim() || undefined,
        },
      });
      if (!r.ok) {
        // Hold likely expired — bounce back to slot pick.
        setBanner(r.reason);
        setStep({ k: "pick" });
        return;
      }
      setStep({ k: "confirmed", startIso: r.startIso });
    } catch (err) {
      setBanner(err instanceof Error ? err.message : "Couldn't confirm the booking.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#fafaf7] text-stone-900 flex items-start justify-center px-5 py-12 sm:py-16">
      <div className="w-full max-w-md">
        {step.k === "loading" && (
          <div className="flex items-center gap-3 text-stone-500">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-sm">Loading…</span>
          </div>
        )}

        {step.k === "error" && (
          <ErrorCard title="Booking unavailable" body={step.msg} />
        )}

        {step.k === "pick" && ctx && (
          <div className="bg-white border border-stone-200 rounded-xl p-7 shadow-sm">
            <div className="flex items-center gap-2 text-stone-400 text-xs uppercase tracking-wider font-medium mb-3">
              <CalendarCheck className="w-3.5 h-3.5" />
              Book with {ctx.spaName}
            </div>

            {/* Service picker (hidden when only one service). */}
            {ctx.services.length > 1 && (
              <label className="block mb-5">
                <span className="block text-sm font-medium text-stone-700 mb-1.5">Service</span>
                <select
                  value={serviceId ?? ""}
                  onChange={(e) => setServiceId(e.target.value || null)}
                  className="w-full bg-stone-50 border border-stone-200 rounded-lg px-3 py-2.5 text-[15px] text-stone-900 focus:border-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-200"
                >
                  <option value="">Choose a service…</option>
                  {ctx.services.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} · {s.durationMin} min
                    </option>
                  ))}
                </select>
              </label>
            )}

            {selectedService && (
              <h1 className="text-xl font-semibold text-stone-900 leading-tight mb-1">
                {selectedService.name}
                <span className="text-stone-400 font-normal text-base"> · {selectedService.durationMin} min</span>
              </h1>
            )}
            {!serviceId && ctx.services.length > 1 && (
              <p className="text-stone-500 text-sm">Pick a service to see available times.</p>
            )}

            {banner && (
              <div className="mt-3 text-[13px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                {banner}
              </div>
            )}

            {serviceId && (
              <div className="mt-5">
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
                              key={s.startIso}
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
          </div>
        )}

        {step.k === "contact" && ctx && (
          <form onSubmit={onConfirm} className="bg-white border border-stone-200 rounded-xl p-7 shadow-sm">
            <button
              type="button"
              onClick={() => setStep({ k: "pick" })}
              className="inline-flex items-center gap-1 text-stone-500 hover:text-stone-800 text-[13px] mb-3"
            >
              <ChevronLeft className="w-3.5 h-3.5" /> Choose a different time
            </button>

            <div className="rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3 mb-5">
              <div className="flex items-center gap-2 text-emerald-900 text-[13px] font-medium">
                <Clock className="w-3.5 h-3.5" />
                {step.serviceName}
              </div>
              <div className="text-emerald-800 text-[15px] font-semibold mt-0.5">
                {fmtDayHeading(step.slot.startIso, tz)} at {fmtTime(step.slot.startIso, tz)}
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

        {step.k === "confirmed" && ctx && (
          <div className="bg-white border border-stone-200 rounded-xl p-7 shadow-sm">
            <div className="w-10 h-10 rounded-full bg-emerald-100 flex items-center justify-center mb-4">
              <CheckCircle2 className="w-5 h-5 text-emerald-700" />
            </div>
            <h1 className="text-2xl font-semibold text-stone-900 leading-tight">You're booked!</h1>
            <p className="mt-3 text-stone-600 leading-relaxed text-[15px]">
              {fmtDayHeading(step.startIso, tz)} at {fmtTime(step.startIso, tz)} with {ctx.spaName}.
              A confirmation is on its way to your email.
            </p>
          </div>
        )}
      </div>
    </main>
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
