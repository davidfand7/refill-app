/**
 * /onboard — Refill 5-step onboarding wizard (Phase 1.1 scaffold, v384).
 *
 * Front door for new Refill spas after /scan. Each step matches the
 * locked architecture (Desktop/Refill-Standalone-Architecture.html §5):
 *
 *   1. Welcome — anchored on /scan result
 *   2. Connect your scheduler (Acuity OAuth — v384.2)
 *   3. Import your patients (auto-detect or CSV — v384.3)
 *   4. Choose delivery channel (Proxy default, Direct advanced)
 *   5. Pick your spa's URL slug + meet your appointments (v384.4)
 *
 * Phase 1.1 ships the SHELL only: routing, step state in URL, step
 * navigation, locked Refill aesthetic. Data wiring per step lands in
 * v384.2 → v384.6 (Acuity, patient import, slug claim, /scan handoff,
 * tool-tip pass).
 *
 * Refill host gated — if a visitor lands here on agentiport.com they
 * get redirected to /scan (the agentiport-side equivalent front door).
 * Per arch doc §4 the wizard never appears on the platform shell; it
 * is the standalone-product experience.
 *
 * Layout deliberately bespoke (not VerticalShell): centered card on
 * paper bg with the Refill wordmark above, no nav rail. Per arch doc
 * §11.1 default aesthetic — emerald accent, paper background, Georgia
 * serif headlines.
 */

import { createFileRoute, Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Mail, X } from "lucide-react";

import { useAuth } from "@/lib/auth";
import { useShell } from "@/lib/shell";
import { cookieDomainFor } from "@/lib/product-context";
import { welcomeWithFallback } from "@/lib/refill-voice";
import {
  getScanLeadForWizard,
  type ScanLeadForWizard,
} from "@/server/scan.functions";
import {
  claimLeadByToken,
  requestMagicLink,
} from "@/server/refill-auth";
import {
  checkSlugAvailable,
  claimSlug,
  getMyTenant,
  type MyTenant,
  type SlugUnavailableReason,
} from "@/server/refill-tenants";
import {
  acceptRecruitInvite,
  getRecruitInvitePreview,
} from "@/server/rep-platform";
import {
  getSchedulerConnection,
  importAcuityClients,
  initiateAcuityOAuth,
  type ImportAcuityClientsResult,
  type SchedulerConnection,
} from "@/server/emma-scheduler.functions";
import { ingestClientListCsv } from "@/server/patient-ingest.functions";
import { Upload } from "lucide-react";

type StepNum = 1 | 2 | 3 | 4 | 5;

interface WizardSearch {
  step: StepNum;
  lead: string | undefined;
  /**
   * Alternate lookup key for Step 1 hydration — accepts the
   * `followup_report_token` value from the /report/<token> link in the
   * Refill follow-up email. Lets users deep-link the wizard from their
   * inbox without first resolving the lead UUID.
   */
  token: string | undefined;
  /**
   * Referral token from /onboard?ref=<token>. Captured on mount into
   * sessionStorage so the magic-link auth redirect doesn't strand it.
   * Consumed at Step-5 claim time and attached to claimSlug payload.
   */
  ref: string | undefined;
  /**
   * v408 — rep-recruit engagement event id from /r/<slug>?e=<eid>.
   * Captured on mount into a cookie so it survives the magic-link round
   * trip. Step 1 detects the cookie, swaps the welcome card for the
   * "Become a sub-rep under [Recruiter]" surface, and acceptRecruitInvite
   * consumes it on click.
   */
  e: string | undefined;
  /**
   * v415.2 — Acuity OAuth round-trip result. Set by the OAuth callback
   * (`/api/integrations/acuity/oauth-callback`) on return; Step 2 reads
   * it post-mount to show a success toast and auto-advance. Value is
   * always "acuity" today (only supported platform); kept as a free
   * string for future Mindbody/JaneApp/Square/Boulevard support.
   */
  scheduler_connected: string | undefined;
  /**
   * v415.2 — OAuth failure code from the callback. Format:
   * "acuity:access_denied" for OAuth-level rejects, or one of the
   * callback's internal failure codes (invalid_state, token_exchange,
   * me_failed, connection_save, webhook_setup, backfill). Step 2 shows
   * a friendly error and keeps the user on Step 2 so they can retry.
   */
  scheduler_error: string | undefined;
  /**
   * v1.3 — patient-import source on Step 3. "acuity" (default) auto-pulls
   * from the connection Step 2 just made; "csv" gates a client-list-CSV
   * drop zone for spas not on a supported OAuth scheduler. Selected on
   * Step 2 via the secondary "Upload a CSV instead" link, which navigates
   * to /onboard?step=3&source=csv and skips Acuity OAuth entirely.
   */
  source: "acuity" | "csv" | undefined;
}

const REFERRAL_COOKIE_KEY = "refill_ref";
const REFERRAL_COOKIE_MAX_AGE = 60 * 60 * 24 * 7; // 7 days
// v408: separate cookie so recruit acceptance and spa-slug claim don't
// stomp on each other. A recipient could legitimately have BOTH (clicked
// a peer-rep recruit invite AND followed a spa-claim link later).
const RECRUIT_COOKIE_KEY = "refill_recruit_event";

// Cookie-backed (not sessionStorage) so the token survives the magic-link
// round trip across subdomains: the wizard lands on getrefill.app, the auth
// redirect lands on app.getrefill.app, sessionStorage is per-origin and would
// be lost. A cookie scoped to .getrefill.app spans both. For localhost dev,
// cookieDomainFor returns "" and the cookie is host-scoped — same tab so it
// still survives.

function readStoredReferral(): string | null {
  if (typeof document === "undefined") return null;
  const target = REFERRAL_COOKIE_KEY + "=";
  for (const c of document.cookie.split(";")) {
    const t = c.trim();
    if (t.startsWith(target)) {
      try {
        return decodeURIComponent(t.slice(target.length)) || null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function writeStoredReferral(token: string): void {
  if (typeof document === "undefined") return;
  const domainAttr = cookieDomainFor(window.location.hostname);
  const parts = [
    REFERRAL_COOKIE_KEY + "=" + encodeURIComponent(token),
    "Path=/",
    "Max-Age=" + REFERRAL_COOKIE_MAX_AGE,
    "SameSite=Lax",
  ];
  if (domainAttr) parts.push("Domain=" + domainAttr);
  if (window.location.protocol === "https:") parts.push("Secure");
  document.cookie = parts.join("; ");
}

function clearStoredReferral(): void {
  if (typeof document === "undefined") return;
  const domainAttr = cookieDomainFor(window.location.hostname);
  const parts = [
    REFERRAL_COOKIE_KEY + "=",
    "Path=/",
    "Max-Age=0",
    "SameSite=Lax",
  ];
  if (domainAttr) parts.push("Domain=" + domainAttr);
  document.cookie = parts.join("; ");
}

// v408: recruit-event cookie helpers (same shape as referral; separate key
// so the two capabilities coexist without clobbering one another).
function readStoredRecruitEvent(): string | null {
  if (typeof document === "undefined") return null;
  const target = RECRUIT_COOKIE_KEY + "=";
  for (const c of document.cookie.split(";")) {
    const t = c.trim();
    if (t.startsWith(target)) {
      try {
        return decodeURIComponent(t.slice(target.length)) || null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function writeStoredRecruitEvent(eventId: string): void {
  if (typeof document === "undefined") return;
  const domainAttr = cookieDomainFor(window.location.hostname);
  const parts = [
    RECRUIT_COOKIE_KEY + "=" + encodeURIComponent(eventId),
    "Path=/",
    "Max-Age=" + REFERRAL_COOKIE_MAX_AGE,
    "SameSite=Lax",
  ];
  if (domainAttr) parts.push("Domain=" + domainAttr);
  if (window.location.protocol === "https:") parts.push("Secure");
  document.cookie = parts.join("; ");
}

function clearStoredRecruitEvent(): void {
  if (typeof document === "undefined") return;
  const domainAttr = cookieDomainFor(window.location.hostname);
  const parts = [
    RECRUIT_COOKIE_KEY + "=",
    "Path=/",
    "Max-Age=0",
    "SameSite=Lax",
  ];
  if (domainAttr) parts.push("Domain=" + domainAttr);
  document.cookie = parts.join("; ");
}

function isStepNum(n: number): n is StepNum {
  return n >= 1 && n <= 5;
}

export const Route = createFileRoute("/onboard")({
  validateSearch: (raw: Record<string, unknown>): WizardSearch => {
    const rawStep = Number(raw.step);
    const step: StepNum = Number.isFinite(rawStep) && isStepNum(rawStep) ? rawStep : 1;
    const lead = typeof raw.lead === "string" && raw.lead.length > 0 ? raw.lead : undefined;
    const token = typeof raw.token === "string" && raw.token.length > 0 ? raw.token : undefined;
    const ref = typeof raw.ref === "string" && raw.ref.length > 0 ? raw.ref : undefined;
    // v408: recruit-event id is uuid-shaped. Tolerant parse — anything that
    // doesn't fit the shape gets dropped silently (matches the rest of the
    // wizard's permissive search-param convention).
    const e = typeof raw.e === "string" && /^[0-9a-f-]{36}$/i.test(raw.e) ? raw.e : undefined;
    // v415.2: OAuth round-trip result params from the callback redirect.
    // Both tolerated as opaque strings — Step 2 validates internally.
    const scheduler_connected =
      typeof raw.scheduler_connected === "string" && raw.scheduler_connected.length > 0
        ? raw.scheduler_connected
        : undefined;
    const scheduler_error =
      typeof raw.scheduler_error === "string" && raw.scheduler_error.length > 0 && raw.scheduler_error.length <= 200
        ? raw.scheduler_error
        : undefined;
    const source =
      raw.source === "acuity" || raw.source === "csv" ? raw.source : undefined;
    return {
      step,
      lead,
      token,
      ref,
      e,
      scheduler_connected,
      scheduler_error,
      source,
    };
  },
  component: OnboardPage,
});

const STEPS: { num: StepNum; label: string }[] = [
  { num: 1, label: "Welcome" },
  { num: 2, label: "Scheduler" },
  { num: 3, label: "Patients" },
  { num: 4, label: "Delivery" },
  { num: 5, label: "URL" },
];

function OnboardPage() {
  const shell = useShell();
  const navigate = useNavigate({ from: "/onboard" });
  const { step, lead, token, ref, e: recruitEventId } = useSearch({ from: "/onboard" });

  // Stash referral token in sessionStorage on first hit so it survives
  // the magic-link round trip (auth redirect strips ?ref= from the URL).
  // Consumed at Step-5 claim time. First write wins — if a user lands
  // with a new ?ref= we update, but stale-no-ref re-mounts don't clobber.
  useEffect(() => {
    if (ref) writeStoredReferral(ref);
  }, [ref]);

  // v408: same pattern for the recruit-event cookie. The wizard reads it
  // in Step 1 to render the "Become a sub-rep under [Recruiter]" surface.
  useEffect(() => {
    if (recruitEventId) writeStoredRecruitEvent(recruitEventId);
  }, [recruitEventId]);

  // Refill host gate. On agentiport / platform / vertical hosts, redirect
  // visitors to /scan — the wizard is a Refill-only surface per arch doc §4.
  // Effect runs client-side after shell hydration (useShell is SSR-safe but
  // returns "platform" until the bootScript runs); we redirect once shell
  // resolves to a non-refill value.
  useEffect(() => {
    if (shell !== "refill" && shell !== "platform") {
      window.location.replace("/scan");
    }
  }, [shell]);

  const goToStep = (next: StepNum) => {
    void navigate({ search: (prev: WizardSearch) => ({ ...prev, step: next }) });
  };

  const canPrev = step > 1;
  const canNext = step < 5;

  return (
    <div className="min-h-screen flex flex-col" style={{ background: "#fbfaf7", color: "#1c2024" }}>
      <Header />

      <main className="flex-1 flex items-start justify-center px-5 sm:px-8 py-12 sm:py-16">
        <div className="w-full max-w-2xl">
          <StepStrip current={step} />

          <WizardBody
            step={step}
            lead={lead}
            token={token}
            ref={ref}
            canPrev={canPrev}
            canNext={canNext}
            onPrev={() => canPrev && goToStep((step - 1) as StepNum)}
            onNext={() => canNext && goToStep((step + 1) as StepNum)}
          />
        </div>
      </main>
    </div>
  );
}

function Header() {
  return (
    <header
      className="px-5 sm:px-8 py-6 border-b"
      style={{ borderColor: "#e6e2d6" }}
    >
      <div className="max-w-2xl mx-auto flex items-center gap-3">
        <RefillMark />
        <div className="leading-tight">
          <div
            className="text-[15px] font-semibold tracking-tight"
            style={{ color: "#056048", fontFamily: "Georgia, 'Times New Roman', serif" }}
          >
            SmartSpa
          </div>
          <div className="text-[11px]" style={{ color: "#8a9098" }}>
            / the patient-profitability OS
          </div>
        </div>
      </div>
    </header>
  );
}

function RefillMark() {
  return (
    <div
      className="flex h-9 w-9 items-center justify-center rounded-lg"
      style={{ background: "#056048", color: "#fbfaf7" }}
      aria-hidden
    >
      <span
        className="text-[20px] font-semibold leading-none"
        style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}
      >
        S
      </span>
    </div>
  );
}

function StepStrip({ current }: { current: StepNum }) {
  return (
    <nav aria-label="Wizard progress" className="mb-6">
      <ol className="flex items-center gap-2 sm:gap-3 text-[12px]">
        {STEPS.map((s, idx) => {
          const isCurrent = s.num === current;
          const isDone = s.num < current;
          return (
            <li key={s.num} className="flex items-center gap-2 sm:gap-3">
              <div className="flex items-center gap-2">
                <div
                  className="flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold"
                  style={{
                    background: isDone ? "#056048" : isCurrent ? "#056048" : "#efece3",
                    color: isDone || isCurrent ? "#fbfaf7" : "#8a9098",
                  }}
                  aria-current={isCurrent ? "step" : undefined}
                >
                  {isDone ? <Check className="h-3.5 w-3.5" aria-hidden /> : s.num}
                </div>
                <span
                  className={`hidden sm:inline ${isCurrent ? "font-semibold" : ""}`}
                  style={{
                    color: isCurrent ? "#1c2024" : isDone ? "#5a6068" : "#8a9098",
                  }}
                >
                  {s.label}
                </span>
              </div>
              {idx < STEPS.length - 1 && (
                <div className="h-px w-6 sm:w-8" style={{ background: "#e6e2d6" }} aria-hidden />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="rounded-xl border bg-white p-7 sm:p-10 shadow-sm"
      style={{ borderColor: "#e6e2d6" }}
    >
      {children}
    </div>
  );
}

// ── Auth gate (v386 / Phase 1.4) ────────────────────────────────────────────

/**
 * Five-state auth gate driving what the wizard renders before any Step body:
 *
 *   checking      — auth context still loading, or we just fired claim
 *   redirecting   — silent-sign-in action_link returned, browser is following
 *   needsEmail    — show single-field email prompt → magic link
 *   checkInbox    — magic link fired, confirmation screen
 *   ready         — session valid, render the wizard
 *
 * One claim attempt per page load, guarded by a ref so React 18 strict-mode
 * double-effect doesn't double-claim. claimLeadByToken is idempotent server-
 * side via token_consumed_at, but skipping the second call also skips the
 * needless network round-trip.
 */
type AuthGateState =
  | { kind: "checking" }
  | { kind: "redirecting" }
  | { kind: "needsEmail"; maskedEmail: string | null }
  | { kind: "checkInbox"; email: string }
  | { kind: "ready" };

function useAuthGate(token: string | undefined): AuthGateState {
  const { session, loading: authLoading } = useAuth();
  const [state, setState] = useState<AuthGateState>({ kind: "checking" });
  const claimFired = useRef(false);

  useEffect(() => {
    if (authLoading) return;
    if (claimFired.current) return;

    // Token path: ask the server whether this is a first-hit silent-sign-in,
    // a pass-through (session already matches), or a stale-token email-prompt.
    if (token) {
      claimFired.current = true;
      (async () => {
        try {
          const result = await claimLeadByToken({
            data: { token, accessToken: session?.access_token },
          });
          if (result.kind === "redirect") {
            setState({ kind: "redirecting" });
            window.location.href = result.actionLink;
            return;
          }
          if (result.kind === "sessionMatch") {
            setState({ kind: "ready" });
            return;
          }
          if (result.kind === "needsEmailPrompt") {
            setState({ kind: "needsEmail", maskedEmail: result.maskedEmail });
            return;
          }
          // notFound — fall through to cold email prompt
          setState({ kind: "needsEmail", maskedEmail: null });
        } catch {
          setState({ kind: "needsEmail", maskedEmail: null });
        }
      })();
      return;
    }

    // Non-token path: session decides.
    if (session) {
      setState({ kind: "ready" });
    } else {
      setState({ kind: "needsEmail", maskedEmail: null });
    }
  }, [authLoading, session, token]);

  return state;
}

function WizardBody({
  step,
  lead,
  token,
  ref: refToken,
  canPrev,
  canNext,
  onPrev,
  onNext,
}: {
  step: StepNum;
  lead: string | undefined;
  token: string | undefined;
  ref: string | undefined;
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
}) {
  const gate = useAuthGate(token);
  const [sentTo, setSentTo] = useState<string | null>(null);

  // Render the locked-aesthetic Card for every gate state so the user never
  // sees a layout flash mid-flow.
  if (gate.kind === "checking") {
    return (
      <Card>
        <GatePulse label="One sec — checking you in…" />
      </Card>
    );
  }

  if (gate.kind === "redirecting") {
    return (
      <Card>
        <GatePulse label="Signing you in…" />
      </Card>
    );
  }

  if (gate.kind === "needsEmail" || gate.kind === "checkInbox") {
    return (
      <Card>
        <EmailPrompt
          lead={lead}
          refToken={refToken}
          maskedEmail={gate.kind === "needsEmail" ? gate.maskedEmail : null}
          sentTo={sentTo}
          onSent={(email) => setSentTo(email)}
        />
      </Card>
    );
  }

  // Ready — render the wizard normally. Step 5 owns its own Back / Claim
  // buttons because the claim action is wizard-terminal (not a step-bump),
  // so the shared Footer would just be in the way.
  // v415.2: Step 2 ALSO owns its CTA (Connect Acuity button replaces
  // Continue; on success the auto-advance fires onNext from inside Step 2).
  // Hiding Footer keeps the OAuth button as the single visible action and
  // avoids the "user clicks Continue without connecting" trap.
  const hideFooter = step === 2 || step === 5;
  return (
    <>
      <Card>
        <StepBody step={step} lead={lead} token={token} refToken={refToken} onPrev={onPrev} onNext={onNext} />
      </Card>
      {!hideFooter && (
        <Footer
          canPrev={canPrev}
          canNext={canNext}
          onPrev={onPrev}
          onNext={onNext}
          step={step}
        />
      )}
    </>
  );
}

function GatePulse({ label }: { label: string }) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-4 py-10"
      role="status"
      aria-live="polite"
    >
      <div
        className="h-9 w-9 rounded-full animate-pulse"
        style={{ background: "#056048" }}
        aria-hidden
      />
      <div className="text-[14px]" style={{ color: "#5a6068" }}>
        {label}
      </div>
    </div>
  );
}

function EmailPrompt({
  lead,
  refToken: refTokenProp,
  maskedEmail,
  sentTo,
  onSent,
}: {
  lead: string | undefined;
  refToken: string | undefined;
  maskedEmail: string | null;
  sentTo: string | null;
  onSent: (email: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // v415.1: OTP-expired UX fix. When Supabase rejects a clicked magic link
  // it redirects back with the error in the URL fragment, e.g.
  //   #error=access_denied&error_code=otp_expired&error_description=Email+...
  // Without handling, the user lands on the Welcome card again with no
  // indication of what went wrong + has to retype their email from
  // scratch. We:
  //   1. Parse the hash on mount; if any error_code is present, set a
  //      friendly error + scrub the hash via history.replaceState so a
  //      refresh doesn't re-trigger.
  //   2. Pre-fill the email from sessionStorage (written by handle() on
  //      the prior submit) so the user just clicks Send again.
  //   3. Clear the sessionStorage stash on successful re-send.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const hash = window.location.hash;
    if (!hash || !hash.includes("error_code=")) return;
    const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
    const errorCode = params.get("error_code");
    if (!errorCode) return;
    if (errorCode === "otp_expired") {
      setError("Your sign-in link expired — drop your email again and we'll send a fresh one.");
    } else {
      const desc = params.get("error_description");
      setError(
        desc
          ? `Sign-in didn't complete: ${desc.replace(/\+/g, " ")}`
          : "Sign-in didn't complete — please try again.",
      );
    }
    // Recover the last submitted email if we have it.
    try {
      const lastEmail = sessionStorage.getItem("refill_onboard_last_email");
      if (lastEmail) setEmail(lastEmail);
    } catch {
      /* sessionStorage unavailable; user retypes */
    }
    // Scrub the hash so a refresh starts clean.
    try {
      window.history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search,
      );
    } catch {
      /* non-fatal */
    }
  }, []);

  // ── Already sent: confirmation screen.
  if (sentTo) {
    return (
      <>
        <StepHeading>Check your inbox.</StepHeading>
        <StepLede>
          We sent a sign-in link to{" "}
          <strong style={{ color: "#1c2024" }}>{sentTo}</strong>. Tap it to
          continue setting up Refill — you can keep this tab open or close it.
        </StepLede>
        <p className="text-[13px] mt-4" style={{ color: "#8a9098" }}>
          Didn't see it? Check spam, or wait a minute and we'll re-send.
        </p>
      </>
    );
  }

  const handle = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const normalized = email.trim().toLowerCase();
      // Prefer URL prop (always present if user landed via ?ref=) over cookie
      // fallback (cookie write can fail silently in incognito or with strict
      // browser settings). URL is the source of truth at this stage.
      const refToken = refTokenProp ?? readStoredReferral() ?? undefined;
      // v415.1: stash the submitted email so the OTP-expired re-render can
      // pre-fill it. Clear on successful send so a future error from a
      // different attempt doesn't restore a stale value.
      try {
        sessionStorage.setItem("refill_onboard_last_email", normalized);
      } catch {
        /* sessionStorage unavailable; pre-fill just won't work */
      }
      await requestMagicLink({ data: { email: normalized, leadId: lead, refToken } });
      try {
        sessionStorage.removeItem("refill_onboard_last_email");
      } catch {
        /* non-fatal */
      }
      onSent(normalized);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Couldn't send the sign-in link — try again in a moment.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handle}>
      <StepHeading>Let's get you signed in.</StepHeading>
      {maskedEmail ? (
        <StepLede>
          We'll send a sign-in link to{" "}
          <strong style={{ color: "#1c2024" }}>{maskedEmail}</strong>. Type the
          full email below to confirm.
        </StepLede>
      ) : (
        <StepLede>
          Drop the email address you'd like to use for your spa. We'll email
          you a one-tap sign-in link — no passwords.
        </StepLede>
      )}

      <label className="block mb-4">
        <span className="sr-only">Email address</span>
        <div
          className="flex items-center gap-2 rounded-md border bg-white px-3 py-2.5"
          style={{ borderColor: "#e6e2d6" }}
        >
          <Mail className="h-4 w-4" aria-hidden style={{ color: "#8a9098" }} />
          <input
            type="email"
            required
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@your-spa.com"
            className="flex-1 outline-none text-[15px]"
            style={{ background: "transparent", color: "#1c2024" }}
            autoComplete="email"
            disabled={submitting}
          />
        </div>
      </label>

      {error && (
        <div
          className="mb-4 rounded-md px-3 py-2 text-[13px]"
          style={{ background: "#fdecec", color: "#8a1616" }}
        >
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={submitting || !email}
        className="inline-flex items-center gap-2 rounded-md px-5 py-2.5 text-[14px] font-semibold shadow-sm transition disabled:opacity-50 disabled:cursor-not-allowed"
        style={{ background: "#056048", color: "#fbfaf7" }}
      >
        {submitting ? "Sending…" : "Send my sign-in link"}
        <ArrowRight className="h-4 w-4" aria-hidden />
      </button>

      <p className="text-[12px] mt-4" style={{ color: "#8a9098" }}>
        By continuing you agree to Refill's terms. We never share your email.
      </p>
    </form>
  );
}

function StepHeading({ children }: { children: React.ReactNode }) {
  return (
    <h1
      className="text-[28px] sm:text-[32px] leading-[1.15] font-semibold tracking-tight mb-3"
      style={{ fontFamily: "Georgia, 'Times New Roman', serif", color: "#1c2024" }}
    >
      {children}
    </h1>
  );
}

function StepLede({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[16px] leading-[1.6] mb-4" style={{ color: "#5a6068" }}>
      {children}
    </p>
  );
}

// v415.3: ComingSoon removed — all v384.x "Phase 1.1 ships the scaffold
// only" badges are gone now that v415.1/.2/.3 wired Steps 2/3/4 to real
// flows. Step 1 (Welcome) + Step 5 (URL claim) were always real; the
// scaffold badges only ever appeared on Steps 2/3/4.

// ── Step bodies ─────────────────────────────────────────────────────────────

function StepBody({
  step,
  lead,
  token,
  refToken,
  onPrev,
  onNext,
}: {
  step: StepNum;
  lead: string | undefined;
  token: string | undefined;
  refToken: string | undefined;
  onPrev: () => void;
  onNext: () => void;
}) {
  switch (step) {
    case 1:
      return <Step1Welcome lead={lead} token={token} />;
    case 2:
      // v415.2: onNext drives the auto-advance after successful OAuth.
      return <Step2Scheduler onConnected={onNext} />;
    case 3:
      return <Step3Patients />;
    case 4:
      return <Step4Delivery />;
    case 5:
      return <Step5Slug lead={lead} token={token} refToken={refToken} onPrev={onPrev} />;
  }
}

function Step1Welcome({
  lead,
  token,
}: {
  lead: string | undefined;
  token: string | undefined;
}) {
  // v408: recruit-invite branch. If the recipient came in via /r/<slug>?e=<id>
  // a refill_recruit_event cookie is set; lookup the invite + recruiter name
  // and (if valid) swap the welcome content for the "Become a sub-rep" surface.
  // The recipient can still set up a spa via the dismiss link — falls through
  // to the normal welcome content with the recruit cookie cleared.
  const [recruitEventId, setRecruitEventId] = useState<string | null>(null);
  const [recruitInvite, setRecruitInvite] = useState<{
    valid: boolean;
    alreadyConverted: boolean;
    senderDisplayName: string | null;
  } | null>(null);
  const [recruitDismissed, setRecruitDismissed] = useState(false);

  useEffect(() => {
    const id = readStoredRecruitEvent();
    if (!id) return;
    setRecruitEventId(id);
    let cancelled = false;
    (async () => {
      try {
        const preview = await getRecruitInvitePreview({ data: { eventId: id } });
        if (!cancelled) setRecruitInvite(preview);
      } catch {
        // Fail-soft: treat as invalid, the user just sees the normal welcome.
        if (!cancelled) setRecruitInvite({ valid: false, alreadyConverted: false, senderDisplayName: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // v384.1: when ?lead=<id> is in the URL (deep-linked from a /scan result),
  // fetch the lead row server-side and anchor Step 1 on the user's own
  // dollar number. Falls back to generic copy if leadId missing, fetch
  // fails, or the lead has no math computed (estimated_monthly_*_usd null).
  const [hydrated, setHydrated] = useState<ScanLeadForWizard | null>(null);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "ready" | "missed">(
    lead || token ? "loading" : "idle",
  );

  useEffect(() => {
    if (!lead && !token) return;
    let cancelled = false;
    (async () => {
      try {
        const result = await getScanLeadForWizard({
          data: lead ? { leadId: lead } : { token },
        });
        if (cancelled) return;
        if (result) {
          setHydrated(result);
          setLoadState("ready");
        } else {
          setLoadState("missed");
        }
      } catch {
        if (!cancelled) setLoadState("missed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [lead, token]);

  const showRecruitBranch =
    !recruitDismissed &&
    recruitEventId &&
    recruitInvite?.valid === true &&
    !recruitInvite.alreadyConverted;

  if (showRecruitBranch && recruitInvite?.senderDisplayName) {
    return (
      <RecruitClaimStep
        eventId={recruitEventId!}
        recruiterName={recruitInvite.senderDisplayName}
        onDismiss={() => {
          clearStoredRecruitEvent();
          setRecruitDismissed(true);
        }}
      />
    );
  }

  const hasRealMath = loadState === "ready" && hydrated?.monthlyRecoveryUsd != null;
  const spaName = hydrated?.practiceName?.trim() || "your spa";

  return (
    <>
      {/* v413: name-anchored greeting when hydrated knows the spa name.
          Falls back to plain "Welcome — let's make your scan real." when
          /onboard is hit cold (no lead). Matches RefillHome's greet() shape
          per refill-voice.ts so the cold-marketing → onboard → dashboard arc
          reads as ONE voice. */}
      <StepHeading>
        {welcomeWithFallback(hydrated?.practiceName, "make your scan real")}
      </StepHeading>

      {hasRealMath ? (
        <>
          <StepLede>
            Your free 30-day trial just started. Based on the scan you ran,
            Refill estimates{" "}
            <strong style={{ color: "#056048" }}>
              ~${Math.round(hydrated.monthlyRecoveryUsd!).toLocaleString()}
            </strong>{" "}
            of recoverable no-show revenue per month for {spaName}.
          </StepLede>
          <StepLede>
            Connect your actual calendar in the next step and we'll start
            catching cancellations as they happen.
          </StepLede>
        </>
      ) : (
        <>
          <StepLede>
            Your free 30-day trial just started. Refill catches the
            cancellations your front desk doesn't have time to chase, fills
            the slots automatically, and only bills when we recover real
            money for you.
          </StepLede>
          <StepLede>
            Connect your actual calendar in the next step and we'll start
            catching cancellations as they happen.
          </StepLede>
        </>
      )}
    </>
  );
}

// v408: Recruit-claim surface. Renders inside Step 1 when the user arrived
// via /r/<slug>?e=<id> from a peer-rep recruit email. The CTA fires
// acceptRecruitInvite which inserts a Tier-1 sub-rep affiliation under
// the recruiter + stamps the engagement event as converted. On success we
// clear the cookie and bounce to /app/rep (RepHome). On dismiss we clear
// the cookie and fall through to the normal spa welcome.
function RecruitClaimStep({
  eventId,
  recruiterName,
  onDismiss,
}: {
  eventId: string;
  recruiterName: string;
  onDismiss: () => void;
}) {
  const { session } = useAuth();
  const accessToken = session?.access_token;
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAccept = async () => {
    if (!accessToken || accepting) return;
    setAccepting(true);
    setError(null);
    try {
      const result = await acceptRecruitInvite({
        data: { accessToken, eventId },
      });
      // Successful accept (or already-converted) consumed the invite; clear
      // the cookie so a refresh doesn't keep re-rendering this surface.
      clearStoredRecruitEvent();
      if (result.converted || result.alreadyConverted) {
        // Land on the rep dashboard. window.location (not navigate) so the
        // shell-context flips cleanly to RepShell on the next paint.
        window.location.href = "/app/rep";
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Couldn't accept the invite — try again in a moment.",
      );
    } finally {
      setAccepting(false);
    }
  };

  return (
    <>
      <div
        className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 mb-4 text-[11px] font-semibold uppercase tracking-wider"
        style={{ background: "#e8f3ed", color: "#056048" }}
      >
        Rep invite
      </div>
      <StepHeading>
        {recruiterName} invited you onto Refill.
      </StepHeading>
      <StepLede>
        Refill pays 3% direct commission, lifetime, on every dollar of
        recovered revenue from spas you introduce. {recruiterName} clips a 1%
        cascade on what your spas recover — that comes out of the 8% Refill
        keeps, not your 3%.
      </StepLede>
      <StepLede>
        Accept the invite to set up your rep account and get your own
        referral link. You can also{" "}
        <button
          type="button"
          onClick={onDismiss}
          className="underline transition hover:opacity-80"
          style={{ color: "#5a6068" }}
        >
          set up a spa instead
        </button>
        {" "}— different flow, different page.
      </StepLede>

      {error && (
        <div
          className="mt-4 rounded-md px-3 py-2 text-[13px]"
          style={{ background: "#fdecec", color: "#8a1616" }}
        >
          {error}
        </div>
      )}

      <button
        type="button"
        onClick={handleAccept}
        disabled={accepting || !accessToken}
        className="mt-6 inline-flex items-center gap-2 rounded-md px-5 py-2.5 text-[14px] font-semibold shadow-sm transition disabled:opacity-50 disabled:cursor-not-allowed"
        style={{ background: "#056048", color: "#fbfaf7" }}
      >
        {accepting ? "Setting up your rep account…" : `Accept invite from ${recruiterName}`}
        <ArrowRight className="h-4 w-4" aria-hidden />
      </button>

      <p className="text-[12px] mt-4" style={{ color: "#8a9098" }}>
        No quota, no exclusivity, no W-2. 1099 referral commission paid
        through Stripe Connect.
      </p>
    </>
  );
}

// v415.2: Step 2 Scheduler — real Acuity OAuth wiring. Replaces the
// v384.2 static-scaffold version. State machine:
//   loading        → checking existing emma_scheduler_connections row
//   connected      → already connected (re-run wizard / Back from Step 3);
//                    show success badge + auto-advance after 1.5s beat
//   needs-connect  → no connection; show Connect Acuity button. Optional
//                    previousError if user returned from a failed OAuth.
//   connecting     → user clicked Connect; redirect URL fetched; about
//                    to top-nav to Acuity authorize page.
//   error          → unrecoverable (session lost / server config missing).
//
// returnTo is "/onboard?step=2" (NOT step=3) so both success AND error
// land back here. Success triggers the auto-advance via onConnected;
// errors render in-place with retry.
//
// Owns its own Back button + CTA — WizardBody hides the shared Footer
// for Step 2 (same pattern as Step 5's wizard-terminal layout).
type Step2State =
  | { kind: "loading" }
  | { kind: "needs-connect"; previousError: string | null }
  | { kind: "connecting" }
  | { kind: "connected"; connection: SchedulerConnection }
  | { kind: "error"; message: string };

function friendlySchedulerError(code: string): string {
  if (code.startsWith("acuity:access_denied")) {
    return "You declined the Acuity connection. Try again when you're ready — Refill needs read access to your calendar to catch cancellations.";
  }
  if (code.startsWith("acuity:")) {
    return `Acuity rejected the connection (${code.replace(/^acuity:/, "")}). Try again, or contact us if this keeps happening.`;
  }
  if (code === "invalid_state" || code === "missing_params") {
    return "The connection round-trip didn't complete cleanly. Try again — this usually works on the second try.";
  }
  if (code === "token_exchange" || code === "me_failed") {
    return "Acuity accepted your sign-in but we couldn't read back your account. Try again, or contact us if this keeps happening.";
  }
  if (code === "connection_save" || code === "webhook_setup" || code === "backfill") {
    return "Your Acuity connection was approved but we hit a hiccup saving it. Try again — your previous attempt won't conflict.";
  }
  if (code === "server_config") {
    return "Refill's Acuity integration is misconfigured on our side. Please contact us — we'll fix it and circle back.";
  }
  return `Connection didn't complete: ${code}`;
}

function Step2Scheduler({ onConnected }: { onConnected: () => void }) {
  const { session } = useAuth();
  const search = useSearch({ from: "/onboard" });
  const navigate = useNavigate({ from: "/onboard" });
  const [state, setState] = useState<Step2State>({ kind: "loading" });

  // Mount: check existing connection + reconcile callback params.
  useEffect(() => {
    let cancelled = false;
    const accessToken = session?.access_token;
    if (!accessToken) {
      // Defensive — auth gate should have caught this before Step 2 renders.
      setState({ kind: "error", message: "Sign-in lost — refresh and try again." });
      return;
    }

    void (async () => {
      try {
        const connection = await getSchedulerConnection({ data: { accessToken } });
        if (cancelled) return;

        // Clear any callback params from the URL once consumed so a refresh
        // doesn't re-trigger toasts or auto-advance. Both consumed below.
        const hadConnected = !!search.scheduler_connected;
        const hadError = !!search.scheduler_error;
        if (hadConnected || hadError) {
          void navigate({
            search: (prev) => ({
              ...prev,
              scheduler_connected: undefined,
              scheduler_error: undefined,
            }),
            replace: true,
          });
        }

        if (connection && connection.status === "connected") {
          setState({ kind: "connected", connection });
          // Auto-advance to Step 3 after a beat so user sees the success
          // state register before the wizard moves on. 1500ms matches the
          // SSR-flash failsafe in worker.ts (familiar feel).
          const t = setTimeout(() => {
            if (!cancelled) onConnected();
          }, 1500);
          return () => clearTimeout(t);
        }

        // No active connection. Show Connect button + surface previous
        // error if the user just bounced back from a failed callback.
        setState({
          kind: "needs-connect",
          previousError: hadError && search.scheduler_error
            ? friendlySchedulerError(search.scheduler_error)
            : null,
        });
      } catch (err) {
        if (!cancelled) {
          setState({
            kind: "error",
            message:
              err instanceof Error
                ? err.message
                : "Couldn't check your scheduler connection.",
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.access_token]);

  const handleConnect = async () => {
    const accessToken = session?.access_token;
    if (!accessToken) {
      setState({ kind: "error", message: "Sign-in lost — refresh and try again." });
      return;
    }
    setState({ kind: "connecting" });
    try {
      const { redirectUrl } = await initiateAcuityOAuth({
        data: {
          accessToken,
          origin: window.location.origin,
          returnTo: "/onboard?step=2",
        },
      });
      // Top-level navigation crosses origins (we go to acuityscheduling.com).
      window.location.href = redirectUrl;
    } catch (err) {
      setState({
        kind: "needs-connect",
        previousError:
          err instanceof Error
            ? `Couldn't start the connection: ${err.message}`
            : "Couldn't start the connection. Try again.",
      });
    }
  };

  // ── Render branches ──────────────────────────────────────────────────────

  if (state.kind === "loading") {
    return <GatePulse label="Checking your scheduler…" />;
  }

  if (state.kind === "error") {
    return (
      <>
        <StepHeading>Hmm — something's off.</StepHeading>
        <StepLede>{state.message}</StepLede>
      </>
    );
  }

  if (state.kind === "connecting") {
    return <GatePulse label="Sending you to Acuity to approve…" />;
  }

  if (state.kind === "connected") {
    const acct = state.connection.platformAccountEmail ?? "your Acuity account";
    return (
      <>
        <StepHeading>Acuity is connected.</StepHeading>
        <StepLede>
          Linked to <strong style={{ color: "#1c2024" }}>{acct}</strong>. Jumping
          to the next step…
        </StepLede>
        <div className="mt-2 flex items-center gap-2 text-[14px]" style={{ color: "#056048" }}>
          <Check className="h-4 w-4" aria-hidden />
          <span>Refill is now watching your calendar for cancellations.</span>
        </div>
      </>
    );
  }

  // needs-connect
  return (
    <>
      <StepHeading>Connect your scheduler.</StepHeading>
      <StepLede>
        One tap, OAuth handles the rest — no API keys, no webhook URLs, no port numbers.
      </StepLede>

      {state.previousError && (
        <div
          className="mt-4 mb-4 rounded-md px-3 py-2 text-[13px]"
          style={{ background: "#fdecec", color: "#8a1616" }}
        >
          {state.previousError}
        </div>
      )}

      <button
        type="button"
        onClick={handleConnect}
        className="mt-2 inline-flex items-center gap-2 rounded-md px-5 py-2.5 text-[14px] font-semibold shadow-sm transition hover:opacity-95"
        style={{ background: "#056048", color: "#fbfaf7" }}
      >
        Connect Acuity
        <ArrowRight className="h-4 w-4" aria-hidden />
      </button>

      <p className="text-[12px] mt-4" style={{ color: "#8a9098" }}>
        Coming soon: Mindbody, JaneApp, Square, Boulevard. On one of those? You
        can still onboard today &mdash; just upload your client list as a CSV.
      </p>

      <button
        type="button"
        onClick={() =>
          void navigate({
            search: (prev) => ({
              ...prev,
              step: 3,
              source: "csv",
            }),
            replace: false,
          })
        }
        className="mt-2 inline-flex items-center gap-1.5 text-[13px] font-medium underline-offset-4 hover:underline"
        style={{ color: "#056048" }}
      >
        Upload a client list CSV instead <ArrowRight className="h-3 w-3" />
      </button>
    </>
  );
}

// v415.3: Step 3 Patients — real Acuity auto-pull. Replaces the v384.3
// static scaffold. On mount, if the user has a connected Acuity
// connection (which Step 2 just ensured), call importAcuityClients to
// pull the roster + upsert via the existing patient-ingest pipeline.
// State machine:
//   importing → spinner + elapsed-time hint
//   imported  → "Imported N patients" + check icon (Continue from Footer
//               advances the user when ready; no auto-advance — let the
//               user see the milestone)
//   empty     → Acuity has 0 clients; show "first cancellation will
//               catch the name" reassurance + Continue still works
//   no-conn   → defensive (Step 2 should have ensured connection); show
//               friendly "Connect Acuity first" message
//   error     → import failed; show retry
//
// Footer's Continue button stays visible and enabled throughout so the
// user can always advance even mid-import — the upsert is idempotent and
// will complete server-side regardless of whether the user waits.
type Step3State =
  | { kind: "importing"; startedAt: number }
  | { kind: "imported"; imported: number; total: number; receipt: ImportAcuityClientsResult & { kind: "imported" } }
  | { kind: "empty" }
  | { kind: "no-connection" }
  | { kind: "error"; message: string };

// v1.3 — Step 3 dispatcher. Branches on the `source` search param (set by
// Step 2's "Upload a CSV instead" link). Thin and hook-stable so the
// rules-of-hooks contract isn't violated by the conditional path.
function Step3Patients() {
  const { source } = useSearch({ from: "/onboard" });
  if (source === "csv") return <Step3PatientsCsv />;
  return <Step3PatientsAcuity />;
}

function Step3PatientsAcuity() {
  const { session } = useAuth();
  const [state, setState] = useState<Step3State>(() => ({
    kind: "importing",
    startedAt: Date.now(),
  }));

  const runImport = (accessToken: string) => {
    const startedAt = Date.now();
    setState({ kind: "importing", startedAt });
    let cancelled = false;
    void importAcuityClients({ data: { accessToken } })
      .then((result) => {
        if (cancelled) return;
        if (result.kind === "no-connection") {
          setState({ kind: "no-connection" });
        } else if (result.kind === "empty") {
          setState({ kind: "empty" });
        } else {
          setState({
            kind: "imported",
            imported:
              result.receipt.candidatesCreated +
              result.receipt.exactMatches,
            total: result.rawCount,
            receipt: result,
          });
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setState({
          kind: "error",
          message:
            err instanceof Error
              ? err.message
              : "Couldn't pull your patient roster.",
        });
      });
    return () => {
      cancelled = true;
    };
  };

  useEffect(() => {
    const accessToken = session?.access_token;
    if (!accessToken) {
      setState({ kind: "no-connection" });
      return;
    }
    return runImport(accessToken);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.access_token]);

  // ── Render branches ──────────────────────────────────────────────────────

  if (state.kind === "importing") {
    return (
      <>
        <StepHeading>Importing your patients.</StepHeading>
        <StepLede>
          Pulling your client roster from Acuity. This usually takes 5-10
          seconds; larger spas can take 20-30.
        </StepLede>
        <div
          className="mt-4 flex items-center gap-3 text-[14px]"
          style={{ color: "#5a6068" }}
        >
          <div
            className="h-3 w-3 rounded-full animate-pulse"
            style={{ background: "#056048" }}
            aria-hidden
          />
          <span>Reading your Acuity clients…</span>
        </div>
        <p className="text-[12px] mt-4" style={{ color: "#8a9098" }}>
          Doing this now (rather than first-cancel later) means your very first
          rescue offer lands fully named — never <em>(no name)</em>.
        </p>
      </>
    );
  }

  if (state.kind === "imported") {
    const sameAsTotal = state.imported === state.total;
    return (
      <>
        <StepHeading>
          Imported {state.total.toLocaleString()} patient
          {state.total === 1 ? "" : "s"}.
        </StepHeading>
        <StepLede>
          Your roster is loaded. Every cancellation Refill catches will land
          with the right patient name attached — never <em>(no name)</em>.
        </StepLede>
        <div
          className="mt-3 flex items-center gap-2 text-[14px]"
          style={{ color: "#056048" }}
        >
          <Check className="h-4 w-4" aria-hidden />
          <span>
            {sameAsTotal
              ? "All clients matched on first pass."
              : `${state.imported.toLocaleString()} new + ${(state.total - state.imported).toLocaleString()} already on file.`}
          </span>
        </div>
      </>
    );
  }

  if (state.kind === "empty") {
    return (
      <>
        <StepHeading>No clients in Acuity yet.</StepHeading>
        <StepLede>
          Your Acuity is connected but doesn't have any client records yet —
          totally fine. Refill catches patient names from the first
          appointment instead, so your very first rescue offer will still
          land fully named.
        </StepLede>
        <p className="text-[12px] mt-3" style={{ color: "#8a9098" }}>
          You can add patients later from Settings if you'd rather pre-load.
        </p>
      </>
    );
  }

  if (state.kind === "no-connection") {
    return (
      <>
        <StepHeading>Hmm — no Acuity connection.</StepHeading>
        <StepLede>
          Looks like the Acuity connection didn't stick. Hit Back to redo
          Step 2 — should only take a moment.
        </StepLede>
      </>
    );
  }

  // error
  return (
    <>
      <StepHeading>Couldn't pull your patients.</StepHeading>
      <StepLede>{state.message}</StepLede>
      <button
        type="button"
        onClick={() => {
          const accessToken = session?.access_token;
          if (accessToken) runImport(accessToken);
        }}
        className="mt-4 inline-flex items-center gap-2 rounded-md px-4 py-2 text-[13px] font-semibold transition hover:opacity-95"
        style={{ background: "#056048", color: "#fbfaf7" }}
      >
        Try again
        <ArrowRight className="h-4 w-4" aria-hidden />
      </button>
      <p className="text-[12px] mt-3" style={{ color: "#8a9098" }}>
        Or hit Continue to skip for now — Refill will catch patient names from
        the first appointment instead.
      </p>
    </>
  );
}

// v1.3: Step 3 CSV fallback for spas not on Acuity (or on a supported OAuth
// scheduler the user opted to skip from Step 2). Drop a client-list CSV →
// client-side reads text → POST raw CSV string to ingestClientListCsv (server)
// which parses + upserts patient knowledge_nodes via the same pipeline
// app.refill.patients.contacts.tsx uses. Continue advances to Step 4 same as
// the Acuity branch — the wizard doesn't care which path got us patients.
type Step3CsvState =
  | { kind: "awaiting" }
  | { kind: "ingesting"; fileName: string }
  | { kind: "imported"; patientsEnriched: number; fileName: string }
  | { kind: "error"; message: string };

function Step3PatientsCsv() {
  const { session } = useAuth();
  const [state, setState] = useState<Step3CsvState>({ kind: "awaiting" });
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  async function handleFile(f: File) {
    if (!/\.csv$/i.test(f.name)) {
      setState({
        kind: "error",
        message: "That doesn't look like a CSV file. Try again with a .csv export.",
      });
      return;
    }
    const accessToken = session?.access_token;
    if (!accessToken) {
      setState({
        kind: "error",
        message: "Sign-in lost — refresh and try again.",
      });
      return;
    }
    setState({ kind: "ingesting", fileName: f.name });
    try {
      const text = await f.text();
      const r = await ingestClientListCsv({
        data: { accessToken, csv: text, sourceFilename: f.name },
      });
      setState({
        kind: "imported",
        patientsEnriched: r.patientsEnriched,
        fileName: f.name,
      });
    } catch (err) {
      setState({
        kind: "error",
        message:
          err instanceof Error
            ? err.message
            : "Couldn't read that file. Make sure it's a client list export from your scheduler.",
      });
    }
  }

  // ── Render branches ──────────────────────────────────────────────────────

  if (state.kind === "ingesting") {
    return (
      <>
        <StepHeading>Reading your client list…</StepHeading>
        <StepLede>
          Parsing <strong style={{ color: "#1c2024" }}>{state.fileName}</strong>{" "}
          and upserting your patient roster. Usually 5-15 seconds.
        </StepLede>
        <div
          className="mt-4 flex items-center gap-3 text-[14px]"
          style={{ color: "#5a6068" }}
        >
          <div
            className="h-3 w-3 rounded-full animate-pulse"
            style={{ background: "#056048" }}
            aria-hidden
          />
          <span>Importing…</span>
        </div>
      </>
    );
  }

  if (state.kind === "imported") {
    return (
      <>
        <StepHeading>
          Imported {state.patientsEnriched.toLocaleString()} patient
          {state.patientsEnriched === 1 ? "" : "s"}.
        </StepHeading>
        <StepLede>
          Your roster is loaded from{" "}
          <strong style={{ color: "#1c2024" }}>{state.fileName}</strong>. Every
          cancellation Refill catches will land with the right patient name
          attached — never <em>(no name)</em>.
        </StepLede>
        <div
          className="mt-3 flex items-center gap-2 text-[14px]"
          style={{ color: "#056048" }}
        >
          <Check className="h-4 w-4" aria-hidden />
          <span>Ready for delivery setup.</span>
        </div>
      </>
    );
  }

  if (state.kind === "error") {
    return (
      <>
        <StepHeading>Hmm — couldn't read that file.</StepHeading>
        <StepLede>{state.message}</StepLede>
        <button
          type="button"
          onClick={() => setState({ kind: "awaiting" })}
          className="mt-4 inline-flex items-center gap-2 rounded-md px-4 py-2 text-[13px] font-semibold transition hover:opacity-95"
          style={{ background: "#056048", color: "#fbfaf7" }}
        >
          Try again
          <ArrowRight className="h-4 w-4" aria-hidden />
        </button>
      </>
    );
  }

  // awaiting
  return (
    <>
      <StepHeading>Upload your client list.</StepHeading>
      <StepLede>
        Export a client list CSV from your scheduler (most have it under
        Reports → Clients). First name, last name, email, and phone are
        all we need.
      </StepLede>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f) void handleFile(f);
        }}
        onClick={() => fileInputRef.current?.click()}
        className="mt-4 rounded-2xl border-2 border-dashed px-6 py-10 text-center cursor-pointer transition"
        style={{
          borderColor: dragOver ? "#056048" : "#d6d2c6",
          background: dragOver ? "#f0f9f4" : "#fbfaf7",
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
          }}
        />
        <div
          className="mx-auto mb-3 h-12 w-12 rounded-full flex items-center justify-center"
          style={{ background: "#e8f3ed" }}
        >
          <Upload className="h-5 w-5" style={{ color: "#056048" }} />
        </div>
        <div className="text-[15px] font-semibold" style={{ color: "#1c2024" }}>
          Drop your client list CSV
        </div>
        <div className="text-[12px] mt-1" style={{ color: "#8a9098" }}>
          or click to browse
        </div>
      </div>

      <p className="text-[12px] mt-4" style={{ color: "#8a9098" }}>
        Don't have a client list export handy? Hit Continue to skip — Refill
        will catch patient names from the first appointment instead.
      </p>
    </>
  );
}

// v415.1: Step 4 Delivery picker. Proxy is the selectable default (per
// [[project_trial_first_no_money_asks]] — trial users should never have
// to commit money / phone porting before they feel the win). Direct is
// displayed-but-disabled with "Available after your first month" copy
// so prospects see the future ceiling without being able to commit to
// the porting workflow during trial. Selection persists to sessionStorage
// so Step 5's claimSlug can include it on tenant creation (tenant
// doesn't exist yet at Step 4 — can't write to a DB row that has no
// primary key).
type DeliveryChannel = "proxy" | "direct";
const DELIVERY_CHANNEL_KEY = "refill_onboard_delivery_channel";

function readStoredDeliveryChannel(): DeliveryChannel | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const v = sessionStorage.getItem(DELIVERY_CHANNEL_KEY);
    if (v === "proxy" || v === "direct") return v;
    return null;
  } catch {
    return null;
  }
}

function writeStoredDeliveryChannel(channel: DeliveryChannel): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(DELIVERY_CHANNEL_KEY, channel);
  } catch {
    /* non-fatal */
  }
}

function clearStoredDeliveryChannel(): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.removeItem(DELIVERY_CHANNEL_KEY);
  } catch {
    /* non-fatal */
  }
}

function Step4Delivery() {
  // Default to proxy (the trial-safe choice). Direct stays disabled in
  // the wizard; the user can flip to it from /app/refill/settings after
  // their trial converts and they've decided phone porting is worth it.
  const [channel, setChannel] = useState<DeliveryChannel>(
    () => readStoredDeliveryChannel() ?? "proxy",
  );

  useEffect(() => {
    writeStoredDeliveryChannel(channel);
  }, [channel]);

  return (
    <>
      <StepHeading>Choose your delivery channel.</StepHeading>
      <StepLede>How should Refill deliver rescue offers to your patients?</StepLede>

      <div className="space-y-3 mb-2">
        <DeliveryOption
          title="Proxy mode"
          tagline="Recommended for month 1"
          body="Refill drafts the message on your Mac. You review and tap send. No carrier setup, no porting, no monthly fees."
          selected={channel === "proxy"}
          onSelect={() => setChannel("proxy")}
        />
        <DeliveryOption
          title="Direct mode"
          tagline="Available post-trial"
          body="Refill sends patients directly via SMS from your spa's own number. Requires phone number porting (~3 weeks). Flip to this from Settings after your trial."
          selected={false}
          disabled
        />
      </div>
    </>
  );
}

function DeliveryOption({
  title,
  tagline,
  body,
  selected,
  disabled,
  onSelect,
}: {
  title: string;
  tagline: string;
  body: string;
  selected: boolean;
  disabled?: boolean;
  onSelect?: () => void;
}) {
  const interactive = !disabled && !!onSelect;
  const borderColor = disabled
    ? "#e6e2d6"
    : selected
      ? "#056048"
      : "#cdd3d8";
  const background = disabled
    ? "#f5f3ee"
    : selected
      ? "#f0f5ef"
      : "transparent";
  const taglineColor = disabled
    ? "#8a9098"
    : selected
      ? "#056048"
      : "#8a9098";
  const titleColor = disabled ? "#5a6068" : "#1c2024";
  const bodyColor = disabled ? "#8a9098" : "#5a6068";

  return (
    <button
      type="button"
      onClick={interactive ? onSelect : undefined}
      disabled={disabled}
      aria-pressed={selected}
      className={
        "w-full text-left rounded-lg border p-4 transition " +
        (interactive
          ? "cursor-pointer hover:opacity-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700"
          : "cursor-not-allowed")
      }
      style={{ borderColor, background }}
    >
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <div
          className="text-[15px] font-semibold flex items-center gap-2"
          style={{ color: titleColor }}
        >
          {selected && (
            <Check className="h-4 w-4" style={{ color: "#056048" }} aria-hidden />
          )}
          {title}
        </div>
        <div
          className="text-[11px] uppercase tracking-wider font-semibold"
          style={{ color: taglineColor }}
        >
          {tagline}
        </div>
      </div>
      <div className="text-[14px] leading-[1.55]" style={{ color: bodyColor }}>
        {body}
      </div>
    </button>
  );
}

// ── Step 5 helpers ──────────────────────────────────────────────────────────

/**
 * Best-effort slug suggestion from a practice name. Drops accents,
 * collapses non-alphanumerics to single hyphens, trims edge hyphens,
 * lowercases, and caps at 30 chars to match the server-side SLUG_MAX.
 * The server re-validates with the same rules so this is purely UX.
 */
function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
}

type SlugStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available" }
  | { kind: "unavailable"; reason: SlugUnavailableReason };

function Step5Slug({
  lead,
  token,
  refToken: refTokenProp,
  onPrev,
}: {
  lead: string | undefined;
  token: string | undefined;
  refToken: string | undefined;
  onPrev: () => void;
}) {
  const { session } = useAuth();
  const accessToken = session?.access_token;

  // ── On-mount: existing-tenant detection + suggested slug hydration.
  const [existingTenant, setExistingTenant] = useState<MyTenant | null>(null);
  const [mountChecked, setMountChecked] = useState(false);
  const [practiceName, setPracticeName] = useState("");
  const [slugInput, setSlugInput] = useState("");
  const userEditedSlug = useRef(false);

  useEffect(() => {
    if (!accessToken) {
      setMountChecked(true);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const result = await getMyTenant({ data: { accessToken } });
        if (cancelled) return;
        if (result.tenant) {
          setExistingTenant(result.tenant);
        }
      } catch {
        // Non-fatal — fall through to letting them claim.
      } finally {
        if (!cancelled) setMountChecked(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  useEffect(() => {
    if (!lead && !token) return;
    let cancelled = false;
    (async () => {
      try {
        const result = await getScanLeadForWizard({
          data: lead ? { leadId: lead } : { token },
        });
        if (cancelled || !result) return;
        const name = result.practiceName?.trim() ?? "";
        if (name) {
          setPracticeName(name);
          if (!userEditedSlug.current) {
            setSlugInput(slugifyName(name));
          }
        }
      } catch {
        // No-op — user can type the name themselves.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [lead, token]);

  // ── Debounced availability check.
  const [status, setStatus] = useState<SlugStatus>({ kind: "idle" });

  useEffect(() => {
    const trimmed = slugInput.trim();
    if (!trimmed) {
      setStatus({ kind: "idle" });
      return;
    }
    setStatus({ kind: "checking" });
    const handle = setTimeout(async () => {
      try {
        const result = await checkSlugAvailable({ data: { slug: trimmed } });
        if (result.available) {
          setStatus({ kind: "available" });
        } else {
          setStatus({ kind: "unavailable", reason: result.reason });
        }
      } catch {
        // Treat as invalid so the user doesn't get a stuck spinner.
        setStatus({ kind: "unavailable", reason: "invalid" });
      }
    }, 300);
    return () => clearTimeout(handle);
  }, [slugInput]);

  // ── Claim flow.
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [claimedTenant, setClaimedTenant] = useState<MyTenant | null>(null);

  const handleClaim = async () => {
    if (!accessToken) {
      setClaimError("Your session expired — refresh and try again.");
      return;
    }
    const name = practiceName.trim();
    const slug = slugInput.trim().toLowerCase();
    if (!name) {
      setClaimError("Add your spa's name first.");
      return;
    }
    if (status.kind !== "available") return;
    setClaiming(true);
    setClaimError(null);
    try {
      // Prefer URL prop over cookie fallback (URL is preserved via step
      // navigation; cookie can fail silently in incognito or with strict
      // browser settings).
      const refToken = refTokenProp ?? readStoredReferral() ?? undefined;
      // v415.1: read the delivery channel stashed by Step 4 (sessionStorage
      // since the tenant didn't exist yet at Step 4 to write to a DB row).
      // Defaults to undefined if Step 4 never ran (e.g. deep-link to Step
      // 5 before the wizard nav gate exists) — the server side defaults
      // to 'proxy' via the column default in that case.
      const deliveryChannel = readStoredDeliveryChannel() ?? undefined;
      const result = await claimSlug({
        data: { slug, name, accessToken, refToken, deliveryChannel },
      });
      if (result.ok) {
        // Successful claim consumed the referral + the delivery-channel
        // stash — clear both so a future tenant the same user might
        // create from a different signup flow doesn't inherit stale state.
        clearStoredReferral();
        clearStoredDeliveryChannel();
        setClaimedTenant({
          id: result.tenant.id,
          slug: result.tenant.slug,
          name: result.tenant.name,
          trialEndsAt: result.tenant.trialEndsAt,
          plan: "trial",
          // v410.1: MyTenant added isDemo — a freshly-claimed real tenant
          // is never a demo persona, so hardcode false here.
          isDemo: false,
        });
      } else if (result.reason === "already_owns") {
        // Race: user opened the wizard twice. Re-fetch and show that state.
        const mine = await getMyTenant({ data: { accessToken } });
        if (mine.tenant) setExistingTenant(mine.tenant);
        else setClaimError("You already have a spa on this account.");
      } else if (result.reason === "taken") {
        setStatus({ kind: "unavailable", reason: "taken" });
        setClaimError("Someone grabbed that one — pick a different URL.");
      } else if (result.reason === "reserved") {
        setStatus({ kind: "unavailable", reason: "reserved" });
        setClaimError("That URL is reserved for the platform.");
      } else {
        setStatus({ kind: "unavailable", reason: "invalid" });
        setClaimError("That URL isn't valid — try lowercase letters, numbers, and hyphens.");
      }
    } catch (err) {
      setClaimError(
        err instanceof Error
          ? err.message
          : "Couldn't lock that in — try again in a moment.",
      );
    } finally {
      setClaiming(false);
    }
  };

  // ── Render: existing-tenant short-circuit ──────────────────────────────
  if (!mountChecked) {
    return <GatePulse label="Checking your spa…" />;
  }
  if (existingTenant || claimedTenant) {
    const t = claimedTenant ?? existingTenant!;
    const isFresh = !!claimedTenant;
    return (
      <>
        <StepHeading>
          {isFresh
            ? `🎉 ${t.slug}.getrefill.app is yours.`
            : `${t.slug}.getrefill.app — your spa.`}
        </StepHeading>
        <StepLede>
          {isFresh
            ? `Refill just provisioned ${t.name}. Patients will see this URL on every rescue link.`
            : `You already claimed this URL for ${t.name}. We'll keep the trial running until ${formatTrialEnd(t.trialEndsAt)}.`}
        </StepLede>
        <StepLede>
          Your dashboard is ready. Karen will follow up by email with anything
          else you need.
        </StepLede>
        {/* v410: terminal CTA dispatches into the Refill standalone shell
            at /app/refill (RefillHome). Closes Pinch #1 — the wizard no longer
            dead-ends with a "close this tab" instruction. */}
        <Link
          to="/app/refill"
          className="mt-4 inline-flex items-center gap-2 rounded-md px-5 py-2.5 text-[14px] font-semibold shadow-sm transition"
          style={{ background: "#056048", color: "#fbfaf7" }}
        >
          Go to your dashboard
          <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
      </>
    );
  }

  // ── Render: claim form ──────────────────────────────────────────────────
  const slugTrimmed = slugInput.trim();
  const canClaim =
    !!practiceName.trim() &&
    slugTrimmed.length >= 3 &&
    status.kind === "available" &&
    !claiming;

  return (
    <>
      <StepHeading>Pick your spa's URL.</StepHeading>
      <StepLede>
        Patients see this URL on every rescue link they tap. We suggest one
        based on your spa's name — adjust if you'd like.
      </StepLede>

      <label className="block mb-4">
        <div
          className="text-[12px] uppercase tracking-wider font-semibold mb-1.5"
          style={{ color: "#8a9098" }}
        >
          Spa name
        </div>
        <input
          type="text"
          value={practiceName}
          onChange={(e) => {
            const next = e.target.value;
            setPracticeName(next);
            if (!userEditedSlug.current) {
              setSlugInput(slugifyName(next));
            }
          }}
          placeholder="Rejuv Skin Spa"
          className="w-full outline-none text-[15px] rounded-md border bg-white px-3 py-2.5"
          style={{ borderColor: "#e6e2d6", color: "#1c2024" }}
        />
      </label>

      <label className="block mb-2">
        <div
          className="text-[12px] uppercase tracking-wider font-semibold mb-1.5"
          style={{ color: "#8a9098" }}
        >
          Your URL
        </div>
        <div
          className="flex items-center gap-2 rounded-md border bg-white px-3 py-2.5"
          style={{ borderColor: "#e6e2d6" }}
        >
          <input
            type="text"
            value={slugInput}
            onChange={(e) => {
              userEditedSlug.current = true;
              setSlugInput(e.target.value.toLowerCase());
            }}
            placeholder="your-spa"
            className="flex-1 outline-none text-[15px] font-mono"
            style={{ background: "transparent", color: "#1c2024" }}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <span className="text-[15px]" style={{ color: "#8a9098" }}>
            .getrefill.app
          </span>
          <SlugStatusIndicator status={status} slug={slugTrimmed} />
        </div>
      </label>

      <SlugStatusLine status={status} />

      {claimError && (
        <div
          className="mt-4 rounded-md px-3 py-2 text-[13px]"
          style={{ background: "#fdecec", color: "#8a1616" }}
        >
          {claimError}
        </div>
      )}

      <div className="mt-6 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={onPrev}
          className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-[14px] font-medium transition"
          style={{ color: "#5a6068" }}
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Back
        </button>
        <button
          type="button"
          onClick={handleClaim}
          disabled={!canClaim}
          className="inline-flex items-center gap-2 rounded-md px-5 py-2.5 text-[14px] font-semibold shadow-sm transition disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ background: "#056048", color: "#fbfaf7" }}
        >
          {claiming ? "Locking in…" : "Lock in this URL"}
          <ArrowRight className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </>
  );
}

function SlugStatusIndicator({
  status,
  slug,
}: {
  status: SlugStatus;
  slug: string;
}) {
  if (!slug) return null;
  if (status.kind === "checking") {
    return (
      <span
        className="inline-block h-3.5 w-3.5 rounded-full animate-pulse"
        style={{ background: "#a8b0b8" }}
        aria-label="Checking availability"
      />
    );
  }
  if (status.kind === "available") {
    return (
      <span
        className="inline-flex h-5 w-5 items-center justify-center rounded-full"
        style={{ background: "#f0f5ef", color: "#056048" }}
        aria-label="Available"
      >
        <Check className="h-3.5 w-3.5" aria-hidden />
      </span>
    );
  }
  if (status.kind === "unavailable") {
    return (
      <span
        className="inline-flex h-5 w-5 items-center justify-center rounded-full"
        style={{ background: "#fdecec", color: "#8a1616" }}
        aria-label="Unavailable"
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </span>
    );
  }
  return null;
}

function SlugStatusLine({ status }: { status: SlugStatus }) {
  if (status.kind === "available") {
    return (
      <p className="text-[13px]" style={{ color: "#056048" }}>
        Available. This is what patients will see.
      </p>
    );
  }
  if (status.kind === "unavailable") {
    const msg =
      status.reason === "taken"
        ? "Already taken — try a variant."
        : status.reason === "reserved"
          ? "Reserved for the platform — pick a different name."
          : "Use 3–30 lowercase letters, numbers, or hyphens. No leading or trailing hyphen.";
    return (
      <p className="text-[13px]" style={{ color: "#8a1616" }}>
        {msg}
      </p>
    );
  }
  if (status.kind === "checking") {
    return (
      <p className="text-[13px]" style={{ color: "#8a9098" }}>
        Checking availability…
      </p>
    );
  }
  return (
    <p className="text-[13px]" style={{ color: "#8a9098" }}>
      Type a few letters to check availability.
    </p>
  );
}

function formatTrialEnd(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return "your trial ends";
  }
}

// ── Footer (Back / Next) ────────────────────────────────────────────────────

function Footer({
  canPrev,
  canNext,
  onPrev,
  onNext,
  step,
}: {
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  step: StepNum;
}) {
  const nextLabel = useMemo(() => {
    if (step === 1) return "Continue";
    if (step === 5) return "Lock in this URL";
    return "Continue";
  }, [step]);

  return (
    <div className="mt-6 flex items-center justify-between gap-3">
      <button
        type="button"
        onClick={onPrev}
        disabled={!canPrev}
        className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-[14px] font-medium transition disabled:opacity-30 disabled:cursor-not-allowed"
        style={{ color: "#5a6068" }}
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        Back
      </button>

      <button
        type="button"
        onClick={onNext}
        disabled={!canNext}
        className="inline-flex items-center gap-2 rounded-md px-5 py-2.5 text-[14px] font-semibold shadow-sm transition disabled:opacity-50 disabled:cursor-not-allowed"
        style={{ background: "#056048", color: "#fbfaf7" }}
      >
        {nextLabel}
        <ArrowRight className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}
