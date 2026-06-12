/**
 * WatchSourcesSection — the Connection Health "expect" gate as a single,
 * kind-agnostic control. Toggling a source ON declares "I expect this to flow";
 * Connection Health then flags it if it ever goes silent (a portal that stops
 * importing, a calendar that isn't connected). One component for every feed
 * kind, mirroring the one expected_sources table + one fn pair behind it — the
 * gate primitive proving itself by reuse (project_trusted_onboarding).
 */

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Eye, EyeOff, Loader2 } from "lucide-react";

import {
  listExpectedSourcesFn,
  setExpectedSourceFn,
  type ExpectedSourceState,
} from "@/server/connection-health.functions";

export function WatchSourcesSection({
  kind,
  title,
  blurb,
  watchingVerb,
  accessToken,
  viewAsUserId,
  onChanged,
}: {
  kind: "portal" | "scheduler" | "delivery";
  title: string;
  blurb: string;
  /** Tail of the success toast: "…will flag it if it {watchingVerb}." */
  watchingVerb: string;
  accessToken: string | null;
  viewAsUserId?: string;
  /** Fired after a successful toggle so the host can re-fetch anything that
   *  depends on the watch state (e.g. the Connection Health cards, which gain/
   *  lose a synthetic "expected but not connected" card immediately). */
  onChanged?: () => void;
}) {
  const [sources, setSources] = useState<ExpectedSourceState[] | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    if (!accessToken) return;
    let alive = true;
    void (async () => {
      try {
        const rows = await listExpectedSourcesFn({
          data: { accessToken, viewAsUserId, kind },
        });
        if (alive) setSources(rows);
      } catch {
        // e.g. the expected_sources migration hasn't landed in this environment
        // yet — keep the section hidden rather than show an empty shell (a
        // successful call always returns the full roster for the kind).
        if (alive) setSources(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [accessToken, viewAsUserId, kind]);

  async function toggle(p: ExpectedSourceState) {
    if (!accessToken || pending) return;
    const next = !p.expected;
    setPending(p.sourceKey);
    setSources((prev) =>
      prev
        ? prev.map((x) =>
            x.sourceKey === p.sourceKey ? { ...x, expected: next } : x,
          )
        : prev,
    );
    try {
      await setExpectedSourceFn({
        data: { accessToken, viewAsUserId, kind, sourceKey: p.sourceKey, expected: next },
      });
      toast.success(
        next
          ? `Watching ${p.name} — Connection Health will flag it if it ${watchingVerb}.`
          : `Stopped watching ${p.name}.`,
      );
      // Refresh anything that depends on the watch state (the health cards
      // gain/lose the "expected but not connected" card right away).
      onChanged?.();
    } catch {
      // revert on failure
      setSources((prev) =>
        prev
          ? prev.map((x) =>
              x.sourceKey === p.sourceKey ? { ...x, expected: p.expected } : x,
            )
          : prev,
      );
      toast.error("Couldn't update. Try again.");
    } finally {
      setPending(null);
    }
  }

  if (!sources) return null;

  return (
    <div className="space-y-2 rounded-lg border border-rule bg-white px-3 py-3">
      <div className="flex items-center gap-1.5 text-[12px] font-semibold text-ink">
        <Eye className="h-3.5 w-3.5 text-emerald" />
        {title}
      </div>
      <p className="text-[11px] text-ink-faint">{blurb}</p>
      <div className="flex flex-wrap gap-2 pt-0.5">
        {sources.map((p) => {
          const on = p.expected;
          const busy = pending === p.sourceKey;
          return (
            <button
              key={p.sourceKey}
              type="button"
              disabled={busy}
              onClick={() => toggle(p)}
              className={
                "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-medium transition disabled:opacity-60 " +
                (on
                  ? "border-emerald bg-emerald/10 text-emerald"
                  : "border-rule bg-white text-ink-soft hover:text-ink")
              }
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : on ? (
                <Eye className="h-3.5 w-3.5" />
              ) : (
                <EyeOff className="h-3.5 w-3.5" />
              )}
              {p.name}
              <span className="text-[10px] opacity-70">
                {on ? "watching" : "off"}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
