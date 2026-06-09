/**
 * Shared Recognition sub-nav (Patient-Profitability OS).
 *
 * One tab strip, four tabs: Inventory / Manufacturers / Rewards / Recall.
 * Previously inlined three different ways across the three route files —
 * extracted here (2026-06-07, P1 Recall) so a new tab is a one-line add
 * instead of a four-file edit that drifts.
 */

import { Link } from "@tanstack/react-router";
import { Gift, Layers, PhoneOutgoing, Sparkles, Wand2, Tag } from "lucide-react";

export type RecognitionTab =
  | "brand-promos"
  | "inventory"
  | "manufacturers"
  | "rewards"
  | "recall"
  | "allocation";

const TABS: Array<{
  key: RecognitionTab;
  to: string;
  label: string;
  Icon: typeof Layers;
}> = [
  { key: "brand-promos", to: "/app/refill/recognition/brand-promos", label: "Brand Promos", Icon: Tag },
  { key: "inventory", to: "/app/refill/recognition/inventory", label: "Inventory", Icon: Layers },
  { key: "manufacturers", to: "/app/refill/recognition/manufacturers", label: "Manufacturers", Icon: Sparkles },
  { key: "rewards", to: "/app/refill/recognition/rewards", label: "Rewards", Icon: Gift },
  { key: "recall", to: "/app/refill/recognition/recall", label: "Recall", Icon: PhoneOutgoing },
  { key: "allocation", to: "/app/refill/recognition/allocation", label: "Allocation", Icon: Wand2 },
];

export function RecognitionTabs({ active }: { active: RecognitionTab }) {
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
