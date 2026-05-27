/**
 * /reset-password — Public landing page for Supabase password-recovery emails (v1.18).
 *
 * The other half of the forgot-password flow. The /login page's "Forgot
 * password?" modal calls `supabase.auth.resetPasswordForEmail` with
 * redirectTo='https://getrefill.app/reset-password' — and until v1.18,
 * that link landed at a 404 because this route didn't exist. Now the
 * full flow works end-to-end: enter email → Supabase emails a link →
 * click → land here → enter new password → done → sign in.
 *
 * How the Supabase recovery hand-off works:
 *   1. User clicks the recovery link from email
 *   2. URL contains a hash fragment with access_token + refresh_token + type=recovery
 *   3. Supabase JS client auto-detects the hash on page load, signs the
 *      user in temporarily, fires the PASSWORD_RECOVERY auth event
 *   4. Our page checks for a session (recovery OR existing); if present,
 *      we let them set a new password via supabase.auth.updateUser
 *   5. On success: redirect to /login so they can sign in fresh
 *
 * Edge cases handled:
 *   - Expired/invalid link → no session → show "invalid or expired" error
 *   - Already signed in (no recovery) → form still works as a generic
 *     change-password (Supabase's updateUser doesn't require old password)
 *
 * Styling mirrors /login (single-card centered on paper bg, inline hexes
 * for tight visual control, Georgia serif headline).
 */

import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Eye, EyeOff, Loader2, CheckCircle2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/reset-password")({
  component: ResetPasswordPage,
});

type Phase = "checking" | "ready" | "invalid" | "saving" | "done";

function ResetPasswordPage() {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>("checking");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // On mount: check if Supabase has signed the user in via the recovery
  // URL hash. Supabase processes the hash automatically — we just need
  // to give it a tick, then read getSession().
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data } = await supabase.auth.getSession();
      if (cancelled) return;
      setPhase(data.session ? "ready" : "invalid");
    })();
    // Also listen for the PASSWORD_RECOVERY event in case the hash
    // processing is async on slower devices.
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY" || event === "SIGNED_IN") {
        if (!cancelled) setPhase("ready");
      }
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  const canSubmit =
    phase === "ready" &&
    password.length >= 8 &&
    password === confirm;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setPhase("saving");
    setError(null);
    const { error: err } = await supabase.auth.updateUser({ password });
    if (err) {
      setError(err.message);
      setPhase("ready");
      return;
    }
    setPhase("done");
    // Sign out of the recovery session so the next sign-in is clean.
    await supabase.auth.signOut();
    // Redirect to /login after a short pause so user sees the success state.
    setTimeout(() => {
      void navigate({ to: "/login" });
    }, 1800);
  }

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
            to="/login"
            className="text-[13px] transition hover:opacity-80"
            style={{ color: "#5a6068" }}
          >
            Back to sign in →
          </Link>
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center px-5 sm:px-8 py-8">
        <div className="w-full max-w-md">
          <div
            className="rounded-xl border bg-white p-7 sm:p-9 shadow-sm"
            style={{ borderColor: "#e6e2d6" }}
          >
            {phase === "checking" && (
              <div className="flex items-center justify-center gap-2 py-8" style={{ color: "#5a6068" }}>
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="text-sm">Verifying your link…</span>
              </div>
            )}

            {phase === "invalid" && (
              <>
                <h1
                  className="text-[24px] sm:text-[28px] leading-[1.2] font-semibold tracking-tight mb-2"
                  style={{
                    fontFamily: "Georgia, 'Times New Roman', serif",
                    color: "#1c2024",
                  }}
                >
                  Link expired or invalid.
                </h1>
                <p className="text-[14px] leading-[1.55] mb-6" style={{ color: "#5a6068" }}>
                  Your password-reset link didn't include a valid session.
                  Recovery links expire after one hour. Request a fresh one
                  from the sign-in page.
                </p>
                <Link
                  to="/login"
                  className="inline-block w-full text-center rounded-md px-4 py-2.5 text-[14px] font-semibold shadow-sm transition hover:opacity-95"
                  style={{ background: "#056048", color: "#fbfaf7" }}
                >
                  Back to sign in
                </Link>
              </>
            )}

            {(phase === "ready" || phase === "saving") && (
              <>
                <h1
                  className="text-[28px] sm:text-[32px] leading-[1.15] font-semibold tracking-tight mb-2"
                  style={{
                    fontFamily: "Georgia, 'Times New Roman', serif",
                    color: "#1c2024",
                  }}
                >
                  Set a new password.
                </h1>
                <p className="text-[15px] leading-[1.55] mb-6" style={{ color: "#5a6068" }}>
                  Pick something you'll remember. Minimum 8 characters.
                </p>

                <form onSubmit={onSubmit} className="space-y-3">
                  <div>
                    <label
                      className="text-[12px] uppercase tracking-wider font-semibold mb-1.5 block"
                      style={{ color: "#8a9098" }}
                    >
                      New password
                    </label>
                    <div className="relative">
                      <input
                        type={showPassword ? "text" : "password"}
                        required
                        minLength={8}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className="w-full rounded-md border bg-white px-3 py-2.5 pr-10 text-[15px] outline-none focus:ring-2"
                        style={{ borderColor: "#e6e2d6", color: "#1c2024" }}
                        placeholder="••••••••"
                        autoComplete="new-password"
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
                  <div>
                    <label
                      className="text-[12px] uppercase tracking-wider font-semibold mb-1.5 block"
                      style={{ color: "#8a9098" }}
                    >
                      Confirm new password
                    </label>
                    <input
                      type={showPassword ? "text" : "password"}
                      required
                      minLength={8}
                      value={confirm}
                      onChange={(e) => setConfirm(e.target.value)}
                      className="w-full rounded-md border bg-white px-3 py-2.5 text-[15px] outline-none focus:ring-2"
                      style={{ borderColor: "#e6e2d6", color: "#1c2024" }}
                      placeholder="••••••••"
                      autoComplete="new-password"
                    />
                    {confirm.length > 0 && password !== confirm && (
                      <p className="text-[12px] mt-1.5" style={{ color: "#8a1616" }}>
                        Passwords don't match.
                      </p>
                    )}
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
                    disabled={!canSubmit || phase === "saving"}
                    className="w-full rounded-md px-4 py-2.5 text-[14px] font-semibold shadow-sm transition hover:opacity-95 disabled:opacity-50"
                    style={{ background: "#056048", color: "#fbfaf7" }}
                  >
                    {phase === "saving" ? "Saving…" : "Save new password"}
                  </button>
                </form>
              </>
            )}

            {phase === "done" && (
              <div className="text-center py-2">
                <div
                  className="mx-auto h-14 w-14 rounded-full flex items-center justify-center mb-4"
                  style={{ background: "#056048", color: "#fbfaf7" }}
                >
                  <CheckCircle2 className="h-7 w-7" />
                </div>
                <h2
                  className="text-[22px] font-semibold mb-2"
                  style={{
                    fontFamily: "Georgia, 'Times New Roman', serif",
                    color: "#1c2024",
                  }}
                >
                  Password updated.
                </h2>
                <p className="text-[14px] leading-[1.55] mb-6" style={{ color: "#5a6068" }}>
                  Redirecting you to sign in with your new password…
                </p>
                <Link
                  to="/login"
                  className="inline-block text-[13px] transition hover:opacity-80"
                  style={{ color: "#056048" }}
                >
                  Sign in now →
                </Link>
              </div>
            )}
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
    </div>
  );
}
