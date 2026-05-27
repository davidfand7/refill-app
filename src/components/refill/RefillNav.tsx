/**
 * RefillNav — horizontal chip nav for the Refill standalone shell (v410).
 *
 * Per [[project-refill-trojan-horse-thesis]]: stays narrow. v1.20.2 lifted
 * Patients into the chip bar as the first chip to match the RefillHome
 * quick-actions ordering (Patients leads). The chip bar is still tight
 * (5 chips) and stays anchored to the no-show-recovery loop — patients
 * are the underlying data anchor that everything else operates on, so
 * it earns its place. New chips beyond these 5 still signal platform
 * ambition and would break the stealth positioning.
 *
 * Same component shape as RepNav so the visual identity reads "sibling
 * product" — Refill chrome is family with the Rep platform chrome, not
 * a separate look.
 */

import { Link } from "@tanstack/react-router";

export type RefillNavKey =
  | "patients"
  | "recovery"
  | "inbox"
  | "settings"
  | "billing";

type RefillNavItem = {
  key: RefillNavKey;
  to: string;
  label: string;
  shortLabel: string;
};

const ITEMS: RefillNavItem[] = [
  { key: "patients", to: "/app/refill/patients",          label: "Patients", shortLabel: "Patients" },
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
