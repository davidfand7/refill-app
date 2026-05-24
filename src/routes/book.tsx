/**
 * /book?b=<token> — public booking landing page (v353).
 *
 * The conversion point of the Promotions Engine arc. Patient clicks the
 * Book button in a v350 email or the Book link in a v350 SMS, lands
 * here, sees the offer + a short preference form, submits → state row
 * advances to 'booked' and the spa owner sees the request in the
 * inbound patient_outreach feed (future Emma inbox surface).
 *
 * Scope = request-a-time, NOT full calendar integration. Patient picks
 * a date + time-of-day window + best contact method + optional note; spa
 * confirms via their normal booking system. Boulevard/Vagaro/Aesthetics-
 * Record integration deferred to a per-tenant ship.
 *
 * Token as capability — same pattern as /order (v325) and /unsubscribe
 * (v351). No auth. Idempotent: revisiting after booking shows the
 * already-booked confirmation directly.
 *
 * Design vocabulary: light-bg / dark-ink, mobile-first, matches
 * /unsubscribe + /order. Patient very plausibly opens this from a
 * phone email app between things.
 */

import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { z } from "zod";
import { fallback } from "@tanstack/zod-adapter";
import { CalendarCheck, CheckCircle2, Loader2, AlertTriangle } from "lucide-react";
import {
  getBookingTarget,
  submitBookingRequest,
  type BookingPageData,
} from "@/server/emma-booking.functions";

const bookSearch = z.object({
  b: fallback(z.string().optional(), undefined),
});

export const Route = createFileRoute("/book")({
  validateSearch: bookSearch,
  component: BookingPage,
});

type LoadState =
  | { kind: "loading" }
  | { kind: "missing-token" }
  | { kind: "error"; message: string }
  | { kind: "form"; target: Extract<BookingPageData, { ok: true }> }
  | { kind: "done"; spaName: string };

type FormState = {
  preferredDate: string;
  preferredTime: "morning" | "afternoon" | "evening" | "flexible";
  contactPref: "phone" | "text" | "email";
  note: string;
};

function todayIso(): string {
  const d = new Date();
  // YYYY-MM-DD in local time for the <input type="date"> min value.
  const tz = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - tz).toISOString().slice(0, 10);
}

function BookingPage() {
  const { b: token } = Route.useSearch();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState<FormState>({
    preferredDate: "",
    preferredTime: "flexible",
    contactPref: "text",
    note: "",
  });

  useEffect(() => {
    if (!token) {
      setState({ kind: "missing-token" });
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const r = await getBookingTarget({ data: { token } });
        if (cancelled) return;
        if (!r.ok) {
          setState({ kind: "error", message: r.reason });
          return;
        }
        if (r.alreadyBooked) {
          setState({ kind: "done", spaName: r.spaName });
        } else {
          setState({ kind: "form", target: r });
        }
      } catch (e) {
        if (cancelled) return;
        setState({
          kind: "error",
          message: e instanceof Error ? e.message : "Couldn't load this link.",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!token || submitting) return;
    if (!form.preferredDate) return;
    setSubmitting(true);
    try {
      const r = await submitBookingRequest({
        data: {
          token,
          preferredDate: form.preferredDate,
          preferredTime: form.preferredTime,
          contactPref: form.contactPref,
          note: form.note,
        },
      });
      if (!r.ok) {
        setState({ kind: "error", message: r.reason });
        return;
      }
      setState({ kind: "done", spaName: r.spaName });
    } catch (e) {
      setState({
        kind: "error",
        message: e instanceof Error ? e.message : "Couldn't submit the request.",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#fafaf7] text-stone-900 flex items-start justify-center px-5 py-12 sm:py-20">
      <div className="w-full max-w-md">
        {state.kind === "loading" && (
          <div className="flex items-center gap-3 text-stone-500">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-sm">Loading…</span>
          </div>
        )}

        {state.kind === "missing-token" && (
          <ErrorCard
            title="Booking link incomplete"
            body="This link is missing its reference code. If you clicked it from an email or text, the message may have been truncated. Contact the practice directly to book."
          />
        )}

        {state.kind === "error" && (
          <ErrorCard title="Couldn't load this link" body={state.message} />
        )}

        {state.kind === "form" && (
          <form
            onSubmit={handleSubmit}
            className="bg-white border border-stone-200 rounded-xl p-7 shadow-sm"
          >
            <div className="flex items-center gap-2 text-stone-400 text-xs uppercase tracking-wider font-medium mb-4">
              <CalendarCheck className="w-3.5 h-3.5" />
              Book your appointment
            </div>
            <h1 className="text-2xl font-semibold text-stone-900 leading-tight">
              Hi {state.target.patientFirstName} — let's get you on the books.
            </h1>

            {state.target.offerHeadline && (
              <p className="mt-3 text-stone-700 leading-relaxed text-[15px]">
                {state.target.offerHeadline}
              </p>
            )}

            {state.target.offerLineItems.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-2">
                {state.target.offerLineItems.map((item) => (
                  <span
                    key={item}
                    className="inline-block bg-emerald-50 text-emerald-800 border border-emerald-200 text-xs font-semibold uppercase tracking-wider rounded-full px-2.5 py-1"
                  >
                    {item}
                  </span>
                ))}
              </div>
            )}

            <p className="mt-5 text-stone-500 text-sm">
              Tell {state.target.spaName} when works for you. They'll confirm
              the exact time and reach out via your preferred method below.
            </p>

            <div className="mt-6 space-y-4">
              <Field label="Preferred date">
                <input
                  type="date"
                  required
                  min={todayIso()}
                  value={form.preferredDate}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, preferredDate: e.target.value }))
                  }
                  className="w-full bg-stone-50 border border-stone-200 rounded-lg px-3 py-2.5 text-[15px] text-stone-900 focus:border-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-200"
                />
              </Field>

              <Field label="Preferred time of day">
                <select
                  required
                  value={form.preferredTime}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      preferredTime: e.target.value as FormState["preferredTime"],
                    }))
                  }
                  className="w-full bg-stone-50 border border-stone-200 rounded-lg px-3 py-2.5 text-[15px] text-stone-900 focus:border-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-200"
                >
                  <option value="morning">Morning</option>
                  <option value="afternoon">Afternoon</option>
                  <option value="evening">Evening</option>
                  <option value="flexible">Flexible — any time works</option>
                </select>
              </Field>

              <Field label="Best way to reach you">
                <select
                  required
                  value={form.contactPref}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      contactPref: e.target.value as FormState["contactPref"],
                    }))
                  }
                  className="w-full bg-stone-50 border border-stone-200 rounded-lg px-3 py-2.5 text-[15px] text-stone-900 focus:border-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-200"
                >
                  <option value="text">Text message</option>
                  <option value="phone">Phone call</option>
                  <option value="email">Email</option>
                </select>
              </Field>

              <Field label="Anything else to tell us? (Optional)">
                <textarea
                  rows={3}
                  maxLength={800}
                  value={form.note}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, note: e.target.value }))
                  }
                  placeholder="Specific treatment, questions, scheduling constraints…"
                  className="w-full bg-stone-50 border border-stone-200 rounded-lg px-3 py-2.5 text-[15px] text-stone-900 placeholder:text-stone-400 focus:border-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-200 resize-none"
                />
              </Field>
            </div>

            <button
              type="submit"
              disabled={submitting || !form.preferredDate}
              className="mt-7 w-full inline-flex items-center justify-center gap-2 bg-stone-900 text-white font-medium text-[15px] rounded-lg px-5 py-3 hover:bg-stone-800 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
            >
              {submitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Submitting…
                </>
              ) : (
                "Request appointment"
              )}
            </button>
            <p className="mt-4 text-stone-400 text-xs text-center">
              {state.target.spaName} will confirm the exact time within a
              business day.
            </p>
          </form>
        )}

        {state.kind === "done" && (
          <div className="bg-white border border-stone-200 rounded-xl p-7 shadow-sm">
            <div className="w-10 h-10 rounded-full bg-emerald-100 flex items-center justify-center mb-4">
              <CheckCircle2 className="w-5 h-5 text-emerald-700" />
            </div>
            <h1 className="text-2xl font-semibold text-stone-900 leading-tight">
              Got it — request sent.
            </h1>
            <p className="mt-3 text-stone-600 leading-relaxed text-[15px]">
              {state.spaName} will reach out shortly to confirm your appointment
              time. You can close this page.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-stone-700 mb-1.5">
        {label}
      </span>
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
      <h1 className="text-2xl font-semibold text-stone-900 leading-tight">
        {title}
      </h1>
      <p className="mt-3 text-stone-600 leading-relaxed text-[15px]">{body}</p>
    </div>
  );
}
