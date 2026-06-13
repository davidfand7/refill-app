/**
 * RescueReviewQueue — the human side of the rescue autonomous-send gate
 * (project_trusted_onboarding, the trust-repair rung).
 *
 * Direct-mode rescue auto-texts fit-patients the moment a slot frees. The gate
 * holds the LOW-CONFIDENCE fits — ones with no positive treatment agreement
 * between the patient and the freed slot — instead of texting blind. This is
 * where the owner releases each held offer in one tap (we send the same SMS the
 * auto-path would have) or skips it.
 *
 * Voice is own-it-never-blame, like the reward queue: SmartSpa being careful
 * about who it texts on the spa's behalf, not an error to clean up. Nothing is
 * lost here — a held offer is a tap away from going out.
 */

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, ShieldQuestion, Send, CalendarClock } from "lucide-react";

import {
  listHeldRescueOffers,
  sendHeldRescueOffer,
  dismissHeldRescueOffer,
  type HeldRescueOffer,
} from "@/server/emma-rescue.functions";

export function RescueReviewQueue({
  accessToken,
  viewAsUserId,
  onChanged,
}: {
  accessToken: string | null;
  viewAsUserId?: string;
  /** Fired after a held offer is sent/skipped so the host can refresh metrics. */
  onChanged?: () => void;
}) {
  const [held, setHeld] = useState<HeldRescueOffer[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accessToken) return;
    try {
      const rows = await listHeldRescueOffers({ data: { accessToken, viewAsUserId } });
      setHeld(rows);
    } catch {
      setHeld(null); // migration not landed yet → stay hidden
    }
  }, [accessToken, viewAsUserId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(offer: HeldRescueOffer, kind: "send" | "dismiss") {
    if (!accessToken || busyId) return;
    setBusyId(offer.offerId);
    // Optimistic: drop it from the queue.
    setHeld((prev) => (prev ? prev.filter((h) => h.offerId !== offer.offerId) : prev));
    try {
      if (kind === "send") {
        await sendHeldRescueOffer({
          data: { accessToken, viewAsUserId, offerId: offer.offerId },
        });
        toast.success(`Texted ${offer.patientName ?? "the patient"} about the opening.`);
      } else {
        await dismissHeldRescueOffer({
          data: { accessToken, viewAsUserId, offerId: offer.offerId },
        });
        toast.success("Skipped — we won't text this one.");
      }
      onChanged?.();
    } catch (e) {
      // Revert on failure.
      setHeld((prev) => (prev ? [offer, ...prev] : [offer]));
      toast.error(e instanceof Error ? e.message : "Couldn't do that. Try again.");
    } finally {
      setBusyId(null);
    }
  }

  if (!held || held.length === 0) return null;

  return (
    <section className="rounded-2xl border border-amber/40 bg-amber-soft/30 p-5">
      <div className="flex items-center gap-2 text-sm font-semibold text-ink">
        <ShieldQuestion className="h-4 w-4 text-amber" />
        A few rescue texts need your OK
        <span className="rounded-full bg-amber/20 px-2 py-0.5 text-[10.5px] font-semibold text-amber">
          {held.length}
        </span>
      </div>
      <p className="mt-1.5 text-[12px] text-ink-soft">
        These openings had no treatment set, so SmartSpa couldn&rsquo;t tell each patient
        what they&rsquo;d be coming in for — it held them for your eyes instead of texting
        blind. Send the ones that make sense, skip the rest.
      </p>

      <div className="mt-4 space-y-2.5">
        {held.map((h) => {
          const busy = busyId === h.offerId;
          return (
            <div
              key={h.offerId}
              className={`rounded-xl border border-rule bg-white px-4 py-3 ${busy ? "opacity-60" : ""}`}
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12.5px]">
                <CalendarClock className="h-3.5 w-3.5 text-emerald" />
                <span className="font-semibold text-ink">
                  {h.patientName ?? "Waitlist patient"}
                </span>
                {h.treatmentType && (
                  <span className="text-ink-soft">· {h.treatmentType}</span>
                )}
                {h.scheduledAt && (
                  <span className="text-[11px] text-ink-faint">{fmtWhen(h.scheduledAt)}</span>
                )}
                {h.lifetimeSpendUsd != null && h.lifetimeSpendUsd > 0 && (
                  <span className="text-[11px] text-emerald-ink">
                    ${Math.round(h.lifetimeSpendUsd).toLocaleString()} lifetime
                  </span>
                )}
              </div>
              {h.heldReason && (
                <p className="mt-1 text-[12px] text-ink-soft">{h.heldReason}</p>
              )}

              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void act(h, "send")}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-emerald/40 bg-white px-3 py-1.5 text-[12.5px] font-semibold text-emerald-ink transition hover:bg-emerald-soft disabled:opacity-50"
                >
                  {busy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Send className="h-3.5 w-3.5" />
                  )}
                  Send the text
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void act(h, "dismiss")}
                  className="self-center text-[11.5px] text-ink-faint underline-offset-2 hover:text-ink hover:underline disabled:opacity-50"
                >
                  Skip
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** Render the opening's time on the spa's intended clock (matches the SMS). */
function fmtWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/Denver",
    });
  } catch {
    return iso;
  }
}
