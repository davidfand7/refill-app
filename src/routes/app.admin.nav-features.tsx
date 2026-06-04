/**
 * /app/admin/nav-features — admin control panel for nav visibility (v1.44.2).
 *
 * Per project-customer-as-developer-access + feedback-stealth-first-doctrine:
 * we ship features and enable them per-tenant (Rejuv first) without bloating
 * every tenant's nav. Pattern mirrors v1.34.3 agent_defaults — registry +
 * per-tenant overrides.
 *
 * Reads: listNavFeatures (registry) + listTenantNavOverrides per-tenant +
 * listAllTenantsForNavOverride for the picker.
 *
 * Writes: setNavFeatureDefault (flip global default), setTenantNavOverride
 * (override per-tenant), clearTenantNavOverride (revert to default).
 *
 * UX: one section per feature. Header shows label + persona + description +
 * global-default toggle. Below: list of current overrides (tenant name + state
 * + revert link) + "Add override" affordance with tenant picker + ON/OFF.
 *
 * Effect on Karen's app: RefillHome / RefillNav call
 * listVisibleNavFeaturesForTenant at render and filter cards/chips through
 * the returned key set. Same pattern will extend to RepHome / RefillRepNav
 * when persona='rep' features ship.
 */

import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Loader2, Plus, RotateCcw, ToggleLeft, ToggleRight, X } from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/PageHeader";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import { supabase } from "@/integrations/supabase/client";
import {
  clearTenantNavOverride,
  listAllTenantsForNavOverride,
  listNavFeatures,
  listTenantNavOverrides,
  setNavFeatureDefault,
  setTenantNavOverride,
  type NavFeatureRow,
  type TenantNavOverrideRow,
} from "@/server/refill-nav-features.functions";

export const Route = createFileRoute("/app/admin/nav-features")({
  component: AdminNavFeaturesPage,
});

type TenantOption = {
  id: string;
  name: string;
  slug: string | null;
  isDemo: boolean;
};

function AdminNavFeaturesPage() {
  const isAdmin = useIsAdmin();
  const [features, setFeatures] = useState<NavFeatureRow[] | null>(null);
  const [tenants, setTenants] = useState<TenantOption[]>([]);
  const [overrides, setOverrides] = useState<Map<string, TenantNavOverrideRow[]>>(
    new Map(),
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) return;
      const [featRes, tenRes] = await Promise.all([
        listNavFeatures({ data: { accessToken: token } }),
        listAllTenantsForNavOverride({ data: { accessToken: token } }),
      ]);
      setFeatures(featRes.features);
      setTenants(tenRes.tenants);
      // Load overrides for every tenant in parallel — small operator-only
      // page, tenant count is in the dozens. Aggregate by feature_key.
      const all = await Promise.all(
        tenRes.tenants.map((t) =>
          listTenantNavOverrides({
            data: { accessToken: token, tenantId: t.id },
          }).then((r) => r.overrides),
        ),
      );
      const grouped = new Map<string, TenantNavOverrideRow[]>();
      for (const list of all) {
        for (const ov of list) {
          const arr = grouped.get(ov.featureKey) ?? [];
          arr.push(ov);
          grouped.set(ov.featureKey, arr);
        }
      }
      setOverrides(grouped);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Couldn't load nav features.");
    }
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    void load();
  }, [isAdmin, load]);

  const tenantsById = useMemo(() => {
    const m = new Map<string, TenantOption>();
    for (const t of tenants) m.set(t.id, t);
    return m;
  }, [tenants]);

  async function toggleDefault(f: NavFeatureRow, next: boolean) {
    setBusyKey(f.featureKey);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Signed out.");
      await setNavFeatureDefault({
        data: { accessToken: token, featureKey: f.featureKey, defaultVisible: next },
      });
      toast.success(`${f.label} default → ${next ? "ON" : "OFF"}`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't flip default.");
    } finally {
      setBusyKey(null);
    }
  }

  async function setOverride(
    f: NavFeatureRow,
    tenantId: string,
    visible: boolean,
  ) {
    setBusyKey(`${f.featureKey}:${tenantId}`);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Signed out.");
      await setTenantNavOverride({
        data: {
          accessToken: token,
          tenantId,
          featureKey: f.featureKey,
          visible,
        },
      });
      const tName = tenantsById.get(tenantId)?.name ?? "tenant";
      toast.success(`${f.label} → ${visible ? "ON" : "OFF"} for ${tName}`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't set override.");
    } finally {
      setBusyKey(null);
    }
  }

  async function clearOverride(f: NavFeatureRow, tenantId: string) {
    setBusyKey(`${f.featureKey}:${tenantId}`);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Signed out.");
      await clearTenantNavOverride({
        data: { accessToken: token, tenantId, featureKey: f.featureKey },
      });
      toast.success("Reverted to default.");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't clear override.");
    } finally {
      setBusyKey(null);
    }
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
        title="Nav features"
        description="Toggle which optional surfaces appear in each tenant's nav. Pattern mirrors agent_defaults — set a global default, override per-tenant. Default-on features get zero override rows; default-off features get an override row per tenant we've enabled them for. Use to ship features stealth + light them up for Rejuv first."
        breadcrumbs={[{ label: "Admin", to: "/app/admin" }, { label: "Nav features" }]}
      />

      <div className="px-6 lg:px-10 py-8 max-w-5xl mx-auto space-y-6">
        {loadError && (
          <div
            className="rounded-md border px-4 py-3 text-sm"
            style={{
              borderColor: "rgba(139, 0, 0, 0.3)",
              background: "#fdecec",
              color: "#8a1616",
            }}
          >
            {loadError}
          </div>
        )}
        {!features ? (
          <div className="flex items-center gap-2 text-sm text-ink-soft">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        ) : features.length === 0 ? (
          <div className="rounded-md border border-rule bg-card px-4 py-6 text-center text-sm text-ink-soft">
            No nav features registered yet. The seed should have added{" "}
            <code className="font-mono text-xs">nav.campaigns</code> — if you see
            this, the migration hasn't been applied. Run the v1.44.2 migration via
            Supabase dashboard.
          </div>
        ) : (
          features.map((f) => (
            <FeatureCard
              key={f.featureKey}
              feature={f}
              overrides={overrides.get(f.featureKey) ?? []}
              tenants={tenants}
              tenantsById={tenantsById}
              busyKey={busyKey}
              onToggleDefault={(next) => toggleDefault(f, next)}
              onSetOverride={(tenantId, visible) => setOverride(f, tenantId, visible)}
              onClearOverride={(tenantId) => clearOverride(f, tenantId)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function FeatureCard({
  feature,
  overrides,
  tenants,
  tenantsById,
  busyKey,
  onToggleDefault,
  onSetOverride,
  onClearOverride,
}: {
  feature: NavFeatureRow;
  overrides: TenantNavOverrideRow[];
  tenants: TenantOption[];
  tenantsById: Map<string, TenantOption>;
  busyKey: string | null;
  onToggleDefault: (next: boolean) => void;
  onSetOverride: (tenantId: string, visible: boolean) => void;
  onClearOverride: (tenantId: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [pendingTenant, setPendingTenant] = useState<string>("");
  const [pendingVisible, setPendingVisible] = useState<boolean>(true);
  const isBusyDefault = busyKey === feature.featureKey;

  // Tenants without an existing override (the candidates for "Add").
  const overrideTenantIds = new Set(overrides.map((o) => o.tenantId));
  const candidateTenants = tenants.filter((t) => !overrideTenantIds.has(t.id));

  return (
    <div className="rounded-xl border border-rule bg-card overflow-hidden">
      <div className="px-5 py-4 border-b border-rule">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1">
              <h2 className="text-[15px] font-semibold tracking-tight text-foreground">
                {feature.label}
              </h2>
              <span
                className="text-[10px] font-semibold uppercase tracking-wider rounded-full px-2 py-0.5"
                style={{ background: "#e8f3ed", color: "#056048" }}
              >
                {feature.persona}
              </span>
              <code
                className="text-[10px] font-mono text-ink-soft"
                style={{ color: "#8a9098" }}
              >
                {feature.featureKey}
              </code>
            </div>
            {feature.description && (
              <p className="text-[13px] leading-[1.5] text-ink-soft">
                {feature.description}
              </p>
            )}
          </div>
          <button
            type="button"
            disabled={isBusyDefault}
            onClick={() => onToggleDefault(!feature.defaultVisible)}
            className="inline-flex items-center gap-1.5 rounded-md border border-rule bg-background px-3 py-1.5 text-[12px] font-semibold transition hover:bg-sidebar-accent/40 disabled:opacity-50"
          >
            {isBusyDefault ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : feature.defaultVisible ? (
              <ToggleRight className="h-3.5 w-3.5 text-emerald" />
            ) : (
              <ToggleLeft className="h-3.5 w-3.5 text-ink-soft" />
            )}
            Default: {feature.defaultVisible ? "ON" : "OFF"}
          </button>
        </div>
      </div>

      <div className="px-5 py-4 space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-[11px] uppercase tracking-wider font-semibold text-ink-soft">
            Per-tenant overrides ({overrides.length})
          </h3>
          {!adding && candidateTenants.length > 0 && (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="inline-flex items-center gap-1 text-[12px] font-semibold text-emerald hover:underline"
            >
              <Plus className="h-3 w-3" />
              Add override
            </button>
          )}
        </div>

        {overrides.length === 0 && !adding && (
          <p className="text-[12px] text-ink-soft italic">
            No overrides — every tenant follows the default
            ({feature.defaultVisible ? "ON" : "OFF"}).
          </p>
        )}

        {overrides.map((o) => {
          const t = tenantsById.get(o.tenantId);
          const rowBusy = busyKey === `${feature.featureKey}:${o.tenantId}`;
          return (
            <div
              key={o.tenantId}
              className="flex items-center justify-between gap-3 rounded-md border border-rule bg-background px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium truncate">
                  {t?.name ?? o.tenantId}
                  {t?.isDemo && (
                    <span
                      className="ml-2 rounded-full px-1.5 py-0.5 text-[9px] uppercase"
                      style={{ background: "#fdf6e6", color: "#8a6d10" }}
                    >
                      demo
                    </span>
                  )}
                </div>
                {t?.slug && (
                  <code
                    className="text-[10px] font-mono"
                    style={{ color: "#8a9098" }}
                  >
                    {t.slug}
                  </code>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                <span
                  className="text-[10px] font-semibold uppercase rounded-full px-2 py-0.5"
                  style={{
                    background: o.visible ? "#e8f3ed" : "#fdecec",
                    color: o.visible ? "#056048" : "#8a1616",
                  }}
                >
                  {o.visible ? "ON" : "OFF"}
                </span>
                <button
                  type="button"
                  disabled={rowBusy}
                  onClick={() => onSetOverride(o.tenantId, !o.visible)}
                  className="text-[11px] underline-offset-2 hover:underline disabled:opacity-50"
                  style={{ color: "#056048" }}
                >
                  Flip
                </button>
                <button
                  type="button"
                  disabled={rowBusy}
                  onClick={() => onClearOverride(o.tenantId)}
                  title="Revert to default"
                  aria-label="Revert to default"
                  className="inline-flex h-6 w-6 items-center justify-center rounded text-ink-soft hover:bg-sidebar-accent/60 disabled:opacity-50"
                >
                  {rowBusy ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <RotateCcw className="h-3 w-3" />
                  )}
                </button>
              </div>
            </div>
          );
        })}

        {adding && (
          <div className="rounded-md border border-rule bg-background px-3 py-2">
            <div className="flex items-center gap-2">
              <select
                value={pendingTenant}
                onChange={(e) => setPendingTenant(e.target.value)}
                className="flex-1 rounded-md border border-rule bg-card px-2 py-1.5 text-[12px]"
              >
                <option value="">Pick a tenant…</option>
                {candidateTenants.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                    {t.isDemo ? " (demo)" : ""}
                  </option>
                ))}
              </select>
              <select
                value={pendingVisible ? "on" : "off"}
                onChange={(e) => setPendingVisible(e.target.value === "on")}
                className="rounded-md border border-rule bg-card px-2 py-1.5 text-[12px]"
              >
                <option value="on">ON</option>
                <option value="off">OFF</option>
              </select>
              <button
                type="button"
                disabled={!pendingTenant}
                onClick={() => {
                  onSetOverride(pendingTenant, pendingVisible);
                  setAdding(false);
                  setPendingTenant("");
                  setPendingVisible(true);
                }}
                className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] font-semibold disabled:opacity-50"
                style={{ background: "#056048", color: "#fbfaf7" }}
              >
                <Check className="h-3 w-3" />
                Save
              </button>
              <button
                type="button"
                onClick={() => {
                  setAdding(false);
                  setPendingTenant("");
                }}
                aria-label="Cancel"
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-soft hover:bg-sidebar-accent/60"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
