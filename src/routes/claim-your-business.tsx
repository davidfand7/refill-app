/**
 * /claim-your-business — Spa-side onboarding entry point.
 *
 * Owner pastes their spa URL → FireCrawl pulls their public site →
 * we show what Refill would know about their practice → owner signs up
 * and claims, materializing a tenant + scrape-derived knowledge nodes
 * stamped with their auth.users.id.
 *
 * Public route by design — no chip nav, no admin chrome. Landing-shell
 * styled to match /story + /start + the marketing surface family.
 *
 * v1.21 port from openagenticv4: cleaved Emma + Agentiport references
 * (header brand, footer copy, ValueProps body text, success messaging,
 * /app/karen destination link). The scrape → review → claim arc is
 * preserved verbatim because the server fns + DB substrate
 * (spa_claim_sessions, knowledge_nodes node_type='spa_profile') already
 * exist in refill-app from earlier ports. Re-points to /app/refill on
 * completion. Hosted-Messaging language replaced with Refill's actual
 * activation story (calendar connect → no-show recovery starts).
 *
 * Original established 2026-05-10 (v256 — Agentiport Phase 4.0 W1).
 */

import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { fallback } from "@tanstack/zod-adapter";
import { z } from "zod";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { toast } from "sonner";
import {
  ArrowRight,
  BadgeCheck,
  Calendar,
  Clock,
  Globe,
  Loader2,
  Mail,
  MapPin,
  Phone,
  ShieldCheck,
  Sparkles,
  Sprout,
} from "lucide-react";
import {
  startSpaScrape,
  getSpaClaimStatus,
  claimSpa,
  updateSpaScrape,
  type SpaClaimSessionRow,
  type SpaScrapeData,
  type SpaScrapeService,
} from "@/server/spa-claim.functions";
import { PasswordInput } from "@/components/PasswordInput";
import { ServicesEditCard } from "@/components/ServicesEditCard";

const searchSchema = z.object({
  session: fallback(z.string().uuid().optional(), undefined),
});

export const Route = createFileRoute("/claim-your-business")({
  validateSearch: searchSchema,
  component: ClaimYourBusinessPage,
});

type Stage = "enter-url" | "scraping" | "review" | "done";

/** Owner-edit shape — what the review stage's form sends to claimSpa. */
type ReviewEdits = {
  spaName?: string;
  services?: SpaScrapeService[];
  hours?: string;
  schedulingLink?: string;
  contactEmail?: string;
  contactPhone?: string;
  address?: string;
  policies?: string[];
};

function ClaimYourBusinessPage() {
  const { session: sessionFromUrl } = Route.useSearch();
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();

  const [stage, setStage] = useState<Stage>("enter-url");
  const [session, setSession] = useState<SpaClaimSessionRow | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Resume an existing session if the URL has one (e.g. owner came back after
  // signing in or hit refresh).
  useEffect(() => {
    if (!sessionFromUrl) return;
    let cancelled = false;
    void (async () => {
      try {
        const row = await getSpaClaimStatus({ data: { sessionId: sessionFromUrl } });
        if (cancelled) return;
        setSession(row);
        setStage(stageForSession(row));
      } catch (e) {
        if (!cancelled) {
          toast.error(
            e instanceof Error ? e.message : "Couldn't load that claim — try starting over.",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionFromUrl]);

  // Poll while a scrape is in flight (resume case — fresh starts now block
  // inline in startSpaScrape so this only matters when an owner returns to
  // a session via ?session=<id> URL).
  useEffect(() => {
    if (stage !== "scraping" || !session || session.id === "pending") return;
    let cancelled = false;
    const tick = async () => {
      try {
        const row = await getSpaClaimStatus({ data: { sessionId: session.id } });
        if (cancelled) return;
        setSession(row);
        if (row.scrape_status === "preview-ready") {
          setStage("review");
        } else if (row.scrape_status === "failed") {
          toast.error(row.scrape_error ?? "Couldn't read your site — please try again.");
          setStage("enter-url");
        }
      } catch (e) {
        if (!cancelled) {
          toast.error(e instanceof Error ? e.message : "Lost connection — please try again.");
          setStage("enter-url");
        }
      }
    };
    const interval = setInterval(() => {
      void tick();
    }, 3500);
    void tick();
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [stage, session?.id]);

  async function handleStart(spaUrl: string) {
    if (!spaUrl.trim() || submitting) return;
    setSubmitting(true);
    // Optimistically render the scraping stage with a synthetic session so
    // the owner sees forward motion while the request blocks — startSpaScrape
    // now awaits FireCrawl inline (30-90s) instead of fire-and-forget, which
    // gets killed by Cloudflare Workers' lifecycle.
    const normalized = /^https?:\/\//i.test(spaUrl.trim())
      ? spaUrl.trim()
      : "https://" + spaUrl.trim();
    setSession({
      id: "pending",
      spa_url: normalized,
      spa_name: null,
      scrape_status: "scraping",
      scrape_error: null,
      scrape_data: null,
      claimed_by: null,
      claimed_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    setStage("scraping");
    try {
      const row = await startSpaScrape({ data: { spaUrl } });
      setSession(row);
      setStage(stageForSession(row));
      void navigate({ to: "/claim-your-business", search: { session: row.id } });
    } catch (e) {
      setStage("enter-url");
      setSession(null);
      toast.error(e instanceof Error ? e.message : "Couldn't start — please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleClaim(accessToken: string, edits?: ReviewEdits) {
    if (!session) return;
    try {
      await claimSpa({
        data: { accessToken, sessionId: session.id, edits },
      });
      // Reload the row so the UI shows the claimed state with applied edits.
      const row = await getSpaClaimStatus({ data: { sessionId: session.id } });
      setSession(row);
      setStage("done");
      toast.success("Claimed. Your spa is loaded — start cancellation recovery any time.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't finish claiming.");
    }
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ background: "#fbfaf7" }}>
      <ClaimHeader user={user} authLoading={authLoading} />

      <main className="flex-1 max-w-4xl mx-auto px-6 py-10 lg:py-14 w-full">
        {stage === "enter-url" && (
          <EnterUrlStage onStart={handleStart} submitting={submitting} />
        )}
        {stage === "scraping" && session && <ScrapingStage session={session} />}
        {stage === "review" && session && (
          <ReviewStage
            session={session}
            user={user}
            authLoading={authLoading}
            onClaim={handleClaim}
          />
        )}
        {stage === "done" && session && <DoneStage session={session} />}
      </main>

      <footer
        className="border-t py-6 text-center text-xs"
        style={{ borderColor: "#e6e2d6", color: "#8a9098" }}
      >
        © {new Date().getFullYear()} SmartSpa · The patient-profitability OS for spas
      </footer>
    </div>
  );
}

function stageForSession(row: SpaClaimSessionRow): Stage {
  switch (row.scrape_status) {
    case "queued":
    case "scraping":
      return "scraping";
    case "preview-ready":
      return "review";
    case "claimed":
      return "done";
    case "failed":
      return "enter-url";
  }
}

// ─── Header ────────────────────────────────────────────────────────────────

function ClaimHeader({
  user,
  authLoading,
}: {
  user: ReturnType<typeof useAuth>["user"];
  authLoading: boolean;
}) {
  return (
    <header
      className="border-b backdrop-blur-sm sticky top-0 z-10"
      style={{
        background: "rgba(251, 250, 247, 0.92)",
        borderColor: "#e6e2d6",
      }}
    >
      <div className="max-w-5xl mx-auto px-6 py-3 flex items-center justify-between">
        <Link to="/" className="flex items-center gap-2.5 text-sm font-semibold">
          <div
            className="flex h-7 w-7 items-center justify-center rounded-lg font-semibold"
            style={{ background: "#056048", color: "#fbfaf7" }}
            aria-hidden
          >
            S
          </div>
          <div className="leading-tight">
            <div style={{ color: "#1c2024" }}>SmartSpa</div>
            <div className="text-[10px] -mt-0.5" style={{ color: "#8a9098" }}>
              / the patient-profitability OS
            </div>
          </div>
        </Link>
        <div className="flex items-center gap-3">
          {!authLoading && user && (
            <span className="text-xs" style={{ color: "#5a6068" }}>
              Signed in as{" "}
              <span style={{ color: "#1c2024" }}>{user.email}</span>
            </span>
          )}
        </div>
      </div>
    </header>
  );
}

// ─── Stage 1: Enter URL ────────────────────────────────────────────────────

function EnterUrlStage({
  onStart,
  submitting,
}: {
  onStart: (url: string) => void;
  submitting: boolean;
}) {
  const [url, setUrl] = useState("");
  return (
    <div className="max-w-2xl mx-auto py-6 lg:py-12 space-y-10">
      <div className="text-center space-y-4">
        <div
          className="inline-flex items-center gap-1.5 rounded-full text-xs font-semibold px-3 py-1"
          style={{ background: "#e8f1ed", color: "#056048" }}
        >
          <Sprout className="h-3.5 w-3.5" />
          For spa owners
        </div>
        <h1
          className="text-3xl lg:text-4xl font-semibold tracking-tight"
          style={{
            fontFamily: "Georgia, 'Times New Roman', serif",
            color: "#1c2024",
          }}
        >
          Turn your cancellations into recovered revenue.
        </h1>
        <p
          className="text-base leading-relaxed max-w-lg mx-auto"
          style={{ color: "#5a6068" }}
        >
          Paste your spa&rsquo;s website. We&rsquo;ll read what&rsquo;s already
          public &mdash; services, scheduling link, hours, contact &mdash; so
          you can preview what Refill knows about your practice in 60 seconds.
          No paperwork, no commitment.
        </p>
      </div>

      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          onStart(url);
        }}
        className="rounded-2xl border bg-white p-5 lg:p-6 shadow-lg space-y-3"
        style={{ borderColor: "#e6e2d6" }}
      >
        <label
          className="text-xs font-medium flex items-center gap-1.5"
          style={{ color: "#5a6068" }}
        >
          <Globe className="h-3.5 w-3.5" />
          Your spa&rsquo;s website
        </label>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            type="text"
            inputMode="url"
            autoFocus
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="rejuvskinandlaser.com"
            disabled={submitting}
            className="flex-1 rounded-lg border px-3 py-2.5 text-sm focus:outline-none focus:ring-2 disabled:opacity-60"
            style={{
              borderColor: "#e6e2d6",
              background: "#fbfaf7",
            }}
          />
          <button
            type="submit"
            disabled={submitting || !url.trim()}
            className="inline-flex items-center justify-center gap-2 rounded-lg px-5 py-2.5 text-sm font-semibold hover:opacity-90 disabled:opacity-60 transition"
            style={{ background: "#056048", color: "#fbfaf7" }}
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ArrowRight className="h-4 w-4" />
            )}
            {submitting ? "Starting…" : "Find my spa"}
          </button>
        </div>
        <p className="text-[11px]" style={{ color: "#8a9098" }}>
          We only read pages that are already public. Nothing private, nothing
          changes on your site.
        </p>
      </form>

      <ValueProps />
    </div>
  );
}

function ValueProps() {
  const items = [
    {
      icon: Calendar,
      title: "Refill watches your calendar for cancellations",
      body: "The moment a slot opens, Refill texts your waitlist with the open time. No new app for your front desk, no new number.",
    },
    {
      icon: ShieldCheck,
      title: "You only pay on what comes back",
      body: "Free to start. We charge $5 when a patient actually books a rescued slot. If nothing books, you pay nothing.",
    },
    {
      icon: Sparkles,
      title: "Your waitlist becomes your safety net",
      body: "Patients you would have lost to cancellations become the people who fill them. The longer Refill runs, the more your waitlist earns for you.",
    },
  ];
  return (
    <div className="grid sm:grid-cols-3 gap-4">
      {items.map((it) => (
        <div
          key={it.title}
          className="rounded-xl border bg-white p-5 space-y-2"
          style={{ borderColor: "#e6e2d6" }}
        >
          <div
            className="h-9 w-9 rounded-lg flex items-center justify-center"
            style={{ background: "#e8f1ed" }}
          >
            <it.icon className="h-4 w-4" style={{ color: "#056048" }} />
          </div>
          <div
            className="text-sm font-semibold"
            style={{ color: "#1c2024" }}
          >
            {it.title}
          </div>
          <div
            className="text-xs leading-relaxed"
            style={{ color: "#5a6068" }}
          >
            {it.body}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Stage 2: Scraping ─────────────────────────────────────────────────────

const SCRAPING_STEPS = [
  "Looking up your home page…",
  "Finding your services…",
  "Reading your hours…",
  "Spotting your scheduling link…",
  "Checking your policies…",
];

function ScrapingStage({ session }: { session: SpaClaimSessionRow }) {
  // Cycle through optimistic step labels — purely cosmetic, doesn't reflect
  // real scrape progress (FireCrawl is opaque mid-flight). The illusion of
  // forward motion matters more than literal accuracy at this stage.
  const [stepIdx, setStepIdx] = useState(0);
  useEffect(() => {
    const t = setInterval(() => {
      setStepIdx((i) => Math.min(i + 1, SCRAPING_STEPS.length - 1));
    }, 4500);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="max-w-xl mx-auto py-12 space-y-8 text-center">
      <div
        className="inline-flex h-14 w-14 mx-auto items-center justify-center rounded-2xl"
        style={{ background: "#e8f1ed" }}
      >
        <Loader2 className="h-7 w-7 animate-spin" style={{ color: "#056048" }} />
      </div>
      <div className="space-y-2">
        <h1
          className="text-2xl font-semibold tracking-tight"
          style={{
            fontFamily: "Georgia, 'Times New Roman', serif",
            color: "#1c2024",
          }}
        >
          Reading your spa…
        </h1>
        <p className="text-sm" style={{ color: "#5a6068" }}>
          {hostname(session.spa_url)} · this usually takes 30–90 seconds
        </p>
      </div>
      <div
        className="rounded-xl border bg-white p-4 max-w-sm mx-auto text-left space-y-2"
        style={{ borderColor: "#e6e2d6" }}
      >
        {SCRAPING_STEPS.map((label, i) => (
          <div
            key={label}
            className="flex items-center gap-2.5 text-sm transition-opacity"
            style={{ opacity: i <= stepIdx ? 1 : 0.4 }}
          >
            {i < stepIdx ? (
              <BadgeCheck
                className="h-4 w-4 shrink-0"
                style={{ color: "#056048" }}
              />
            ) : i === stepIdx ? (
              <Loader2
                className="h-4 w-4 animate-spin shrink-0"
                style={{ color: "#056048" }}
              />
            ) : (
              <div
                className="h-4 w-4 rounded-full border shrink-0"
                style={{ borderColor: "#e6e2d6" }}
              />
            )}
            <span style={{ color: i === stepIdx ? "#1c2024" : "#5a6068" }}>
              {label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// ─── Stage 3: Review + claim (editable) ────────────────────────────────────
// Owner sees what was extracted AND can refine before claiming. Architecture:
// edit always-on instead of a separate edit mode. Caught "Get In Touch"
// being mistakenly extracted as a service on rejuvskinspa.com 2026-05-09 —
// owner can now just remove it inline.

function ReviewStage({
  session,
  user,
  authLoading,
  onClaim,
}: {
  session: SpaClaimSessionRow;
  user: ReturnType<typeof useAuth>["user"];
  authLoading: boolean;
  onClaim: (accessToken: string, edits?: ReviewEdits) => Promise<void>;
}) {
  const data: SpaScrapeData = session.scrape_data ?? {};
  const isAlreadyClaimed = session.scrape_status === "claimed";

  // Initialize edit state from the scrape. Owner mutates this; we send the
  // whole shape to claimSpa as `edits` so the server applies before materialize.
  const [spaName, setSpaName] = useState(
    session.spa_name ?? data.spaName ?? "",
  );
  const [services, setServices] = useState<SpaScrapeService[]>(data.services ?? []);
  const [hours, setHours] = useState(data.hours ?? "");
  const [schedulingLink, setSchedulingLink] = useState(data.schedulingLink ?? "");
  const [contactEmail, setContactEmail] = useState(data.contactEmail ?? "");
  const [contactPhone, setContactPhone] = useState(data.contactPhone ?? "");
  const [address, setAddress] = useState(data.address ?? "");
  // Policies stored as a single textarea, one per line (parse on submit).
  const [policiesText, setPoliciesText] = useState(
    (data.policies ?? []).join("\n"),
  );

  const buildEdits = (): ReviewEdits => ({
    spaName: spaName.trim() || undefined,
    services,
    hours: hours.trim() || undefined,
    schedulingLink: schedulingLink.trim() || undefined,
    contactEmail: contactEmail.trim() || undefined,
    contactPhone: contactPhone.trim() || undefined,
    address: address.trim() || undefined,
    policies: policiesText
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
  });

  // Debounced auto-save against spa_claim_sessions so edits survive a
  // page reload, signup-confirmation-link round-trip, or browser swap.
  // Without this, an owner who edits services then has to confirm their
  // signup email loses everything they typed when they come back via the
  // ?session=<id> link. Skip auto-save once the session is claimed (the
  // canonical store is knowledge_nodes after that — handled by the tenant
  // dashboard). First-render skip prevents an immediate echo-save on mount
  // that would overwrite server state with the same data.
  const firstRenderRef = useRef(true);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");
  useEffect(() => {
    if (firstRenderRef.current) {
      firstRenderRef.current = false;
      return;
    }
    if (isAlreadyClaimed) return;
    if (!session.id || session.id === "pending") return;
    setSaveStatus("saving");
    const handle = setTimeout(() => {
      void (async () => {
        try {
          await updateSpaScrape({
            data: { sessionId: session.id, edits: buildEdits() },
          });
          setSaveStatus("saved");
          // Auto-clear "Saved" after a beat so the indicator doesn't camp.
          setTimeout(() => setSaveStatus((s) => (s === "saved" ? "idle" : s)), 2000);
        } catch {
          setSaveStatus("idle");
        }
      })();
    }, 1500);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    spaName,
    services,
    hours,
    schedulingLink,
    contactEmail,
    contactPhone,
    address,
    policiesText,
  ]);

  return (
    <div className="space-y-8">
      <div className="text-center space-y-3 max-w-2xl mx-auto">
        <div
          className="inline-flex items-center gap-1.5 rounded-full text-xs font-semibold px-3 py-1"
          style={{ background: "#e8f1ed", color: "#056048" }}
        >
          <BadgeCheck className="h-3.5 w-3.5" />
          Found your spa
        </div>
        <h1
          className="text-3xl font-semibold tracking-tight"
          style={{
            fontFamily: "Georgia, 'Times New Roman', serif",
            color: "#1c2024",
          }}
        >
          Here&rsquo;s what Refill knows about your spa
        </h1>
        <p className="text-sm leading-relaxed" style={{ color: "#5a6068" }}>
          Pulled from {hostname(session.spa_url)} a moment ago. Edit anything
          that&rsquo;s off &mdash; what you confirm here is what Refill uses.
          {data.extractedBy === "regex" && (
            <span
              className="block mt-1 text-[11px] italic"
              style={{ color: "#8a9098" }}
            >
              (Used the basic extractor &mdash; review carefully.)
            </span>
          )}
        </p>
        {saveStatus !== "idle" && !isAlreadyClaimed && (
          <div
            className="inline-flex items-center gap-1.5 text-[11px]"
            style={{ color: "#8a9098" }}
          >
            {saveStatus === "saving" ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                Saving your edits…
              </>
            ) : (
              <>
                <BadgeCheck className="h-3 w-3" style={{ color: "#056048" }} />
                Edits saved.
              </>
            )}
          </div>
        )}
      </div>

      <div
        className="max-w-3xl mx-auto rounded-2xl border bg-white p-5 lg:p-6 space-y-3"
        style={{ borderColor: "#e6e2d6" }}
      >
        <FieldLabel icon={Sprout}>Practice name</FieldLabel>
        <input
          type="text"
          value={spaName}
          onChange={(e) => setSpaName(e.target.value)}
          placeholder="Your spa's brand name"
          className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2"
          style={{ borderColor: "#e6e2d6", background: "#fbfaf7" }}
        />
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <ServicesEditCard
          services={services}
          onChange={setServices}
          outerClassName="lg:row-span-1"
          emptyCopy={
            <>
              We didn&apos;t pick out services from your site. Add the
              treatments you offer below &mdash; we use these to match you
              with relevant manufacturer promos.
            </>
          }
        />

        <EditCard icon={Calendar} title="Scheduling">
          <FieldLabel>Booking link</FieldLabel>
          <input
            type="url"
            value={schedulingLink}
            onChange={(e) => setSchedulingLink(e.target.value)}
            placeholder="https://app.acuityscheduling.com/…"
            className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2"
            style={{ borderColor: "#e6e2d6", background: "#fbfaf7" }}
          />
          <FieldLabel icon={Clock}>Hours</FieldLabel>
          <textarea
            value={hours}
            onChange={(e) => setHours(e.target.value)}
            placeholder={"Mon-Fri 9-6\nSat 10-4\nSun closed"}
            rows={3}
            className="w-full rounded-lg border px-3 py-2 text-sm font-mono leading-relaxed focus:outline-none focus:ring-2"
            style={{ borderColor: "#e6e2d6", background: "#fbfaf7" }}
          />
          <p className="text-[11px]" style={{ color: "#8a9098" }}>
            Leave hours empty if you don&rsquo;t post them publicly.
          </p>
        </EditCard>

        <EditCard icon={MapPin} title="Contact">
          <FieldLabel icon={Mail}>Email</FieldLabel>
          <input
            type="email"
            value={contactEmail}
            onChange={(e) => setContactEmail(e.target.value)}
            placeholder="info@yourspa.com"
            className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2"
            style={{ borderColor: "#e6e2d6", background: "#fbfaf7" }}
          />
          <FieldLabel icon={Phone}>Phone</FieldLabel>
          <input
            type="tel"
            value={contactPhone}
            onChange={(e) => setContactPhone(e.target.value)}
            placeholder="(303) 555-1234"
            className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2"
            style={{ borderColor: "#e6e2d6", background: "#fbfaf7" }}
          />
          <FieldLabel icon={MapPin}>Address</FieldLabel>
          <input
            type="text"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="1234 Main St, Denver, CO 80202"
            className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2"
            style={{ borderColor: "#e6e2d6", background: "#fbfaf7" }}
          />
        </EditCard>

        <EditCard icon={ShieldCheck} title="Policies">
          <FieldLabel>One per line</FieldLabel>
          <textarea
            value={policiesText}
            onChange={(e) => setPoliciesText(e.target.value)}
            placeholder={
              "24-hour cancellation policy\n$50 deposit required for new clients\n…"
            }
            rows={5}
            className="w-full rounded-lg border px-3 py-2 text-sm leading-relaxed focus:outline-none focus:ring-2"
            style={{ borderColor: "#e6e2d6", background: "#fbfaf7" }}
          />
          <p className="text-[11px]" style={{ color: "#8a9098" }}>
            Refill respects these when texting your waitlist. Add cancellation,
            deposits, age rules, anything you want enforced.
          </p>
        </EditCard>
      </div>

      {isAlreadyClaimed ? (
        <AlreadyClaimedCard />
      ) : authLoading ? (
        <div className="flex justify-center py-6">
          <Loader2 className="h-5 w-5 animate-spin" style={{ color: "#5a6068" }} />
        </div>
      ) : user ? (
        <ClaimButton buildEdits={buildEdits} onClaim={onClaim} />
      ) : (
        <SignUpAndClaim buildEdits={buildEdits} onClaim={onClaim} />
      )}
    </div>
  );
}

function FieldLabel({
  icon: Icon,
  children,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <label
      className="text-xs font-medium flex items-center gap-1.5"
      style={{ color: "#5a6068" }}
    >
      {Icon && <Icon className="h-3.5 w-3.5" />}
      {children}
    </label>
  );
}

function EditCard({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="rounded-2xl border bg-white p-5 space-y-3"
      style={{ borderColor: "#e6e2d6" }}
    >
      <div className="flex items-center gap-2">
        <div
          className="h-7 w-7 rounded-lg flex items-center justify-center"
          style={{ background: "#e8f1ed" }}
        >
          <Icon className="h-3.5 w-3.5" style={{ color: "#056048" }} />
        </div>
        <div
          className="text-sm font-semibold"
          style={{ color: "#1c2024" }}
        >
          {title}
        </div>
      </div>
      <div className="space-y-2.5">{children}</div>
    </div>
  );
}

function ClaimButton({
  buildEdits,
  onClaim,
}: {
  buildEdits: () => ReviewEdits;
  onClaim: (accessToken: string, edits?: ReviewEdits) => Promise<void>;
}) {
  const [working, setWorking] = useState(false);
  return (
    <div
      className="rounded-2xl border p-6 max-w-xl mx-auto text-center space-y-3"
      style={{ borderColor: "rgba(5,96,72,0.2)", background: "#f3f7f5" }}
    >
      <div className="text-sm font-semibold" style={{ color: "#1c2024" }}>
        Looks right? Claim your spa.
      </div>
      <p className="text-xs leading-relaxed" style={{ color: "#5a6068" }}>
        Refill loads this knowledge under your account. Your tenant is private
        to you until you wire your scheduler and waitlist.
      </p>
      <button
        type="button"
        disabled={working}
        onClick={async () => {
          setWorking(true);
          try {
            const { data: sess } = await supabase.auth.getSession();
            const token = sess.session?.access_token;
            if (!token) {
              toast.error("Sign-in lost — please sign in again.");
              return;
            }
            await onClaim(token, buildEdits());
          } finally {
            setWorking(false);
          }
        }}
        className="inline-flex items-center justify-center gap-2 rounded-lg px-6 py-2.5 text-sm font-semibold hover:opacity-90 disabled:opacity-60 transition"
        style={{ background: "#056048", color: "#fbfaf7" }}
      >
        {working ? <Loader2 className="h-4 w-4 animate-spin" /> : <BadgeCheck className="h-4 w-4" />}
        {working ? "Claiming…" : "Claim my spa"}
      </button>
    </div>
  );
}

function AlreadyClaimedCard() {
  return (
    <div
      className="rounded-2xl border p-6 max-w-xl mx-auto text-center space-y-3"
      style={{ borderColor: "rgba(5,96,72,0.2)", background: "#f3f7f5" }}
    >
      <BadgeCheck className="h-6 w-6 mx-auto" style={{ color: "#056048" }} />
      <div className="text-sm font-semibold" style={{ color: "#1c2024" }}>
        This spa is already claimed.
      </div>
      <p className="text-xs" style={{ color: "#5a6068" }}>
        If that&rsquo;s you, sign in and head back to your Refill dashboard.
      </p>
      <Link
        to="/login"
        className="inline-flex items-center justify-center gap-2 rounded-lg px-5 py-2 text-sm font-medium hover:opacity-90 transition"
        style={{ background: "#1c2024", color: "#fbfaf7" }}
      >
        Sign in
        <ArrowRight className="h-3.5 w-3.5" />
      </Link>
    </div>
  );
}

function SignUpAndClaim({
  buildEdits,
  onClaim,
}: {
  buildEdits: () => ReviewEdits;
  onClaim: (accessToken: string, edits?: ReviewEdits) => Promise<void>;
}) {
  const [mode, setMode] = useState<"signup" | "signin">("signup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const lockRef = useRef(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (lockRef.current) return;
    lockRef.current = true;
    setWorking(true);
    setError(null);
    try {
      if (mode === "signup") {
        const { error: err } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: window.location.origin + "/claim-your-business" },
        });
        if (err) throw err;
      } else {
        const { error: err } = await supabase.auth.signInWithPassword({ email, password });
        if (err) throw err;
      }
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        throw new Error(
          mode === "signup"
            ? "Check your email to confirm — then come back here."
            : "Sign-in didn't take — please try again.",
        );
      }
      await onClaim(token, buildEdits());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setWorking(false);
      lockRef.current = false;
    }
  }

  return (
    <div
      className="rounded-2xl border bg-white p-6 max-w-xl mx-auto space-y-4"
      style={{ borderColor: "rgba(5,96,72,0.2)" }}
    >
      <div className="text-center space-y-1">
        <div className="text-base font-semibold" style={{ color: "#1c2024" }}>
          Claim this spa
        </div>
        <p className="text-xs" style={{ color: "#5a6068" }}>
          Create a free account so Refill can load your spa under your name.
        </p>
      </div>

      <div
        className="flex justify-center gap-1 rounded-lg p-1 text-xs"
        style={{ background: "#f3f0e7" }}
      >
        <button
          type="button"
          onClick={() => setMode("signup")}
          className="px-3 py-1.5 rounded-md transition flex-1"
          style={
            mode === "signup"
              ? {
                  background: "#ffffff",
                  color: "#1c2024",
                  boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
                }
              : { color: "#5a6068", background: "transparent" }
          }
        >
          Create account
        </button>
        <button
          type="button"
          onClick={() => setMode("signin")}
          className="px-3 py-1.5 rounded-md transition flex-1"
          style={
            mode === "signin"
              ? {
                  background: "#ffffff",
                  color: "#1c2024",
                  boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
                }
              : { color: "#5a6068", background: "transparent" }
          }
        >
          I already have one
        </button>
      </div>

      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label className="text-xs font-medium" style={{ color: "#5a6068" }}>
            Email
          </label>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={working}
            className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 disabled:opacity-60"
            style={{ borderColor: "#e6e2d6", background: "#fbfaf7" }}
            placeholder="you@yourspa.com"
          />
        </div>
        <div>
          <label className="text-xs font-medium" style={{ color: "#5a6068" }}>
            Password
          </label>
          <PasswordInput
            required
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={working}
            className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 disabled:opacity-60"
            style={{ borderColor: "#e6e2d6", background: "#fbfaf7" }}
            placeholder="••••••••"
          />
        </div>
        {error && (
          <div
            className="rounded-lg text-xs px-3 py-2 ring-1"
            style={{
              background: "#fdecec",
              color: "#b94842",
              boxShadow: "inset 0 0 0 1px rgba(185,72,66,0.2)",
            }}
          >
            {error}
          </div>
        )}
        <button
          type="submit"
          disabled={working}
          className="w-full inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold hover:opacity-90 disabled:opacity-60 transition"
          style={{ background: "#056048", color: "#fbfaf7" }}
        >
          {working ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <BadgeCheck className="h-4 w-4" />
          )}
          {working
            ? "Working…"
            : mode === "signup"
              ? "Create account & claim"
              : "Sign in & claim"}
        </button>
      </form>
      <p
        className="text-[11px] text-center"
        style={{ color: "#8a9098" }}
      >
        Free to claim · No credit card · $5 per booking we create
      </p>
    </div>
  );
}

// ─── Stage 4: Done ─────────────────────────────────────────────────────────

function DoneStage({ session }: { session: SpaClaimSessionRow }) {
  const spaName = session.spa_name ?? hostname(session.spa_url);
  return (
    <div className="max-w-xl mx-auto py-10 space-y-8 text-center">
      <div
        className="inline-flex h-16 w-16 mx-auto items-center justify-center rounded-2xl"
        style={{ background: "#e8f1ed" }}
      >
        <BadgeCheck className="h-8 w-8" style={{ color: "#056048" }} />
      </div>
      <div className="space-y-2">
        <h1
          className="text-2xl font-semibold tracking-tight"
          style={{
            fontFamily: "Georgia, 'Times New Roman', serif",
            color: "#1c2024",
          }}
        >
          {spaName} is claimed.
        </h1>
        <p className="text-sm leading-relaxed" style={{ color: "#5a6068" }}>
          Your services, hours, and policies are loaded into your Refill
          tenant. Recovery starts the moment you wire your scheduler and
          waitlist &mdash; the next two steps are right inside the dashboard.
        </p>
      </div>
      <div
        className="rounded-xl border bg-white p-5 text-left space-y-3"
        style={{ borderColor: "#e6e2d6" }}
      >
        <div
          className="text-xs font-semibold uppercase tracking-wider"
          style={{ color: "#8a9098" }}
        >
          What&rsquo;s next
        </div>
        <ol className="space-y-2.5 text-sm" style={{ color: "#1c2024" }}>
          <li className="flex gap-2.5">
            <span
              className="h-5 w-5 rounded-full text-[11px] font-semibold flex items-center justify-center shrink-0"
              style={{ background: "#e8f1ed", color: "#056048" }}
            >
              1
            </span>
            <span>
              Wire your scheduler (Acuity, Boulevard, Mindbody, others)
              so Refill sees cancellations the moment they happen.
            </span>
          </li>
          <li className="flex gap-2.5">
            <span
              className="h-5 w-5 rounded-full text-[11px] font-semibold flex items-center justify-center shrink-0"
              style={{ background: "#e8f1ed", color: "#056048" }}
            >
              2
            </span>
            <span>
              Import your patient list so we know who to text when slots
              open. CSV from your PMS works.
            </span>
          </li>
          <li className="flex gap-2.5">
            <span
              className="h-5 w-5 rounded-full text-[11px] font-semibold flex items-center justify-center shrink-0"
              style={{ background: "#e8f1ed", color: "#056048" }}
            >
              3
            </span>
            <span>
              Watch the live recovery feed light up as patients fill
              cancellations. You only pay on what comes back.
            </span>
          </li>
        </ol>
      </div>
      <Link
        to="/app/refill"
        className="inline-flex items-center justify-center gap-2 rounded-lg px-5 py-2.5 text-sm font-semibold hover:opacity-90 transition"
        style={{ background: "#056048", color: "#fbfaf7" }}
      >
        Open my dashboard
        <ArrowRight className="h-4 w-4" />
      </Link>
    </div>
  );
}
