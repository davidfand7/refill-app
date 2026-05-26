/**
 * Rolling product changelog for the version pill (rendered by PageHeader).
 *
 * Fresh start for the cleaved Refill app — openagenticv4's 3,691-line
 * history is not load-bearing here. Append a new entry to the top of
 * CHANGELOG for each Refill ship.
 */

export interface ChangelogEntry {
  version: string;
  date: string;
  items: string[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "v1.4.5",
    date: "May 2026",
    items: [
      "<strong>v1.4.5 &mdash; Patient rescue-claim URL points at getrefill.app (not stale emma.agentiport.com).</strong> The FIRST successful end-to-end Karen Acuity cancel 2026-05-26 1:02 PM MT (the [[project-rejuv-proof-or-nothing]] moment) landed the Resend email correctly in davidfand303@gmail.com — but the embedded patient claim URL hardcoded <code>https://emma.agentiport.com/rescue/claim/&lt;token&gt;</code>, the legacy openagenticv4 host. The actual /rescue/claim/$token route lives on getrefill.app (src/routes/rescue.claim.$token.tsx) post-Refill-cleave. Fix: <code>buildRescueClaimUrl</code> now reads <code>process.env.REFILL_PUBLIC_ORIGIN</code> with a getrefill.app fallback, matching the established pattern in src/server/rep-platform.ts.",
    ],
  },
  {
    version: "v1.4.4",
    date: "May 2026",
    items: [
      "<strong>v1.4.4 &mdash; Lazy fromNumber check (unblock proxy-email-only rescue mode).</strong> Karen's second live cancel after v1.4.3 surfaced one more chain break: the rescue dispatcher's upfront <code>if (!fromNumber)</code> bail fired regardless of delivery path, marking the rescue attempt closed_unfilled with notes 'Spa has no provisioned SMS number.' But per [[project-carriers-mothballed]] Twilio is OFF — patient outreach happens via iMessage MCP through Karen's machine, with the spa-owner getting a consolidated proxy email from Resend (the email carries patient claim URLs Karen forwards). Karen's setup is proxy-email-only (rescue_proxy_email set, rescue_proxy_phone null) — which doesn't need a fromNumber at all. The fix makes the check path-aware: <code>willNeedFromNumber = !isProxyMode || !!proxyPhone</code>. Pure proxy-email-only spas (= Karen, = every Refill spa post-carrier-mothball) now flow through cleanly; spas configured for proxy-SMS or direct-mode still get the structural guard. Net: the dispatcher's THIRD pre-INSERT early-return path needed a fix to match the post-mothball architecture.",
    ],
  },
  {
    version: "v1.4.3",
    date: "May 2026",
    items: [
      "<strong>v1.4.3 &mdash; Acuity timezone-parsing fix (caught by Karen's first live cancel).</strong> The Acuity &rarr; emma_appointments ingest path had a long-latent timezone bug: both <code>acuityAppointmentToRow</code> (server fn) and <code>acuityAppointmentToInsert</code> (webhook receiver) parsed Acuity&rsquo;s timezone-aware datetime with <code>.replace(/[+-]\\d{4}$/, &quot;Z&quot;)</code> &mdash; a regex that stripped the TZ offset WITHOUT applying it. So &ldquo;2026-05-26T16:00:00-0600&rdquo; (4 PM MT, the spa's local) became &ldquo;2026-05-26T16:00:00Z&rdquo; (4 PM UTC = 10 AM MT), shifting every appointment time 6 hours too early for an MT spa. Karen's first live cancel exposed it: she booked the test for 4 PM MT, cancelled at 12:18 PM MT &mdash; the dispatcher correctly skipped because the (corrupted) scheduled_at said the slot was already 2.5 hours past, when it was actually still 3.5 hours future. Fix: replaced regex with <code>new Date(apt.datetime).toISOString()</code>, which JavaScript's Date constructor handles correctly for every Acuity datetime shape (with or without colon in offset, Z-suffix, etc.). Implications well beyond the dispatcher: Karen&rsquo;s 61-appointment backfill ALL had wrong scheduled_at values; every recovery dashboard time, every preshow reminder, every QBO reconciliation window calculation was 6 hours off. Backfill remediation: Karen clicks &ldquo;Re-sync now&rdquo; on Settings/Scheduler post-deploy &mdash; the upsert overwrites every existing row with corrected UTC. Pinning the lesson per [[feedback-no-blame-no-glide]]: I missed the regex during the original scout because &ldquo;.replace timezone with Z&rdquo; LOOKED correct without thinking through that it's a string-substitution, not a time-zone math operation. Real-data testing > extensive code review; this is exactly what [[project-rejuv-proof-or-nothing]] was designed to surface.",
    ],
  },
  {
    version: "v1.4.2",
    date: "May 2026",
    items: [
      "<strong>v1.4.2 &mdash; Centering sweep (the bug v1.4.1 exposed).</strong> Karen-walk on the v1.4.1 re-skin caught Recovery + Billing rendering their headers and body content left-anchored under the centered chip nav &mdash; a jarring visual inconsistency. Root cause: a pre-existing pattern across 7 refill routes where the page body wrapper used <code>max-w-Xxl px-6 lg:px-10</code> without <code>mx-auto</code>, so the content left-anchored to the screen edge while the chrome (chip nav, top-right strip) centered. The old sticky/backdrop chrome bar masked this; the v1.4.1 re-skin removed the bar and surfaced it. Class-of-bug audit + sweep: added <code>w-full mx-auto</code> to 7 routes (recovery, billing, appointments, reports, rescue, settings/noshow, settings/sender). Inbox + settings/scheduler already had it &mdash; pattern was inconsistent across the codebase, now uniformly centered to match RefillHome + /scan + /onboard.",
    ],
  },
  {
    version: "v1.4.1",
    date: "May 2026",
    items: [
      "<strong>v1.4.1 &mdash; PageHeader re-skin (Refill house style).</strong> The Karen walk + v1.4 Billing fix surfaced a deeper design mismatch: the authed sub-pages (Recovery, Inbox, Settings, Billing, plus 14 other refill.* routes) all wore platform-y chrome &mdash; sticky header bar with backdrop blur, all-caps &lsquo;REFILL&rsquo; eyebrow, sans-serif title + amber version pill, breadcrumbs &mdash; while the rest of getrefill (/scan, /onboard, /login, RefillHome) used the warm brand-forward Refill aesthetic: Georgia serif h1, light paper bg, soft ink-soft lede, sage accents, no eyebrows, no breadcrumbs, no in-body version pill. The handoff between public and authed surfaces was jarring. Rewrote <code>PageHeader.tsx</code> in-place to the Refill house style: Georgia serif h1 (matches RefillHome&rsquo;s &lsquo;Hey {spa}.&rsquo; greeting), soft ink-soft description, kept the actions slot (Refresh buttons etc.) on the right of title, dropped sticky/backdrop chrome and breadcrumb rendering. The <code>eyebrow</code> and <code>breadcrumbs</code> props are kept on the interface as silent back-compat no-ops so the 25 callers don&rsquo;t need touching. Relocated the version-pill + changelog Popover into <code>RefillShellChrome</code>&rsquo;s top-right strip so there&rsquo;s a single v-pill per session rather than one duplicated on every page; restyled in soft sage (#e8f3ed background, #056048 ink) to match brand. Net: 3 files touched (PageHeader.tsx, RefillShellChrome.tsx, changelog.ts), 25 routes inherit the new look automatically.",
    ],
  },
  {
    version: "v1.4",
    date: "May 2026",
    items: [
      "<strong>v1.4 &mdash; Billing-route + brand-CTA cleanup (Karen-walk pinches).</strong> The Karen live walk surfaced three destination-never-built bugs from features that shipped half-wired: (1) Billing chip routed to <code>/app/refill/billing</code> which redirected to <code>/app/billing</code> &mdash; a route speced as the canonical Refill billing surface in v391 but the frontend was never created (only backend + Stripe API routes shipped); (2) the &lsquo;Connect Acuity (30 sec)&rsquo; post-receipt CTA on /scan pointed at <code>/start</code>, also never built; (3) the header &lsquo;Already a customer? Sign in &rarr;&rsquo; link on /scan ALSO pointed at <code>/start</code> &mdash; a hidden third bug exposed by the brand.ctaHref being overloaded across login + signup intents. Fix: built <code>/app/billing</code> proper (lifted the working BillingPage from app.refill.billing.tsx, swapped 5 Emma&rarr;Refill copy leaks, removed the unreachable useShell-gated redirect wrapper); stripped app.refill.billing.tsx to a 5-line back-compat <code>&lt;Navigate to=&quot;/app/billing&quot; replace /&gt;</code> shim for stale email links; rewired 4 internal references (RefillNav chip, RefillHome ActionCard, RefillShellChrome active-chip derive, the &lsquo;Choose a plan&rsquo; CTA on Recovery); split <code>brand.ctaHref</code> into <code>ctaHref</code> (now <code>/onboard</code>) and new <code>loginHref</code> (<code>/login</code>) so signup and signin links route correctly. Same pre-flight gap that hid these bugs from earlier walks: HTTP 200 &ne; destination-route-exists; click-through pre-flight is now the rule.",
    ],
  },
  {
    version: "v1.3",
    date: "May 2026",
    items: [
      "<strong>v1.3 &mdash; /onboard CSV-drop fallback for non-Acuity spas.</strong> Until tonight, Step 2 of the onboard wizard had a hard dead-end for any spa not on Acuity &mdash; the only escape was &lsquo;ask us to enable your platform manually after you finish setup.&rsquo; Added a secondary &lsquo;Upload a client list CSV instead&rsquo; link on Step 2&rsquo;s needs-connect state that navigates to /onboard?step=3&amp;source=csv and skips OAuth entirely. Step 3 reads the source param, dispatches to a new <code>Step3PatientsCsv</code> branch with a drop zone (parsing client-side, posting to existing <code>ingestClientListCsv</code> server fn so we&rsquo;re reusing the battle-tested ingest pipeline behind app.refill.patients.contacts.tsx). State machine: awaiting / ingesting / imported / error. Refactored <code>Step3Patients</code> into a hook-stable dispatcher (renamed the old logic to <code>Step3PatientsAcuity</code>; thin Step3Patients now branches on source). After CSV import, the wizard Continue button advances to Step 4 same as the Acuity path &mdash; the rest of onboarding is source-agnostic. Closes Task #4.",
    ],
  },
  {
    version: "v1.2",
    date: "May 2026",
    items: [
      "<strong>v1.2 &mdash; /scan funnel sharpening (CSV-export polish + Acuity live-mode upgrade).</strong> Original Task #3 was framed as &lsquo;pivot /scan to OAuth-first&rsquo;, but a scout pass surfaced that OAuth-at-the-door conflicts with the trojan-horse stealth-widget posture (asking for OAuth before proving value is exactly what incumbent PMS partners fear). Split the two problems: (1) CSV-export friction &mdash; new inline guide picker beneath the drop zone lets a non-tech spa owner pick their scheduler and see verified export steps (5 platforms with confirmed paths, the other 19 fall through to a generic fallback per the no-fabrication rule); (2) post-receipt OAuth upgrade &mdash; when the parsed dialect resolves to Acuity (deterministic OR AI-mapped), the bottom CTA swaps from generic /start framing to &lsquo;Connect Acuity for live mode&rsquo; with explicit pass-through to /start?detected=acuity. Non-Acuity users get a heads-up line that live-mode for their platform is on the roadmap. Architecture memorialized in project_scan_trojan_horse_architecture.",
    ],
  },
  {
    version: "v1.1",
    date: "May 2026",
    items: [
      "<strong>v1.1 &mdash; RefillShell routing fixes (Karen dry-run prep).</strong> Pre-walk code-audit surfaced 4 hard 404s in the spa-owner shell: Billing nav chip, Billing quick-action card, header gear icon, and the active-chip derive all pointed at top-level routes that don&rsquo;t exist (the nested /app/refill/* convention is the established one). Rewired so a first-time owner click on Billing or Settings lands on the right page.",
    ],
  },
  {
    version: "v1.0",
    date: "May 2026",
    items: [
      "<strong>v1.0 &mdash; Refill cleave landed.</strong> Standalone repo + standalone Supabase + standalone CF Worker on getrefill.app. The 2-week cleave from openagenticv4 collapsed the cross-host auth bridge stack (set Site URL = getrefill.app, single cookie domain, zero shell stamping). 74 migrations ported, 90+ source files lifted, ~50 KLOC of bridge/product-context entanglement deleted by simplification.",
    ],
  },
];

export function currentVersion(): string {
  return CHANGELOG[0]?.version ?? "v1.0";
}
