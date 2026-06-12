/**
 * AttributionReviewQueue — the human side of the reward-attribution confidence
 * gate (project_trusted_onboarding, the trust-repair rung).
 *
 * When a $ reward matched more than one patient, ingestion HELD it rather than
 * silently crediting whoever sorted first. This is where the owner latches it:
 * pick the right patient (we attribute the reward AND learn the alias so the
 * next import auto-resolves), or dismiss it as "none of these."
 *
 * Voice is own-it-never-blame: the gate is presented as SmartSpa being careful
 * with her money, not as an error she has to clean up. A first uncertainty
 * handled honestly buys more trust than a silent guess that's sometimes wrong.
 */

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, ShieldQuestion, Check, Gift } from "lucide-react";

import {
  listAttributionHoldsFn,
  resolveAttributionHoldFn,
  type AttributionHold,
} from "@/server/reward-attribution-holds.functions";
import { ambiguityReason, type MatchSignal } from "@/lib/match-confidence";

export function AttributionReviewQueue({
  accessToken,
  viewAsUserId,
  onResolved,
}: {
  accessToken: string | null;
  viewAsUserId?: string;
  /** Fired after a hold is resolved so the host can re-fetch reward entries
   *  (a just-attributed reward should flip from orphaned to matched). */
  onResolved?: () => void;
}) {
  const [holds, setHolds] = useState<AttributionHold[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accessToken) return;
    try {
      const rows = await listAttributionHoldsFn({ data: { accessToken, viewAsUserId } });
      setHolds(rows);
    } catch {
      setHolds(null); // migration not landed yet → stay hidden
    }
  }, [accessToken, viewAsUserId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function resolve(
    hold: AttributionHold,
    choice: { kind: "assign"; nodeId: string } | { kind: "dismiss" },
  ) {
    if (!accessToken || busyId) return;
    setBusyId(hold.id);
    // Optimistic: drop it from the queue.
    setHolds((prev) => (prev ? prev.filter((h) => h.id !== hold.id) : prev));
    try {
      await resolveAttributionHoldFn({
        data: { accessToken, viewAsUserId, holdId: hold.id, choice },
      });
      if (choice.kind === "assign") {
        const who = hold.candidates.find((c) => c.id === choice.nodeId)?.name ?? "that patient";
        toast.success(`Reward assigned to ${who}. SmartSpa will remember next time.`);
      } else {
        toast.success("Left unmatched. It won't be credited to anyone.");
      }
      onResolved?.();
    } catch (e) {
      // Revert on failure.
      setHolds((prev) => (prev ? [hold, ...prev] : [hold]));
      toast.error(e instanceof Error ? e.message : "Couldn't save. Try again.");
    } finally {
      setBusyId(null);
    }
  }

  if (!holds || holds.length === 0) return null;

  return (
    <div className="rounded-2xl border border-amber/40 bg-amber-soft/30 p-5">
      <div className="flex items-center gap-2 text-sm font-semibold text-ink">
        <ShieldQuestion className="h-4 w-4 text-amber" />
        A few rewards need your eyes
        <span className="rounded-full bg-amber/20 px-2 py-0.5 text-[10.5px] font-semibold text-amber">
          {holds.length}
        </span>
      </div>
      <p className="mt-1.5 text-[12px] text-ink-soft">
        Each of these matched more than one patient, so SmartSpa held it instead of
        guessing — a reward should never land on the wrong person. Pick who each
        belongs to and we&rsquo;ll remember it for next time.
      </p>

      <div className="mt-4 space-y-2.5">
        {holds.map((h) => {
          const busy = busyId === h.id;
          const amount = h.rewardAmountUsd != null ? `$${Math.round(h.rewardAmountUsd)}` : "A";
          const reason = ambiguityReason((h.signals as MatchSignal[]) ?? []);
          return (
            <div
              key={h.id}
              className={`rounded-xl border border-rule bg-white px-4 py-3 ${busy ? "opacity-60" : ""}`}
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12.5px]">
                <Gift className="h-3.5 w-3.5 text-emerald" />
                <span className="font-semibold text-ink">
                  {amount} {cap(h.manufacturer)} reward
                </span>
                <span className="text-ink-soft">· {h.brandProduct}</span>
                {h.expirationDate && (
                  <span className="text-[11px] text-amber">expires {fmtDate(h.expirationDate)}</span>
                )}
              </div>
              <p className="mt-1 text-[12px] text-ink-soft">
                {h.candidates.length} patients {reason}
                {h.contactName ? (
                  <>
                    {" "}
                    under <span className="font-medium text-ink">{h.contactName}</span>
                  </>
                ) : null}
                . Which one is it?
              </p>

              <div className="mt-2 flex flex-wrap gap-2">
                {h.candidates.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    disabled={busy}
                    onClick={() => void resolve(h, { kind: "assign", nodeId: c.id })}
                    className="inline-flex flex-col items-start rounded-lg border border-emerald/40 bg-white px-3 py-1.5 text-left transition hover:bg-emerald-soft disabled:opacity-50"
                  >
                    <span className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-emerald-ink">
                      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                      {c.name ?? "Unnamed patient"}
                    </span>
                    {(c.email || c.phone) && (
                      <span className="text-[10.5px] text-ink-faint">{c.email ?? c.phone}</span>
                    )}
                  </button>
                ))}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void resolve(h, { kind: "dismiss" })}
                  className="self-center text-[11.5px] text-ink-faint underline-offset-2 hover:text-ink hover:underline disabled:opacity-50"
                >
                  None of these
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return iso;
  return `${m}/${d}/${y.slice(2)}`;
}
