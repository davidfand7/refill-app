/**
 * AdminNav — chip nav for /app/admin/* surfaces.
 *
 * v1.24.1. Pattern mirrors RefillNav but for the admin section. Unlike
 * the spa-owner / rep chrome (locked to 5 chips per the trojan-horse
 * thesis), admin is an operator surface — it can hold more chips without
 * leaking platform-ambition signals to spa owners (admin pages are
 * never reachable from outside).
 *
 * Renders at the top of every /app/admin/* page via app.tsx's admin
 * branch. Home link bounces back to the surface index when admin needs
 * the full card grid.
 */
import { Link, useLocation } from "@tanstack/react-router";
import { Home } from "lucide-react";

type AdminNavItem = {
  to: string;
  label: string;
  match: (pathname: string) => boolean;
};

const ITEMS: AdminNavItem[] = [
  {
    to: "/app/admin",
    label: "Home",
    match: (p) => p === "/app/admin" || p === "/app/admin/",
  },
  {
    to: "/app/admin/users",
    label: "Users",
    match: (p) => p.startsWith("/app/admin/users"),
  },
  {
    // v1.34.3: renamed from "/app/admin/flags" / "Flags" — old URL
    // redirects here. Match-fn covers both paths so the chip highlights
    // during the redirect grace period.
    to: "/app/admin/agents",
    label: "Agents",
    match: (p) =>
      p.startsWith("/app/admin/agents") || p.startsWith("/app/admin/flags"),
  },
  {
    to: "/app/admin/reports",
    label: "Reports",
    match: (p) => p.startsWith("/app/admin/reports"),
  },
  {
    to: "/app/admin/audit",
    label: "Audit log",
    match: (p) => p.startsWith("/app/admin/audit"),
  },
  {
    to: "/app/admin/outreach",
    label: "Outreach",
    match: (p) => p.startsWith("/app/admin/outreach"),
  },
  {
    to: "/app/admin/refill-trials",
    label: "Trials",
    match: (p) => p.startsWith("/app/admin/refill-trials"),
  },
];

export function AdminNav() {
  const location = useLocation();
  return (
    <nav
      aria-label="Admin navigation"
      className="mx-auto max-w-6xl px-4 pt-4"
    >
      <div className="-mx-2 mb-4 flex flex-wrap items-center gap-1">
        {ITEMS.map((item) => {
          const isActive = item.match(location.pathname);
          const isHome = item.to === "/app/admin";
          return (
            <Link
              key={item.to}
              to={item.to}
              aria-current={isActive ? "page" : undefined}
              className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-semibold transition focus-visible:outline-none focus-visible:ring-2"
              style={{
                background: isActive ? "#056048" : "transparent",
                color: isActive ? "#fbfaf7" : "#5a6068",
                border: isActive ? "1px solid #056048" : "1px solid #e6e2d6",
              }}
            >
              {isHome && <Home className="h-3 w-3" />}
              {item.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
