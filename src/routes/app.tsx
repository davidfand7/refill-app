/**
 * /app layout — outer AppShell wraps every shell-selection branch.
 *
 * v1.24.0 architectural rebuild. Pre-rebuild, chrome (sign-out, PersonaSwitcher,
 * version pill, etc.) lived INSIDE RefillShell / RepShell, both of which were
 * conditionally mounted. When tenant/role resolution failed, the chain
 * collapsed and the user was trapped without sign-out. v1.24.0 separates:
 *
 *   - AppShell (always-on outer chrome): sign-out / PersonaSwitcher /
 *     version pill / theme toggle / email. NEVER conditional on
 *     tenant/role state. Lovable-style.
 *   - Inner shells (RefillShell / RepShell): brand-specific nav chips +
 *     banners. May render null when their state isn't ready, but
 *     AppShell still keeps the user oriented.
 *
 * Auth gate: unauthed → /login.
 * Role gate: rep → RepShell, spa-owner with tenant → RefillShell.
 * Pre-tenant spa-owner / admin-with-no-tenant: AppShell with bare Outlet
 * inside (the route inside, e.g. /app/admin, renders its own page chrome).
 */

import { createFileRoute, Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import { AdminNav } from "@/components/admin/AdminNav";
import { AppShell } from "@/components/AppShell";
import { DemoModeProvider } from "@/lib/demo-mode";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { OfflineBanner } from "@/components/OfflineBanner";
import { RefillShell } from "@/components/shells/RefillShell";
import { RepShell } from "@/components/shells/RepShell";
import { getAdminViewAsUserId } from "@/lib/admin-view-as";
import { useAuth } from "@/lib/auth";
import { useEffectiveRoles } from "@/hooks/useEffectiveRoles";
import { useRepProfile } from "@/lib/use-rep-profile";
import { useTenantMembership } from "@/lib/use-tenant-membership";

export const Route = createFileRoute("/app")({
  component: AppLayout,
});

function AppLayout() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const tenantMembership = useTenantMembership();
  const repProfile = useRepProfile();
  // v1.23.0 (P3) cross-shell impersonation: shell derives from the
  // impersonated user's roles when admin is viewing-as someone.
  const viewAsUserId =
    typeof window !== "undefined" ? getAdminViewAsUserId() : undefined;
  const rolesState = useEffectiveRoles(viewAsUserId);
  const shell =
    rolesState.status === "resolved" ? rolesState.roles.shell : null;

  useEffect(() => {
    if (loading) return;
    if (!user) {
      void navigate({ to: "/login" });
    }
  }, [user, loading, navigate]);

  // Auto-dispatch users landing on bare /app to their shell home.
  useEffect(() => {
    if (loading || !user) return;
    if (location.pathname !== "/app" && location.pathname !== "/app/") return;
    if (shell === "rep" || repProfile.profile) {
      void navigate({ to: "/app/rep", replace: true });
      return;
    }
    if (shell === "admin" || shell === "developer") {
      void navigate({ to: "/app/admin", replace: true });
      return;
    }
    if (tenantMembership.tenant) {
      void navigate({ to: "/app/refill", replace: true });
      return;
    }
  }, [
    location.pathname,
    shell,
    repProfile.profile,
    tenantMembership.tenant,
    user,
    loading,
    navigate,
  ]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-ink-soft">
        Loading…
      </div>
    );
  }

  if (!user) return null;

  // Pick inner content + brand subtitle based on path + state. AppShell
  // wraps every outcome so sign-out + PersonaSwitcher are always
  // reachable — even if the inner shell can't mount.
  const pathname = location.pathname;
  const isRefillPath = pathname.startsWith("/app/refill");
  const isRepPath = pathname.startsWith("/app/rep");
  const isAdminPath = pathname.startsWith("/app/admin");
  const isRep = shell === "rep" || !!repProfile.profile;

  let subtitle: string | undefined;
  let inner: ReactNode;

  if (isRefillPath && tenantMembership.tenant) {
    subtitle = "the patient-profitability OS";
    inner = (
      <RefillShell>
        <Outlet />
      </RefillShell>
    );
  } else if (isRepPath && isRep) {
    subtitle = "rep platform";
    inner = (
      <RepShell>
        <Outlet />
      </RepShell>
    );
  } else if (isAdminPath) {
    // Admin pages get their own light identity (no spa-owner / rep brand
    // bleed) + AdminNav chip strip below the AppShell header so admin
    // can hop between admin surfaces without bouncing back to /app/admin.
    subtitle = "admin";
    inner = (
      <>
        <AdminNav />
        <Outlet />
      </>
    );
  } else if (isRep) {
    subtitle = "rep platform";
    inner = (
      <RepShell>
        <Outlet />
      </RepShell>
    );
  } else if (tenantMembership.tenant) {
    subtitle = "the patient-profitability OS";
    inner = (
      <RefillShell>
        <Outlet />
      </RefillShell>
    );
  } else {
    subtitle = undefined;
    inner = <Outlet />;
  }

  return (
    <DemoModeProvider>
      <ErrorBoundary>
        <OfflineBanner />
        <AppShell subtitle={subtitle}>{inner}</AppShell>
      </ErrorBoundary>
    </DemoModeProvider>
  );
}
