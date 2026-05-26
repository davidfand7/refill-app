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
 *   2. Quick actions grid — 4 cards: Recovery / Inbox / Settings / Billing
 *   3. LiveRecoveryFeed slot — v410 placeholder; v410.1 wires the realtime
 *      ticker against emma_recovery_events for this tenant
 */

import { Link } from "@tanstack/react-router";
import {
  ArrowRight,
  CreditCard,
  DollarSign,
  Inbox,
  Plug,
  type LucideIcon,
} from "lucide-react";

import { useAuth } from "@/lib/auth";
import { greet } from "@/lib/refill-voice";
import { useTenantMembership } from "@/lib/use-tenant-membership";
import { LiveRecoveryFeed } from "@/components/refill/LiveRecoveryFeed";

type QuickAction = {
  key: string;
  to: string;
  label: string;
  subtitle: string;
  icon: LucideIcon;
};

const ACTIONS: QuickAction[] = [
  {
    key: "recovery",
    to: "/app/refill/recovery",
    label: "Recovery",
    subtitle: "See what Refill recovered for you",
    icon: DollarSign,
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
    to: "/app/refill/settings/scheduler",
    label: "Settings",
    subtitle: "Scheduler, sender, and rules",
    icon: Plug,
  },
  {
    key: "billing",
    to: "/app/refill/billing",
    label: "Billing",
    subtitle: "Invoices and plan",
    icon: CreditCard,
  },
];

export function RefillHome() {
  const membership = useTenantMembership();
  const { session } = useAuth();
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

  return (
    <div className="px-4 sm:px-8 py-8 sm:py-12" style={{ color: "#1c2024" }}>
      <div className="mx-auto max-w-6xl">
        <Hero name={greetingName} />

        <SectionLabel>Quick actions</SectionLabel>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-10">
          {ACTIONS.map((a) => (
            <ActionCard key={a.key} action={a} />
          ))}
        </div>

        <SectionLabel>Live</SectionLabel>
        <LiveRecoveryFeed accessToken={session.access_token} />
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
        into recovered revenue. You only pay on the dollars that come back.
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
