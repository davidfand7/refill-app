/**
 * RefillRepShellChrome — Refill rep workspace header + nav.
 *
 * Sibling of RefillShellChrome (spa-owner side). Renders:
 *   - Top header (Refill wordmark + theme/settings/sign-out user controls)
 *   - DemoBanner (when demo mode is on)
 *   - RefillRepNav (6-chip nav for primary rep surfaces)
 *
 * Per project_refill_trojan_horse_thesis: stays narrow + visually identical
 * to the spa-owner chrome so the two sides read as siblings, not as
 * different products.
 */
import { Link, useLocation } from "@tanstack/react-router";
import { LogOut, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

import { DemoBanner } from "@/components/DemoBanner";
import { NotificationCenter } from "@/components/NotificationCenter";
import { RefillRepNav, type RefillRepNavKey } from "@/components/refill/RefillRepNav";
import { useAuth } from "@/lib/auth";
import { applyTheme, getStoredTheme, type Theme } from "@/lib/theme";
import type { RepAccountRow } from "@/server/rep-platform";

function deriveActiveKey(pathname: string): RefillRepNavKey | undefined {
  if (pathname.startsWith("/app/rep/outreach")) return "outreach";
  if (pathname.startsWith("/app/rep/recruit")) return "recruit";
  if (pathname.startsWith("/app/rep/network")) return "network";
  if (pathname.startsWith("/app/rep/ledger")) return "ledger";
  if (pathname.startsWith("/app/rep/referral-links")) return "referral-links";
  if (pathname.startsWith("/app/rep/integrations")) return "integrations";
  return undefined;
}

export function RefillRepShellChrome({ rep: _rep }: { rep: RepAccountRow }) {
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
        style={{ background: "rgba(251, 250, 247, 0.92)", borderColor: "#e6e2d6" }}
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
                / rep platform
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
            <span
              className="hidden sm:inline truncate max-w-[14ch] text-xs px-2"
              style={{ color: "#8a9098" }}
              title={user?.email ?? ""}
            >
              {user?.email}
            </span>
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
        <RefillRepNav active={activeKey} />
      </div>
    </>
  );
}
