/**
 * Horizontal tab strip rendered at the top of every /app/refill/agents/*
 * page so Karen can cross-navigate without going back through the nav
 * chip → breadcrumb chain. Established v1.34.6 when Rescue + Attribution
 * surfaces landed alongside Preshow.
 */

import { Link } from "@tanstack/react-router";
import { Award, Bell, Sparkles, Target } from "lucide-react";
import { cn } from "@/lib/utils";

type AgentTab = "preshow" | "rescue" | "attribution" | "recognition";

const TABS: Array<{
  key: AgentTab;
  to: string;
  label: string;
  icon: typeof Bell;
}> = [
  { key: "preshow", to: "/app/refill/agents/preshow", label: "Preshow", icon: Bell },
  { key: "rescue", to: "/app/refill/agents/rescue", label: "Rescue", icon: Sparkles },
  { key: "attribution", to: "/app/refill/agents/attribution", label: "Attribution", icon: Target },
  { key: "recognition", to: "/app/refill/agents/recognition", label: "Recognition", icon: Award },
];

export function AgentsTabStrip({ active }: { active: AgentTab }) {
  return (
    <div className="border-b border-rule bg-paper/50">
      <div className="max-w-5xl mx-auto px-4 lg:px-10 flex items-center gap-1 overflow-x-auto">
        {TABS.map((t) => {
          const isActive = active === t.key;
          const Icon = t.icon;
          return (
            <Link
              key={t.key}
              to={t.to}
              className={cn(
                "inline-flex items-center gap-1.5 px-3 py-2 text-[12px] font-medium transition border-b-2 -mb-px whitespace-nowrap",
                isActive
                  ? "border-emerald text-emerald-ink"
                  : "border-transparent text-ink-soft hover:text-ink",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {t.label}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
