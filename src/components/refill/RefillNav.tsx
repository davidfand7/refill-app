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
 * Recapture). Reason: Patients (WHO) and Catalog (WHAT) are the two data
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
  | "calendar"
  | "catalog"
  | "buying"
  | "rewards"
  | "recovery"
  | "skills"
  | "settings";

type RefillNavItem = {
  key: RefillNavKey;
  to: string;
  label: string;
  shortLabel: string;
  /** Render a visual group divider after this chip. */
  dividerAfter?: boolean;
};

// v2.3.19 (IA reorg, "Solutions-first" grouping): the chip row now reads as
// two clusters with a divider between them —
//   [ Solutions ]            [ Spine / data + back-office ]
//   Calendar · Promos · Refill  |  Patients · Catalog · Account
// The action Solutions (the daily-driver workspaces) lead; the data
// primitives (Patients = WHO, Catalog = WHAT) + back-office (Account) follow.
// (History: v1.34.1 promoted Promos into nav; v2.1.0 made the strip
// Solution-oriented under the SmartSpa umbrella — Calendar merged
// Appointments+Schedule + owns booking/connections; "Refill" became the
// no-show-recovery Solution as the Agents section dissolved.)
const ITEMS: RefillNavItem[] = [
  // ── Solutions (action workspaces) ──────────────────────────────────────
  { key: "calendar", to: "/app/refill/calendar/schedule", label: "Calendar", shortLabel: "Calendar" },
  // v2.200.0: the old "Incentives"/"Recognition" Solution split by RECIPIENT
  // into two first-class chips (project_buying_rewards_taxonomy):
  //   • Buying  = spa-side — samples (inventory) + tiers (program) [+ Deal Desk].
  //   • Rewards = patient-side — manufacturer loyalty + offers + Renew (recall).
  // Route namespace stays /recognition (same labels-over-namespace pattern as
  // Recapture over /recovery); the shell's deriveActiveKey routes each sub-path
  // to the right chip.
  { key: "buying",  to: "/app/refill/recognition/deal", label: "Buying",  shortLabel: "Buying" },
  { key: "rewards", to: "/app/refill/recognition/rewards",   label: "Rewards", shortLabel: "Rewards" },
  // The Refill Solution: prevent (reminders) + recover (rescue) no-shows.
  // v2.175.1: chip labeled "Recapture" to match the page title (closing the
  // chip≠title island). Route namespace + Solution stay "refill/recovery" —
  // same pattern as Incentives keeping /recognition while the chip reads
  // Incentives.
  { key: "recovery", to: "/app/refill/recovery",           label: "Recapture", shortLabel: "Recapture", dividerAfter: true },
  // ── Spine (ownership layer + data primitives + back-office) ────────────
  // "Skills" (v2.19.0): the cross-solution Ownership Flywheel surface — the
  // routines SmartSpa runs across every Solution. Earned-gated at the page
  // level (hidden until the first verified win). Placement provisional per
  // project_skill_funnel's open IA decision.
  { key: "skills",   to: "/app/refill/skills",             label: "Skills",   shortLabel: "Skills" },
  { key: "patients", to: "/app/refill/patients",          label: "Patients", shortLabel: "Patients" },
  { key: "catalog",  to: "/app/refill/catalog/services",  label: "Catalog",  shortLabel: "Catalog" },
  // "Account" (Spine back-office): Reports + Login/Sender/Spa profile/
  // Lite mode + Billing/Attribution. Reports leads, so the chip lands there.
  // (Inbox→Refill, Billing→here folded in v2.1.1; Reports→here v2.1.2.)
  { key: "settings", to: "/app/refill/reports",            label: "Account", shortLabel: "Account" },
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
          <div key={item.key} className="inline-flex items-center gap-1">
            <Link
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
            {item.dividerAfter && (
              <span
                aria-hidden="true"
                className="mx-1.5 hidden h-5 w-px sm:inline-block"
                style={{ background: "#e6e2d6" }}
              />
            )}
          </div>
        );
      })}
    </nav>
  );
}
