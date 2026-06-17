/**
 * /rescue/claim/<token> — public claim landing for same-day rescue (v361).
 *
 * Patient gets the SMS link, taps it, lands here. Sees the offer
 * (treatment + time + provider). Taps Confirm → first-tap-wins claim
 * → spa appointment record reassigns to them.
 *
 * Mobile-first, light-bg, matching v325/v351/v353 vocabulary.
 */

import { createFileRoute, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Clock,
  Loader2,
} from "lucide-react";
import {
  claimRescueSlot,
  getRescueOfferPayload,
  getRescueOfferBrand,
  type RescueOfferPayload,
} from "@/server/emma-rescue.functions";
import { PublicBrandHeader } from "@/components/refill/PublicBrandHeader";

export const Route = createFileRoute("/rescue/claim/$token")({
  component: RescueClaimPage,
  // v2.66.0 — resolve the spa's brand name server-side so link-preview scrapers
  // (iMessage / Mail / Slack) get the SPA's brand in the head, not "SmartSpa",
  // when the spa is white-labeled. Degrades to SmartSpa on any failure.
  loader: async ({ params }) => {
    try {
      const brand = await getRescueOfferBrand({ data: { token: params.token } });
      return { brandName: brand?.name ?? "SmartSpa" };
    } catch {
      return { brandName: "SmartSpa" };
    }
  },
  // v379.1 — branded link-preview meta for iMessage / iOS Mail / Messages /
  // Slack / etc. The root route's defaults (Agentiport homepage card) are
  // wrong for a patient receiving a rescue offer SMS or iMessage; this
  // override gives a Refill-branded card that actually previews the offer.
  // Server-rendered via TanStack Start so link-preview scrapers see it
  // without executing JS.
  head: ({ loaderData }) => {
    // v2.66.0 — og:site_name + alt carry the spa's brand for a white-labeled
    // spa (loaderData.brandName), falling back to SmartSpa. The OG card IMAGE
    // stays the shared SmartSpa asset for now; per-spa OG images are slice 4.
    const siteName = loaderData?.brandName ?? "SmartSpa";
    return {
      meta: [
        { title: "Your appointment slot just opened up" },
        { name: "description", content: "A spot just freed up. Tap to grab it before someone else does." },
        { property: "og:title", content: "Your appointment slot just opened up" },
        { property: "og:description", content: "A spot just freed up. Tap to grab it before someone else does." },
        { property: "og:site_name", content: siteName },
        { property: "og:type", content: "website" },
        { property: "og:image", content: "https://getrefill.app/brand/refill-og-patient.png" },
        { property: "og:image:width", content: "1200" },
        { property: "og:image:height", content: "630" },
        { property: "og:image:alt", content: `${siteName} — your appointment slot just opened up` },
        { name: "twitter:title", content: "Your appointment slot just opened up" },
        { name: "twitter:description", content: "A spot just freed up. Tap to grab it before someone else does." },
        { name: "twitter:card", content: "summary_large_image" },
        { name: "twitter:image", content: "https://getrefill.app/brand/refill-og-patient.png" },
      ],
    };
  },
});

function RescueClaimPage() {
  const { token } = useParams({ from: "/rescue/claim/$token" });
  const [payload, setPayload] = useState<RescueOfferPayload | null | "loading">("loading");
  const [busy, setBusy] = useState(false);
  const [claimedScheduledAt, setClaimedScheduledAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await getRescueOfferPayload({ data: { token } });
        setPayload(r);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't load this link.");
        setPayload(null);
      }
    })();
  }, [token]);

  async function confirm() {
    setBusy(true);
    try {
      const r = await claimRescueSlot({ data: { token } });
      if (r.ok && r.scheduledAt) {
        setClaimedScheduledAt(r.scheduledAt);
      }
      // Re-read payload for the latest status reflection
      const fresh = await getRescueOfferPayload({ data: { token } });
      setPayload(fresh);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't claim — please try again.");
    } finally {
      setBusy(false);
    }
  }

  const when = (() => {
    const iso = claimedScheduledAt ?? (payload && payload !== "loading" ? payload.scheduledAt : null);
    if (!iso) return null;
    // timeZone: "America/Denver" so this matches the spa-intended clock the SMS/email
    // composer (server) already renders. The DB stores appointments TZ-naive
    // (Acuity import packs spa-local clock into UTC), so rendering everywhere
    // as UTC produces a consistent spa-local clock for every patient on every
    // device. Without this, browsers west of UTC subtract their offset and
    // disagree with the iMessage body — a real patient would show up hours
    // off. Proper per-spa TZ-aware rendering is a separate ship that needs
    // a schema fix on top. (v379.2.)
    return new Date(iso).toLocaleString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/Denver",
    });
  })();

  // What name (if any) to render after "with" on the claim card.
  //   - Different from spa name → use the provider name as-is.
  //   - Same as spa name + tenant has `owner-display-name` set → use that
  //     (solo-practitioner case; v1.26.12 — at Karen's Rejuv Skin Spa the
  //     Acuity calendar is named after the practice but Karen IS the
  //     provider; render "with Karen").
  //   - Same as spa name + no owner override → suppress, matches the
  //     original v379.2 behavior for multi-practitioner spas where the
  //     calendar aliases the practice.
  const displayProviderName: string | null = (() => {
    if (!payload || payload === "loading") return null;
    if (!payload.providerName) return null;
    const sameAsSpa =
      payload.providerName.trim().toLowerCase() ===
      payload.spaName.trim().toLowerCase();
    if (sameAsSpa) return payload.ownerDisplayName?.trim() || null;
    return payload.providerName;
  })();
  const showProvider = !!displayProviderName;

  // v2.66.0 — "Your Brand" white-label. The payload carries the spa's resolved
  // brand (plain SmartSpa unless the spa is entitled + active). Defaults below
  // keep the loading / error states on the SmartSpa accent.
  const brand = payload && payload !== "loading" ? payload.brand : null;
  const accent = brand?.accent ?? "#056048";

  return (
    <div className="min-h-screen bg-[#fbfaf7] text-[#1c2024] flex flex-col items-center justify-center p-6 font-[-apple-system,BlinkMacSystemFont,'Helvetica_Neue',system-ui,sans-serif]">
      <div className="w-full max-w-md bg-white border border-[#e2dfd6] rounded-2xl p-6 sm:p-8 shadow-sm">
        {/* v2.66.0 — brand header (logo image or letter mark). Only shown once
            the brand has resolved, so loading/error stay clean. v2.70.0 — shared
            component with a logo-404 fallback. */}
        {brand && <PublicBrandHeader brand={brand} />}

        {payload === "loading" && (
          <div className="flex items-center gap-2 text-sm text-[#5a6068] justify-center py-6">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading the offer…
          </div>
        )}

        {payload === null && (
          <div className="text-center py-4">
            <AlertTriangle className="h-10 w-10 text-[#a73b1a] mx-auto mb-3" />
            <h1 className="text-xl font-semibold mb-1">Link not valid</h1>
            <p className="text-sm text-[#5a6068]">
              This link may have expired or been mistyped.
              {error && <span className="block mt-2 text-[#a73b1a]">{error}</span>}
            </p>
          </div>
        )}

        {payload && payload !== "loading" && payload.status === "claimable" && (
          <>
            <div className="flex items-center justify-center mb-3">
              <CalendarClock className="h-10 w-10" style={{ color: accent }} />
            </div>
            <h1 className="text-xl font-semibold text-center mb-1">
              {payload.patientFirstName ? `${payload.patientFirstName}, ` : ""}
              an opening just came up
              {showProvider && (
                <>
                  {" "}with{" "}
                  <span style={{ color: accent }}>
                    {displayProviderName}
                  </span>
                </>
              )}
            </h1>
            <p className="text-sm text-[#5a6068] text-center mb-4">
              {payload.spaName} just had a cancellation. Tap below to grab it
              before anyone else does.
            </p>
            <div className="rounded-lg bg-[#f4f1ea] border border-[#e2dfd6] p-4 mb-5 space-y-1.5">
              <Row label="When" value={when ?? ""} />
              {payload.treatmentType && <Row label="Treatment" value={payload.treatmentType} />}
              {showProvider && <Row label="With" value={displayProviderName!} />}
              <Row label="Duration" value={`${payload.durationMin} min`} />
            </div>
            <button
              type="button"
              onClick={() => void confirm()}
              disabled={busy}
              style={{ backgroundColor: accent }}
              className="w-full rounded-md text-white px-4 py-3 text-sm font-semibold hover:opacity-90 transition disabled:opacity-50"
            >
              {busy ? (
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Claiming…
                </span>
              ) : (
                "Grab this slot"
              )}
            </button>
            <p className="text-[11px] text-[#8a9098] text-center mt-3">
              First come, first served. If someone beats you to it we'll let you know.
            </p>
          </>
        )}

        {payload && payload !== "loading" && payload.status === "already_claimed_by_you" && (
          <div className="text-center py-2">
            <CheckCircle2 className="h-10 w-10 mx-auto mb-3" style={{ color: accent }} />
            <h1 className="text-xl font-semibold mb-1">You're on the books</h1>
            <p className="text-sm text-[#5a6068]">
              {when && (
                <>
                  See you
                  {showProvider && (
                    <>
                      {" "}with{" "}
                      <strong className="text-[#1c2024]">
                        {displayProviderName}
                      </strong>
                    </>
                  )}{" "}
                  at <strong className="text-[#1c2024]">{when}</strong>.
                </>
              )}
            </p>
            <p className="text-xs text-[#8a9098] mt-3">
              We'll text you a reminder closer to the time.
            </p>
          </div>
        )}

        {payload && payload !== "loading" && payload.status === "claimed_by_someone_else" && (
          <div className="text-center py-2">
            <Clock className="h-10 w-10 text-[#8a5a16] mx-auto mb-3" />
            <h1 className="text-xl font-semibold mb-1">Just missed it</h1>
            <p className="text-sm text-[#5a6068]">
              Someone else grabbed this slot a moment before you. Hang tight —
              we'll text you again next time something good frees up.
            </p>
          </div>
        )}

        {payload && payload !== "loading" && payload.status === "no_longer_available" && (
          <div className="text-center py-2">
            <AlertTriangle className="h-10 w-10 text-[#8a5a16] mx-auto mb-3" />
            <h1 className="text-xl font-semibold mb-1">Slot no longer open</h1>
            <p className="text-sm text-[#5a6068]">
              This offer was withdrawn or filled directly with the spa.
            </p>
          </div>
        )}

        {payload && payload !== "loading" && payload.status === "expired" && (
          <div className="text-center py-2">
            <Clock className="h-10 w-10 text-[#8a5a16] mx-auto mb-3" />
            <h1 className="text-xl font-semibold mb-1">This offer expired</h1>
            <p className="text-sm text-[#5a6068]">
              The slot has passed. We'll text you again next time something good
              comes up.
            </p>
          </div>
        )}

        {/* v2.66.0 — "powered by SmartSpa" credit, suppressed when the spa's
            paid white-label removes it. */}
        {brand && !brand.removePoweredBy && (
          <p className="text-[10px] text-[#a3a8ae] text-center mt-5">
            powered by SmartSpa
          </p>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between text-sm">
      <span className="text-[#5a6068]">{label}</span>
      <span className="font-medium text-[#1c2024]">{value}</span>
    </div>
  );
}
