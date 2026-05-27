/**
 * RefillShellChrome — Refill standalone-product workspace header +
 * DemoBanner + RefillNav, factored into a single shell-level component (v410).
 *
 * Mirror of RepShellChrome for the spa-owner side of the Refill product.
 * Per [[project-refill-trojan-horse-thesis]], the chrome stays narrow:
 * 4 nav chips, "Refill" identity, "/ no-show recovery" subtitle. Looks
 * like a feature, not a platform. Same emerald + paper palette as the rep
 * platform so the two surfaces read as siblings.
 *
 * Active chip derived from useLocation() — callers don't pass an `active`
 * prop, the shell always knows which route is mounted.
 */
import { Link, useLocation } from "@tanstack/react-router";
import { LogOut, Moon, Settings, Sparkles, Sun } from "lucide-react";
import { useEffect, useState } from "react";

import { DemoBanner } from "@/components/DemoBanner";
import { NotificationCenter } from "@/components/NotificationCenter";
import { RefillNav, type RefillNavKey } from "@/components/refill/RefillNav";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useAuth } from "@/lib/auth";
import { CHANGELOG, currentVersion } from "@/lib/changelog";
import { applyTheme, getStoredTheme, type Theme } from "@/lib/theme";
import type { MyTenant } from "@/server/refill-tenants";

function deriveActiveKey(pathname: string): RefillNavKey | undefined {
  if (pathname.startsWith("/app/refill/recovery")) return "recovery";
  if (pathname.startsWith("/app/refill/inbox")) return "inbox";
  if (pathname.startsWith("/app/refill/settings")) return "settings";
  if (pathname.startsWith("/app/billing") || pathname.startsWith("/app/refill/billing")) return "billing";
  // /app/refill (Refill home) and any unrecognized path: no chip active.
  return undefined;
}

export function RefillShellChrome({
  tenant,
  viewAs,
}: {
  tenant: MyTenant;
  /**
   * v1.19 — when the parent shell rendered via the admin-fallback path
   * (admin user with no tenant_memberships row), we get viewAs="admin"
   * and show a banner so the admin knows they're not on their own data.
   */
  viewAs?: "admin";
}) {
  const location = useLocation();
  const { user, signOut } = useAuth();
  const [theme, setTheme] = useState<Theme>("system");
  useEffect(() => setTheme(getStoredTheme()), []);

  const toggleTheme = () => {
    const root = document.documentElement;
    const next: Theme = root.classList.contains("dark") ? "light" : "dark";
    applyTheme(next);
    setTheme(next);
  };

  const activeKey = deriveActiveKey(location.pathname);

  return (
    <>
      <header
        className="sticky top-0 z-30 border-b backdrop-blur"
        style={{
          background: "rgba(251, 250, 247, 0.92)",
          borderColor: "#e6e2d6",
        }}
      >
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
          <Link to="/app/refill" className="flex items-center gap-2.5 shrink-0">
            <div
              className="flex h-8 w-8 items-center justify-center rounded-lg font-semibold"
              style={{ background: "#056048", color: "#fbfaf7" }}
              aria-hidden
            >
              R
            </div>
            <div className="hidden sm:block leading-tight">
              <div
                className="text-sm font-semibold tracking-tight"
                style={{ color: "#1c2024" }}
              >
                Refill
              </div>
              <div className="text-[11px] -mt-0.5" style={{ color: "#8a9098" }}>
                / no-show recovery
              </div>
            </div>
          </Link>

          <div className="ml-auto flex items-center gap-1">
            <NotificationCenter />
            <VersionPill />
            <button
              onClick={toggleTheme}
              title={theme === "dark" ? "Light mode" : "Dark mode"}
              aria-label={theme === "dark" ? "Light mode" : "Dark mode"}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-soft hover:bg-sidebar-accent/60 hover:text-foreground transition-colors"
            >
              {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
            <Link
              to="/app/refill/settings/scheduler"
              className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs text-ink-soft hover:bg-sidebar-accent/60 hover:text-foreground transition-colors"
              title="Settings"
            >
              <Settings className="h-3.5 w-3.5" />
              <span className="hidden sm:inline truncate max-w-[14ch]">{user?.email}</span>
            </Link>
            <button
              onClick={signOut}
              title="Sign out"
              aria-label="Sign out"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-soft hover:bg-sidebar-accent/60 hover:text-foreground transition-colors"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-4 pt-4">
        <DemoBanner />
        {viewAs === "admin" && (
          <div
            className="mb-3 rounded-lg border px-3 py-2 text-[12px] flex items-center gap-2"
            style={{
              background: "#fdf6dc",
              borderColor: "rgba(138, 109, 12, 0.3)",
              color: "#8a6d0c",
            }}
          >
            <Sparkles className="h-3.5 w-3.5 shrink-0" />
            <span>
              Viewing as <strong>{tenant.name}</strong> (admin fallback).
              Data fetchers still filter by your own user_id, so patient /
              recovery surfaces may read empty until cross-tenant data-view
              is wired (queued v1.20+).
            </span>
          </div>
        )}
        <RefillNav active={activeKey} />
      </div>
    </>
  );
}

// ─── VersionPill ─────────────────────────────────────────────────────────
//
// Single v-pill per session, sitting in the chrome top-right strip. Click
// → Popover with the full changelog. Relocated here from PageHeader in
// v1.4.1 so the v-pill doesn't duplicate on every authed page (which
// pulled focus away from the page's actual headline).

function VersionPill() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="What's new"
          title="What's new"
          className="inline-flex h-7 items-center rounded-full px-2.5 text-[11px] font-semibold tracking-wide transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          style={{
            background: "#e8f3ed",
            color: "#056048",
          }}
        >
          {currentVersion()}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="border-b border-border px-4 py-3 flex items-center gap-2">
          <Sparkles className="h-3.5 w-3.5" style={{ color: "#056048" }} />
          <div className="text-sm font-semibold">What's new</div>
        </div>
        <div className="max-h-80 overflow-y-auto divide-y divide-border">
          {CHANGELOG.map((entry) => (
            <div key={entry.version} className="px-4 py-3">
              <div className="flex items-baseline justify-between gap-2 mb-1.5">
                <div className="text-xs font-semibold text-foreground">
                  {entry.version}
                </div>
                <div className="text-[10px] uppercase tracking-wide text-ink-soft">
                  {entry.date}
                </div>
              </div>
              <ul className="space-y-1">
                {entry.items.map((item, i) => (
                  <li
                    key={i}
                    className="text-xs leading-relaxed text-ink-soft pl-3 relative before:content-['•'] before:absolute before:left-0 before:text-[#056048]"
                    dangerouslySetInnerHTML={{ __html: item }}
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
