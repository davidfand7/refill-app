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
import { RefillShellChrome } from "@/components/refill/RefillShellChrome";
import { useTenantMembership } from "@/lib/use-tenant-membership";

export function RefillShell({ children }: { children: React.ReactNode }) {
  const membership = useTenantMembership();
  if (membership.status !== "tenant") return null;
  return (
    <div className="min-h-screen" style={{ background: "#fbfaf7" }}>
      <RefillShellChrome tenant={membership.tenant} />
      <main className="flex-1 min-w-0 pb-16 md:pb-0">{children}</main>
    </div>
  );
}
