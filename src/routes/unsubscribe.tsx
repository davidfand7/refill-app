/**
 * /unsubscribe?u=<state_id> — public unsubscribe landing page (v351).
 *
 * Lands the URL promised by every Emma B2C campaign email (v350 footer).
 * No auth — the state_id IS the capability. Two states: pre-confirm
 * ("Unsubscribe from {SPA}?" + Confirm button) and post-confirm ("✓
 * You've been unsubscribed."). Mobile-first — patients click this from
 * their phone email app, often in the middle of the day.
 *
 * Design vocabulary: matches the light-bg / dark-ink polished-doc style
 * of the v325 /order landing page. No marketing fluff, no upsell, no
 * "are you sure?" guilt trips. TCPA + CAN-SPAM both expect this to be
 * the easiest moment in the user's day.
 */

import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { z } from "zod";
import { fallback } from "@tanstack/zod-adapter";
import { CheckCircle2, Loader2, ShieldOff, AlertTriangle } from "lucide-react";
import {
  confirmUnsubscribe,
  getUnsubscribeTarget,
  type UnsubscribePageData,
} from "@/server/emma-optout.functions";

const unsubSearch = z.object({
  u: fallback(z.string().optional(), undefined),
});

export const Route = createFileRoute("/unsubscribe")({
  validateSearch: unsubSearch,
  component: UnsubscribePage,
});

type LoadState =
  | { kind: "loading" }
  | { kind: "missing-token" }
  | { kind: "error"; message: string }
  | { kind: "pre"; spaName: string; patientName: string }
  | { kind: "done"; spaName: string; patientName: string };

function UnsubscribePage() {
  const { u: stateId } = Route.useSearch();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!stateId) {
      setState({ kind: "missing-token" });
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const r = await getUnsubscribeTarget({ data: { stateId } });
        if (cancelled) return;
        applyResult(r, setState);
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
  }, [stateId]);

  async function handleConfirm() {
    if (!stateId || confirming) return;
    setConfirming(true);
    try {
      const r = await confirmUnsubscribe({ data: { stateId } });
      applyResult(r, setState);
    } catch (e) {
      setState({
        kind: "error",
        message: e instanceof Error ? e.message : "Couldn't unsubscribe.",
      });
    } finally {
      setConfirming(false);
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
            title="Unsubscribe link incomplete"
            body="This unsubscribe link is missing its reference code. If you clicked it from an email, the email may have been truncated. Reply STOP to that email's sender phone number or contact the practice directly."
          />
        )}

        {state.kind === "error" && (
          <ErrorCard title="Couldn't load this link" body={state.message} />
        )}

        {state.kind === "pre" && (
          <div className="bg-white border border-stone-200 rounded-xl p-7 shadow-sm">
            <div className="flex items-center gap-2 text-stone-400 text-xs uppercase tracking-wider font-medium mb-4">
              <ShieldOff className="w-3.5 h-3.5" />
              Unsubscribe
            </div>
            <h1 className="text-2xl font-semibold text-stone-900 leading-tight">
              Unsubscribe from {state.spaName}?
            </h1>
            <p className="mt-3 text-stone-600 leading-relaxed text-[15px]">
              You won't receive any more promotional emails or text messages
              from {state.spaName}. This won't affect appointment confirmations
              or messages you initiate.
            </p>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={confirming}
              className="mt-7 w-full inline-flex items-center justify-center gap-2 bg-stone-900 text-white font-medium text-[15px] rounded-lg px-5 py-3 hover:bg-stone-800 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
            >
              {confirming ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Unsubscribing…
                </>
              ) : (
                "Confirm unsubscribe"
              )}
            </button>
            <p className="mt-4 text-stone-400 text-xs text-center">
              Changed your mind? Just close this page.
            </p>
          </div>
        )}

        {state.kind === "done" && (
          <div className="bg-white border border-stone-200 rounded-xl p-7 shadow-sm">
            <div className="w-10 h-10 rounded-full bg-emerald-100 flex items-center justify-center mb-4">
              <CheckCircle2 className="w-5 h-5 text-emerald-700" />
            </div>
            <h1 className="text-2xl font-semibold text-stone-900 leading-tight">
              You've been unsubscribed.
            </h1>
            <p className="mt-3 text-stone-600 leading-relaxed text-[15px]">
              You won't receive any more promotional messages from{" "}
              {state.spaName}. If you'd like to re-subscribe later, contact the
              practice directly.
            </p>
          </div>
        )}
      </div>
    </main>
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

function applyResult(
  r: UnsubscribePageData,
  setState: (s: LoadState) => void,
) {
  if (!r.ok) {
    setState({ kind: "error", message: r.reason });
    return;
  }
  setState({
    kind: r.alreadyDone ? "done" : "pre",
    spaName: r.spaName,
    patientName: r.patientName,
  });
}
