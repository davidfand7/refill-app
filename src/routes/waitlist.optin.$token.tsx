/**
 * /waitlist/optin/<token> — public landing for the waitlist opt-in invite (v1.27.0).
 *
 * Karen (or any spa owner) seeds a paused emma_waitlist row + mints a per-patient
 * token via the bulk-seed or v1.27.1 invite-composer path. The token URL ships to
 * the patient through the iMessage MCP composer (blue-bubble from the owner's Apple
 * ID) or any other channel. Patient taps → lands here.
 *
 * State machine:
 *   loading           — fetching payload
 *   invalid           — token unknown / expired / mistyped
 *   already_opted_in  — patient is already active; show "you're already in"
 *   already_revoked   — patient previously revoked; show "you opted out" + how to rejoin
 *   needs_confirm     — paused row exists; show explicit Confirm + Decline
 *   confirmed         — terminal happy state after Confirm tap
 *
 * The Confirm tap is the affirmative opt-in event (TCPA-defensible). Decline calls
 * revokeWaitlistOptIn so the row goes to status='revoked' and the patient never
 * receives a rescue-side message from the engine.
 *
 * Mirrors rescue.claim.$token.tsx for chrome + OG meta so iMessage link previews
 * render the patient-facing Refill card, not the spa-owner pricing card.
 */

import { createFileRoute, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  HeartHandshake,
  Loader2,
  XCircle,
} from "lucide-react";
import {
  getWaitlistOptInPayload,
  getWaitlistOptInBrand,
  optInToWaitlist,
  revokeWaitlistOptIn,
  type WaitlistOptInPayload,
} from "@/server/emma-waitlist.functions";
import type { PublicBrand } from "@/server/brand-resolver";

export const Route = createFileRoute("/waitlist/optin/$token")({
  component: WaitlistOptInPage,
  // v2.66.0 — resolve the spa's brand name server-side so link-preview scrapers
  // get the spa's brand in og:site_name when white-labeled. Degrades to SmartSpa.
  loader: async ({ params }) => {
    try {
      const brand = await getWaitlistOptInBrand({ data: { token: params.token } });
      return { brandName: brand?.name ?? "SmartSpa" };
    } catch {
      return { brandName: "SmartSpa" };
    }
  },
  head: ({ loaderData }) => {
    const siteName = loaderData?.brandName ?? "SmartSpa";
    return {
    meta: [
      { title: "Join the waitlist" },
      {
        name: "description",
        content:
          "Get a text the moment a great slot opens up. Tap to join — reply STOP anytime to leave.",
      },
      { property: "og:title", content: "Join the waitlist" },
      {
        property: "og:description",
        content:
          "Get a text the moment a great slot opens up. Tap to join — reply STOP anytime to leave.",
      },
      { property: "og:site_name", content: siteName },
      { property: "og:type", content: "website" },
      {
        property: "og:image",
        content: "https://getrefill.app/brand/refill-og-patient.png",
      },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      {
        property: "og:image:alt",
        content: `${siteName} — join the waitlist`,
      },
      { name: "twitter:title", content: "Join the waitlist" },
      {
        name: "twitter:description",
        content:
          "Get a text the moment a great slot opens up. Tap to join — reply STOP anytime to leave.",
      },
      { name: "twitter:card", content: "summary_large_image" },
      {
        name: "twitter:image",
        content: "https://getrefill.app/brand/refill-og-patient.png",
      },
    ],
    };
  },
});

type LoadState =
  | { kind: "loading" }
  | { kind: "invalid"; message: string | null }
  | { kind: "ready"; payload: WaitlistOptInPayload }
  | { kind: "confirmed"; spaName: string; firstName: string | null; brand: PublicBrand }
  | { kind: "declined"; spaName: string; brand: PublicBrand };

function WaitlistOptInPage() {
  const { token } = useParams({ from: "/waitlist/optin/$token" });
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const payload = await getWaitlistOptInPayload({ data: { token } });
        if (cancelled) return;
        if (!payload) {
          setState({ kind: "invalid", message: null });
          return;
        }
        setState({ kind: "ready", payload });
      } catch (e) {
        if (cancelled) return;
        setState({
          kind: "invalid",
          message: e instanceof Error ? e.message : null,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function handleConfirm() {
    if (busy || state.kind !== "ready") return;
    setBusy(true);
    try {
      await optInToWaitlist({ data: { token } });
      setState({
        kind: "confirmed",
        spaName: state.payload.spaName,
        firstName: state.payload.patientFirstName,
        brand: state.payload.brand,
      });
    } catch (e) {
      setState({
        kind: "invalid",
        message: e instanceof Error ? e.message : "Couldn't confirm — try again.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleDecline() {
    if (busy || state.kind !== "ready") return;
    setBusy(true);
    try {
      await revokeWaitlistOptIn({ data: { token } });
      setState({ kind: "declined", spaName: state.payload.spaName, brand: state.payload.brand });
    } catch (e) {
      setState({
        kind: "invalid",
        message: e instanceof Error ? e.message : "Couldn't opt out — try again.",
      });
    } finally {
      setBusy(false);
    }
  }

  // v2.66.0 — "Your Brand" white-label. The brand rides on the payload (and is
  // carried into the confirmed/declined terminal states). Defaults keep the
  // loading / invalid states on the SmartSpa accent.
  const brand: PublicBrand | null =
    state.kind === "ready"
      ? state.payload.brand
      : state.kind === "confirmed" || state.kind === "declined"
        ? state.brand
        : null;
  const accent = brand?.accent ?? "#056048";

  return (
    <div className="min-h-screen bg-[#fbfaf7] text-[#1c2024] flex flex-col items-center justify-center p-6 font-[-apple-system,BlinkMacSystemFont,'Helvetica_Neue',system-ui,sans-serif]">
      <div className="w-full max-w-md bg-white border border-[#e2dfd6] rounded-2xl p-6 sm:p-8 shadow-sm">
        {/* v2.66.0 — brand header (logo image or letter mark + name). */}
        {brand && (
          <div className="flex items-center justify-center mb-4">
            {brand.logoUrl ? (
              <img
                src={brand.logoUrl}
                alt={brand.name}
                className="h-9 max-w-[180px] object-contain"
              />
            ) : (
              <div className="inline-flex items-center gap-2">
                <span
                  className="h-7 w-7 rounded-full flex items-center justify-center text-white font-bold text-sm"
                  style={{ backgroundColor: accent }}
                >
                  {brand.logoMark}
                </span>
                <span className="text-[15px] font-semibold text-[#1c2024]">
                  {brand.name}
                </span>
              </div>
            )}
          </div>
        )}

        {state.kind === "loading" && (
          <div className="flex items-center gap-2 text-sm text-[#5a6068] justify-center py-6">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading your invite…
          </div>
        )}

        {state.kind === "invalid" && (
          <div className="text-center py-4">
            <AlertTriangle className="h-10 w-10 text-[#a73b1a] mx-auto mb-3" />
            <h1 className="text-xl font-semibold mb-1">Link not valid</h1>
            <p className="text-sm text-[#5a6068]">
              This invite link may have expired or been mistyped.
              {state.message && (
                <span className="block mt-2 text-[#a73b1a]">
                  {state.message}
                </span>
              )}
            </p>
          </div>
        )}

        {state.kind === "ready" && state.payload.alreadyOptedIn && (
          <div className="text-center py-2">
            <CheckCircle2 className="h-10 w-10 mx-auto mb-3" style={{ color: accent }} />
            <h1 className="text-xl font-semibold mb-1">You're already in</h1>
            <p className="text-sm text-[#5a6068]">
              You're on{" "}
              <strong className="text-[#1c2024]">
                {state.payload.spaName}
              </strong>
              's waitlist. We'll text you the moment a great slot opens up.
            </p>
            <p className="text-xs text-[#8a9098] mt-3">
              Reply STOP anytime to leave.
            </p>
          </div>
        )}

        {state.kind === "ready" && state.payload.alreadyRevoked && (
          <div className="text-center py-2">
            <XCircle className="h-10 w-10 text-[#8a5a16] mx-auto mb-3" />
            <h1 className="text-xl font-semibold mb-1">You've opted out</h1>
            <p className="text-sm text-[#5a6068]">
              You previously left{" "}
              <strong className="text-[#1c2024]">
                {state.payload.spaName}
              </strong>
              's waitlist. If you'd like to rejoin, just text{" "}
              {state.payload.spaName} directly and they'll add you back.
            </p>
          </div>
        )}

        {state.kind === "ready" &&
          !state.payload.alreadyOptedIn &&
          !state.payload.alreadyRevoked && (
            <>
              <div className="flex items-center justify-center mb-3">
                <HeartHandshake className="h-10 w-10" style={{ color: accent }} />
              </div>
              <h1 className="text-xl font-semibold text-center mb-1">
                {state.payload.patientFirstName
                  ? `${state.payload.patientFirstName}, join `
                  : "Join "}
                <span style={{ color: accent }}>
                  {state.payload.spaName}
                </span>
                's waitlist?
              </h1>
              <p className="text-sm text-[#5a6068] text-center mb-5 leading-relaxed">
                We'll send you a quick text the moment a great slot opens up —
                rescheduled, no-show, or last-minute opening. First to tap gets
                it.
              </p>
              <button
                type="button"
                onClick={() => void handleConfirm()}
                disabled={busy}
                style={{ backgroundColor: accent }}
                className="w-full rounded-md text-white px-4 py-3 text-sm font-semibold hover:opacity-90 transition disabled:opacity-50"
              >
                {busy ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Adding you…
                  </span>
                ) : (
                  "Yes, count me in"
                )}
              </button>
              <button
                type="button"
                onClick={() => void handleDecline()}
                disabled={busy}
                className="w-full mt-2 rounded-md border border-[#e2dfd6] bg-white text-[#5a6068] px-4 py-2.5 text-sm font-medium hover:bg-[#f4f1ea] transition disabled:opacity-50"
              >
                No thanks
              </button>
              <p className="text-[11px] text-[#8a9098] text-center mt-4 leading-relaxed">
                You'll only hear from us when an actual slot opens that matches
                what you'd want. Reply STOP anytime to leave.
              </p>
            </>
          )}

        {state.kind === "confirmed" && (
          <div className="text-center py-2">
            <CheckCircle2 className="h-10 w-10 mx-auto mb-3" style={{ color: accent }} />
            <h1 className="text-xl font-semibold mb-1">
              {state.firstName ? `${state.firstName}, you're in` : "You're in"}
            </h1>
            <p className="text-sm text-[#5a6068]">
              We'll text you the moment a great slot opens up at{" "}
              <strong className="text-[#1c2024]">{state.spaName}</strong>.
            </p>
            <p className="text-xs text-[#8a9098] mt-3">
              Reply STOP anytime to leave.
            </p>
          </div>
        )}

        {state.kind === "declined" && (
          <div className="text-center py-2">
            <XCircle className="h-10 w-10 text-[#8a5a16] mx-auto mb-3" />
            <h1 className="text-xl font-semibold mb-1">No worries</h1>
            <p className="text-sm text-[#5a6068]">
              You won't get waitlist texts from{" "}
              <strong className="text-[#1c2024]">{state.spaName}</strong>. If
              you change your mind, just let them know directly.
            </p>
          </div>
        )}

        {/* v2.66.0 — "powered by SmartSpa", suppressed when white-label removes it. */}
        {brand && !brand.removePoweredBy && (
          <p className="text-[10px] text-[#a3a8ae] text-center mt-5">
            powered by SmartSpa
          </p>
        )}
      </div>
    </div>
  );
}
