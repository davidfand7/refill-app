/**
 * RefillNav — horizontal chip nav for the Refill standalone shell (v410).
 *
 * Per [[project-refill-trojan-horse-thesis]]: this stays narrow forever.
 * 4 chips, no more. Refill is a single-feature widget — recovery, replies
 * to recovery, settings for recovery, and the bill. Adding more chips
 * would signal platform ambition and break the stealth positioning that
 * keeps incumbent PMS players from waking up to us.
 *
 * Same component shape as RepNav so the visual identity reads "sibling
 * product" — Refill chrome is family with the Rep platform chrome, not
 * a separate look.
 */

import { Link } from "@tanstack/react-router";

export type RefillNavKey = "recovery" | "inbox" | "settings" | "billing";

type RefillNavItem = {
  key: RefillNavKey;
  to: string;
  label: string;
  shortLabel: string;
};

const ITEMS: RefillNavItem[] = [
  { key: "recovery", to: "/app/refill/recovery",           label: "Recovery", shortLabel: "Recovery" },
  { key: "inbox",    to: "/app/refill/inbox",              label: "Inbox",    shortLabel: "Inbox" },
  { key: "settings", to: "/app/refill/settings/scheduler", label: "Settings", shortLabel: "Settings" },
  { key: "billing",  to: "/app/billing",                 label: "Billing",  shortLabel: "Billing" },
];

export function RefillNav({ active }: { active?: RefillNavKey }) {
  return (
    <nav
      aria-label="Refill navigation"
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
