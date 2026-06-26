/**
 * /app/admin/reports — P5 per-tenant + per-rep rollups.
 *
 * Two tabs (Tenants / Reps). Each shows the rollup table with sortable
 * counts. Drilldown links open the tenant/rep in the existing surfaces
 * via the PersonaSwitcher pattern (admin views-as the tenant owner).
 */
import { createFileRoute } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { PageHeader } from "@/components/PageHeader";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import { supabase } from "@/integrations/supabase/client";
import {
  pickRedirectForPersonaSwitch,
  setAdminViewAsUserId,
} from "@/lib/admin-view-as";
import {
  getRepReport,
  getTenantReport,
  type RepReportRow,
  type TenantReportRow,
} from "@/server/admin-reports";

export const Route = createFileRoute("/app/admin/reports")({
  component: AdminReportsPage,
});

type Tab = "tenants" | "reps";

function AdminReportsPage() {
  const isAdmin = useIsAdmin();
  const [tab, setTab] = useState<Tab>("tenants");
  const [tenants, setTenants] = useState<TenantReportRow[] | null>(null);
  const [reps, setReps] = useState<RepReportRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) return;
      const [t, r] = await Promise.all([
        getTenantReport({ data: { accessToken: token } }),
        getRepReport({ data: { accessToken: token } }),
      ]);
      setTenants(t.rows);
      setReps(r.rows);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Couldn't load.");
    }
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    void load();
  }, [isAdmin, load]);

  function viewAsTenantOwner(row: TenantReportRow) {
    if (!row.ownerUserId) return;
    // Reports always lives on /app/admin/* — picking a spa-owner here
    // is a cross-shell jump, so smart-routing will redirect to /app.
    const redirectTo =
      typeof window !== "undefined"
        ? pickRedirectForPersonaSwitch(window.location.pathname, "spa-owner")
        : undefined;
    setAdminViewAsUserId(row.ownerUserId, redirectTo);
  }

  function viewAsRep(row: RepReportRow) {
    const redirectTo =
      typeof window !== "undefined"
        ? pickRedirectForPersonaSwitch(window.location.pathname, "rep")
        : undefined;
    setAdminViewAsUserId(row.repUserId, redirectTo);
  }

  if (!isAdmin) {
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
        title="Reports"
        description="Per-tenant + per-rep rollups across the platform. Click any row's email to view-as that user."
        breadcrumbs={[
          { label: "Admin", to: "/app/admin" },
          { label: "Reports" },
        ]}
      />

      <div className="px-6 lg:px-10 py-8 max-w-6xl mx-auto space-y-4">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setTab("tenants")}
            className="inline-flex h-9 items-center rounded-md px-3 text-xs font-medium"
            style={{
              background: tab === "tenants" ? "#056048" : "transparent",
              color: tab === "tenants" ? "#fbfaf7" : "#5a6068",
              border: `1px solid ${tab === "tenants" ? "#056048" : "#e6e2d6"}`,
            }}
          >
            Tenants
          </button>
          <button
            onClick={() => setTab("reps")}
            className="inline-flex h-9 items-center rounded-md px-3 text-xs font-medium"
            style={{
              background: tab === "reps" ? "#056048" : "transparent",
              color: tab === "reps" ? "#fbfaf7" : "#5a6068",
              border: `1px solid ${tab === "reps" ? "#056048" : "#e6e2d6"}`,
            }}
          >
            Reps
          </button>
        </div>

        {loadError && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            {loadError}
          </div>
        )}

        {tab === "tenants" && tenants && (
          <div
            className="overflow-hidden rounded-xl border bg-card"
            style={{ borderColor: "#e6e2d6" }}
          >
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-[11px] uppercase tracking-wider text-ink-soft">
                <tr>
                  <th className="text-left px-4 py-2.5">Tenant</th>
                  <th className="text-left px-4 py-2.5">Plan</th>
                  <th className="text-left px-4 py-2.5">Owner</th>
                  <th className="text-right px-4 py-2.5">Patients</th>
                  <th className="text-right px-4 py-2.5">Recapture events</th>
                  <th className="text-right px-4 py-2.5">Recapture $</th>
                  <th className="text-right px-4 py-2.5">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y" style={{ borderColor: "#e6e2d6" }}>
                {tenants.map((t) => (
                  <tr key={t.tenantId}>
                    <td className="px-4 py-3">
                      <div className="font-medium">
                        {t.name}
                        {t.isDemo && (
                          <span className="ml-1.5 text-[10px] text-ink-faint">
                            (demo)
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-ink-soft font-mono mt-0.5">
                        {t.slug}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs">{t.plan}</td>
                    <td className="px-4 py-3 text-xs">
                      {t.ownerEmail ?? (
                        <span className="text-ink-faint">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs">
                      {t.patientCount.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs">
                      {t.recoveryEventCount.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs">
                      ${t.recoveryRevenueUsdLifetime.toLocaleString(undefined, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => viewAsTenantOwner(t)}
                        disabled={!t.ownerUserId}
                        className="inline-flex h-7 items-center rounded-md px-2 text-[11px] font-medium disabled:opacity-40"
                        style={{ background: "#e8f1ed", color: "#056048" }}
                        title={
                          t.ownerUserId
                            ? `View as ${t.ownerEmail ?? t.ownerUserId}`
                            : "No owner found"
                        }
                      >
                        View as
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === "reps" && reps && (
          <div
            className="overflow-hidden rounded-xl border bg-card"
            style={{ borderColor: "#e6e2d6" }}
          >
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-[11px] uppercase tracking-wider text-ink-soft">
                <tr>
                  <th className="text-left px-4 py-2.5">Rep</th>
                  <th className="text-left px-4 py-2.5">Email</th>
                  <th className="text-left px-4 py-2.5">Status</th>
                  <th className="text-left px-4 py-2.5">Origin</th>
                  <th className="text-right px-4 py-2.5">Downstream tenants</th>
                  <th className="text-right px-4 py-2.5">Attributed $</th>
                  <th className="text-right px-4 py-2.5">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y" style={{ borderColor: "#e6e2d6" }}>
                {reps.map((r) => (
                  <tr key={r.repUserId}>
                    <td className="px-4 py-3 font-medium">{r.displayName}</td>
                    <td className="px-4 py-3 text-xs">
                      {r.email ?? <span className="text-ink-faint">—</span>}
                    </td>
                    <td className="px-4 py-3 text-xs">{r.status}</td>
                    <td className="px-4 py-3 text-xs">{r.originType}</td>
                    <td className="px-4 py-3 text-right font-mono text-xs">
                      {r.downstreamTenantCount.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs">
                      ${r.attributedRevenueUsdLifetime.toLocaleString(undefined, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => viewAsRep(r)}
                        className="inline-flex h-7 items-center rounded-md px-2 text-[11px] font-medium"
                        style={{ background: "#e8f1ed", color: "#056048" }}
                        title={`View as ${r.email ?? r.displayName}`}
                      >
                        View as
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="px-4 py-2 text-[11px] text-ink-faint bg-muted/30">
              Attribution math (downstream tenants + attributed $) is
              zeros until v1.25 ships the rep_attributions table. Rep
              identity + status surfaced today.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
