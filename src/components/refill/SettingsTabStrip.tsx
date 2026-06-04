/**
 * Horizontal tab strip rendered at the top of every /app/refill/settings/*
 * page so Karen can cross-navigate between Scheduler / Account / Sender /
 * Spa profile / Light mode without going back through nav chip → breadcrumb.
 * Same pattern as AgentsTabStrip. Established v1.44.1 as part of the
 * discoverability sweep — pre-ship, the 4 non-scheduler settings pages
 * (Account, Sender, Spa profile, Light mode) were reachable only by direct
 * URL despite being fully built.
 */

import { Link } from "@tanstack/react-router";
import { Plug, UserCog, AtSign, Building2, Mail } from "lucide-react";
import { cn } from "@/lib/utils";

type SettingsTab = "scheduler" | "account" | "sender" | "spa-profile" | "light-mode";

const TABS: Array<{
  key: SettingsTab;
  to: string;
  label: string;
  icon: typeof Plug;
}> = [
  { key: "scheduler", to: "/app/refill/settings/scheduler", label: "Scheduler", icon: Plug },
  { key: "account", to: "/app/refill/settings/account", label: "Account", icon: UserCog },
  { key: "sender", to: "/app/refill/settings/sender", label: "Sender", icon: AtSign },
  { key: "spa-profile", to: "/app/refill/settings/spa-profile", label: "Spa profile", icon: Building2 },
  { key: "light-mode", to: "/app/refill/settings/light-mode", label: "Light mode", icon: Mail },
];

export function SettingsTabStrip({ active }: { active: SettingsTab }) {
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
