/**
 * /app/karen — SmartSpa spa-owner dashboard for managing what Emma knows.
 *
 * Post-claim management surface for spa owners. Reads the spa profile from
 * knowledge_nodes (the canonical store after claim — spa_claim_sessions is
 * staging-only and gets stale once the owner edits anything in the dashboard)
 * and writes back via diff-based upsert that preserves node IDs (so any
 * knowledge_edges that crystallize over time aren't accidentally cascaded
 * away by a save).
 *
 * Activation status: shows the current Hosted Messaging status (sandbox vs
 * live) with the next concrete step. Sandbox is the default — Emma knows
 * the spa but isn't replying to texts yet. Live requires Hosted Messaging
 * paperwork (1-3 weeks of carrier coordination, runs out-of-band).
 *
 * Routed from /claim-your-business "Open my dashboard" CTA (replaced the
 * v256 placeholder pointing at /app/repos which had no spa context).
 *
 * Established 2026-05-09 (v263 — Phase 4.0 W1.5 spa-side management).
 * Rebranded Karen → Emma 2026-05-10 (v277). URL slug renamed
 * /app/karen → /app/refill in v283; legacy /app/karen redirects via the
 * stub at src/routes/app.karen.tsx for grace-period bookmarks.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { RefillHome } from "@/components/refill/RefillHome";
import { useShell } from "@/lib/shell";
import { useTenantMembership } from "@/lib/use-tenant-membership";
import {
  ArrowRight,
  BadgeCheck,
  Calendar,
  CalendarClock,
  Clock,
  Globe,
  Loader2,
  Mail,
  MapPin,
  Phone,
  Plus,
  RotateCcw,
  Save,
  ShieldCheck,
  Sparkles,
  Sprout,
  Users,
  X,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/integrations/supabase/client";
import {
  getSpaProfile,
  updateSpaProfile,
  type SpaProfile,
  type SpaScrapeData,
  type SpaScrapeService,
} from "@/server/spa-claim.functions";
import {
  listOverduePatients,
  summarizeOverdueCohort,
  type OverdueCohortSummary,
  type OverduePatient,
} from "@/server/patient-ingest.functions";
import type { ProductKind } from "@/lib/product-manufacturer-map";
import { cn } from "@/lib/utils";
import { ServicesEditCard } from "@/components/ServicesEditCard";

export const Route = createFileRoute("/app/refill/")({
  component: EmmaIndex,
});

// v410: persona index branch. Tenant users on the Refill product surface
// (app.getrefill.app) render RefillHome — the narrow standalone-product
// landing — instead of KarenDashboard (which is the SmartSpa spa-profile
// editor, the wrong front door for a returning Refill customer).
// Non-Refill spa owners on emma.agentiport.com keep KarenDashboard
// unchanged. Per [[project-refill-trojan-horse-thesis]].
//
// v413.2 HARD GATE: on Refill shell, KarenDashboard MUST NEVER render —
// it leaks SmartSpa branding into a Refill-host surface (eyebrow
// "EMMA(OS)", title "Emma", body copy referencing Emma). The app.tsx
// AppLayout already redirects non-tenant Refill users to /onboard
// before this component mounts, but defense in depth: if we somehow
// render here with shell=refill AND not-tenant, return null rather
// than fall through to KarenDashboard's Emma chrome. Per
// [[feedback-emma-never-user-facing]] HARD RULE.
function EmmaIndex() {
  const shell = useShell();
  const membership = useTenantMembership();
  if (shell === "refill") {
    if (membership.status === "tenant") {
      return <RefillHome />;
    }
    return null;
  }
  return <KarenDashboard />;
}

function KarenDashboard() {
  const [profile, setProfile] = useState<SpaProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token;
        if (!token) {
          if (!cancelled) {
            setLoading(false);
            setError("Please sign in to manage your spa.");
          }
          return;
        }
        const p = await getSpaProfile({ data: { accessToken: token } });
        if (!cancelled) {
          setProfile(p);
          setLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setLoading(false);
          setError(e instanceof Error ? e.message : "Couldn't load your spa.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="flex items-center gap-2 text-sm text-ink-soft">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading your spa…
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <PageHeader
          eyebrow="SmartSpa"
          title="Spa Settings"
          description="Manage what SmartSpa knows about your spa."
        />
        <div className="px-6 lg:px-10 py-10">
          <EmptyState
            icon={ShieldCheck}
            title="Couldn't load your spa"
            description={error}
          />
        </div>
      </div>
    );
  }

  if (!profile?.claimed) {
    return (
      <div>
        <PageHeader
          eyebrow="SmartSpa"
          title="Spa Settings"
          description="Once you've claimed a spa, SmartSpa's knowledge lives here."
        />
        <div className="px-6 lg:px-10 py-10">
          <div className="max-w-xl mx-auto rounded-2xl border border-border bg-card p-8 text-center space-y-4">
            <div className="mx-auto h-12 w-12 rounded-2xl bg-emerald/10 flex items-center justify-center">
              <Sprout className="h-5 w-5 text-emerald" />
            </div>
            <div className="space-y-1">
              <h2 className="text-lg font-semibold">No spa claimed yet</h2>
              <p className="text-sm text-ink-soft leading-relaxed">
                Paste your spa's website and we'll set SmartSpa up in 60 seconds.
              </p>
            </div>
            <Link
              to="/claim-your-business"
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-emerald text-paper px-5 py-2.5 text-sm font-semibold hover:opacity-90 transition"
            >
              Claim your spa
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return <ClaimedDashboard profile={profile} onProfileUpdate={setProfile} />;
}

// ─── Claimed dashboard: editable cards + activation banner ────────────────

function ClaimedDashboard({
  profile,
  onProfileUpdate,
}: {
  profile: SpaProfile;
  onProfileUpdate: (p: SpaProfile) => void;
}) {
  const data = profile.data;
  const spaName = data.spaName ?? hostname(profile.sourceUrl) ?? "Your spa";

  return (
    <div>
      <PageHeader
        eyebrow="SmartSpa · Spa Settings"
        title={spaName}
        description={
          profile.sourceUrl ? `Loaded from ${hostname(profile.sourceUrl)}.` : undefined
        }
        actions={
          profile.sourceUrl ? (
            <a
              href={profile.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted transition"
            >
              <Globe className="h-3.5 w-3.5" />
              View site
            </a>
          ) : undefined
        }
      />

      <div className="px-6 lg:px-10 py-8 space-y-6 max-w-[960px] mx-auto">
        <ActivationBanner />
        <OverdueTodayCard />
        <ProfileEditor profile={profile} onProfileUpdate={onProfileUpdate} />
      </div>
    </div>
  );
}

// ─── Overdue Today card (P3) ──────────────────────────────────────────────

function OverdueTodayCard() {
  const [summary, setSummary] = useState<OverdueCohortSummary | null>(null);
  const [preview, setPreview] = useState<OverduePatient[] | null>(null);
  const [loading, setLoading] = useState(true);

  // v1.23.0 P3 sweep: summarizeOverdueCohort + listOverduePatients now
  // both plumb viewAsUserId. Previously summarizeOverdueCohort was a
  // priority-5-opt-in carve-out (admin-fallback showed admin's empty
  // cohort); v1.23.0 closes that gap so the RefillHome overdue summary
  // counts match the surfaced patient list when admin views-as.
  const membership = useTenantMembership();
  const viewAsUserId =
    membership.status === "tenant" ? membership.viewAsUserId : undefined;

  useEffect(() => {
    if (membership.status === "loading") return;
    let cancelled = false;
    void (async () => {
      try {
        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token;
        if (!token) {
          if (!cancelled) setLoading(false);
          return;
        }
        const [s, list] = await Promise.all([
          summarizeOverdueCohort({ data: { accessToken: token, viewAsUserId } }),
          listOverduePatients({
            data: { accessToken: token, limit: 5, viewAsUserId },
          }),
        ]);
        if (!cancelled) {
          setSummary(s);
          setPreview(list);
          setLoading(false);
        }
      } catch {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [membership.status, viewAsUserId]);

  if (loading) {
    return (
      <div className="rounded-2xl border border-border bg-card p-5 flex items-center gap-2 text-xs text-ink-soft">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Checking patient cadence…
      </div>
    );
  }
  if (!summary || summary.totalOverdue === 0) return null;

  return (
    <section className="rounded-2xl border border-amber-400/30 bg-amber-50/60 dark:bg-amber-950/20 overflow-hidden">
      <div className="px-5 py-4 flex items-start gap-3">
        <div className="h-9 w-9 rounded-lg bg-amber-200/60 dark:bg-amber-500/20 flex items-center justify-center shrink-0">
          <CalendarClock className="h-4 w-4 text-amber-700 dark:text-amber-300" />
        </div>
        <div className="flex-1">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-sm font-semibold">
              {summary.totalOverdue.toLocaleString()} patient
              {summary.totalOverdue === 1 ? "" : "s"} overdue for a touchup
            </span>
            {summary.totalLapsed > 0 && (
              <span className="text-[11px] text-ink-soft">
                · {summary.totalLapsed.toLocaleString()} lapsed (over 2× window)
              </span>
            )}
          </div>
          <div className="text-xs text-ink-soft mt-1 flex items-center gap-2 flex-wrap">
            <KindBreakdown byKind={summary.byKind} />
          </div>
        </div>
        <Link
          to="/app/refill/patients"
          search={{ overdue: "1" } as never}
          className="shrink-0 inline-flex items-center gap-1.5 rounded-lg bg-emerald text-paper px-3 py-1.5 text-xs font-semibold hover:opacity-90 transition"
        >
          <Users className="h-3.5 w-3.5" />
          See all
        </Link>
      </div>
      {preview && preview.length > 0 && (
        <div className="border-t border-amber-400/20 divide-y divide-amber-400/20">
          {preview.map((p) => (
            <OverdueRow key={p.patientId} patient={p} />
          ))}
        </div>
      )}
    </section>
  );
}

function KindBreakdown({
  byKind,
}: {
  byKind: Partial<Record<ProductKind, number>>;
}) {
  const entries = useMemo(
    () =>
      (Object.entries(byKind) as Array<[ProductKind, number]>).sort(
        (a, b) => b[1] - a[1],
      ),
    [byKind],
  );
  if (entries.length === 0) return null;
  return (
    <>
      {entries.map(([k, n], i) => (
        <span key={k} className="inline-flex items-center gap-1">
          <span className="font-semibold tabular-nums">{n}</span>
          <span>{kindShortLabel(k)}</span>
          {i < entries.length - 1 && <span className="text-ink-faint">·</span>}
        </span>
      ))}
    </>
  );
}

function OverdueRow({ patient }: { patient: OverduePatient }) {
  const monthsOverdue = Math.round(patient.daysOverdue / 30);
  return (
    <Link
      to="/app/refill/patients/$patientId"
      params={{ patientId: patient.patientId }}
      className="block px-5 py-3 hover:bg-amber-100/40 dark:hover:bg-amber-500/10 transition"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate">
            {patient.displayName}
          </div>
          <div className="text-[11px] text-ink-soft mt-0.5">
            Last {kindShortLabel(patient.kind)}{" "}
            {formatRelative(patient.lastVisitOfKind)} ·{" "}
            {patient.lifetimeSpendUsd.toLocaleString("en-US", {
              style: "currency",
              currency: "USD",
              maximumFractionDigits: 0,
            })}{" "}
            lifetime
          </div>
        </div>
        <div className="shrink-0 flex items-center gap-2">
          {patient.phone && (
            <span
              className="text-[11px] text-ink-soft inline-flex items-center gap-1"
              title={patient.phone}
            >
              <Phone className="h-3 w-3" />
            </span>
          )}
          {patient.email && (
            <span
              className="text-[11px] text-ink-soft inline-flex items-center gap-1"
              title={patient.email}
            >
              <Mail className="h-3 w-3" />
            </span>
          )}
          <span
            className={cn(
              "rounded-full px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
              patient.isLapsed
                ? "bg-destructive/15 text-destructive"
                : "bg-amber-200/70 text-amber-900 dark:bg-amber-500/30 dark:text-amber-200",
            )}
          >
            {monthsOverdue >= 1
              ? `${monthsOverdue}mo overdue`
              : `${patient.daysOverdue}d overdue`}
          </span>
        </div>
      </div>
    </Link>
  );
}

function kindShortLabel(k: ProductKind): string {
  switch (k) {
    case "toxin":
      return "toxin";
    case "filler":
      return "filler";
    case "biostimulator":
      return "biostim";
    case "device":
      return "device";
    case "retail":
      return "retail";
    case "reward":
      return "reward";
    case "payment":
      return "payment";
    case "discount":
      return "discount";
    case "service":
      return "service";
    case "note":
      return "note";
    default:
      return k;
  }
}

function formatRelative(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  const then = Date.UTC(y, m - 1, d);
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.round(days / 30)}mo ago`;
  return `${Math.round(days / 365 * 10) / 10}yr ago`;
}

function ActivationBanner() {
  // v263 ships the dashboard surface; Hosted Messaging activation status is
  // tracked out-of-band today (paperwork-only). When the per-account
  // activation_status field lands, swap this for a state-aware banner with
  // sandbox / pending / live variants.
  return (
    <div className="rounded-2xl border border-amber-400/30 bg-amber-50 dark:bg-amber-950/20 p-5 flex items-start gap-4">
      <div className="h-9 w-9 rounded-lg bg-amber-200/60 dark:bg-amber-500/20 flex items-center justify-center shrink-0">
        <Sparkles className="h-4 w-4 text-amber-700 dark:text-amber-400" />
      </div>
      <div className="flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-foreground">Sandbox mode</span>
          <span className="rounded-full bg-amber-200/60 dark:bg-amber-500/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-800 dark:text-amber-300">
            Not live yet
          </span>
        </div>
        <p className="text-xs text-ink-soft leading-relaxed">
          SmartSpa has your spa loaded but isn't replying to customer texts yet. We're
          coordinating Hosted Messaging activation with your carrier — this is a
          1-3 week paperwork process that runs in parallel with the work you do
          here. We'll reach out to schedule activation; nothing for you to do today.
        </p>
      </div>
    </div>
  );
}

function ProfileEditor({
  profile,
  onProfileUpdate,
}: {
  profile: SpaProfile;
  onProfileUpdate: (p: SpaProfile) => void;
}) {
  const data = profile.data;
  const [spaName, setSpaName] = useState(data.spaName ?? "");
  const [services, setServices] = useState<SpaScrapeService[]>(data.services ?? []);
  const [hours, setHours] = useState(data.hours ?? "");
  const [schedulingLink, setSchedulingLink] = useState(data.schedulingLink ?? "");
  const [contactEmail, setContactEmail] = useState(data.contactEmail ?? "");
  const [contactPhone, setContactPhone] = useState(data.contactPhone ?? "");
  const [address, setAddress] = useState(data.address ?? "");
  const [policiesText, setPoliciesText] = useState((data.policies ?? []).join("\n"));
  const [saving, setSaving] = useState(false);

  // Track baseline so we can show "Save"/"Reset" only when something changed.
  const baselineRef = useBaselineRef({
    spaName: data.spaName ?? "",
    services: data.services ?? [],
    hours: data.hours ?? "",
    schedulingLink: data.schedulingLink ?? "",
    contactEmail: data.contactEmail ?? "",
    contactPhone: data.contactPhone ?? "",
    address: data.address ?? "",
    policiesText: (data.policies ?? []).join("\n"),
  });

  const dirty = isDirty(
    {
      spaName,
      services,
      hours,
      schedulingLink,
      contactEmail,
      contactPhone,
      address,
      policiesText,
    },
    baselineRef.current,
  );

  function resetToServer() {
    setSpaName(data.spaName ?? "");
    setServices(data.services ?? []);
    setHours(data.hours ?? "");
    setSchedulingLink(data.schedulingLink ?? "");
    setContactEmail(data.contactEmail ?? "");
    setContactPhone(data.contactPhone ?? "");
    setAddress(data.address ?? "");
    setPoliciesText((data.policies ?? []).join("\n"));
  }

  async function handleSave(e?: FormEvent) {
    e?.preventDefault();
    if (saving || !dirty) return;
    setSaving(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        toast.error("Sign-in lost — refresh and try again.");
        return;
      }
      const updated = await updateSpaProfile({
        data: {
          accessToken: token,
          edits: {
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
          },
        },
      });
      onProfileUpdate(updated);
      toast.success("Saved. SmartSpa's brain is up to date.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save changes.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSave} className="space-y-5">
      <div className="rounded-2xl border border-border bg-card p-5 lg:p-6 space-y-3">
        <FieldLabel icon={Sprout}>Practice name</FieldLabel>
        <input
          type="text"
          value={spaName}
          onChange={(e) => setSpaName(e.target.value)}
          placeholder="Your spa's brand name"
          className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <ServicesEditCard services={services} onChange={setServices} />

        <EditCard icon={Calendar} title="Scheduling">
          <FieldLabel>Booking link</FieldLabel>
          <input
            type="url"
            value={schedulingLink}
            onChange={(e) => setSchedulingLink(e.target.value)}
            placeholder="https://app.acuityscheduling.com/…"
            className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <FieldLabel icon={Clock}>Hours</FieldLabel>
          <textarea
            value={hours}
            onChange={(e) => setHours(e.target.value)}
            placeholder={"Mon-Fri 9-6\nSat 10-4\nSun closed"}
            rows={3}
            className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm font-mono leading-relaxed focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <p className="text-[11px] text-ink-soft">
            Leave hours empty if you don't post them publicly.
          </p>
        </EditCard>

        <EditCard icon={MapPin} title="Contact">
          <FieldLabel icon={Mail}>Email</FieldLabel>
          <input
            type="email"
            value={contactEmail}
            onChange={(e) => setContactEmail(e.target.value)}
            placeholder="info@yourspa.com"
            className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <FieldLabel icon={Phone}>Phone</FieldLabel>
          <input
            type="tel"
            value={contactPhone}
            onChange={(e) => setContactPhone(e.target.value)}
            placeholder="(303) 555-1234"
            className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <FieldLabel icon={MapPin}>Address</FieldLabel>
          <input
            type="text"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="1234 Main St, Denver, CO 80202"
            className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
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
            className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <p className="text-[11px] text-ink-soft">
            SmartSpa will follow these. Add cancellation, deposits, age rules,
            anything it should enforce.
          </p>
        </EditCard>
      </div>

      <SaveBar
        dirty={dirty}
        saving={saving}
        onSave={() => void handleSave()}
        onReset={resetToServer}
      />
    </form>
  );
}

function SaveBar({
  dirty,
  saving,
  onSave,
  onReset,
}: {
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onReset: () => void;
}) {
  return (
    <div
      className={
        "sticky bottom-4 z-20 transition-all " +
        (dirty ? "opacity-100 translate-y-0" : "opacity-0 pointer-events-none translate-y-4")
      }
    >
      <div className="mx-auto max-w-2xl rounded-2xl border border-border bg-card/95 backdrop-blur shadow-lg flex items-center gap-3 px-4 py-3">
        <span className="text-xs text-ink-soft flex-1">
          You have unsaved changes.
        </span>
        <button
          type="button"
          onClick={onReset}
          disabled={saving}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-50 transition"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Reset
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald text-paper px-4 py-1.5 text-xs font-semibold hover:opacity-90 disabled:opacity-60 transition"
        >
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Save className="h-3.5 w-3.5" />
          )}
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </div>
  );
}

// ─── Building blocks ──────────────────────────────────────────────────────
// Mirrors the EditCard / ServicesEditCard shapes from claim-your-business.tsx
// intentionally — the same mental model for "what Emma knows" applies on
// both surfaces. Kept local rather than extracted to a shared component
// because the two routes might diverge as the dashboard grows (e.g., per-card
// save buttons, version history, audit trail) and premature shared abstraction
// would slow that down.

function FieldLabel({
  icon: Icon,
  children,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <label className="text-xs font-medium text-ink-soft flex items-center gap-1.5">
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
    <div className="rounded-2xl border border-border bg-card p-5 space-y-3">
      <div className="flex items-center gap-2">
        <div className="h-7 w-7 rounded-lg bg-emerald/10 flex items-center justify-center">
          <Icon className="h-3.5 w-3.5 text-emerald" />
        </div>
        <div className="text-sm font-semibold">{title}</div>
      </div>
      <div className="space-y-2.5">{children}</div>
    </div>
  );
}

// ServicesEditCard moved to @/components/ServicesEditCard as of v269 — shared
// with /claim-your-business after the v265.1+v266 lockstep tax confirmed the
// "intentionally not extracted" v264 rationale had inverted.

// ─── Helpers ──────────────────────────────────────────────────────────────

type Snapshot = {
  spaName: string;
  services: SpaScrapeService[];
  hours: string;
  schedulingLink: string;
  contactEmail: string;
  contactPhone: string;
  address: string;
  policiesText: string;
};

function isDirty(current: Snapshot, baseline: Snapshot): boolean {
  if (current.spaName !== baseline.spaName) return true;
  if (current.hours !== baseline.hours) return true;
  if (current.schedulingLink !== baseline.schedulingLink) return true;
  if (current.contactEmail !== baseline.contactEmail) return true;
  if (current.contactPhone !== baseline.contactPhone) return true;
  if (current.address !== baseline.address) return true;
  if (current.policiesText !== baseline.policiesText) return true;
  if (current.services.length !== baseline.services.length) return true;
  for (let i = 0; i < current.services.length; i++) {
    if (current.services[i].name !== baseline.services[i].name) return true;
  }
  return false;
}

// Hook helper: keeps a stable ref to the most recent baseline (initial server
// state) so the dirty check compares against pristine, not against last render.
function useBaselineRef<T>(initial: T) {
  const ref = useRef<T>(initial);
  // Only update when the identity actually changes (e.g. after a save returns
  // fresh server data and the component receives a new profile).
  useEffect(() => {
    ref.current = initial;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(initial)]);
  return ref;
}

function hostname(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
