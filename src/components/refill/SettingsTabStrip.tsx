/**
 * Horizontal tab strip rendered at the top of every /app/refill/settings/*
 * page so Karen can cross-navigate between Scheduler / Account / Sender /
 * Spa profile / Lite mode without going back through nav chip → breadcrumb.
 * Same pattern as AgentsTabStrip. Established v1.44.1 as part of the
 * discoverability sweep — pre-ship, the 4 non-scheduler settings pages
 * (Account, Sender, Spa profile, Lite mode) were reachable only by direct
 * URL despite being fully built.
 */

import { Link } from "@tanstack/react-router";
import { UserCog, AtSign, Building2, Mail, Receipt, GitMerge, BarChart3, Activity, Palette } from "lucide-react";
import { cn } from "@/lib/utils";

// The "Account" Solution (Spine back-office). Folded in over v2.1.0–v2.1.2:
// Scheduler/Online-booking left for the Calendar Solution; Billing +
// Attribution moved in (v2.1.1); Reports moved in as the lead tab (v2.1.2).
type SettingsTab =
  | "reports"
  | "health"
  | "account"
  | "sender"
  | "spa-profile"
  | "brand"
  | "light-mode"
  | "billing"
  | "attribution";

const TABS: Array<{
  key: SettingsTab;
  to: string;
  label: string;
  icon: typeof UserCog;
}> = [
  { key: "reports", to: "/app/refill/reports", label: "Reports", icon: BarChart3 },
  { key: "health", to: "/app/refill/settings/health", label: "Health", icon: Activity },
  { key: "account", to: "/app/refill/settings/account", label: "Login", icon: UserCog },
  { key: "sender", to: "/app/refill/settings/sender", label: "Sender", icon: AtSign },
  { key: "spa-profile", to: "/app/refill/settings/spa-profile", label: "Spa profile", icon: Building2 },
  { key: "brand", to: "/app/refill/settings/brand", label: "Your Brand", icon: Palette },
  { key: "light-mode", to: "/app/refill/settings/light-mode", label: "Lite mode", icon: Mail },
  { key: "billing", to: "/app/billing", label: "Billing", icon: Receipt },
  { key: "attribution", to: "/app/billing/attribution", label: "Attribution", icon: GitMerge },
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
