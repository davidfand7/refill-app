/**
 * RefillRepShellChrome — Refill rep inner chrome (sub-nav + banners).
 *
 * v1.24.0 rebuild: outer chrome (brand mark + sign-out + PersonaSwitcher +
 * version pill + theme toggle + email) moved up to AppShell. This file is
 * now just the rep-specific inner surface: DemoBanner + RefillRepNav.
 */
import { useLocation } from "@tanstack/react-router";
import { Sparkles } from "lucide-react";

import { DemoBanner } from "@/components/DemoBanner";
import { RefillRepNav, type RefillRepNavKey } from "@/components/refill/RefillRepNav";
import { getAdminViewAsUserId } from "@/lib/admin-view-as";
import type { RepAccountRow } from "@/server/rep-platform";

function deriveActiveKey(pathname: string): RefillRepNavKey | undefined {
  if (pathname.startsWith("/app/rep/outreach")) return "outreach";
  if (pathname.startsWith("/app/rep/recruit")) return "recruit";
  if (pathname.startsWith("/app/rep/network")) return "network";
  if (pathname.startsWith("/app/rep/ledger")) return "ledger";
  if (pathname.startsWith("/app/rep/referral-links")) return "referral-links";
  if (pathname.startsWith("/app/rep/integrations")) return "integrations";
  return undefined;
}

export function RefillRepShellChrome({ rep }: { rep: RepAccountRow }) {
  const location = useLocation();
  const activeKey = deriveActiveKey(location.pathname);
  // v1.24.3: when admin is impersonating a rep, surface a persistent
  // banner so they don't forget which persona they're in. Mirrors the
  // RefillShellChrome admin-fallback banner for spa-owners.
  const isImpersonating =
    typeof window !== "undefined" && !!getAdminViewAsUserId();

  return (
    <div className="mx-auto max-w-6xl px-4 pt-4">
      <DemoBanner />
      {isImpersonating && (
        <div
          className="mb-3 rounded-lg border px-3 py-2 text-[12px] flex items-center gap-2"
          style={{
            background: "#fdf6dc",
            borderColor: "rgba(138, 109, 12, 0.3)",
            color: "#8a6d0c",
          }}
        >
          <Sparkles className="h-3.5 w-3.5 shrink-0" />
          <span>
            Viewing as <strong>{rep.displayName}</strong>. Use the persona
            switcher in the upper-right to change view or revert.
          </span>
        </div>
      )}
      <RefillRepNav active={activeKey} />
    </div>
  );
}
