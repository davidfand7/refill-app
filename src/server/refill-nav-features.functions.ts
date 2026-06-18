/**
 * Nav features registry + per-tenant overrides (v1.44.2).
 *
 * Admin-controlled visibility for optional nav surfaces. Pattern mirrors
 * v1.34.3's agent_defaults + per-tenant overrides applied to nav.
 *
 * Read path: RefillHome / RefillNav (and rep equivalents) call
 * listVisibleNavFeaturesForTenant() once at render, filter their
 * ACTIONS / CHIPS arrays through the returned string[] of enabled keys.
 *
 * Write path: /app/admin/nav-features uses listNavFeatures (registry),
 * listTenantNavOverrides (per-tenant) + setTenantNavOverride /
 * clearTenantNavOverride / setNavFeatureDefault. Admin-gated via
 * requireAdminRole.
 *
 * Why two tables instead of just "default | per-tenant" enum on one row:
 * tenant count grows; carrying a row per (tenant × feature) only for
 * overrides keeps the table small. Default-on features have ZERO rows
 * in tenant_nav_overrides — the read fn falls through to the registry
 * default. Same shape as agent_defaults pattern.
 */

import { admin, type SbClient } from "./admin-client";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { accessTokenInput, verifyAuth } from "@/server/auth-helpers";


async function requireAdminRole(sb: SbClient, accessToken: string): Promise<string> {
  const userId = await verifyAuth(accessToken);
  const { data, error } = await sb
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (error) throw new Error(`Role check failed: ${error.message}`);
  if (!data) throw new Error("Admin role required.");
  return userId;
}

// ─── Types ───────────────────────────────────────────────────────────────

export type NavFeaturePersona = "spa" | "rep" | "admin";

export interface NavFeatureRow {
  featureKey: string;
  label: string;
  description: string | null;
  persona: NavFeaturePersona;
  defaultVisible: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TenantNavOverrideRow {
  tenantId: string;
  featureKey: string;
  visible: boolean;
  updatedAt: string;
  updatedBy: string | null;
}

// ─── listVisibleNavFeaturesForTenant (read path — every signed-in user) ──

const visibleInput = accessTokenInput.extend({
  tenantId: z.string().uuid(),
  persona: z.enum(["spa", "rep", "admin"]),
});

export const listVisibleNavFeaturesForTenant = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => visibleInput.parse(raw))
  .handler(async ({ data }): Promise<{ visibleKeys: string[] }> => {
    // Just verify the caller has a valid session — visibility is not
    // sensitive (it's just nav chrome). Tenant_id is trusted because RLS
    // on tenant_nav_overrides scopes overrides to the caller's tenant
    // anyway (per the migration's read policy).
    await verifyAuth(data.accessToken);
    const sb = admin();

    // Load registry rows for this persona + tenant overrides in parallel.
    const [regRes, ovrRes] = await Promise.all([
      sb
        .from("nav_features")
        .select("feature_key, default_visible")
        .eq("persona", data.persona),
      sb
        .from("tenant_nav_overrides")
        .select("feature_key, visible")
        .eq("tenant_id", data.tenantId),
    ]);
    if (regRes.error) throw new Error(`nav_features read failed: ${regRes.error.message}`);
    if (ovrRes.error) throw new Error(`tenant_nav_overrides read failed: ${ovrRes.error.message}`);

    const overrides = new Map<string, boolean>();
    for (const r of ovrRes.data ?? []) overrides.set(r.feature_key, r.visible);

    const visibleKeys: string[] = [];
    for (const r of regRes.data ?? []) {
      const v = overrides.get(r.feature_key) ?? r.default_visible;
      if (v) visibleKeys.push(r.feature_key);
    }
    return { visibleKeys };
  });

// ─── listNavFeatures (admin — full registry) ─────────────────────────────

export const listNavFeatures = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => accessTokenInput.parse(raw))
  .handler(async ({ data }): Promise<{ features: NavFeatureRow[] }> => {
    const sb = admin();
    await requireAdminRole(sb, data.accessToken);
    const { data: rows, error } = await sb
      .from("nav_features")
      .select("*")
      .order("persona", { ascending: true })
      .order("feature_key", { ascending: true });
    if (error) throw new Error(`nav_features list failed: ${error.message}`);
    return {
      features: (rows ?? []).map((r) => ({
        featureKey: r.feature_key,
        label: r.label,
        description: r.description,
        persona: r.persona as NavFeaturePersona,
        defaultVisible: r.default_visible,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    };
  });

// ─── listTenantNavOverrides (admin — overrides for one tenant) ───────────

const tenantOverridesInput = accessTokenInput.extend({
  tenantId: z.string().uuid(),
});

export const listTenantNavOverrides = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => tenantOverridesInput.parse(raw))
  .handler(async ({ data }): Promise<{ overrides: TenantNavOverrideRow[] }> => {
    const sb = admin();
    await requireAdminRole(sb, data.accessToken);
    const { data: rows, error } = await sb
      .from("tenant_nav_overrides")
      .select("*")
      .eq("tenant_id", data.tenantId);
    if (error) throw new Error(`overrides list failed: ${error.message}`);
    return {
      overrides: (rows ?? []).map((r) => ({
        tenantId: r.tenant_id,
        featureKey: r.feature_key,
        visible: r.visible,
        updatedAt: r.updated_at,
        updatedBy: r.updated_by,
      })),
    };
  });

// ─── listAllTenantsForOverrideGrid (admin — picker) ──────────────────────

export const listAllTenantsForNavOverride = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => accessTokenInput.parse(raw))
  .handler(
    async ({
      data,
    }): Promise<{
      tenants: Array<{ id: string; name: string; slug: string | null; isDemo: boolean }>;
    }> => {
      const sb = admin();
      await requireAdminRole(sb, data.accessToken);
      const { data: rows, error } = await sb
        .from("tenants")
        .select("id, name, slug, is_demo")
        .order("name", { ascending: true });
      if (error) throw new Error(`tenants list failed: ${error.message}`);
      return {
        tenants: (rows ?? []).map((r) => ({
          id: r.id,
          name: r.name,
          slug: r.slug,
          isDemo: r.is_demo ?? false,
        })),
      };
    },
  );

// ─── setTenantNavOverride (admin upsert) ─────────────────────────────────

const setOverrideInput = accessTokenInput.extend({
  tenantId: z.string().uuid(),
  featureKey: z.string().min(1).max(120),
  visible: z.boolean(),
});

export const setTenantNavOverride = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => setOverrideInput.parse(raw))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const sb = admin();
    const adminUserId = await requireAdminRole(sb, data.accessToken);
    const { error } = await sb
      .from("tenant_nav_overrides")
      .upsert(
        {
          tenant_id: data.tenantId,
          feature_key: data.featureKey,
          visible: data.visible,
          updated_by: adminUserId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "tenant_id,feature_key" },
      );
    if (error) throw new Error(`override upsert failed: ${error.message}`);
    return { ok: true };
  });

// ─── clearTenantNavOverride (admin — revert to default) ──────────────────

const clearOverrideInput = accessTokenInput.extend({
  tenantId: z.string().uuid(),
  featureKey: z.string().min(1).max(120),
});

export const clearTenantNavOverride = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => clearOverrideInput.parse(raw))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const sb = admin();
    await requireAdminRole(sb, data.accessToken);
    const { error } = await sb
      .from("tenant_nav_overrides")
      .delete()
      .eq("tenant_id", data.tenantId)
      .eq("feature_key", data.featureKey);
    if (error) throw new Error(`override clear failed: ${error.message}`);
    return { ok: true };
  });

// ─── setNavFeatureDefault (admin — flip global default) ──────────────────

const setDefaultInput = accessTokenInput.extend({
  featureKey: z.string().min(1).max(120),
  defaultVisible: z.boolean(),
});

export const setNavFeatureDefault = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => setDefaultInput.parse(raw))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const sb = admin();
    await requireAdminRole(sb, data.accessToken);
    const { error } = await sb
      .from("nav_features")
      .update({
        default_visible: data.defaultVisible,
        updated_at: new Date().toISOString(),
      })
      .eq("feature_key", data.featureKey);
    if (error) throw new Error(`default flip failed: ${error.message}`);
    return { ok: true };
  });
