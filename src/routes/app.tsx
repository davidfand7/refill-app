/**
 * /app layout — Refill-only shell dispatcher.
 *
 * Cleave rewrite 2026-05-24: collapsed from openagenticv4's 4-shell
 * dispatcher (refill / liz / karen / platform) to a 2-shell setup
 * (RefillShell for spa owners, RepShell for reps). All the Agentiport
 * scaffolding (AppSidebar, CommandPalette, KAREN_/LIZ_ALLOWED_PREFIXES,
 * ShortcutCheatsheet, MobileNav) is gone — replaced by per-shell chrome
 * already imported by the shell components themselves.
 *
 * Auth gate: unauthed → redirect to /login.
 * Role gate: rep → RepShell, spa-owner with tenant → RefillShell.
 * Pre-tenant spa-owner: render bare /app outlet (the onboarding flow
 * lives at /onboard, not gated here — they get there from /scan or
 * the post-magic-link redirect).
 */

import { createFileRoute, Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { DemoModeProvider } from "@/lib/demo-mode";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { OfflineBanner } from "@/components/OfflineBanner";
import { RefillShell } from "@/components/shells/RefillShell";
import { RepShell } from "@/components/shells/RepShell";
import { getMyPrimaryRole } from "@/server/user-prefs.functions";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useRepProfile } from "@/lib/use-rep-profile";
import { useTenantMembership } from "@/lib/use-tenant-membership";

export const Route = createFileRoute("/app")({
  component: AppLayout,
});

type PrimaryRole = "spa-owner" | "rep" | "developer" | "admin" | null;

function AppLayout() {
  const { user, session, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const tenantMembership = useTenantMembership();
  const repProfile = useRepProfile();
  const [primaryRole, setPrimaryRole] = useState<PrimaryRole>(null);

  useEffect(() => {
    if (loading) return;
    if (!user) {
      void navigate({ to: "/login" });
      return;
    }
    const accessToken = session?.access_token;
    if (!accessToken) return;
    void getMyPrimaryRole({ data: { accessToken } })
      .then((r) => setPrimaryRole((r?.primaryRole as PrimaryRole) ?? null))
      .catch(() => setPrimaryRole(null));
  }, [user, loading, session?.access_token, navigate]);

  // Auto-dispatch users landing on bare /app to their shell home. Without
  // this, magic-link-driven landings sit on /app with an empty Outlet.
  useEffect(() => {
    if (loading || !user) return;
    if (location.pathname !== "/app" && location.pathname !== "/app/") return;
    if (primaryRole === "rep" || repProfile.profile) {
      void navigate({ to: "/app/rep", replace: true });
      return;
    }
    if (primaryRole === "admin") {
      void navigate({ to: "/app/admin", replace: true });
      return;
    }
    if (primaryRole === "developer") {
      void navigate({ to: "/app/admin/personas", replace: true });
      return;
    }
    if (tenantMembership.tenant) {
      void navigate({ to: "/app/refill", replace: true });
      return;
    }
    // No role + no tenant + no rep profile yet — could still be loading.
    // Wait for the async checks to settle; we'll re-fire when state updates.
  }, [
    location.pathname,
    primaryRole,
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

  // Reps get RepShell — even if they happen to also own a tenant. Role
  // wins; they can browse to /app/refill via direct link if needed and
  // RefillShell will pick it up via its own gate.
  if (primaryRole === "rep" || repProfile.profile) {
    return (
      <DemoModeProvider>
        <ErrorBoundary>
          <OfflineBanner />
          <RepShell>
            <Outlet />
          </RepShell>
        </ErrorBoundary>
      </DemoModeProvider>
    );
  }

  // Spa-owner with claimed tenant → RefillShell.
  if (tenantMembership.tenant) {
    return (
      <DemoModeProvider>
        <ErrorBoundary>
          <OfflineBanner />
          <RefillShell>
            <Outlet />
          </RefillShell>
        </ErrorBoundary>
      </DemoModeProvider>
    );
  }

  // Authed but no tenant + no rep profile — pre-tenant state. Render the
  // outlet bare; the route inside (e.g. /app/admin/personas, /app/refill
  // with its own non-tenant gate) decides what to show.
  return (
    <DemoModeProvider>
      <ErrorBoundary>
        <OfflineBanner />
        <Outlet />
      </ErrorBoundary>
    </DemoModeProvider>
  );
}
