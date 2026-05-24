/**
 * RepNav — horizontal nav for Refill Rep Platform routes (Phase 2G, v399).
 *
 * Always present at the top of every rep-facing surface (mounted via
 * RepShellChrome). Click-through chip nav — Kelly can jump anywhere from
 * anywhere without typing URLs.
 *
 * v412 — reordered + added Home as the first chip. Order is intentionally
 * sequential L→R so a first-time rep reading the chips left-to-right reads
 * the platform flow: Home → set up economics → mint a referral link → do
 * outreach → recruit downstream → check network → check commissions →
 * connect integrations. Repeat users use chips as random-access; the
 * sequence is orientation, not a wizard.
 *
 * The active chip is highlighted by passing `active` as one of the route
 * keys. Non-active chips use the link's Refill-green hover state.
 */

import { Link } from "@tanstack/react-router";

type RepNavKey =
  | "home"
  | "economics"
  | "referral-links"
  | "outreach"
  | "recruit"
  | "network"
  | "ledger"
  | "integrations";

type RepNavItem = {
  key: RepNavKey;
  to: string;
  label: string;
  shortLabel: string;
};

const ITEMS: RepNavItem[] = [
  // v412: explicit Home chip — only way back to RepHome used to be the
  // top-left Refill logo (non-obvious). Now everyone has a labeled
  // affordance no matter which surface they're on.
  { key: "home",           to: "/app/rep",                 label: "Home",                 shortLabel: "Home" },
  { key: "economics",      to: "/app/rep/economics",       label: "Commission economics", shortLabel: "Economics" },
  { key: "referral-links", to: "/app/rep/referral-links",  label: "Referral links",       shortLabel: "Links" },
  { key: "outreach",       to: "/app/rep/outreach",        label: "Outreach",             shortLabel: "Outreach" },
  // v408: recruit chip lives next to outreach so the two related surfaces
  // are visually adjacent in the nav.
  { key: "recruit",        to: "/app/rep/recruit",         label: "Recruit reps",         shortLabel: "Recruit" },
  { key: "network",        to: "/app/rep/network",         label: "Network",              shortLabel: "Network" },
  { key: "ledger",         to: "/app/rep/ledger",          label: "Commissions",          shortLabel: "Ledger" },
  { key: "integrations",   to: "/app/rep/integrations",    label: "Integrations",         shortLabel: "Apps" },
];

export function RepNav({ active }: { active?: RepNavKey }) {
  return (
    <nav
      aria-label="Rep platform navigation"
      className="-mx-2 mb-6 flex flex-wrap items-center gap-1"
    >
      {ITEMS.map((item) => {
        const isActive = item.key === active;
        return (
          <Link
            key={item.key}
            to={item.to}
            aria-current={isActive ? "page" : undefined}
            className="inline-flex items-center rounded-full px-3 py-1.5 text-[12px] font-semibold transition focus-visible:outline-none focus-visible:ring-2"
            style={{
              background: isActive ? "#056048" : "transparent",
              color: isActive ? "#fbfaf7" : "#5a6068",
              border: isActive ? "1px solid #056048" : "1px solid #e6e2d6",
            }}
          >
            <span className="hidden sm:inline">{item.label}</span>
            <span className="sm:hidden">{item.shortLabel}</span>
          </Link>
        );
      })}
    </nav>
  );
}
