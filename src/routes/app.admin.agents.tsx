/**
 * /app/admin/flags — feature flags surface, catalog-driven.
 *
 * v1.24.1 rewrite. v1.24.0 shipped a row-driven view: showed whatever
 * raw rows existed in public.feature_flags and offered a "+ New flag"
 * button that asked for a raw flag_key + scope UUID + JSON metadata.
 * Operator had no way to know what flags Refill even supported, and the
 * empty state was "0 flag rows" — incomprehensible. Per
 * [[feedback-human-first-design]], that was computer-shaped, not
 * operator-shaped.
 *
 * v1.24.1 inverts the model: <code>FLAG_CATALOG</code> in
 * <code>src/lib/feature-flag-catalog.ts</code> is the source of what
 * features exist (each with a human-readable label + description + ON
 * and OFF meanings + default state). This page renders ONE CARD PER
 * CATALOG ENTRY. The feature_flags table holds OVERRIDES to the
 * default — global override (admin says "off for everyone"), tenant
 * override (admin says "off for Rejuv"), etc.
 *
 * Add-override flow: scope picker (global/tenant/user/rep) + target
 * picker (dropdown of tenants for scope=tenant, users for scope=user /
 * rep). No raw UUIDs asked of the operator.
 */
import { createFileRoute } from "@tanstack/react-router";
import { Check, Loader2, Plus, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { PageHeader } from "@/components/PageHeader";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import { supabase } from "@/integrations/supabase/client";
import {
  FLAG_CATALOG,
  findFlagInCatalog,
  type FeatureFlagDefinition,
} from "@/lib/feature-flag-catalog";
import {
  deleteFlag,
  listFlags,
  upsertFlag,
  type FeatureFlagRow,
} from "@/server/admin-flags";
import {
  listImpersonableUsers,
  type ImpersonableUser,
} from "@/server/role-helpers";
import {
  listTenantsForAdmin,
  type AdminTenantOption,
} from "@/server/refill-tenants";

export const Route = createFileRoute("/app/admin/agents")({
  component: AdminAgentsPage,
});

// v1.34.3 (renamed from AdminFlagsPage). The page logic is unchanged from
// the previous /app/admin/flags surface — same FLAG_CATALOG read, same
// toggle/override behavior. Only the URL + chip label moved per the
// "Agents & overrides" reframe locked 2026-06-02. The old /app/admin/flags
// URL now redirects here. Per-tenant Preshow profile drift visibility
// lands as v1.34.3.x — for v1.34.3 the page keeps the existing
// feature_flags catalog view.
function AdminAgentsPage() {
  const isAdmin = useIsAdmin();
  const [flags, setFlags] = useState<FeatureFlagRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [overrideContext, setOverrideContext] = useState<
    FeatureFlagDefinition | null
  >(null);

  const load = useCallback(async () => {
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) return;
      const { flags: f } = await listFlags({ data: { accessToken: token } });
      setFlags(f);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Couldn't load flags.");
    }
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    void load();
  }, [isAdmin, load]);

  // Group rows by flag_key for easy lookup per catalog card.
  const rowsByKey = useMemo(() => {
    const m = new Map<string, FeatureFlagRow[]>();
    for (const r of flags ?? []) {
      let arr = m.get(r.flagKey);
      if (!arr) {
        arr = [];
        m.set(r.flagKey, arr);
      }
      arr.push(r);
    }
    return m;
  }, [flags]);

  async function toggleGlobal(def: FeatureFlagDefinition, nextEnabled: boolean) {
    setBusyKey(def.key);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Signed out.");
      await upsertFlag({
        data: {
          accessToken: token,
          flagKey: def.key,
          scope: "global",
          scopeId: null,
          enabled: nextEnabled,
        },
      });
      toast.success(
        `${def.label} → ${nextEnabled ? "enabled" : "disabled"} globally`,
      );
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't toggle.");
    } finally {
      setBusyKey(null);
    }
  }

  async function clearGlobalOverride(def: FeatureFlagDefinition, rowId: string) {
    setBusyKey(def.key);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Signed out.");
      await deleteFlag({ data: { accessToken: token, id: rowId } });
      toast.success(`${def.label} → reverted to default`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't revert.");
    } finally {
      setBusyKey(null);
    }
  }

  async function removeOverride(rowId: string, label: string) {
    if (!window.confirm(`Remove this override on ${label}?`)) return;
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Signed out.");
      await deleteFlag({ data: { accessToken: token, id: rowId } });
      toast.success("Override removed");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't remove.");
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
        title="Agents & overrides"
        description="Refill's agents (Preshow, Rescue, Attribution, Recognition Allocation) and the global defaults that govern them. Defaults apply to every spa; add an override when a tenant, rep, or user needs the exception. Every toggle is audit-logged."
        breadcrumbs={[
          { label: "Admin", to: "/app/admin" },
          { label: "Agents & overrides" },
        ]}
      />

      <div className="px-6 lg:px-10 py-8 max-w-4xl mx-auto space-y-4">
        {loadError && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            {loadError}
          </div>
        )}

        {flags === null ? (
          <div className="text-sm text-ink-soft flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : (
          FLAG_CATALOG.map((def) => {
            const allRows = rowsByKey.get(def.key) ?? [];
            const globalRow = allRows.find((r) => r.scope === "global");
            const overrides = allRows.filter((r) => r.scope !== "global");
            const isOn = globalRow ? globalRow.enabled : def.defaultEnabled;
            const isBusy = busyKey === def.key;
            return (
              <FlagCard
                key={def.key}
                def={def}
                effectiveOn={isOn}
                globalRow={globalRow}
                overrides={overrides}
                isBusy={isBusy}
                onToggleGlobal={() => toggleGlobal(def, !isOn)}
                onClearGlobal={() =>
                  globalRow && clearGlobalOverride(def, globalRow.id)
                }
                onAddOverride={() => setOverrideContext(def)}
                onRemoveOverride={removeOverride}
              />
            );
          })
        )}

        {/* Surface any uncatalogued rows so admin can clean them up. */}
        {flags && (() => {
          const uncatalogued = flags.filter(
            (r) => !findFlagInCatalog(r.flagKey),
          );
          if (uncatalogued.length === 0) return null;
          return (
            <div
              className="mt-8 rounded-xl border bg-card p-4"
              style={{ borderColor: "#e6e2d6" }}
            >
              <div className="text-[11px] uppercase tracking-wider text-ink-soft mb-2">
                Uncatalogued rows
              </div>
              <div className="text-xs text-ink-soft mb-3">
                These flag_keys don&rsquo;t match anything in the catalog.
                Probably stale &mdash; safe to delete.
              </div>
              <ul className="space-y-1.5">
                {uncatalogued.map((r) => (
                  <li
                    key={r.id}
                    className="flex items-center gap-2 text-xs font-mono"
                  >
                    <span className="text-ink-soft">{r.flagKey}</span>
                    <span className="text-ink-faint">·</span>
                    <span className="text-ink-soft">{r.scope}</span>
                    <span className="text-ink-faint">·</span>
                    <span>{r.enabled ? "ON" : "OFF"}</span>
                    <button
                      onClick={() => removeOverride(r.id, r.flagKey)}
                      className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded-md text-destructive hover:bg-destructive/10"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          );
        })()}
      </div>

      {overrideContext && (
        <AddOverrideModal
          def={overrideContext}
          onClose={() => setOverrideContext(null)}
          onSaved={() => {
            setOverrideContext(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function FlagCard({
  def,
  effectiveOn,
  globalRow,
  overrides,
  isBusy,
  onToggleGlobal,
  onClearGlobal,
  onAddOverride,
  onRemoveOverride,
}: {
  def: FeatureFlagDefinition;
  effectiveOn: boolean;
  globalRow: FeatureFlagRow | undefined;
  overrides: FeatureFlagRow[];
  isBusy: boolean;
  onToggleGlobal: () => void;
  onClearGlobal: () => void;
  onAddOverride: () => void;
  onRemoveOverride: (rowId: string, label: string) => void;
}) {
  return (
    <div
      className="rounded-xl border bg-card p-5"
      style={{ borderColor: "#e6e2d6" }}
    >
      <div className="flex items-start gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="text-[16px] font-semibold tracking-tight">
              {def.label}
            </h3>
            {globalRow && (
              <span
                className="inline-flex h-5 items-center rounded-full px-2 text-[10px] font-semibold"
                style={{
                  background: "rgba(138, 109, 12, 0.1)",
                  color: "#8a6d0c",
                }}
              >
                global override
              </span>
            )}
          </div>
          <p className="text-[13px] leading-[1.5] text-ink-soft mb-2">
            {def.description}
          </p>
          <p className="text-[12px] leading-[1.4] text-ink-faint">
            {effectiveOn ? def.onMeaning : def.offMeaning}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          <button
            onClick={onToggleGlobal}
            disabled={isBusy}
            className="inline-flex h-8 items-center rounded-full px-3 text-[11px] font-semibold disabled:opacity-50"
            style={{
              background: effectiveOn ? "#056048" : "#e6e2d6",
              color: effectiveOn ? "#fbfaf7" : "#5a6068",
            }}
          >
            {effectiveOn ? "ON" : "OFF"}
          </button>
          <div className="text-[10px] text-ink-faint">
            default: {def.defaultEnabled ? "ON" : "OFF"}
          </div>
          {globalRow && (
            <button
              onClick={onClearGlobal}
              disabled={isBusy}
              className="text-[10px] text-ink-soft hover:text-ink underline disabled:opacity-50"
              title="Remove the global override and revert to the catalog default"
            >
              revert to default
            </button>
          )}
        </div>
      </div>

      {(overrides.length > 0 || true) && (
        <div
          className="mt-4 pt-4 border-t"
          style={{ borderColor: "#f3f0e7" }}
        >
          <div className="flex items-center justify-between mb-2">
            <div className="text-[11px] uppercase tracking-wider text-ink-soft">
              Per-target overrides {overrides.length > 0 && `(${overrides.length})`}
            </div>
            <button
              onClick={onAddOverride}
              className="inline-flex h-7 items-center gap-1 rounded-md px-2.5 text-[11px] font-medium"
              style={{
                background: "#e8f1ed",
                color: "#056048",
                border: "1px solid #056048",
              }}
            >
              <Plus className="h-3 w-3" />
              Add override
            </button>
          </div>
          {overrides.length === 0 ? (
            <div className="text-[11px] text-ink-faint italic">
              No per-tenant / per-user / per-rep overrides.
            </div>
          ) : (
            <ul className="space-y-1.5">
              {overrides.map((row) => (
                <li
                  key={row.id}
                  className="flex items-center gap-2 text-[12px]"
                >
                  <span
                    className="inline-flex h-5 items-center rounded-full px-2 text-[10px] font-semibold"
                    style={{ background: "#fdf6dc", color: "#8a6d0c" }}
                  >
                    {row.scope}
                  </span>
                  <span className="font-mono text-[11px] text-ink-soft truncate max-w-[24ch]">
                    {row.scopeId}
                  </span>
                  <span className="text-ink-faint">·</span>
                  <span
                    className="inline-flex h-5 items-center rounded-full px-2 text-[10px] font-semibold"
                    style={{
                      background: row.enabled ? "#056048" : "#e6e2d6",
                      color: row.enabled ? "#fbfaf7" : "#5a6068",
                    }}
                  >
                    {row.enabled ? "ON" : "OFF"}
                  </span>
                  <button
                    onClick={() => onRemoveOverride(row.id, def.label)}
                    className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded-md text-destructive hover:bg-destructive/10"
                    title="Remove override"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function AddOverrideModal({
  def,
  onClose,
  onSaved,
}: {
  def: FeatureFlagDefinition;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [scope, setScope] = useState<"tenant" | "user" | "rep">("tenant");
  const [scopeId, setScopeId] = useState("");
  const [enabled, setEnabled] = useState(!def.defaultEnabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [tenants, setTenants] = useState<AdminTenantOption[] | null>(null);
  const [users, setUsers] = useState<ImpersonableUser[] | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token;
        if (!token) return;
        const [t, u] = await Promise.all([
          listTenantsForAdmin({ data: { accessToken: token } }),
          listImpersonableUsers({ data: { accessToken: token } }),
        ]);
        setTenants(t.tenants);
        setUsers(u.users);
      } catch {
        /* picker empty if fetch fails — show inline error */
      }
    })();
  }, []);

  // Reset scopeId when scope changes
  useEffect(() => {
    setScopeId("");
  }, [scope]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (!scopeId) {
        throw new Error("Pick a target first.");
      }
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Signed out.");
      await upsertFlag({
        data: {
          accessToken: token,
          flagKey: def.key,
          scope,
          scopeId,
          enabled,
        },
      });
      toast.success(`Override added on ${def.label}`);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save.");
    } finally {
      setBusy(false);
    }
  }

  // Build the target options based on current scope.
  const targetOptions =
    scope === "tenant"
      ? (tenants ?? []).map((t) => ({
          id: t.id,
          label: `${t.name}${t.isDemo ? " (demo)" : ""}`,
        }))
      : scope === "user"
        ? (users ?? []).map((u) => ({
            id: u.userId,
            label: `${u.displayName} (${u.email})`,
          }))
        : scope === "rep"
          ? (users ?? [])
              .filter((u) => u.shell === "rep")
              .map((u) => ({
                id: u.userId,
                label: `${u.displayName} (${u.email})`,
              }))
          : [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl bg-white shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between px-5 py-4 border-b"
          style={{ borderColor: "#e6e2d6" }}
        >
          <div>
            <h2 className="font-semibold text-base">Override</h2>
            <p className="text-xs mt-0.5 text-ink-soft">
              {def.label} — default is{" "}
              <strong>{def.defaultEnabled ? "ON" : "OFF"}</strong>
            </p>
          </div>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded text-ink-soft hover:opacity-70"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <form onSubmit={onSubmit} className="px-5 py-4 space-y-3">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider mb-1.5 text-ink-soft">
              Scope
            </div>
            <div className="flex gap-1">
              {(["tenant", "user", "rep"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setScope(s)}
                  className="inline-flex h-8 items-center rounded-md px-3 text-xs font-medium"
                  style={{
                    background: scope === s ? "#056048" : "transparent",
                    color: scope === s ? "#fbfaf7" : "#5a6068",
                    border: `1px solid ${scope === s ? "#056048" : "#e6e2d6"}`,
                  }}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          <label className="block">
            <div className="text-[10px] font-semibold uppercase tracking-wider mb-1.5 text-ink-soft">
              Target {scope}
            </div>
            <select
              value={scopeId}
              onChange={(e) => setScopeId(e.target.value)}
              required
              className="w-full rounded-md border bg-white px-3 py-2 text-sm outline-none focus:ring-2"
              style={{ borderColor: "#e6e2d6" }}
            >
              <option value="">— pick a {scope} —</option>
              {targetOptions.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </select>
            {targetOptions.length === 0 && (
              <div className="text-[11px] text-ink-faint mt-1">
                No {scope}s loaded yet.
              </div>
            )}
          </label>

          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider mb-1.5 text-ink-soft">
              For this {scope}, the flag should be
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setEnabled(true)}
                className="flex-1 inline-flex h-9 items-center justify-center gap-1.5 rounded-md text-xs font-medium"
                style={{
                  background: enabled ? "#056048" : "transparent",
                  color: enabled ? "#fbfaf7" : "#5a6068",
                  border: `1px solid ${enabled ? "#056048" : "#e6e2d6"}`,
                }}
              >
                {enabled && <Check className="h-3.5 w-3.5" />}
                ON
              </button>
              <button
                type="button"
                onClick={() => setEnabled(false)}
                className="flex-1 inline-flex h-9 items-center justify-center gap-1.5 rounded-md text-xs font-medium"
                style={{
                  background: !enabled ? "#5a6068" : "transparent",
                  color: !enabled ? "#fbfaf7" : "#5a6068",
                  border: `1px solid ${!enabled ? "#5a6068" : "#e6e2d6"}`,
                }}
              >
                {!enabled && <Check className="h-3.5 w-3.5" />}
                OFF
              </button>
            </div>
          </div>

          {error && (
            <div className="rounded-md px-3 py-2 text-xs bg-destructive/10 text-destructive">
              {error}
            </div>
          )}
          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="inline-flex h-9 items-center rounded-md border px-3 text-xs font-medium"
              style={{ borderColor: "#e6e2d6", color: "#5a6068" }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || !scopeId}
              className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-xs font-medium"
              style={{ background: "#056048", color: "#fbfaf7" }}
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Save override
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
