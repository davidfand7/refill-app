/**
 * RefillShellChrome — Refill spa-owner inner chrome (sub-nav + banners).
 *
 * v1.24.0 rebuild: the OUTER chrome (brand mark + sign-out + PersonaSwitcher
 * + version pill + theme toggle + email) moved up to AppShell, which renders
 * ABOVE every shell-selection branch in app.tsx. RefillShellChrome is now
 * just the inner spa-owner-specific surface: DemoBanner + the
 * admin-viewing-as banner (when applicable) + RefillNav chip strip.
 *
 * This separation is what makes the universal sign-out unconditional. If
 * tenant resolution fails for any reason, AppShell still renders its header;
 * the failure only shows up here (no chip strip, no banners) — never as
 * lost-sign-out.
 *
 * Active chip derived from useLocation() — callers don't pass an `active`
 * prop, the shell always knows which route is mounted.
 */
import { useLocation } from "@tanstack/react-router";
import { Sparkles } from "lucide-react";

import { DemoBanner } from "@/components/DemoBanner";
import { RefillNav, type RefillNavKey } from "@/components/refill/RefillNav";
import { WishlistWidget } from "@/components/WishlistWidget";
import { type MyTenant } from "@/server/refill-tenants";

function deriveActiveKey(pathname: string): RefillNavKey | undefined {
  // Calendar Solution absorbs the old Appointments + Schedule routes.
  if (
    pathname.startsWith("/app/refill/calendar") ||
    pathname.startsWith("/app/refill/schedule") ||
    pathname.startsWith("/app/refill/appointments")
  )
    return "calendar";
  if (pathname.startsWith("/app/refill/patients")) return "patients";
  if (pathname.startsWith("/app/refill/catalog")) return "catalog";
  // "Promos" Solution (recognition namespace; old /promos redirects in).
  if (pathname.startsWith("/app/refill/recognition")) return "recognition";
  // Refill Solution = recovery + dissolved preshow/rescue agents + Inbox tab.
  if (
    pathname.startsWith("/app/refill/recovery") ||
    pathname.startsWith("/app/refill/inbox")
  )
    return "recovery";
  // "Account" Solution (chip key stays "settings") absorbs Reports + Billing.
  if (
    pathname.startsWith("/app/refill/reports") ||
    pathname.startsWith("/app/refill/settings") ||
    pathname.startsWith("/app/billing") ||
    pathname.startsWith("/app/refill/billing")
  )
    return "settings";
  return undefined;
}

export function RefillShellChrome({
  tenant,
  viewAs,
  viewAsExplicit,
}: {
  tenant: MyTenant;
  /**
   * v1.19 — when the parent shell rendered via the admin-fallback path
   * (admin user with no tenant_memberships row), we get viewAs="admin"
   * and show a banner so the admin knows they're not on their own data.
   */
  viewAs?: "admin";
  /**
   * v1.26.20 — distinguishes admin-picked-this (PersonaSwitcher set
   * localStorage) from admin-defaulted-here (no pick made, server
   * returned first available tenant). Branches banner copy + color so
   * an unintended landing doesn't masquerade as an explicit choice.
   * Ignored when viewAs is not set.
   */
  viewAsExplicit?: boolean;
}) {
  const location = useLocation();
  const activeKey = deriveActiveKey(location.pathname);

  // v1.26.20 — defaulted-landing visual is amber-bright (vs the calmer
  // soft-yellow used for explicit picks) so admin notices the surprise
  // landing rather than reading the banner as "yep this is what I picked".
  const isDefaulted = viewAs === "admin" && viewAsExplicit === false;
  const bannerStyle = isDefaulted
    ? {
        background: "#fff1d6",
        borderColor: "rgba(180, 95, 6, 0.45)",
        color: "#7a4a06",
      }
    : {
        background: "#fdf6dc",
        borderColor: "rgba(138, 109, 12, 0.3)",
        color: "#8a6d0c",
      };

  return (
    <div className="mx-auto max-w-6xl px-4 pt-4">
      <DemoBanner />
      {viewAs === "admin" && (
        <div
          className="mb-3 rounded-lg border px-3 py-2 text-[12px] flex items-center gap-2"
          style={bannerStyle}
        >
          <Sparkles className="h-3.5 w-3.5 shrink-0" />
          {isDefaulted ? (
            <span>
              <strong>Defaulted to {tenant.name}</strong> &mdash; you
              haven&rsquo;t picked a persona, so the server returned the
              first tenant available. Use the persona switcher in the
              upper-right to view a specific tenant deliberately. Read
              fetchers return this tenant&rsquo;s data (v1.20). CSV
              ingest (v1.20.5) and plan writes (v1.26.7) target this
              tenant. Stripe payment-method writes still scope to your
              own user_id.
            </span>
          ) : (
            <span>
              Viewing as <strong>{tenant.name}</strong>. Use the persona
              switcher in the upper-right to change view. Read fetchers
              return this tenant&rsquo;s data (v1.20). CSV ingest
              (v1.20.5) and plan writes (v1.26.7) target this tenant.
              Stripe payment-method writes still scope to your own
              user_id.
            </span>
          )}
        </div>
      )}
      <RefillNav active={activeKey} />
      {/* v1.33.0 — floating wishlist widget renders fixed-position so it
          appears on every /app/refill/* page but stays out of marketing
          + admin surfaces (admin gate is inside the widget). */}
      <WishlistWidget />
    </div>
  );
}
