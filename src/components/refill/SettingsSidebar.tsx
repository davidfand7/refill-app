/**
 * SettingsSidebar — the Account/back-office nav as a LEFT RAIL (v2.176.0).
 *
 * Replaces the old horizontal SettingsTabStrip (overflow-x-auto, 10 tabs) that
 * scrolled awkwardly. A settings hub with this many destinations wants a
 * vertical rail: every item visible at once, grouped, and room to grow as admin
 * items land (Grasshopper's call during the deep-dive sweep). Rendered ONCE by
 * RefillShell for any settings route — pages no longer embed their own nav.
 *
 * Active item derived from the pathname (longest `to` match wins, so
 * /app/billing/attribution beats /app/billing). Responsive: vertical rail on
 * md+, a horizontal scroll strip on mobile (a side rail would eat phone width).
 */
import { Link, useLocation } from "@tanstack/react-router";
import {
  UserCog,
  AtSign,
  Building2,
  Mail,
  Receipt,
  GitMerge,
  BarChart3,
  Activity,
  Palette,
  Factory,
} from "lucide-react";

import { cn } from "@/lib/utils";

type SettingsTab =
  | "reports"
  | "health"
  | "account"
  | "sender"
  | "spa-profile"
  | "brand"
  | "light-mode"
  | "manufacturers"
  | "billing"
  | "attribution";

const TABS: Record<SettingsTab, { to: string; label: string; icon: typeof UserCog }> = {
  reports: { to: "/app/refill/reports", label: "Reports", icon: BarChart3 },
  health: { to: "/app/refill/settings/health", label: "Health", icon: Activity },
  account: { to: "/app/refill/settings/account", label: "Login", icon: UserCog },
  sender: { to: "/app/refill/settings/sender", label: "Sender", icon: AtSign },
  "spa-profile": { to: "/app/refill/settings/spa-profile", label: "Spa profile", icon: Building2 },
  brand: { to: "/app/refill/settings/brand", label: "Your Brand", icon: Palette },
  "light-mode": { to: "/app/refill/settings/light-mode", label: "Lite mode", icon: Mail },
  manufacturers: { to: "/app/refill/settings/manufacturers", label: "Manufacturers", icon: Factory },
  billing: { to: "/app/billing", label: "Billing", icon: Receipt },
  attribution: { to: "/app/billing/attribution", label: "Attribution", icon: GitMerge },
};

// Grouped so the rail reads as a settings map, not a flat list — and so future
// admin items drop into their own group instead of lengthening one column.
const GROUPS: Array<{ heading: string; items: SettingsTab[] }> = [
  { heading: "Overview", items: ["reports"] },
  { heading: "Spa setup", items: ["spa-profile", "brand", "sender", "account"] },
  { heading: "Connections", items: ["health", "manufacturers"] },
  { heading: "Billing", items: ["billing", "attribution"] },
  { heading: "Modes", items: ["light-mode"] },
];

const ORDER: SettingsTab[] = GROUPS.flatMap((g) => g.items);

function deriveActive(pathname: string): SettingsTab | undefined {
  let best: { key: SettingsTab; len: number } | undefined;
  for (const key of ORDER) {
    const to = TABS[key].to;
    if (pathname === to || pathname.startsWith(to + "/") || pathname.startsWith(to)) {
      if (!best || to.length > best.len) best = { key, len: to.length };
    }
  }
  return best?.key;
}

export function SettingsSidebar() {
  const { pathname } = useLocation();
  const active = deriveActive(pathname);

  return (
    <>
      {/* Mobile: horizontal scroll strip (a side rail would eat phone width). */}
      <div className="md:hidden -mx-4 border-b border-rule bg-paper/50 px-4">
        <div className="flex items-center gap-1 overflow-x-auto">
          {ORDER.map((key) => {
            const t = TABS[key];
            const Icon = t.icon;
            const isActive = active === key;
            return (
              <Link
                key={key}
                to={t.to}
                className={cn(
                  "-mb-px inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-[12px] font-medium transition",
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

      {/* Desktop: grouped vertical rail. */}
      <nav className="hidden w-48 shrink-0 pt-6 md:block">
        {GROUPS.map((g) => (
          <div key={g.heading} className="mb-4">
            <div className="mb-1 px-3 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
              {g.heading}
            </div>
            {g.items.map((key) => {
              const t = TABS[key];
              const Icon = t.icon;
              const isActive = active === key;
              return (
                <Link
                  key={key}
                  to={t.to}
                  className={cn(
                    "flex items-center gap-2 rounded-lg px-3 py-1.5 text-[13px] font-medium transition",
                    isActive
                      ? "bg-emerald-soft text-emerald-ink"
                      : "text-ink-soft hover:bg-paper hover:text-ink",
                  )}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  {t.label}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
    </>
  );
}
