/**
 * /login — Refill-pure sign-in page.
 *
 * Cleave fresh-build 2026-05-24: built from scratch off the v416.A.2
 * Refill-pure layout (paper bg + emerald accent + Georgia serif headlines +
 * single-card centered composition). Dropped from openagenticv4:
 *   - Split-panel Agentiport template
 *   - Shell-discriminator (single shell post-cleave)
 *   - "Continue with Google" button (Google OAuth not configured —
 *     [[feedback-google-oauth-not-hooked-up]], never suggest OAuth as
 *     a login path)
 *
 * Email + password auth via supabase.auth.signInWithPassword.
 * Forgot-password flow uses supabase.auth.resetPasswordForEmail.
 * Post-auth dispatch handled by post-login-redirect.
 */

import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Eye, EyeOff, Loader2, Mail, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import {
  hasDispatched,
  markDispatched,
  postLoginTarget,
} from "@/lib/post-login-redirect";
import { getEffectiveRoles } from "@/server/role-helpers";

export const Route = createFileRoute("/login")({
  component: LoginPage,
});

function LoginPage() {
  const { user, session } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [forgotOpen, setForgotOpen] = useState(false);

  // Post-sign-in dispatch. Single-apex: just navigate to the role's
  // entry path. No cross-host hard nav.
  useEffect(() => {
    const accessToken = session?.access_token;
    if (!user || !accessToken) return;
    if (hasDispatched()) {
      void navigate({ to: "/app" });
      return;
    }
    let cancelled = false;
    // v1.22.2 (P2): fetch the unified shell from getEffectiveRoles
    // (user_roles source of truth) instead of legacy getMyPrimaryRole
    // (user_preferences.primary_role). Admin sign-in now correctly
    // routes to /app/admin instead of the legacy /app/refill default
    // — the dead "admin" branch in postLoginTarget is now live.
    void getEffectiveRoles({ data: { accessToken } })
      .then((roles) => {
        if (cancelled) return;
        const target = postLoginTarget(roles?.shell ?? null);
        markDispatched();
        void navigate({ to: target.href });
      })
      .catch(() => {
        if (cancelled) return;
        markDispatched();
        void navigate({ to: "/app" });
      });
    return () => {
      cancelled = true;
    };
  }, [user, session?.access_token, navigate]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error: err } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (err) setError(err.message);
    setLoading(false);
  };

  return (
    <div
      className="min-h-screen flex flex-col"
      style={{ background: "#fbfaf7", color: "#1c2024" }}
    >
      <header className="px-5 sm:px-8 py-6">
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-4">
          <Link to="/" className="flex items-center gap-3 group">
            <div
              className="flex h-9 w-9 items-center justify-center rounded-lg transition group-hover:opacity-90"
              style={{ background: "#056048", color: "#fbfaf7" }}
              aria-hidden
            >
              <span
                className="text-[20px] font-semibold leading-none"
                style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}
              >
                R
              </span>
            </div>
            <span
              className="text-[15px] font-semibold tracking-tight"
              style={{
                color: "#056048",
                fontFamily: "Georgia, 'Times New Roman', serif",
              }}
            >
              Refill
            </span>
          </Link>
          <Link
            to="/scan"
            className="text-[13px] transition hover:opacity-80"
            style={{ color: "#5a6068" }}
          >
            New to Refill? →
          </Link>
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center px-5 sm:px-8 py-8">
        <div className="w-full max-w-md">
          <div
            className="rounded-xl border bg-white p-7 sm:p-9 shadow-sm"
            style={{ borderColor: "#e6e2d6" }}
          >
            <h1
              className="text-[28px] sm:text-[32px] leading-[1.15] font-semibold tracking-tight mb-2"
              style={{
                fontFamily: "Georgia, 'Times New Roman', serif",
                color: "#1c2024",
              }}
            >
              Welcome back.
            </h1>
            <p
              className="text-[15px] leading-[1.55] mb-6"
              style={{ color: "#5a6068" }}
            >
              Sign in to see what Refill recovered for you this week.
            </p>

            <form onSubmit={onSubmit} className="space-y-3">
              <div>
                <label
                  className="text-[12px] uppercase tracking-wider font-semibold mb-1.5 block"
                  style={{ color: "#8a9098" }}
                >
                  Email
                </label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full rounded-md border bg-white px-3 py-2.5 text-[15px] outline-none focus:ring-2"
                  style={{ borderColor: "#e6e2d6", color: "#1c2024" }}
                  placeholder="you@your-spa.com"
                  autoComplete="email"
                />
              </div>
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label
                    className="text-[12px] uppercase tracking-wider font-semibold"
                    style={{ color: "#8a9098" }}
                  >
                    Password
                  </label>
                  <button
                    type="button"
                    onClick={() => setForgotOpen(true)}
                    className="text-[12px] transition hover:opacity-80"
                    style={{ color: "#056048" }}
                  >
                    Forgot password?
                  </button>
                </div>
                <div className="relative">
                  <input
                    type={showPassword ? "text" : "password"}
                    required
                    minLength={6}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full rounded-md border bg-white px-3 py-2.5 pr-10 text-[15px] outline-none focus:ring-2"
                    style={{ borderColor: "#e6e2d6", color: "#1c2024" }}
                    placeholder="••••••••"
                    autoComplete="current-password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    className="absolute inset-y-0 right-0 flex items-center px-3 transition hover:opacity-70"
                    style={{ color: "#8a9098" }}
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
              {error && (
                <div
                  className="rounded-md px-3 py-2 text-[13px]"
                  style={{ background: "#fdecec", color: "#8a1616" }}
                >
                  {error}
                </div>
              )}
              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-md px-4 py-2.5 text-[14px] font-semibold shadow-sm transition hover:opacity-95 disabled:opacity-50"
                style={{ background: "#056048", color: "#fbfaf7" }}
              >
                {loading ? "Signing in…" : "Sign in"}
              </button>
            </form>
          </div>
        </div>
      </main>

      <footer className="px-5 sm:px-8 py-8">
        <div
          className="max-w-5xl mx-auto text-center text-[12px]"
          style={{ color: "#8a9098" }}
        >
          Built for med-spas.
        </div>
      </footer>

      {forgotOpen && (
        <ForgotPasswordModal
          defaultEmail={email}
          onClose={() => setForgotOpen(false)}
        />
      )}
    </div>
  );
}

function ForgotPasswordModal({
  defaultEmail,
  onClose,
}: {
  defaultEmail: string;
  onClose: () => void;
}) {
  const [email, setEmail] = useState(defaultEmail);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function handleSend(e: FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setSending(true);
    setError(null);
    const { error: err } = await supabase.auth.resetPasswordForEmail(
      email.trim(),
      { redirectTo: "https://getrefill.app/reset-password" },
    );
    if (err) setError(err.message);
    setSent(true);
    setSending(false);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl bg-white shadow-xl overflow-hidden"
        style={{ borderColor: "#e6e2d6" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: "#e6e2d6" }}>
          <div>
            <h2 className="font-semibold text-base">Reset your password</h2>
            <p className="text-xs mt-0.5" style={{ color: "#5a6068" }}>
              We'll email you a link.
            </p>
          </div>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded text-ink-soft hover:opacity-70"
            aria-label="Close"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        {sent ? (
          <div className="px-5 py-6 flex flex-col items-center text-center gap-3">
            <div className="rounded-full p-3" style={{ background: "#e8f1ed" }}>
              <Mail className="h-5 w-5" style={{ color: "#056048" }} />
            </div>
            <div>
              <div className="text-sm font-semibold">Check your email.</div>
              <div className="text-xs mt-1 max-w-sm" style={{ color: "#5a6068" }}>
                If <b>{email}</b> is on file, a reset link is on its way.
              </div>
            </div>
            <button
              onClick={onClose}
              className="mt-2 inline-flex h-8 items-center rounded-md px-4 text-xs font-medium"
              style={{ background: "#056048", color: "#fbfaf7" }}
            >
              Done
            </button>
          </div>
        ) : (
          <form onSubmit={handleSend} className="px-5 py-4 space-y-3">
            <label className="block">
              <div
                className="text-[10px] font-semibold uppercase tracking-wider mb-1"
                style={{ color: "#8a9098" }}
              >
                Email
              </div>
              <input
                type="email"
                required
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@your-spa.com"
                className="w-full rounded-md border bg-white px-3 py-2 text-sm outline-none focus:ring-2"
                style={{ borderColor: "#e6e2d6" }}
              />
            </label>
            {error && (
              <div
                className="rounded-md px-3 py-2 text-xs"
                style={{ background: "#fdecec", color: "#8a1616" }}
              >
                {error}
              </div>
            )}
            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                onClick={onClose}
                disabled={sending}
                className="inline-flex h-8 items-center rounded-md border px-3 text-xs font-medium"
                style={{ borderColor: "#e6e2d6", color: "#5a6068" }}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={sending || !email.trim()}
                className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium"
                style={{ background: "#056048", color: "#fbfaf7" }}
              >
                {sending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Send reset link
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
