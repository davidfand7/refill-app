/**
 * AppShell — outer always-on chrome.
 *
 * v1.24.0 architectural rebuild. Pre-rebuild, the chrome (sign-out,
 * PersonaSwitcher, version pill, theme toggle, email) was nested INSIDE
 * RefillShell and RepShell, which were conditionally mounted by app.tsx
 * based on tenant + role resolution. When the tenant fallback failed
 * (admin impersonating a non-tenant-owner, schema-cache lag, transient
 * server error), the whole chain collapsed and the user was trapped with
 * no chrome and no way to sign out.
 *
 * v1.24.0 separates concerns:
 *   - AppShell (this file): outer always-on universal infra. Sign-out,
 *     PersonaSwitcher, version pill, theme toggle, email. NEVER depends
 *     on tenant/role/shell resolution. If the user is signed in, they
 *     have sign-out.
 *   - RefillShellChrome / RefillRepShellChrome (inner): brand + nav
 *     chips + tenant-specific banners only. Render inside AppShell when
 *     the appropriate shell mounts. When no shell mounts, AppShell still
 *     renders, just without inner brand/nav.
 *
 * Brand customization is parameterized via the `subtitle` prop ("no-show
 * recovery" for Refill, "rep platform" for Rep, or undefined for the
 * fallback admin view). The brand link always points at /app — app.tsx's
 * auto-dispatch effect routes to the right home from there.
 *
 * Per Grasshopper 2026-05-27: the Lovable pattern. Chrome is the
 * outermost layer; content failures never take it down.
 */
import { Link } from "@tanstack/react-router";
import { LogOut, Moon, Sun } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { NotificationCenter } from "@/components/NotificationCenter";
import { PersonaSwitcher } from "@/components/admin/PersonaSwitcher";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useAuth } from "@/lib/auth";
import { CHANGELOG, currentVersion } from "@/lib/changelog";
import { applyTheme, getStoredTheme, type Theme } from "@/lib/theme";

import { Sparkles } from "lucide-react";

export function AppShell({
  subtitle,
  children,
}: {
  /** Optional brand subtitle — e.g. "no-show recovery", "rep platform".
   *  When omitted, renders just the Refill wordmark. Inner shells set
   *  this to differentiate spa-owner vs rep workspace; the fallback
   *  admin view omits it. */
  subtitle?: string;
  children: ReactNode;
}) {
  const { user, signOut } = useAuth();
  const [theme, setTheme] = useState<Theme>("system");
  useEffect(() => setTheme(getStoredTheme()), []);

  const toggleTheme = () => {
    const root = document.documentElement;
    const next: Theme = root.classList.contains("dark") ? "light" : "dark";
    applyTheme(next);
    setTheme(next);
  };

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
          <Link to="/app" className="flex items-center gap-2.5 shrink-0">
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
              {subtitle && (
                <div className="text-[11px] -mt-0.5" style={{ color: "#8a9098" }}>
                  / {subtitle}
                </div>
              )}
            </div>
          </Link>

          <div className="ml-auto flex items-center gap-1">
            <PersonaSwitcher />
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
            <span
              className="hidden sm:inline truncate max-w-[20ch] text-xs px-2"
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
      {children}
    </>
  );
}

// ─── VersionPill ─────────────────────────────────────────────────────────
// Moved here from RefillShellChrome so it lives with the rest of the
// always-on chrome.

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
