/**
 * RefillNav — horizontal chip nav for the Refill standalone shell (v410).
 *
 * Per [[project-refill-trojan-horse-thesis]] the PUBLIC surfaces stay
 * narrow forever (landing / scan / onboard). The trojan-horse thesis is
 * about positioning to PROSPECTS who haven't logged in. Inside the
 * authenticated shell, the spa owner needs the surfaces they'll actually
 * use — hiding daily-use surfaces behind deep links makes them work harder.
 *
 * v1.29.2 added Catalog as the second chip (after Patients, before
 * Recovery). Reason: Patients (WHO) and Catalog (WHAT) are the two data
 * primitives every downstream engine reads from; surfacing both at the
 * top makes the mental model match the data model. Earlier nav guidance
 * was over-applied; the public landing pages stay narrow but the in-app
 * nav reflects actual usage.
 *
 * Same component shape as RepNav so the visual identity reads "sibling
 * product" — Refill chrome is family with the Rep platform chrome, not
 * a separate look.
 */

import { Link } from "@tanstack/react-router";

export type RefillNavKey =
  | "patients"
  | "catalog"
  | "promos"
  | "recognition"
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

// v1.34.1 (coherency pass): Promos chip promoted into nav. Sits in the
// "data primitives" cluster (Patients = WHO, Catalog = WHAT we sell,
// Promos = WHAT manufacturers offer us) before the action chips. The
// /app/refill/promos route was previously deep-link-only — orphan since
// the v341 port. Closes the discoverability gap.
const ITEMS: RefillNavItem[] = [
  { key: "patients", to: "/app/refill/patients",          label: "Patients", shortLabel: "Patients" },
  { key: "catalog",  to: "/app/refill/catalog/products",  label: "Catalog",  shortLabel: "Catalog" },
  { key: "promos",   to: "/app/refill/promos",            label: "Promos",   shortLabel: "Promos" },
  // v1.34.2: Recognition Allocation Engine. Lives between Promos and Recovery —
  // adjacent to Promos (both are manufacturer-rebate concepts) but distinct
  // (Promos = offers from manufacturers TO spa; Recognition = inventory
  // deployed FROM spa TO patients).
  { key: "recognition", to: "/app/refill/recognition/inventory", label: "Recognition", shortLabel: "Recognition" },
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
