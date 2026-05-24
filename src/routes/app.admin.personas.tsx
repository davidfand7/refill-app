/**
 * /app/admin/personas — v417.1 persona switcher.
 *
 * Grasshopper-only test surface. Bootstraps shared test passwords on
 * the demo personas (Kelly, Maria, Karen), then surfaces them as cards
 * with "Sign in as <persona>" buttons. Clicking signs out the admin
 * session and signs in as the persona via supabase.auth.signInWithPassword
 * — instant in-tab session swap, no magic-link round-trip, no cross-host
 * bridge invocation. Lands on the persona's dashboard.
 *
 * Round-trip back to admin: standard sign-out + Google OAuth log back
 * in as davidfand303@gmail.com (existing flow). The dropdown itself
 * doesn't try to preserve the admin session under the persona — that
 * would require Supabase session-stacking which the platform doesn't
 * support cleanly.
 *
 * Auth: useIsAdmin client gate + server-side requireAdmin on every fn
 * call (defense in depth — service-role calls can't be triggered by
 * a non-admin even if they slip past the client gate).
 */

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ArrowRight, Check, Loader2, Users } from "lucide-react";

import { useAuth } from "@/lib/auth";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import { PageHeader } from "@/components/PageHeader";
import { supabase } from "@/integrations/supabase/client";
import {
  bootstrapV417Personas,
  listV417Personas,
  type BootstrapPersonaResult,
  type V417Persona,
} from "@/server/v417-personas";

export const Route = createFileRoute("/app/admin/personas")({
  component: AdminPersonasPage,
});

type BootstrapState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; results: BootstrapPersonaResult[]; password: string }
  | { kind: "error"; message: string };

function AdminPersonasPage() {
  const { session, loading: authLoading } = useAuth();
  const isAdmin = useIsAdmin();
  const navigate = useNavigate();

  const [personas, setPersonas] = useState<V417Persona[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [bootstrap, setBootstrap] = useState<BootstrapState>({ kind: "idle" });
  const [signInError, setSignInError] = useState<string | null>(null);
  const [signingInAs, setSigningInAs] = useState<string | null>(null);

  // Bounce non-authed to login.
  useEffect(() => {
    if (authLoading) return;
    if (!session) {
      void navigate({ to: "/login" });
    }
  }, [authLoading, session, navigate]);

  // Load persona roster once admin status confirmed.
  useEffect(() => {
    if (!session?.access_token || !isAdmin) return;
    let cancelled = false;
    void listV417Personas({ data: { accessToken: session.access_token } })
      .then((r) => {
        if (cancelled) return;
        setPersonas(r.personas);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : "Couldn't load personas.");
      });
    return () => {
      cancelled = true;
    };
  }, [session?.access_token, isAdmin]);

  const handleBootstrap = async () => {
    if (!session?.access_token) return;
    setBootstrap({ kind: "running" });
    try {
      const result = await bootstrapV417Personas({
        data: { accessToken: session.access_token },
      });
      setBootstrap({
        kind: "done",
        results: result.results,
        password: result.password,
      });
    } catch (err) {
      setBootstrap({
        kind: "error",
        message: err instanceof Error ? err.message : "Bootstrap failed.",
      });
    }
  };

  const handleSignInAs = async (persona: V417Persona) => {
    if (signingInAs) return;
    setSignInError(null);
    setSigningInAs(persona.email);
    try {
      // Sign out current admin session first so signInWithPassword
      // doesn't end up in a weird mid-state if it fails.
      await supabase.auth.signOut();
      // Sign in as persona with the shared test password.
      const { error } = await supabase.auth.signInWithPassword({
        email: persona.email,
        password: "RefillTest2026!", // matches V417_TEST_PASSWORD in server
      });
      if (error) throw new Error(error.message);
      // Hard navigate so the new session's shell/role bootscript fires
      // cleanly without React clinging to admin-session state.
      window.location.assign(persona.dashboard);
    } catch (err) {
      setSignInError(
        err instanceof Error ? err.message : "Couldn't sign in as that persona.",
      );
      setSigningInAs(null);
    }
  };

  if (authLoading || !session) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center text-sm text-ink-soft">
        <Loader2 className="h-4 w-4 animate-spin mr-2" />
        Checking access…
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center text-sm text-ink-soft">
        <Loader2 className="h-4 w-4 animate-spin mr-2" />
        Loading…
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <PageHeader
        eyebrow="Admin"
        title="Persona switcher"
        description="Sign in as any demo persona to test the system end-to-end. Idempotent password bootstrap; click 'Sign in as X' to swap sessions instantly."
        breadcrumbs={[{ label: "Admin", to: "/app/admin" }, { label: "Personas" }]}
      />

      <div className="px-6 lg:px-10 py-8 max-w-5xl mx-auto space-y-8">
        {/* Bootstrap section */}
        <section className="rounded-2xl border border-border bg-card p-5 lg:p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-[15px] font-semibold mb-1">Password bootstrap</h2>
              <p className="text-[13px] text-ink-soft leading-relaxed">
                Sets <code className="text-[12px]">RefillTest2026!</code> as the
                shared password on Kelly / Maria / Karen via service-role admin.
                Idempotent — run anytime; re-running just re-applies the same
                password.
              </p>
            </div>
            <button
              type="button"
              onClick={handleBootstrap}
              disabled={bootstrap.kind === "running"}
              className="shrink-0 inline-flex items-center gap-1.5 rounded-lg bg-primary text-primary-foreground px-4 py-2 text-[13px] font-semibold transition hover:opacity-90 disabled:opacity-50"
            >
              {bootstrap.kind === "running" ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Setting passwords…
                </>
              ) : (
                <>
                  <Users className="h-3.5 w-3.5" />
                  Bootstrap personas
                </>
              )}
            </button>
          </div>
          {bootstrap.kind === "done" && (
            <div className="mt-4 space-y-2">
              {bootstrap.results.map((r) => (
                <div
                  key={r.email}
                  className="flex items-center gap-2 text-[13px]"
                >
                  {r.status === "ok" ? (
                    <Check className="h-4 w-4 text-emerald-600" aria-hidden />
                  ) : (
                    <span className="h-4 w-4 inline-flex items-center justify-center text-destructive">
                      ⚠
                    </span>
                  )}
                  <span className="font-mono">{r.email}</span>
                  <span
                    className={
                      r.status === "ok"
                        ? "text-emerald-700"
                        : "text-destructive"
                    }
                  >
                    {r.status === "ok" ? "password set" : r.message}
                  </span>
                </div>
              ))}
              <p className="text-[12px] text-ink-soft mt-3">
                Shared password:{" "}
                <code className="text-[12px] bg-muted px-1.5 py-0.5 rounded">
                  {bootstrap.password}
                </code>
              </p>
            </div>
          )}
          {bootstrap.kind === "error" && (
            <div className="mt-4 text-[13px] text-destructive">
              {bootstrap.message}
            </div>
          )}
        </section>

        {/* Persona cards */}
        <section>
          <h2 className="text-[15px] font-semibold mb-3">Sign in as</h2>
          {loadError && (
            <div className="text-[13px] text-destructive mb-3">{loadError}</div>
          )}
          {signInError && (
            <div className="text-[13px] text-destructive mb-3">{signInError}</div>
          )}
          {!personas && !loadError && (
            <div className="text-[13px] text-ink-soft flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading personas…
            </div>
          )}
          {personas && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {personas.map((p) => (
                <PersonaCard
                  key={p.email}
                  persona={p}
                  loading={signingInAs === p.email}
                  disabled={!!signingInAs && signingInAs !== p.email}
                  onSignIn={() => void handleSignInAs(p)}
                />
              ))}
            </div>
          )}
          <p className="text-[12px] text-ink-soft mt-4">
            Persona swap signs you out and signs in as the chosen account in
            this tab. To get back to admin: sign out from the persona's
            dashboard, sign back in as <code>davidfand303@gmail.com</code> via
            Google OAuth.
          </p>
        </section>
      </div>
    </div>
  );
}

function PersonaCard({
  persona,
  loading,
  disabled,
  onSignIn,
}: {
  persona: V417Persona;
  loading: boolean;
  disabled: boolean;
  onSignIn: () => void;
}) {
  const roleLabel =
    persona.role === "rep" ? "Rep" : persona.role === "spa-owner" ? "Spa owner" : persona.role;
  return (
    <div className="rounded-2xl border border-border bg-card p-5 flex flex-col">
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="text-[15px] font-semibold text-foreground">
          {persona.displayName}
        </div>
        <span
          className="text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-full bg-primary/10 text-primary"
        >
          {roleLabel}
        </span>
      </div>
      <div className="text-[12px] font-mono text-ink-soft mb-3">
        {persona.email}
      </div>
      <div className="text-[13px] leading-[1.5] text-ink-soft flex-1 mb-4">
        {persona.description}
      </div>
      <div className="text-[11px] text-ink-soft mb-3">
        Lands at <code>{persona.dashboard}</code>
      </div>
      <button
        type="button"
        onClick={onSignIn}
        disabled={loading || disabled}
        className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary text-primary-foreground px-4 py-2 text-[13px] font-semibold transition hover:opacity-90 disabled:opacity-50"
      >
        {loading ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Signing in…
          </>
        ) : (
          <>
            Sign in as {persona.displayName.split(" ")[0]}
            <ArrowRight className="h-3.5 w-3.5" />
          </>
        )}
      </button>
    </div>
  );
}
