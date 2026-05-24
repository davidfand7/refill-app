/**
 * RepShellChrome — Refill-rep workspace header + DemoBanner + RepNav,
 * factored into a single shell-level component (Phase 3.1.4, v401).
 *
 * Before this ship, every rep route mounted its own DemoBanner +
 * RepNav inline AND called getMyRepAccount independently to know
 * whether to show the demo banner. That meant:
 *   - 6&times; duplicate getMyRepAccount roundtrips per rep session
 *   - 6 places to keep the demo-banner visible / wipe-instruction in sync
 *   - 6 places to update if the chip nav set ever changes
 *
 * Now the chrome lives ONCE in the shell, and per-route mounts of
 * &lt;DemoBanner&gt; / &lt;RepNav&gt; are stripped (Phase 3.1.10).
 *
 * Active chip is derived from useLocation(), not passed by callers —
 * the shell ALWAYS knows which route is mounted, so the callers don't
 * need to pass an `active` prop.
 *
 * Visual language: Refill emerald (#056048) on light ink (#fbfaf7) per
 * the rep-platform aesthetic. No sidebar. Workspace identity reads
 * &quot;Refill / Rep platform&quot; — not &quot;Agentiport / Workspace.&quot; This is the
 * fix for Pinch #6 (workspace identity leakage) from the 2026-05-22
 * Kelly Caffee dry-run.
 */
import { Link, useLocation } from "@tanstack/react-router";
import { LogOut, Moon, Settings, Sun } from "lucide-react";
import { useEffect, useState } from "react";

import { DemoBanner } from "@/components/lizzie/DemoBanner";
import { NotificationCenter } from "@/components/NotificationCenter";
import { RepNav } from "@/components/lizzie/RepNav";
import { useAuth } from "@/lib/auth";
import type { RepAccountRow } from "@/server/rep-platform";
import { applyTheme, getStoredTheme, type Theme } from "@/lib/theme";

type RepNavKey =
  | "home"
  | "economics"
  | "referral-links"
  | "outreach"
  | "recruit"
  | "network"
  | "ledger"
  | "integrations";

function deriveActiveKey(pathname: string): RepNavKey | undefined {
  if (pathname.startsWith("/app/rep/economics")) return "economics";
  if (pathname.startsWith("/app/rep/referral-links")) return "referral-links";
  // v408: recruit check must precede outreach since "/recruit" and "/outreach"
  // are distinct prefixes and order doesn't matter here, but keeping them
  // adjacent visually mirrors the nav order.
  if (pathname.startsWith("/app/rep/recruit")) return "recruit";
  if (pathname.startsWith("/app/rep/outreach")) return "outreach";
  if (pathname.startsWith("/app/rep/network")) return "network";
  if (pathname.startsWith("/app/rep/ledger")) return "ledger";
  if (pathname.startsWith("/app/rep/integrations")) return "integrations";
  // v412: /app/rep + /app/rep/ (rep home) light up the Home chip.
  // Exact match — not prefix — so nothing else accidentally claims it.
  if (pathname === "/app/rep" || pathname === "/app/rep/") return "home";
  return undefined;
}

export function RepShellChrome({ rep }: { rep: RepAccountRow }) {
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
          <Link to="/app/rep" className="flex items-center gap-2.5 shrink-0">
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
                Rep platform
              </div>
            </div>
          </Link>

          <div className="ml-auto flex items-center gap-1">
            <NotificationCenter />
            <button
              onClick={toggleTheme}
              title={theme === "dark" ? "Light mode" : "Dark mode"}
              aria-label={theme === "dark" ? "Light mode" : "Dark mode"}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-soft hover:bg-sidebar-accent/60 hover:text-foreground transition-colors"
            >
              {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
            <Link
              to="/app/settings"
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
        <DemoBanner isDemo={rep.isDemo} wipeFnName="wipe_kelly_demo_data" />
        <RepNav active={activeKey} />
      </div>
    </>
  );
}
