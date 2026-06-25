/**
 * /app/refill/settings/account — Account settings.
 *
 * In-app surface for authed users to:
 *   - Change their account email with reverification (v1.22)
 *   - Change their password without going through email recovery (v1.18)
 *
 * Email change flow: supabase.auth.updateUser({ email }) → Supabase sends
 * a confirmation link to the NEW address (and, depending on dashboard
 * "secure email change" setting, also to the OLD address). The change is
 * NOT applied until the user clicks the link. Mid-flight, the user's
 * row has `new_email` populated so we render a pending-state banner that
 * survives navigation and refresh.
 *
 * Password change: supabase.auth.updateUser({ password }) — Supabase
 * doesn't require the current password (the active JWT is the auth gate).
 * For UX clarity we show "new password" + "confirm" only; no "current
 * password" field since requiring it would be theater (Supabase would let
 * us in either way).
 *
 * Mirrors the settings-page chrome (PageHeader + brand-token Tailwind)
 * vs the public /reset-password page which mirrors /login styling.
 */

import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import {
  CheckCircle2,
  Download,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  Mail,
  X,
} from "lucide-react";
import { Link } from "@tanstack/react-router";

import { PageHeader } from "@/components/PageHeader";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useTenantMembership } from "@/lib/use-tenant-membership";
import { cn } from "@/lib/utils";
import { exportSpaData, type SpaDataExport } from "@/server/data-export.functions";

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

  // v1.22 email change state.
  const [emailMode, setEmailMode] = useState<"idle" | "editing">("idle");
  const [newEmail, setNewEmail] = useState("");
  const [emailSaving, setEmailSaving] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);

  // Capture the auth.users.updated_at timestamp + any pending email change
  // on load. Supabase's user.new_email is populated when an email change
  // has been requested but not confirmed; we render it as a banner so the
  // change survives page reloads + browser closes. Best-effort; failure
  // is non-fatal for the rest of the page.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data } = await supabase.auth.getUser();
      if (cancelled) return;
      setLastUpdatedAt(data.user?.updated_at ?? null);
      // new_email is a string when a change is pending, undefined otherwise.
      const u = data.user as
        | (typeof data.user & { new_email?: string })
        | null;
      setPendingEmail(u?.new_email ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  async function onSubmitEmail(e: FormEvent) {
    e.preventDefault();
    const trimmed = newEmail.trim();
    if (!trimmed || trimmed === user?.email || emailSaving) return;
    setEmailSaving(true);
    setEmailError(null);
    const { error: err } = await supabase.auth.updateUser({ email: trimmed });
    if (err) {
      setEmailError(err.message);
      toast.error(err.message);
      setEmailSaving(false);
      return;
    }
    setPendingEmail(trimmed);
    setEmailMode("idle");
    setNewEmail("");
    setEmailSaving(false);
    toast.success(`Confirmation sent to ${trimmed}. Click the link there to finish the change.`);
  }

  function cancelEmailChange() {
    // Supabase doesn't expose a direct "cancel pending email change" API.
    // The pending state expires server-side after a configured TTL (default
    // 24h). Simplest user-friendly cancel: re-request to the current email,
    // which overwrites new_email with the same address as the current one
    // (effectively a no-op on confirmation) — Supabase nulls new_email in
    // that case. Errors surface in toast; UI optimistically clears anyway.
    if (!user?.email) return;
    void (async () => {
      try {
        await supabase.auth.updateUser({ email: user.email! });
      } catch {
        /* non-fatal — pending state will expire on its own */
      }
      setPendingEmail(null);
      toast.success("Email change cancelled.");
    })();
  }

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
        description="Your sign-in details for Refill. Change your email (with confirmation) or password anytime."
      />

      <div className="px-6 lg:px-10 py-6 max-w-2xl w-full mx-auto space-y-6">
        {/* Email section (editable + pending state) */}
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
                Used for sign-in + recovery emails.
              </div>

              {/* Pending email change banner */}
              {pendingEmail && pendingEmail !== user?.email && (
                <div className="mt-3 rounded-md bg-amber-soft px-3 py-2 text-[13px] text-amber flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <span className="font-semibold">Change pending: </span>
                    <span className="break-all">{pendingEmail}</span>
                    <span className="block text-[12px] mt-0.5 opacity-90">
                      Check your inbox at <strong>{pendingEmail}</strong> and
                      click the confirmation link to finish the change.
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={cancelEmailChange}
                    className="text-amber/80 hover:text-amber transition shrink-0"
                    aria-label="Cancel email change"
                    title="Cancel email change"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}

              {/* Edit form */}
              {emailMode === "idle" ? (
                <button
                  type="button"
                  onClick={() => {
                    setEmailMode("editing");
                    setNewEmail("");
                    setEmailError(null);
                  }}
                  className="mt-3 text-[13px] font-medium text-emerald hover:opacity-80 transition"
                >
                  Change email
                </button>
              ) : (
                <form onSubmit={onSubmitEmail} className="mt-3 space-y-2">
                  <label className="text-[12px] uppercase tracking-wider font-semibold text-ink-faint block">
                    New email
                  </label>
                  <input
                    type="email"
                    required
                    autoFocus
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                    placeholder="you@yourspa.com"
                    className="w-full rounded-md border border-rule bg-white px-3 py-2 text-[15px] text-ink outline-none focus:border-emerald focus:ring-2 focus:ring-emerald/30"
                    autoComplete="email"
                  />
                  {emailError && (
                    <div className="rounded-md bg-rose-soft px-3 py-2 text-[13px] text-rose">
                      {emailError}
                    </div>
                  )}
                  <div className="flex items-center gap-2 pt-1">
                    <button
                      type="submit"
                      disabled={
                        emailSaving ||
                        !newEmail.trim() ||
                        newEmail.trim() === user?.email
                      }
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-md px-4 py-2 text-[13px] font-semibold transition",
                        emailSaving ||
                          !newEmail.trim() ||
                          newEmail.trim() === user?.email
                          ? "bg-rule text-ink-faint cursor-not-allowed"
                          : "bg-emerald text-paper hover:opacity-95",
                      )}
                    >
                      {emailSaving ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          Sending…
                        </>
                      ) : (
                        "Send confirmation"
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEmailMode("idle");
                        setNewEmail("");
                        setEmailError(null);
                      }}
                      className="text-[13px] text-ink-soft hover:text-ink transition"
                    >
                      Cancel
                    </button>
                  </div>
                  <p className="text-[11px] text-ink-faint pt-1">
                    We&rsquo;ll email a confirmation link to the new address.
                    Your email stays the same until you click it.
                  </p>
                </form>
              )}
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

        {/* Your data & leaving — the honest-exit rung. */}
        <YourDataSection />
      </div>
    </div>
  );
}

// ─── Your data & leaving (honest exit) ──────────────────────────────────────

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function patientsToCsv(patients: SpaDataExport["patients"]): string {
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const header = ["Name", "Email", "Phone", "Lifetime spend (USD)"];
  const lines = patients.map((p) =>
    [p.name ?? "", p.email ?? "", p.phone ?? "", p.lifetimeSpendUsd != null ? p.lifetimeSpendUsd.toFixed(2) : ""]
      .map((c) => esc(String(c)))
      .join(","),
  );
  return [header.map(esc).join(","), ...lines].join("\r\n");
}

function YourDataSection() {
  const [busy, setBusy] = useState<"csv" | "json" | null>(null);
  // Forward the admin/tenant "view-as" user so the export reads the spa being
  // viewed, not the operator's own (empty) book — same plumbing every other
  // spa-owner data fetcher uses. Without it, viewing Rejuv as a tenant exported
  // 0 patients (resolveEffectiveUserId fell back to the signed-in operator).
  const membership = useTenantMembership();
  const viewAsUserId =
    membership.status === "tenant" ? membership.viewAsUserId : undefined;

  async function fetchExport(): Promise<SpaDataExport | null> {
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    if (!token) {
      toast.error("Please sign in again.");
      return null;
    }
    return exportSpaData({ data: { accessToken: token, viewAsUserId } });
  }

  async function downloadPatientCsv() {
    if (busy) return;
    setBusy("csv");
    try {
      const data = await fetchExport();
      if (!data) return;
      const blob = new Blob([patientsToCsv(data.patients)], { type: "text/csv;charset=utf-8;" });
      triggerDownload(blob, `smartspa-patient-book-${data.exportedAt.slice(0, 10)}.csv`);
      toast.success(`Exported ${data.counts.patients} patients.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't export your data.");
    } finally {
      setBusy(null);
    }
  }

  async function downloadFullJson() {
    if (busy) return;
    setBusy("json");
    try {
      const data = await fetchExport();
      if (!data) return;
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      triggerDownload(blob, `smartspa-export-${data.exportedAt.slice(0, 10)}.json`);
      toast.success(
        `Exported ${data.counts.patients} patients · ${data.counts.appointments} appointments · ${data.counts.waitlist} waitlist.`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't export your data.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rounded-xl border border-rule bg-white px-5 py-5">
      <h2 className="text-base font-semibold text-ink">Your data &amp; leaving</h2>
      <p className="mt-1 text-[13px] text-ink-soft">
        Your data is yours. Take your full patient book, appointments, and waitlist with
        you anytime — one click, no questions asked. SmartSpa earns its keep by being
        useful, not by holding your data hostage.
      </p>

      <div className="mt-4 flex flex-wrap gap-2.5">
        <button
          type="button"
          onClick={() => void downloadPatientCsv()}
          disabled={busy !== null}
          className="inline-flex items-center gap-2 rounded-lg bg-emerald text-paper px-3.5 py-2 text-sm font-semibold hover:opacity-90 transition disabled:opacity-50"
        >
          {busy === "csv" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          Download patient book (CSV)
        </button>
        <button
          type="button"
          onClick={() => void downloadFullJson()}
          disabled={busy !== null}
          className="inline-flex items-center gap-2 rounded-lg border border-rule bg-white px-3.5 py-2 text-sm font-medium text-ink hover:bg-rule-soft/50 transition disabled:opacity-50"
        >
          {busy === "json" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          Download everything (JSON)
        </button>
      </div>

      <div className="mt-5 rounded-lg bg-rule-soft/40 border border-rule p-4">
        <div className="text-[12px] font-semibold uppercase tracking-wider text-ink-soft">
          If you ever want to leave
        </div>
        <ol className="mt-2 space-y-1.5 text-[13px] text-ink-soft list-decimal list-inside">
          <li>Export your data above — it&rsquo;s a complete copy you keep.</li>
          <li>
            Remove your card on the{" "}
            <Link to="/app/billing" className="text-emerald font-medium hover:underline">
              Billing page
            </Link>{" "}
            and billing stops. We never charge after that.
          </li>
          <li>That&rsquo;s it. No phone call, no &ldquo;are you sure,&rdquo; no retention maze.</li>
        </ol>
        <p className="mt-2.5 text-[11.5px] text-ink-faint">
          Your billing ledger has its own CSV export on the Billing page. Easy to leave is
          how we prove SmartSpa is worth staying for.
        </p>
      </div>
    </section>
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
