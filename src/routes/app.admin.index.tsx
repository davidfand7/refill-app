/**
 * /app/admin — operator-only admin index (v413.1).
 *
 * One landing page for every admin surface so the operator doesn't have
 * to remember individual URLs (which today is the only way to navigate
 * to /app/admin/outreach, /app/admin/refill-trials, etc.). Goal 4
 * (substrate invisibility) operator-side complement: admin tools stay
 * non-user-discoverable from the Refill journey but become trivially
 * operator-discoverable here.
 *
 * Auth: useIsAdmin gate. Non-admins get a hard redirect to /app via
 * effect (matches the pattern in app.admin.refill-trials.tsx). No
 * data fetching on this page — pure nav — so the client-side gate is
 * the source of truth; no server fn round-trip needed.
 *
 * Adding a new admin surface = append one entry to ADMIN_SURFACES. The
 * shape is intentionally minimal (path, label, description, icon) so
 * the cost of indexing a new admin tool is one line.
 */

import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import {
  BarChart3,
  FlaskConical,
  History,
  Lightbulb,
  Loader2,
  Mail,
  ToggleLeft,
  Users,
  type LucideIcon,
} from "lucide-react";

import { useAuth } from "@/lib/auth";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import { PageHeader } from "@/components/PageHeader";

export const Route = createFileRoute("/app/admin/")({
  component: AdminIndexPage,
});

interface AdminSurface {
  path: string;
  label: string;
  description: string;
  icon: LucideIcon;
}

const ADMIN_SURFACES: AdminSurface[] = [
  {
    path: "/app/admin/users",
    label: "Users & roles",
    description:
      "Create users, grant/revoke roles, send password resets, delete accounts. Every mutation audit-logged.",
    icon: Users,
  },
  {
    path: "/app/admin/flags",
    label: "Feature flags",
    description:
      "Global / tenant / user / rep scopes. Toggle features without a code ship. First-hit wins on the read API.",
    icon: ToggleLeft,
  },
  {
    path: "/app/admin/reports",
    label: "Reports",
    description:
      "Per-tenant + per-rep rollups: patient count, recovery events, revenue, plan. Drill into any user via View-as.",
    icon: BarChart3,
  },
  {
    path: "/app/admin/audit",
    label: "Audit log",
    description:
      "Chronological list of every admin action — role grants, user creates, password resets, flag toggles.",
    icon: History,
  },
  {
    path: "/app/admin/outreach",
    label: "Outreach templates",
    description:
      "Edit outreach email copy inline or bulk-import from polished HTML. Versioned, no engineer involvement needed.",
    icon: Mail,
  },
  {
    path: "/app/admin/refill-trials",
    label: "Refill trial lever board",
    description:
      "Every tenant in the Refill funnel — drip state, day-number, trial end, incentive offers, ad-hoc sends.",
    icon: FlaskConical,
  },
  {
    path: "/app/admin/wishlist",
    label: "Wishlist inbox",
    description:
      "Every feature request from every spa with the 48h SLA workflow. Status, reply thread, mark shipped in vX.Y.Z. Per project_wishlist_thesis: this loop IS the moat.",
    icon: Lightbulb,
  },
];

// v1.23.0 (P3) — the /dev/$persona route is gone. Persona testing now
// happens via the PersonaSwitcher dropdown in the upper-right header of
// any shell. Admin signs in once at /login (admin@refill-demo.test +
// shared test password) and switches view without a logout cycle.

function AdminIndexPage() {
  const { session, loading: authLoading } = useAuth();
  const isAdmin = useIsAdmin();
  const navigate = useNavigate();

  // Unauthenticated → /login. Authenticated-but-not-admin → /app.
  // The useIsAdmin hook starts at false then flips true async, so we
  // wait one tick (authLoading false + session truthy) before bouncing
  // non-admins — otherwise admins would be redirected before the
  // user_roles check completes.
  useEffect(() => {
    if (authLoading) return;
    if (!session) {
      void navigate({ to: "/login" });
    }
  }, [authLoading, session, navigate]);

  if (authLoading || !session) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center text-sm text-ink-soft">
        <Loader2 className="h-4 w-4 animate-spin mr-2" />
        Checking access…
      </div>
    );
  }

  if (!isAdmin) {
    // useIsAdmin returns false both while-loading and when-not-admin —
    // we can't distinguish without a server round-trip. Render the
    // pulse for one more beat; if the user truly isn't an admin the
    // server fns on the linked pages will gate them out anyway.
    return (
      <div className="min-h-[60vh] flex items-center justify-center text-sm text-ink-soft">
        <Loader2 className="h-4 w-4 animate-spin mr-2" />
        Loading…
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <PageHeader
        eyebrow="Admin"
        title="Admin"
        description="Operator-only tools. Add new admin surfaces by appending to ADMIN_SURFACES in this file."
        breadcrumbs={[{ label: "Admin" }]}
      />

      <div className="px-6 lg:px-10 py-8 max-w-5xl mx-auto">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {ADMIN_SURFACES.map((s) => (
            <SurfaceCard key={s.path} surface={s} />
          ))}
        </div>
      </div>
    </div>
  );
}

function SurfaceCard({ surface }: { surface: AdminSurface }) {
  const Icon = surface.icon;
  return (
    <Link
      to={surface.path}
      className="group rounded-2xl border border-border bg-card p-5 transition hover:shadow-sm hover:border-emerald/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-start gap-3 mb-3">
        <div className="h-9 w-9 rounded-lg bg-emerald/10 flex items-center justify-center shrink-0">
          <Icon className="h-4 w-4 text-emerald" />
        </div>
      </div>
      <div className="text-[15px] font-semibold tracking-tight mb-1 text-foreground">
        {surface.label}
      </div>
      <div className="text-[13px] leading-[1.5] text-ink-soft">
        {surface.description}
      </div>
    </Link>
  );
}
