/**
 * RefillHome — the Refill standalone-product spa-owner landing dashboard (v410).
 *
 * Mounts at /app/refill when the signed-in user resolves to a tenant on the
 * Refill product (gated by the persona branch in app.emma.index.tsx).
 * Mirror of RepHome for the rep platform side.
 *
 * Per [[project-refill-trojan-horse-thesis]]: stays narrow forever. Hero +
 * 4 quick-action cards (one per nav chip) + LiveRecoveryFeed placeholder
 * (full widget lands in v410.1). No "explore more features" surfaces, no
 * upgrade CTAs — Refill is a single-feature widget by design.
 *
 * Three regions:
 *   1. Hero — "Hey {firstName}." + short tagline
 *   2. Quick actions grid — 5 cards: Patients / Recapture / Inbox / Settings /
 *      Billing. Patients leads (the underlying data anchor), followed by the
 *      4 chip-nav surfaces. v1.20.1 added the Patients card — chip nav
 *      stays 4-locked per trojan-horse thesis; the grid is the soft
 *      discoverability surface for /app/refill/patients.
 *   3. LiveRecoveryFeed slot — v410 placeholder; v410.1 wires the realtime
 *      ticker against recovery_events for this tenant
 */

import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  ArrowRight,
  Award,
  BarChart3,
  Bell,
  BookOpen,
  Calendar,
  CreditCard,
  DollarSign,
  Inbox,
  Megaphone,
  Plug,
  Share2,
  UserPlus,
  Users,
  type LucideIcon,
} from "lucide-react";

import { useAuth } from "@/lib/auth";
import { greet } from "@/lib/refill-voice";
import { useTenantMembership } from "@/lib/use-tenant-membership";
import { LiveRecoveryFeed } from "@/components/refill/LiveRecoveryFeed";
import { listVisibleNavFeaturesForTenant } from "@/server/refill-nav-features.functions";

type QuickAction = {
  key: string;
  to: string;
  label: string;
  subtitle: string;
  icon: LucideIcon;
  /** v1.44.2: optional feature_key for the nav-features registry. When set,
   *  the card only renders if listVisibleNavFeaturesForTenant returns this
   *  key for the current tenant. Cards WITHOUT featureKey are always-on
   *  (the daily/weekly core flow). */
  featureKey?: string;
};

// v1.34.1 (coherency pass): dashboard quick-actions now mirror nav chips
// 1:1. Catalog + Promos added so the dashboard reflects the same surface
// area Karen can reach from the chip strip. Same order as RefillNav.
const ACTIONS: QuickAction[] = [
  {
    key: "patients",
    to: "/app/refill/patients",
    label: "Patients",
    subtitle: "Your roster, cadence, and waitlist",
    icon: Users,
  },
  {
    key: "appointments",
    to: "/app/refill/calendar/appointments",
    label: "Appointments",
    subtitle: "Calendar source of truth + CSV import",
    icon: Calendar,
  },
  {
    key: "catalog",
    to: "/app/refill/catalog/services",
    label: "Catalog",
    subtitle: "Services and products you offer",
    icon: BookOpen,
  },
  {
    key: "recognition",
    to: "/app/refill/recognition/inventory",
    label: "Incentives",
    subtitle: "Rewards, recall, allocation & manufacturer incentives",
    icon: Award,
  },
  {
    key: "agents",
    to: "/app/refill/recovery/preshow",
    label: "Agents",
    subtitle: "Preshow reminders + cadence profiles",
    icon: Bell,
  },
  {
    key: "recovery",
    to: "/app/refill/recovery",
    label: "Recapture",
    subtitle: "See what Refill recovered for you",
    icon: DollarSign,
  },
  {
    key: "reports",
    to: "/app/refill/reports",
    label: "Reports",
    subtitle: "Promotions funnel + per-campaign rollups",
    icon: BarChart3,
  },
  {
    // v1.44.2: feature-flagged via nav.campaigns. Default OFF in the registry;
    // admin enables per-tenant via /app/admin/nav-features. Rejuv flips on
    // first as the proof-of-pattern for the opt-in nav surface.
    key: "campaigns",
    to: "/app/refill/campaigns",
    label: "Campaigns",
    subtitle: "Marketing blast composer (manual cohort sends)",
    icon: Megaphone,
    featureKey: "nav.campaigns",
  },
  // v1.44.3: remaining orphans from the 2026-06-03 audit registered as
  // featureKey-gated cards. All default OFF; admin enables per-tenant.
  // Sharing stays invisible until rep-side reader ships (half-built P4).
  {
    key: "sharing",
    to: "/app/refill/sharing",
    label: "Data sharing",
    subtitle: "Grant per-rep access to your aggregate metrics",
    icon: Share2,
    featureKey: "nav.sharing",
  },
  {
    key: "waitlist-invite",
    to: "/app/refill/waitlist/invite",
    label: "Waitlist invite",
    subtitle: "Cold opt-in composer for new patients",
    icon: UserPlus,
    featureKey: "nav.waitlist.invite",
  },
  {
    key: "waitlist-seed",
    to: "/app/refill/waitlist/seed",
    label: "Waitlist seed (per patient)",
    subtitle: "Manually add a waitlist intent for one patient",
    icon: UserPlus,
    featureKey: "nav.waitlist.seed",
  },
  {
    key: "waitlist-bulk",
    to: "/app/refill/waitlist/bulk",
    label: "Waitlist seed (bulk)",
    subtitle: "Migrate a cohort onto Refill's waitlist at once",
    icon: UserPlus,
    featureKey: "nav.waitlist.bulk",
  },
  {
    key: "inbox",
    to: "/app/refill/inbox",
    label: "Inbox",
    subtitle: "Patient replies and rescue threads",
    icon: Inbox,
  },
  {
    key: "settings",
    to: "/app/refill/calendar/connections",
    label: "Settings",
    subtitle: "Scheduler, sender, and rules",
    icon: Plug,
  },
  {
    key: "billing",
    to: "/app/billing",
    label: "Billing",
    subtitle: "Invoices and plan",
    icon: CreditCard,
  },
];

export function RefillHome() {
  const membership = useTenantMembership();
  const { session } = useAuth();
  // v1.44.2: visible feature_keys for the current tenant from the
  // nav-features registry. Always-on cards (no featureKey) render
  // regardless; opt-in cards (with featureKey) only render when present.
  // Defaults to an empty set during load so opt-ins stay hidden until
  // resolution lands — safer than rendering then disappearing.
  const [visibleKeys, setVisibleKeys] = useState<Set<string> | null>(null);

  const tenantIdForLookup =
    membership.status === "tenant" ? membership.tenant.id : null;
  useEffect(() => {
    const accessToken = session?.access_token;
    if (!accessToken || !tenantIdForLookup) return;
    let cancelled = false;
    listVisibleNavFeaturesForTenant({
      data: { accessToken, tenantId: tenantIdForLookup, persona: "spa" },
    })
      .then((r) => {
        if (!cancelled) setVisibleKeys(new Set(r.visibleKeys));
      })
      .catch(() => {
        // Fail-soft: empty set means only always-on cards show. Better
        // than blocking the entire dashboard on a nav-flag fetch.
        if (!cancelled) setVisibleKeys(new Set());
      });
    return () => {
      cancelled = true;
    };
  }, [session?.access_token, tenantIdForLookup]);

  if (membership.status !== "tenant") return null;
  // v410.4 — useTenantMembership only resolves to "tenant" once useAuth has
  // a session (the hook reads session.access_token internally), so a tenant
  // status implies session.access_token exists. The TS non-null is safe.
  if (!session?.access_token) return null;
  const tenant = membership.tenant;
  // Greeting uses the tenant's name as the friendly anchor — Karen sees
  // "Hey Rejuv Skin Spa." which reads warmer than her email, and a tenant
  // owner is the persona we know exists.
  const greetingName = tenant.name;

  // Filter cards: always-on (no featureKey) render unconditionally; opt-in
  // cards render only when their key is in visibleKeys. While visibleKeys
  // is still loading (null), hide opt-ins so we don't flash them then
  // disappear.
  const visibleActions = ACTIONS.filter(
    (a) => !a.featureKey || (visibleKeys?.has(a.featureKey) ?? false),
  );

  return (
    <div className="px-4 sm:px-8 py-8 sm:py-12" style={{ color: "#1c2024" }}>
      <div className="mx-auto max-w-6xl">
        <Hero name={greetingName} />

        <SectionLabel>Quick actions</SectionLabel>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-10">
          {visibleActions.map((a) => (
            <ActionCard key={a.key} action={a} />
          ))}
        </div>

        <SectionLabel>Live</SectionLabel>
        <LiveRecoveryFeed
          accessToken={session.access_token}
          viewAsUserId={membership.viewAsUserId}
        />
      </div>
    </div>
  );
}

function Hero({ name }: { name: string }) {
  // v413: canonical name-anchored greeting via refill-voice.ts. RefillHome
  // is the reference implementation — every other Refill-shell signed-in
  // surface that knows the spa name should match this exact shape.
  return (
    <div className="mb-10">
      <h1
        className="text-[30px] sm:text-[36px] leading-[1.1] font-semibold tracking-tight mb-3"
        style={{
          fontFamily: "Georgia, 'Times New Roman', serif",
          color: "#1c2024",
        }}
      >
        {greet(name)}
      </h1>
      <p
        className="text-[15px] leading-[1.6] max-w-xl"
        style={{ color: "#5a6068" }}
      >
        Refill is watching your calendar for cancellations and turning them
        into recovered revenue. You only pay $5 for each booking we create.
      </p>
    </div>
  );
}

function ActionCard({ action }: { action: QuickAction }) {
  const Icon = action.icon;
  return (
    <Link
      to={action.to}
      className="group rounded-xl border bg-white p-5 transition hover:shadow-sm focus-visible:outline-none focus-visible:ring-2"
      style={{ borderColor: "#e6e2d6" }}
    >
      <div className="flex items-start justify-between gap-3">
        <div
          className="flex h-9 w-9 items-center justify-center rounded-lg shrink-0 transition-colors"
          style={{ background: "#e8f3ed" }}
        >
          <Icon className="h-[18px] w-[18px]" />
        </div>
        <ArrowRight
          className="h-4 w-4 mt-1 transition-transform group-hover:translate-x-0.5"
          style={{ color: "#8a9098" }}
        />
      </div>
      <div className="mt-4">
        <div
          className="text-[15px] font-semibold tracking-tight mb-1"
          style={{ color: "#1c2024" }}
        >
          {action.label}
        </div>
        <div className="text-[13px] leading-[1.45]" style={{ color: "#8a9098" }}>
          {action.subtitle}
        </div>
      </div>
    </Link>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="text-[11px] uppercase tracking-wider font-semibold mb-3"
      style={{ color: "#8a9098" }}
    >
      {children}
    </div>
  );
}
