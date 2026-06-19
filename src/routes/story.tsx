/**
 * /story — the deep-trust founders' story page (v1.12, ported from openagenticv4 v371.3).
 *
 * Polished long-form version of Karen + David's outreach narrative. Lives at
 * getrefill.app/story — the page every Karen cold-email CTA links to for
 * prospects who want the full story: founders, pain, what we built,
 * transparent pricing, peer-to-peer close.
 *
 * Voice: Karen Anderson, co-founder + 20-year med-spa owner. Singular
 * named author throughout (vs the draft's mixed "my husband and I" + joint
 * authorship). David is referenced; Karen is the peer-to-peer voice that
 * lands with other (mostly female) spa owners.
 *
 * Tone moves preserved from Grasshopper's original draft:
 *   - The 20+ years owner / 35+ years tech-bizdev frame (founding hook)
 *   - "We get paid IF you get paid"
 *   - "Nothing, nada, zip, zilch" guarantee landing
 *   - "Whatever you decide, good luck on your Med Spa journey" close
 *   - Karen + David signature with personal touch
 *
 * Cleave changes from openagenticv4's version:
 *   - Drops useShell() + brandFor() shell-discriminator (refill-app is
 *     single-brand; brandFor was removed during cleave per src/lib/brand.ts)
 *   - All slate-* / emerald-NNN / amber-NNN Tailwind generics translated to
 *     Refill brand tokens (ink / ink-soft / ink-faint / emerald / emerald-soft
 *     / amber / amber-soft / paper / rule) per v1.10-v1.11 brand-coherence work
 *   - Dark CTA blocks: bg-slate-900 → bg-emerald (matches v1.11 sweep)
 */

import { createFileRoute } from "@tanstack/react-router";
import { ArrowRight, Lock, Sparkles } from "lucide-react";

import { brand } from "@/lib/brand";

export const Route = createFileRoute("/story")({
  component: StoryPage,
});

const SCAN_HREF = "/scan";
const HELP_EMAIL = "gethelp@getrefill.app";

function StoryPage() {
  return (
    <div className="min-h-screen bg-paper text-ink">
      {/* Top strip — same chrome rhythm as /scan */}
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
          href={SCAN_HREF}
          className="text-sm text-ink-soft hover:text-ink transition"
        >
          See your number →
        </a>
      </header>

      {/* Hero */}
      <section className="max-w-2xl mx-auto px-6 pt-12 pb-8 text-center">
        <div className="inline-flex items-center gap-1.5 text-xs uppercase tracking-wider text-emerald bg-emerald-soft border border-emerald/30 rounded-full px-3 py-1 mb-5">
          <Sparkles className="h-3 w-3" />
          Built by spa owners for spa owners
        </div>
        <h1
          className="text-4xl sm:text-5xl font-semibold tracking-tight text-ink mb-5 leading-tight"
          style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}
        >
          We've owned a med spa for 20+ years.
          <br />
          We finally built the no-show fix.
        </h1>
        <p className="text-lg text-ink-soft max-w-xl mx-auto">
          My husband David and I have owned{" "}
          <a
            href="https://rejuvskinspa.com"
            className="underline decoration-rule hover:decoration-ink transition"
          >
            rejuvskinspa.com
          </a>{" "}
          for two decades. We built {brand.name} because we needed it
          ourselves — and nobody else had what we wanted.
        </p>
      </section>

      {/* The pain */}
      <section className="max-w-2xl mx-auto px-6 py-10">
        <h2 className="text-xs uppercase tracking-wider text-ink-faint font-semibold mb-3">
          The pain you already know
        </h2>
        <p className="text-base text-ink-soft mb-4 leading-relaxed">
          If last-minute cancellations and no-shows are making you crazy —
          and costing real money — you already know the math. In our business
          we only have so many hours, and a no-show is no money. Plain and
          simple. The empty slot doesn't refund the rent, the staff hours,
          or the patient who would have happily taken it.
        </p>
        <p className="text-base text-ink-soft leading-relaxed">
          For 20+ years we endured it. Every front desk, every morning,
          shuffling, calling, texting, refilling — manually catching
          most of them, but not all. And the ones that slipped through?
          Just gone. Revenue that never comes back.
        </p>
      </section>

      {/* What we built */}
      <section className="max-w-2xl mx-auto px-6 py-10">
        <h2 className="text-xs uppercase tracking-wider text-ink-faint font-semibold mb-3">
          What we built
        </h2>
        <p className="text-base text-ink-soft mb-4 leading-relaxed">
          My husband has 35+ years in software business development. After
          two decades of watching that money walk out the door from the
          spa side, he finally
          did something about it. There's no silver bullet — we're not
          promising one, and we don't believe anyone honest does. What we
          built is a step in the right direction that gets better the
          longer you run it.
        </p>
        <p className="text-base text-ink-soft leading-relaxed">
          {brand.name} reads your appointment export (any major scheduler),
          shows you exactly how much money your cancellations + no-shows
          are actually costing you — net of what your team already refills
          manually — and then catches the slots that slip through with an
          automated waitlist + same-day rescue + smart reminder cadence.
          The math is code-computed. No fuzzy promises. Every dollar
          billable is audit-trailed against your books.
        </p>
      </section>

      {/* The math we show */}
      <section className="max-w-2xl mx-auto px-6 py-10">
        <h2 className="text-xs uppercase tracking-wider text-ink-faint font-semibold mb-3">
          The honest math — defensible against your books
        </h2>
        <p className="text-base text-ink-soft mb-4 leading-relaxed">
          Most pitches in this space inflate the number. They count every
          cancellation as a loss — but real spas know their front desk
          refills most of those slots manually. That revenue is already in
          your books. It's not lost.
        </p>
        <p className="text-base text-ink-soft leading-relaxed">
          {brand.name}'s math computes the{" "}
          <strong className="text-ink">empty slots only</strong> —
          cancelled slots that stayed empty, where no rebooking or refill
          happened. That's typically 15–35% of cancellations on real
          med-spa data. Smaller number than the inflated version,
          infinitely more defensible. Then we catch 45–55% of THAT residual
          gap with our recovery engine. Per-spa numbers vary. Your scan
          report shows your actual breakdown by day, by provider, by
          service.
        </p>
      </section>

      {/* The 3-step CTA card */}
      <section className="max-w-2xl mx-auto px-6 py-8">
        <div className="rounded-xl bg-white border border-rule p-7 shadow-sm">
          <div className="text-xs uppercase tracking-wider text-emerald font-semibold mb-3">
            30 seconds to your real number
          </div>
          <ol className="text-base text-ink space-y-3 mb-5 pl-1">
            <li className="flex gap-3">
              <span className="font-semibold text-ink-faint tabular-nums">
                1.
              </span>
              <span>
                Export 3 months of appointments from your scheduler as a{" "}
                <code className="text-sm bg-rule-soft rounded px-1.5 py-0.5">
                  .csv
                </code>
              </span>
            </li>
            <li className="flex gap-3">
              <span className="font-semibold text-ink-faint tabular-nums">
                2.
              </span>
              <span>
                Drop it at{" "}
                <a
                  href={SCAN_HREF}
                  className="font-semibold underline decoration-rule hover:decoration-ink"
                >
                  smartspa.app
                </a>
              </span>
            </li>
            <li className="flex gap-3">
              <span className="font-semibold text-ink-faint tabular-nums">
                3.
              </span>
              <span>
                See your real number + the full breakdown (by day, by
                provider, by service)
              </span>
            </li>
          </ol>
          <div className="flex items-center gap-2 text-xs text-ink-soft bg-rule-soft border border-rule rounded-lg px-3 py-2">
            <Lock className="h-3.5 w-3.5 shrink-0" />
            <span>
              Your appointment data stays in your browser. Only the column
              structure ever touches our servers. As fellow owners, we
              know how precious that data is.
            </span>
          </div>
          <a
            href={SCAN_HREF}
            className="mt-5 inline-flex items-center gap-2 rounded-xl bg-emerald text-paper text-sm font-medium px-5 py-2.5 hover:opacity-90 transition"
          >
            Scan your schedule
            <ArrowRight className="h-4 w-4" />
          </a>
        </div>
      </section>

      {/* The pricing */}
      <section className="max-w-2xl mx-auto px-6 py-10">
        <h2 className="text-xs uppercase tracking-wider text-ink-faint font-semibold mb-3">
          The pricing
        </h2>
        <p className="text-base text-ink-soft mb-4 leading-relaxed">
          Ready for this:{" "}
          <strong className="text-ink">it's free.</strong> Yes — we've
          all heard "free" before, then the real price hits. We're
          completely transparent. There is a price — but{" "}
          <strong className="text-ink">
            only if we're successful in making you money
          </strong>
          . In other words: we only get paid if you get paid.
        </p>
        <p className="text-base text-ink-soft mb-4 leading-relaxed">
          We charge <strong className="text-ink">$5</strong> for each
          booking we create for you. So if {brand.name} fills 5 slots in a
          month that would otherwise have sat empty, you pay us $25 — and you
          keep every dollar of revenue those visits bring in. If we can't fill
          any?{" "}
          <strong className="text-ink">
            You owe us $0. Nothing, nada, zip, zilch.
          </strong>
        </p>
        <p className="text-base text-ink-soft leading-relaxed">
          No credit card to start. No setup fee. No commitments. No
          contracts. No annual lock-in. Start and stop whenever you want.
          Restart whenever you want. Yes, really.
        </p>
      </section>

      {/* The guarantee */}
      <section className="max-w-2xl mx-auto px-6 py-8">
        <div className="rounded-xl bg-amber-soft border border-amber/30 p-6">
          <div className="text-xs uppercase tracking-wider text-amber font-semibold mb-2">
            Conviction guarantee
          </div>
          <p className="text-base text-ink leading-relaxed">
            Your full schedule analysis is yours to keep — even if{" "}
            {brand.name} turns out not to fit your spa. The scan is free.
            The report is free. The recovery engine is free unless it
            actually recovers something. Nothing to lose; everything to
            gain.
          </p>
        </div>
      </section>

      {/* What scheduler? */}
      <section className="max-w-2xl mx-auto px-6 py-10">
        <h2 className="text-xs uppercase tracking-wider text-ink-faint font-semibold mb-3">
          Will it work with my scheduler?
        </h2>
        <p className="text-base text-ink-soft leading-relaxed">
          Most likely yes. {brand.name} auto-recognizes 24+ platforms —
          Acuity, Boulevard, Mangomint, Vagaro, Mindbody, Jane,
          WellnessLiving, Fresha, GlossGenius, Zenoti, Square,
          AestheticsPro, Aesthetic Record, and more. If your platform
          isn't in the list, our AI maps your CSV the first time it sees
          it and caches the mapping forever — so subsequent uploads are
          instant. If something doesn't read correctly, email me at{" "}
          <a
            href={`mailto:${HELP_EMAIL}`}
            className="font-semibold underline decoration-rule hover:decoration-ink"
          >
            {HELP_EMAIL}
          </a>{" "}
          and we'll get your platform mapped within 48 hours.
        </p>
      </section>

      {/* Closing */}
      <section className="max-w-2xl mx-auto px-6 py-10">
        <p className="text-base text-ink-soft leading-relaxed mb-4">
          Whatever you decide, good luck on your med spa journey. Despite
          the pain and suffering of the cancels and no-shows, it's been a
          great ride for us — and a great life for our daughter — for the
          past 20+ years. We hope the same for you.
        </p>
        <p className="text-base text-ink-soft leading-relaxed">
          Kind regards,
        </p>
        <p className="text-base text-ink font-medium mt-1">
          Karen + David Anderson
          <br />
          <span className="text-sm text-ink-soft font-normal">
            Co-founders, {brand.name} ·{" "}
            <a
              href="https://rejuvskinspa.com"
              className="underline decoration-rule hover:decoration-ink"
            >
              rejuvskinspa.com
            </a>
          </span>
        </p>
        <p className="text-sm text-ink-soft mt-6">
          P.S. Questions? Reach me at{" "}
          <a
            href={`mailto:${HELP_EMAIL}`}
            className="font-semibold underline decoration-rule hover:decoration-ink"
          >
            {HELP_EMAIL}
          </a>
          .
        </p>
      </section>

      {/* Bottom CTA */}
      <section className="max-w-2xl mx-auto px-6 pb-16 pt-6">
        <div className="rounded-xl bg-emerald text-paper px-6 py-7 text-center">
          <div className="text-xs uppercase tracking-wider text-paper/70 mb-2">
            Ready when you are
          </div>
          <div
            className="text-2xl font-semibold mb-4"
            style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}
          >
            See your real no-show number in 30 seconds.
          </div>
          <a
            href={SCAN_HREF}
            className="inline-flex items-center gap-2 rounded-xl bg-paper text-emerald text-sm font-medium px-5 py-2.5 hover:opacity-90 transition"
          >
            Scan your schedule
            <ArrowRight className="h-4 w-4" />
          </a>
          <div className="text-xs text-paper/70 mt-3">
            Free · no signup · your data stays in your browser
          </div>
        </div>
      </section>

      <footer className="max-w-3xl mx-auto px-6 pb-10 text-center text-xs text-ink-faint">
        {brand.footerLine}
      </footer>
    </div>
  );
}
