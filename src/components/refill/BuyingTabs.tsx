/**
 * Buying sub-nav (v2.200.0) — the spa-side of the manufacturer relationship.
 *
 * Half of the "Recognition" split (project_buying_rewards_taxonomy). Buying =
 * what you buy, the tiers it earns, the samples that sweeten it.
 *   • Samples = the incentive pool (portal-issued "on the books" +
 *     promo/samples "off the books"). Route stays /recognition/inventory.
 *   • Tiers   = the formal program ladder (tier = level = portfolio).
 *     Route stays /recognition/program.
 * Deal Desk (the Purchase⇄Samples⇄Promo capture) arrives Phase 2 as a third
 * tab; Allocation folded into it (still reachable by URL meanwhile).
 */

import { Link } from "@tanstack/react-router";
import { Layers, Target, Handshake } from "lucide-react";

export type BuyingTab = "deal" | "samples" | "tiers";

const TABS: Array<{
  key: BuyingTab;
  to: string;
  label: string;
  Icon: typeof Layers;
}> = [
  { key: "deal", to: "/app/refill/recognition/deal", label: "Deal Desk", Icon: Handshake },
  { key: "samples", to: "/app/refill/recognition/inventory", label: "Samples", Icon: Layers },
  { key: "tiers", to: "/app/refill/recognition/program", label: "Tiers", Icon: Target },
];

// active is optional so a folding/transitional Buying-side page (e.g. the
// de-listed Allocation route) can keep the sub-nav with nothing highlighted.
export function BuyingTabs({ active }: { active?: BuyingTab }) {
  return (
    <div className="border-b border-rule bg-paper/50">
      <div className="max-w-[960px] mx-auto px-4 lg:px-10 flex items-center gap-1">
        {TABS.map(({ key, to, label, Icon }) => (
          <Link
            key={key}
            to={to}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-[12px] font-medium border-b-2 -mb-px transition"
            style={{
              borderColor: active === key ? "#056048" : "transparent",
              color: active === key ? "#056048" : "#5a6068",
            }}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </Link>
        ))}
      </div>
    </div>
  );
}
