/**
 * /deals/<slug> — public patient-facing list of a spa's current offers.
 *
 * The "pull" half of the offer engine's delivery (slice 4a): a shareable page
 * a spa can post anywhere, listing every currently-active public offer with a
 * single Book CTA back to /s/<slug>. No auth (slug = capability, same spirit
 * as the booking page). Cohort-targeted offers are NOT listed here — they
 * reach their patients via push (slice 4b), not a public page.
 *
 * Design vocabulary matches /s/<slug>: light-bg, dark-ink, mobile-first.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AlertTriangle, ArrowRight, CalendarCheck, Loader2, Sparkles, Tag } from "lucide-react";
import {
  getPublicDealsFn,
  type PublicDeal,
} from "@/server/refill-promo-calendar.functions";

export const Route = createFileRoute("/deals/$slug")({
  component: DealsPage,
});

function fmtEnds(iso: string | null): string | null {
  if (!iso) return null;
  const [y, m, d] = iso.split("-").map((n) => parseInt(n, 10));
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "long",
    day: "numeric",
  });
}

type State =
  | { screen: "loading" }
  | { screen: "error"; message: string }
  | { screen: "ready"; spaName: string; deals: PublicDeal[]; bookingEnabled: boolean };

function DealsPage() {
  const { slug } = Route.useParams();
  const [state, setState] = useState<State>({ screen: "loading" });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await getPublicDealsFn({ data: { slug } });
        if (cancelled) return;
        if (!res.ok) {
          setState({ screen: "error", message: res.reason });
          return;
        }
        setState({ screen: "ready", spaName: res.spaName, deals: res.deals, bookingEnabled: res.bookingEnabled });
      } catch {
        if (!cancelled) setState({ screen: "error", message: "Couldn't load offers." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  return (
    <div style={{ background: "#fbfaf7", minHeight: "100vh", color: "#1c2024" }}>
      <div className="mx-auto w-full max-w-xl px-5 py-10">
        {state.screen === "loading" && (
          <div className="flex items-center justify-center gap-2 py-20 text-[14px]" style={{ color: "#5a6068" }}>
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading offers…
          </div>
        )}

        {state.screen === "error" && (
          <div className="flex flex-col items-center gap-3 py-20 text-center">
            <AlertTriangle className="h-7 w-7" style={{ color: "#b94842" }} />
            <p className="text-[15px]" style={{ color: "#5a6068" }}>{state.message}</p>
          </div>
        )}

        {state.screen === "ready" && (
          <>
            <header className="mb-7">
              <div
                className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-wider"
                style={{ background: "#e8f1ed", color: "#056048" }}
              >
                <Sparkles className="h-3.5 w-3.5" />
                Current offers
              </div>
              <h1
                className="mt-3 text-[28px] leading-tight font-semibold"
                style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}
              >
                {state.spaName}
              </h1>
            </header>

            {state.deals.length === 0 ? (
              <div
                className="rounded-2xl border px-6 py-10 text-center"
                style={{ borderColor: "#e6e2d6", background: "#fff" }}
              >
                <Tag className="mx-auto mb-2 h-6 w-6" style={{ color: "#8a9098" }} />
                <p className="text-[14px]" style={{ color: "#5a6068" }}>
                  {state.bookingEnabled
                    ? "No current offers — but you can still book an appointment any time."
                    : "No current offers right now. Contact the practice to book your next visit."}
                </p>
              </div>
            ) : (
              <ul className="space-y-3">
                {state.deals.map((deal, i) => {
                  const ends = fmtEnds(deal.endsOn);
                  // A Special with a mappable service becomes a deep-link: tap it
                  // → land in the booker with that service already chosen. Offers
                  // with no mappable service stay static (info only).
                  // v2.74.0 — external-PMS (Acuity) spas gate native booking, so
                  // deep-link Book CTAs would dead-end; show the offer statically.
                  const bookable = !!deal.serviceName && state.bookingEnabled;
                  const body = (
                    <div className="flex items-center gap-3">
                      <div
                        className="rounded-full p-2 shrink-0"
                        style={{ background: "#fdf6dc" }}
                      >
                        <Tag className="h-4 w-4" style={{ color: "#8a6d0c" }} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-[16px] font-semibold">{deal.headline}</div>
                        {ends && (
                          <div className="mt-0.5 text-[12.5px]" style={{ color: "#8a9098" }}>
                            through {ends}
                          </div>
                        )}
                      </div>
                      {bookable && (
                        // Outlined box (border + text), not a solid button and not
                        // a real <button> — the whole card is the <Link>, so this
                        // is just the visual affordance. Pinned right, vertically
                        // centered with the offer headline.
                        <span
                          className="shrink-0 inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 text-[12.5px] font-semibold transition"
                          style={{ borderColor: "#056048", color: "#056048", background: "#fff" }}
                        >
                          Book this <ArrowRight className="h-3.5 w-3.5" />
                        </span>
                      )}
                    </div>
                  );
                  return (
                    <li
                      key={i}
                      className="overflow-hidden rounded-2xl border"
                      style={{ borderColor: "#e6e2d6", background: "#fff" }}
                    >
                      {bookable ? (
                        <Link
                          to="/s/$slug"
                          params={{ slug }}
                          search={{ service: deal.serviceName ?? undefined }}
                          className={
                            "block px-5 pt-4 transition hover:bg-[#fbfaf7] " +
                            (deal.landingUrl ? "pb-2" : "pb-4")
                          }
                        >
                          {body}
                        </Link>
                      ) : (
                        <div className={"px-5 pt-4 " + (deal.landingUrl ? "pb-2" : "pb-4")}>
                          {body}
                        </div>
                      )}
                      {/* "Learn more" is a SEPARATE sibling <a> (its own row,
                          outside the booking <Link>) so it's an independent click
                          target — the brand page, not the booker. Clean padding,
                          no negative margins (which can drag it under the Link and
                          silently kill its click). */}
                      {deal.landingUrl && (
                        <div className="px-5 pb-4">
                          <a
                            href={deal.landingUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-block text-[12.5px] font-medium underline"
                            style={{ color: "#056048" }}
                          >
                            Learn more
                          </a>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            {state.bookingEnabled && (
              <Link
                to="/s/$slug"
                params={{ slug }}
                className="mt-7 flex w-full items-center justify-center gap-2 rounded-xl px-5 py-3.5 text-[15px] font-semibold transition hover:opacity-95"
                style={{ background: "#056048", color: "#fbfaf7" }}
              >
                <CalendarCheck className="h-4.5 w-4.5" />
                Book an appointment
              </Link>
            )}
            <p className="mt-3 text-center text-[11px]" style={{ color: "#8a9098" }}>
              Offers are applied at your visit.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
