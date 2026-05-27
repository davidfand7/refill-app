/**
 * /app/refill/settings/account — Account settings (v1.18b).
 *
 * In-app surface for authed users to:
 *   - See their account email (read-only — email change requires
 *     reverification flow which is a future ship)
 *   - Change their password without going through email recovery
 *
 * Uses supabase.auth.updateUser({ password }) — Supabase doesn't require
 * the current password (the active JWT is the auth gate). For UX clarity
 * we show "new password" + "confirm" only; no "current password" field
 * since requiring it would be theater (Supabase would let us in either way).
 *
 * Mirrors the settings-page chrome (PageHeader + brand-token Tailwind)
 * vs the public /reset-password page which mirrors /login styling.
 */

import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { CheckCircle2, Eye, EyeOff, Loader2, Lock, Mail } from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/refill/settings/account")({
  component: AccountSettingsPage,
});

function AccountSettingsPage() {
  const { user, loading: authLoading } = useAuth();

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Capture the auth.users.updated_at timestamp on load so we can show
  // "last changed N ago" context. Best-effort; failure is non-fatal.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data } = await supabase.auth.getUser();
      if (cancelled) return;
      setLastUpdatedAt(data.user?.updated_at ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  const canSubmit =
    password.length >= 8 && password === confirm && !saving;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    const { error: err, data } = await supabase.auth.updateUser({ password });
    if (err) {
      setError(err.message);
      toast.error(err.message);
      setSaving(false);
      return;
    }
    toast.success("Password updated.");
    setPassword("");
    setConfirm("");
    setLastUpdatedAt(data.user?.updated_at ?? null);
    setSaving(false);
  }

  return (
    <div>
      <PageHeader
        title="Account"
        description="Your sign-in details for Refill. Email change requires a reverification flow (coming soon); password can be changed here anytime."
      />

      <div className="px-6 lg:px-10 py-6 max-w-2xl space-y-6">
        {/* Email row (read-only) */}
        <section className="rounded-xl border border-rule bg-white px-5 py-4">
          <div className="flex items-start gap-3">
            <div className="rounded-full bg-emerald-soft p-2 shrink-0">
              <Mail className="h-4 w-4 text-emerald" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[11px] uppercase tracking-wider font-semibold text-ink-faint mb-1">
                Email
              </div>
              <div className="text-base font-medium text-ink truncate">
                {authLoading ? (
                  <span className="inline-flex items-center gap-2 text-ink-soft">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Loading…
                  </span>
                ) : (
                  user?.email ?? "—"
                )}
              </div>
              <div className="text-xs text-ink-soft mt-1">
                Used for sign-in + recovery emails. Contact support to change.
              </div>
            </div>
          </div>
        </section>

        {/* Change password form */}
        <section className="rounded-xl border border-rule bg-white px-5 py-5">
          <div className="flex items-start gap-3 mb-5">
            <div className="rounded-full bg-emerald-soft p-2 shrink-0">
              <Lock className="h-4 w-4 text-emerald" />
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="text-base font-semibold text-ink">
                Change password
              </h2>
              <p className="text-xs text-ink-soft mt-0.5">
                {lastUpdatedAt
                  ? `Last changed ${relativeTime(lastUpdatedAt)}.`
                  : "Pick something you'll remember. Minimum 8 characters."}
              </p>
            </div>
          </div>

          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <label className="text-[12px] uppercase tracking-wider font-semibold text-ink-faint mb-1.5 block">
                New password
              </label>
              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-md border border-rule bg-white px-3 py-2.5 pr-10 text-[15px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30"
                  placeholder="••••••••"
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  className="absolute inset-y-0 right-0 flex items-center px-3 text-ink-faint hover:text-ink-soft transition"
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
            <div>
              <label className="text-[12px] uppercase tracking-wider font-semibold text-ink-faint mb-1.5 block">
                Confirm new password
              </label>
              <input
                type={showPassword ? "text" : "password"}
                required
                minLength={8}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="w-full rounded-md border border-rule bg-white px-3 py-2.5 text-[15px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30"
                placeholder="••••••••"
                autoComplete="new-password"
              />
              {confirm.length > 0 && password !== confirm && (
                <p className="text-[12px] mt-1.5 text-rose">
                  Passwords don't match.
                </p>
              )}
            </div>
            {error && (
              <div className="rounded-md bg-rose-soft px-3 py-2 text-[13px] text-rose">
                {error}
              </div>
            )}
            <div className="flex items-center gap-3 pt-1">
              <button
                type="submit"
                disabled={!canSubmit}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md px-5 py-2.5 text-[14px] font-semibold shadow-sm transition",
                  canSubmit
                    ? "bg-emerald text-paper hover:opacity-95"
                    : "bg-rule text-ink-faint cursor-not-allowed",
                )}
              >
                {saving ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Saving…
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="h-4 w-4" />
                    Update password
                  </>
                )}
              </button>
              <span className="text-[11px] text-ink-faint">
                You'll stay signed in on this device.
              </span>
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "recently";
  const diff = Date.now() - then;
  const day = 24 * 60 * 60 * 1000;
  if (diff < 60_000) return "just now";
  if (diff < 60 * 60_000) return `${Math.round(diff / 60_000)} min ago`;
  if (diff < day) return `${Math.round(diff / (60 * 60_000))}h ago`;
  if (diff < 7 * day) return `${Math.round(diff / day)}d ago`;
  return new Date(iso).toLocaleDateString();
}
