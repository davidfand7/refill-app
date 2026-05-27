/**
 * /start — thin manual-onboarding intake for Refill (v1.13, ported from openagenticv4 v372).
 *
 * Where the "Set up Refill for my spa" CTA in every Karen cold-email lands.
 * Captures the minimum Karen + David need to onboard a new spa within
 * 24 hours: email, practice name, current scheduler. Optional fields for
 * richer context.
 *
 * Why manual not self-serve: shipping a half-baked self-serve flow loses
 * more pilots than it converts. Manual onboarding from a real spa-owner
 * couple is the strongest first impression in the segment. This intake
 * is the bridge until the self-serve /onboard wizard proves itself.
 *
 * Companion to:
 *   - /scan (CSV upload + math) — the funnel entry
 *   - /story (founders narrative) — the trust-build
 *   - /onboard (5-step self-serve wizard) — the post-trust path
 *
 * Cleave changes from openagenticv4's version (same pattern as v1.12 /story):
 *   - Drops useShell() + brandFor() (refill-app single-brand; brandFor
 *     was deleted during cleave per src/lib/brand.ts)
 *   - All slate-* / emerald-NNN / amber-NNN / rose-NNN Tailwind generics
 *     translated to Refill brand tokens per v1.10-v1.11 work
 *   - Dark CTA flipped bg-slate-900 → bg-emerald matching v1.11 sweep
 *   - rounded-3xl → rounded-xl per v1.10 polish convention
 */

import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { ArrowRight, CheckCircle2, Loader2 } from "lucide-react";

import { brand } from "@/lib/brand";
import { submitRefillSetupIntent } from "@/server/refill-setup.functions";

export const Route = createFileRoute("/start")({
  component: StartPage,
});

const SCHEDULERS = [
  "Acuity",
  "Boulevard",
  "Mangomint",
  "Vagaro",
  "Mindbody",
  "Jane (JaneApp)",
  "WellnessLiving",
  "GlossGenius",
  "Fresha",
  "Square Appointments",
  "Zenoti",
  "AestheticsPro",
  "Aesthetic Record",
  "Booker",
  "Schedulicity",
  "Moxie",
  "Meevo",
  "PatientNow",
  "Nextech",
  "Symplast",
  "Pabau",
  "SimplePractice",
  "RepeatMD",
  "Calendly",
  "Other / not sure",
];

function StartPage() {
  const [email, setEmail] = useState("");
  const [practiceName, setPracticeName] = useState("");
  const [scheduler, setScheduler] = useState("");
  const [phone, setPhone] = useState("");
  const [monthlyCancels, setMonthlyCancels] = useState("");
  const [notes, setNotes] = useState("");

  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setBusy(true);
      setError(null);
      try {
        await submitRefillSetupIntent({
          data: {
            email: email.trim(),
            practiceName: practiceName.trim(),
            scheduler: scheduler.trim() || "Other / not sure",
            phone: phone.trim() || null,
            estimatedMonthlyCancels: monthlyCancels.trim()
              ? Math.max(
                  0,
                  Math.round(Number(monthlyCancels.replace(/[^\d.]/g, ""))),
                )
              : null,
            notes: notes.trim() || null,
            source:
              typeof window !== "undefined" ? window.location.href : null,
          },
        });
        setDone(true);
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Something went wrong — please try again.",
        );
      } finally {
        setBusy(false);
      }
    },
    [email, practiceName, scheduler, phone, monthlyCancels, notes],
  );

  return (
    <div className="min-h-screen bg-paper text-ink">
      <header className="max-w-3xl mx-auto px-6 pt-6 pb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-lg bg-emerald text-paper flex items-center justify-center text-sm font-semibold">
            {brand.logoMark}
          </div>
          <span className="font-semibold tracking-tight text-ink">
            {brand.name}
          </span>
          <span className="text-ink-faint text-sm hidden sm:inline">
            {brand.tagline}
          </span>
        </div>
        <a
          href="/scan"
          className="text-sm text-ink-soft hover:text-ink transition"
        >
          ← Back to scan
        </a>
      </header>

      <section className="max-w-xl mx-auto px-6 pt-12 pb-6 text-center">
        <h1
          className="text-3xl sm:text-4xl font-semibold tracking-tight text-ink mb-3 leading-tight"
          style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}
        >
          Let&#39;s get {brand.name} set up for your spa.
        </h1>
        <p className="text-lg text-ink-soft max-w-lg mx-auto">
          Karen and David onboard each spa personally for the first 90 days
          — usually within 24 hours of this form. No credit card. No
          contract. We only get paid if we actually refill slots for you.
        </p>
      </section>

      <section className="max-w-xl mx-auto px-6 pb-16">
        {done ? (
          <div className="rounded-xl bg-emerald-soft border border-emerald/30 p-8 text-center">
            <div className="mx-auto h-14 w-14 rounded-full bg-emerald text-paper flex items-center justify-center mb-4">
              <CheckCircle2 className="h-7 w-7" />
            </div>
            <h2 className="text-xl font-semibold text-ink mb-2">
              Got it. We&#39;ll be in touch within 24 hours.
            </h2>
            <p className="text-sm text-ink-soft max-w-md mx-auto">
              Karen or David will reply directly to {email} to get your
              spa set up. If you need us sooner, email us at{" "}
              <a
                href="mailto:gethelp@getrefill.app"
                className="font-semibold underline text-emerald"
              >
                gethelp@getrefill.app
              </a>
              .
            </p>
            <a
              href="/scan"
              className="inline-flex items-center gap-2 mt-6 text-sm text-emerald hover:opacity-80 underline"
            >
              Scan another date range or location →
            </a>
          </div>
        ) : (
          <form
            onSubmit={submit}
            className="rounded-xl bg-white border border-rule shadow-sm p-7 space-y-5"
          >
            <Field
              label="Practice name"
              required
              value={practiceName}
              onChange={setPracticeName}
              placeholder="e.g. Rejuv Skin Spa"
            />
            <Field
              label="Your email"
              required
              type="email"
              value={email}
              onChange={setEmail}
              placeholder="you@yourspa.com"
            />
            <div>
              <label className="block text-sm font-medium text-ink-soft mb-1.5">
                Current scheduler <span className="text-rose">*</span>
              </label>
              <select
                required
                value={scheduler}
                onChange={(e) => setScheduler(e.target.value)}
                className="w-full rounded-xl border border-rule bg-white px-3.5 py-2.5 text-sm focus:outline-none focus:border-ink-soft"
              >
                <option value="">Pick the platform you use today…</option>
                {SCHEDULERS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <Field
              label="Phone (optional)"
              type="tel"
              value={phone}
              onChange={setPhone}
              placeholder="(555) 123-4567"
            />
            <Field
              label="Roughly how many cancellations + no-shows per month? (optional)"
              type="text"
              value={monthlyCancels}
              onChange={setMonthlyCancels}
              placeholder="e.g. 30"
            />
            <div>
              <label className="block text-sm font-medium text-ink-soft mb-1.5">
                Anything else we should know? (optional)
              </label>
              <textarea
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Multi-location, specific concerns, what you tried before, etc."
                className="w-full rounded-xl border border-rule bg-white px-3.5 py-2.5 text-sm focus:outline-none focus:border-ink-soft resize-y"
              />
            </div>

            {error && (
              <div className="rounded-xl bg-amber-soft border border-amber/30 px-4 py-3 text-sm text-amber">
                {error}
              </div>
            )}

            <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center pt-2">
              <button
                type="submit"
                disabled={busy}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald text-paper text-sm font-medium px-6 py-3 hover:opacity-90 transition disabled:opacity-50"
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    Send to Karen + David
                    <ArrowRight className="h-4 w-4" />
                  </>
                )}
              </button>
              <span className="text-xs text-ink-faint">
                Replies come from a real person, usually same-day.
              </span>
            </div>
          </form>
        )}

        <p className="text-center text-xs text-ink-faint mt-8 max-w-md mx-auto">
          {brand.name} is free until we actually recover revenue for you.
          12% of recovered, then. No credit card, no setup fee, no
          commitment. Cancel anytime.
        </p>
      </section>
    </div>
  );
}

function Field({
  label,
  required,
  type = "text",
  value,
  onChange,
  placeholder,
}: {
  label: string;
  required?: boolean;
  type?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-ink-soft mb-1.5">
        {label} {required && <span className="text-rose">*</span>}
      </label>
      <input
        required={required}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-xl border border-rule bg-white px-3.5 py-2.5 text-sm focus:outline-none focus:border-ink-soft"
      />
    </div>
  );
}
