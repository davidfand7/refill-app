/**
 * RefillShell — the Refill standalone-product spa-owner workspace shell (v410).
 *
 * Selected from app.tsx when:
 *   shell === "refill" && useTenantMembership().status === "tenant"
 *
 * Renders the narrow Refill chrome (4-chip nav, "Refill / no-show recovery"
 * brand identity, no Agentiport sidebar). Closes the v410 Pinch #2 mirror
 * for spa owners — Karen on getrefill.app no longer sees the Agentiport
 * developer surface.
 *
 * Per [[project-refill-trojan-horse-thesis]]: the shell stays narrow forever.
 * No "upgrade to broader feature set" CTAs inside, no platform-ambition
 * surfaces — Refill is positioned as a single-feature widget, the stealth
 * is the strategy.
 *
 * Defensive null-return if tenant membership isn't in the "tenant" state
 * when this mounts (app.tsx branch should prevent it; this catches any
 * future code path that mounts RefillShell outside that branch).
 */
import { useLocation } from "@tanstack/react-router";

import { RefillShellChrome } from "@/components/refill/RefillShellChrome";
import { SettingsSidebar } from "@/components/refill/SettingsSidebar";
import { useTenantMembership } from "@/lib/use-tenant-membership";

/** Account/back-office routes get the left settings rail (v2.176.0). Mirrors
 *  RefillShellChrome's deriveActiveKey "settings" branch. */
function isSettingsRoute(pathname: string): boolean {
  return (
    pathname.startsWith("/app/refill/reports") ||
    pathname.startsWith("/app/refill/settings") ||
    pathname.startsWith("/app/billing") ||
    pathname.startsWith("/app/refill/billing")
  );
}

export function RefillShell({ children }: { children: React.ReactNode }) {
  const membership = useTenantMembership();
  const { pathname } = useLocation();
  if (membership.status !== "tenant") return null;
  // v1.19: thread viewAs through so chrome can show the admin "viewing as"
  // banner when the membership is the admin-fallback rather than a real
  // tenant_memberships row.
  const settings = isSettingsRoute(pathname);
  return (
    <div className="min-h-screen" style={{ background: "#fbfaf7" }}>
      <RefillShellChrome
        tenant={membership.tenant}
        viewAs={membership.viewAs}
        viewAsExplicit={membership.viewAsExplicit}
      />
      <main className="flex-1 min-w-0 pb-16 md:pb-0">
        {settings ? (
          // v2.176.0: Account hub gets a left rail (was a 10-tab horizontal
          // scroll strip). Pages keep their own PageHeader + content; the rail
          // is rendered once here for every settings route.
          <div className="mx-auto max-w-6xl px-4 md:flex md:gap-6">
            <SettingsSidebar />
            <div className="min-w-0 flex-1">{children}</div>
          </div>
        ) : (
          children
        )}
      </main>
    </div>
  );
}
