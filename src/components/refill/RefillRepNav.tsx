/**
 * RefillRepNav — chip nav for the Refill rep workspace.
 *
 * Sibling of RefillNav (spa-owner 4-chip nav). Stays narrow per
 * project_refill_trojan_horse_thesis — 7 chips for the rep's primary
 * surfaces, no overflow menu, no "more" affordance. The chip order
 * matches the daily-use frequency per memory `project_rep_to_rep_recruiting_outreach`:
 * Outreach → Recruit → Network → Commissions → Referral links → Integrations.
 * Home is the wordmark click (not a chip).
 */
import { Link } from "@tanstack/react-router";

export type RefillRepNavKey =
  | "outreach"
  | "recruit"
  | "network"
  | "ledger"
  | "referral-links"
  | "integrations";

const CHIPS: { key: RefillRepNavKey; label: string; to: string }[] = [
  { key: "outreach", label: "Outreach", to: "/app/rep/outreach" },
  { key: "recruit", label: "Recruit", to: "/app/rep/recruit" },
  { key: "network", label: "Network", to: "/app/rep/network" },
  { key: "ledger", label: "Commissions", to: "/app/rep/ledger" },
  { key: "referral-links", label: "Referral links", to: "/app/rep/referral-links" },
  { key: "integrations", label: "Integrations", to: "/app/rep/integrations" },
];

export function RefillRepNav({ active }: { active?: RefillRepNavKey }) {
  return (
    <nav className="flex flex-wrap items-center gap-1.5 pb-3 pt-1 overflow-x-auto">
      {CHIPS.map((chip) => {
        const isActive = chip.key === active;
        return (
          <Link
            key={chip.key}
            to={chip.to}
            className="inline-flex h-8 items-center rounded-full border px-3 text-[12px] font-medium transition whitespace-nowrap"
            style={{
              borderColor: isActive ? "#056048" : "#e6e2d6",
              background: isActive ? "#056048" : "transparent",
              color: isActive ? "#fbfaf7" : "#1c2024",
            }}
          >
            {chip.label}
          </Link>
        );
      })}
    </nav>
  );
}
