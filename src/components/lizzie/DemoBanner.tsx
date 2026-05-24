/**
 * DemoBanner — visual marker that the active session is a seeded demo
 * persona. Renders nothing when isDemo is false.
 *
 * Originally rep-specific (Phase 2G v399.2 — Kelly demo). v410 generalized
 * to accept a wipeFnName so both rep (wipe_kelly_demo_data) and spa-owner
 * (wipe_karen_demo_data) shells can surface the same banner shape with
 * the right SQL to clear their respective demo seeds.
 */

import { AlertTriangle } from "lucide-react";

export function DemoBanner({
  isDemo,
  wipeFnName = "wipe_kelly_demo_data",
}: {
  isDemo: boolean;
  wipeFnName?: string;
}) {
  if (!isDemo) return null;
  return (
    <div
      role="status"
      aria-label="Demo mode active"
      className="-mx-2 mb-4 flex items-start gap-2 rounded-lg border px-3.5 py-2.5 text-[12.5px] leading-[1.5]"
      style={{
        background: "#fdf6e6",
        borderColor: "#e8d896",
        color: "#6b520c",
      }}
    >
      <AlertTriangle
        className="h-4 w-4 flex-shrink-0 mt-0.5"
        style={{ color: "#8a6d10" }}
        aria-hidden
      />
      <div>
        <strong style={{ color: "#5a4408" }}>Demo mode.</strong> This account
        is pre-populated with sample data for walkthrough purposes. Run{" "}
        <code
          className="font-mono text-[11.5px] px-1 py-0.5 rounded"
          style={{ background: "#f4ead0", color: "#5a4408" }}
        >
          select * from public.{wipeFnName}();
        </code>{" "}
        in the Supabase SQL editor to clear before live use.
      </div>
    </div>
  );
}
