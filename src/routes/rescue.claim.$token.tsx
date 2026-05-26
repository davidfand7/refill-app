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
  type RescueOfferPayload,
} from "@/server/emma-rescue.functions";

export const Route = createFileRoute("/rescue/claim/$token")({
  component: RescueClaimPage,
  // v379.1 — branded link-preview meta for iMessage / iOS Mail / Messages /
  // Slack / etc. The root route's defaults (Agentiport homepage card) are
  // wrong for a patient receiving a rescue offer SMS or iMessage; this
  // override gives a Refill-branded card that actually previews the offer.
  // Server-rendered via TanStack Start so link-preview scrapers see it
  // without executing JS.
  head: () => ({
    meta: [
      { title: "Your appointment slot just opened up" },
      { name: "description", content: "A spot just freed up. Tap to grab it before someone else does." },
      { property: "og:title", content: "Your appointment slot just opened up" },
      { property: "og:description", content: "A spot just freed up. Tap to grab it before someone else does." },
      { property: "og:site_name", content: "Refill" },
      { property: "og:type", content: "website" },
      { property: "og:image", content: "https://getrefill.app/brand/refill-og.png" },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      { property: "og:image:alt", content: "Refill — no-show recovery for med-spas" },
      { name: "twitter:title", content: "Your appointment slot just opened up" },
      { name: "twitter:description", content: "A spot just freed up. Tap to grab it before someone else does." },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:image", content: "https://getrefill.app/brand/refill-og.png" },
    ],
  }),
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

  // Suppress the "With" row when the appointment's provider_name is the same
  // as the spa name (common Acuity setup: the calendar is named after the
  // practice, not after the human provider). Rendering both produces e.g.
  // "Rejuv Skin Spa · With Rejuv Skin Spa" which reads broken. Same dedup
  // applied in the SMS/email composer. (v379.2.)
  const showProvider =
    payload && payload !== "loading" &&
    !!payload.providerName &&
    payload.providerName.trim().toLowerCase() !==
      payload.spaName.trim().toLowerCase();

  return (
    <div className="min-h-screen bg-[#fbfaf7] text-[#1c2024] flex flex-col items-center justify-center p-6 font-[-apple-system,BlinkMacSystemFont,'Helvetica_Neue',system-ui,sans-serif]">
      <div className="w-full max-w-md bg-white border border-[#e2dfd6] rounded-2xl p-6 sm:p-8 shadow-sm">
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
              <CalendarClock className="h-10 w-10 text-[#056048]" />
            </div>
            <h1 className="text-xl font-semibold text-center mb-1">
              {payload.patientFirstName ? `${payload.patientFirstName}, ` : ""}
              an opening just came up
            </h1>
            <p className="text-sm text-[#5a6068] text-center mb-4">
              {payload.spaName} just had a cancellation. Tap below to grab it
              before anyone else does.
            </p>
            <div className="rounded-lg bg-[#f4f1ea] border border-[#e2dfd6] p-4 mb-5 space-y-1.5">
              <Row label="When" value={when ?? ""} />
              {payload.treatmentType && <Row label="Treatment" value={payload.treatmentType} />}
              {showProvider && <Row label="With" value={payload.providerName!} />}
              <Row label="Duration" value={`${payload.durationMin} min`} />
            </div>
            <button
              type="button"
              onClick={() => void confirm()}
              disabled={busy}
              className="w-full rounded-md bg-[#056048] text-white px-4 py-3 text-sm font-semibold hover:bg-[#044a38] transition disabled:opacity-50"
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
            <CheckCircle2 className="h-10 w-10 text-[#056048] mx-auto mb-3" />
            <h1 className="text-xl font-semibold mb-1">You're on the books</h1>
            <p className="text-sm text-[#5a6068]">
              {when && (
                <>
                  See you at <strong className="text-[#1c2024]">{when}</strong>.
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
