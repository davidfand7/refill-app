/**
 * Refill Catalog — Products + Services CRUD server fns (v1.29.x).
 *
 * Substrate primitive for the Profitability Engine (spec §3.1, Desktop/
 * Refill-Profitability-Engine-Spec-v0_1.html). Three tables shipped in
 * v1.29.0 migration:
 *   - public.products          (per-tenant physical products)
 *   - public.services          (per-tenant services offered)
 *   - public.service_products  (many-to-many junction; quantity_per_service)
 *
 * Auth pattern: verifyAuth → resolveEffectiveUserId (admin viewAs honored)
 * → getTenantIdForUser. Matches refill-billing.ts shape verbatim. No-tenant
 * users get a hard error directing them to onboarding.
 *
 * v1.29.1 ships Products CRUD only. v1.29.2 adds Services. v1.29.3 adds the
 * linkage CRUD + auto-margin derive. v1.29.4 adds Acuity CSV import.
 */

import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { resolveEffectiveUserId } from "@/server/auth-helpers";

// ─── Public types ─────────────────────────────────────────────────────────

export type ProductCategory = "tox" | "filler" | "laser_consumable" | "skincare" | "other";

export type ProductUnitType = "vial" | "syringe" | "bottle" | "session" | "other";

export type ProductManufacturer =
  | "abbvie"
  | "galderma"
  | "evolus"
  | "merz"
  | "skinceuticals"
  | "eltamd"
  | "neocutis"
  | "obagi"
  | "revance"
  | "rha"
  | "sciton"
  | "abbvie-coolsculpting"
  | "generic"
  | "in_house";

export type Product = {
  id: string;
  tenantId: string;
  brand: string;
  category: ProductCategory;
  unitType: ProductUnitType;
  costPerUnit: number;
  salesPricePerUnit: number;
  marginPerUnit: number;
  marginPct: number | null;
  manufacturer: ProductManufacturer | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

// ─── Admin client ─────────────────────────────────────────────────────────

function admin() {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw new Error("Server is missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  }
  return createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

type SupabaseAdmin = ReturnType<typeof admin>;

async function getTenantIdForUser(sb: SupabaseAdmin, userId: string): Promise<string> {
  const { data, error } = await sb
    .from("tenant_memberships")
    .select("tenant_id, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Tenant lookup failed: ${error.message}`);
  if (!data) {
    throw new Error("No Refill tenant — finish onboarding before opening the catalog.");
  }
  return data.tenant_id;
}

// ─── Shape adapters ───────────────────────────────────────────────────────

type ProductRow = {
  id: string;
  tenant_id: string;
  brand: string;
  category: string;
  unit_type: string;
  cost_per_unit: string | number;
  sales_price_per_unit: string | number;
  manufacturer: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

function rowToProduct(r: ProductRow): Product {
  const cost = typeof r.cost_per_unit === "string" ? Number(r.cost_per_unit) : r.cost_per_unit;
  const price = typeof r.sales_price_per_unit === "string" ? Number(r.sales_price_per_unit) : r.sales_price_per_unit;
  const margin = price - cost;
  const marginPct = price > 0 ? margin / price : null;
  return {
    id: r.id,
    tenantId: r.tenant_id,
    brand: r.brand,
    category: r.category as ProductCategory,
    unitType: r.unit_type as ProductUnitType,
    costPerUnit: cost,
    salesPricePerUnit: price,
    marginPerUnit: margin,
    marginPct,
    manufacturer: (r.manufacturer as ProductManufacturer | null) ?? null,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ─── Zod ──────────────────────────────────────────────────────────────────

const CATEGORY_VALUES = ["tox", "filler", "laser_consumable", "skincare", "other"] as const;
const UNIT_VALUES = ["vial", "syringe", "bottle", "session", "other"] as const;
const MANUFACTURER_VALUES = [
  "abbvie", "galderma", "evolus", "merz",
  "skinceuticals", "eltamd", "neocutis", "obagi",
  "revance", "rha", "sciton", "abbvie-coolsculpting",
  "generic", "in_house",
] as const;

const readInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
});

const productPayload = z.object({
  brand: z.string().trim().min(1, "Brand is required.").max(120),
  category: z.enum(CATEGORY_VALUES),
  unitType: z.enum(UNIT_VALUES),
  costPerUnit: z.number().nonnegative("Cost can't be negative."),
  salesPricePerUnit: z.number().nonnegative("Price can't be negative."),
  manufacturer: z.enum(MANUFACTURER_VALUES).nullable(),
  notes: z.string().trim().max(500).nullable(),
});

const createInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
  product: productPayload,
});

const updateInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
  id: z.string().uuid(),
  product: productPayload,
});

const deleteInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
  id: z.string().uuid(),
});

// ─── listProductsFn ───────────────────────────────────────────────────────

export const listProductsFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => readInput.parse(raw))
  .handler(async ({ data }): Promise<Product[]> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);
    const { data: rows, error } = await sb
      .from("products")
      .select("*")
      .eq("tenant_id", tenantId)
      .order("category", { ascending: true })
      .order("brand", { ascending: true });
    if (error) throw new Error(`Couldn't list products: ${error.message}`);
    return (rows ?? []).map((r) => rowToProduct(r as ProductRow));
  });

// ─── createProductFn ──────────────────────────────────────────────────────

export const createProductFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => createInput.parse(raw))
  .handler(async ({ data }): Promise<Product> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);
    const { data: row, error } = await sb
      .from("products")
      .insert({
        tenant_id: tenantId,
        brand: data.product.brand,
        category: data.product.category,
        unit_type: data.product.unitType,
        cost_per_unit: data.product.costPerUnit,
        sales_price_per_unit: data.product.salesPricePerUnit,
        manufacturer: data.product.manufacturer,
        notes: data.product.notes,
      })
      .select("*")
      .single();
    if (error || !row) {
      throw new Error(`Couldn't create product: ${error?.message ?? "no row"}`);
    }
    return rowToProduct(row as ProductRow);
  });

// ─── updateProductFn ──────────────────────────────────────────────────────

export const updateProductFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => updateInput.parse(raw))
  .handler(async ({ data }): Promise<Product> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);
    const { data: row, error } = await sb
      .from("products")
      .update({
        brand: data.product.brand,
        category: data.product.category,
        unit_type: data.product.unitType,
        cost_per_unit: data.product.costPerUnit,
        sales_price_per_unit: data.product.salesPricePerUnit,
        manufacturer: data.product.manufacturer,
        notes: data.product.notes,
      })
      .eq("id", data.id)
      .eq("tenant_id", tenantId)
      .select("*")
      .single();
    if (error || !row) {
      throw new Error(`Couldn't update product: ${error?.message ?? "no row"}`);
    }
    return rowToProduct(row as ProductRow);
  });

// ─── deleteProductFn ──────────────────────────────────────────────────────

export const deleteProductFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => deleteInput.parse(raw))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);
    const { error } = await sb
      .from("products")
      .delete()
      .eq("id", data.id)
      .eq("tenant_id", tenantId);
    if (error) throw new Error(`Couldn't delete product: ${error.message}`);
    return { ok: true };
  });

// ══ Services (v1.29.2) ═══════════════════════════════════════════════════

export type ServiceCategory = "tox" | "filler" | "laser" | "facial" | "skincare" | "other";

export type ServiceCogsSource = "manual" | "derived";

export type Service = {
  id: string;
  tenantId: string;
  name: string;
  category: ServiceCategory;
  servicePrice: number;
  cogsPerService: number | null;
  cogsSource: ServiceCogsSource;
  marginPerService: number | null;
  marginPct: number | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

type ServiceRow = {
  id: string;
  tenant_id: string;
  name: string;
  category: string;
  service_price: string | number;
  cogs_per_service: string | number | null;
  cogs_source: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

function rowToService(r: ServiceRow): Service {
  const price = typeof r.service_price === "string" ? Number(r.service_price) : r.service_price;
  const cogsRaw = r.cogs_per_service;
  const cogs = cogsRaw === null ? null : typeof cogsRaw === "string" ? Number(cogsRaw) : cogsRaw;
  const margin = cogs === null ? null : price - cogs;
  const marginPct = margin === null || price <= 0 ? null : margin / price;
  return {
    id: r.id,
    tenantId: r.tenant_id,
    name: r.name,
    category: r.category as ServiceCategory,
    servicePrice: price,
    cogsPerService: cogs,
    cogsSource: r.cogs_source as ServiceCogsSource,
    marginPerService: margin,
    marginPct,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const SERVICE_CATEGORY_VALUES = ["tox", "filler", "laser", "facial", "skincare", "other"] as const;

const servicePayload = z.object({
  name: z.string().trim().min(1, "Service name is required.").max(160),
  category: z.enum(SERVICE_CATEGORY_VALUES),
  servicePrice: z.number().nonnegative("Price can't be negative."),
  cogsPerService: z.number().nonnegative("COGS can't be negative.").nullable(),
  notes: z.string().trim().max(500).nullable(),
});

const createServiceInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
  service: servicePayload,
});

const updateServiceInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
  id: z.string().uuid(),
  service: servicePayload,
});

// ─── listServicesFn ───────────────────────────────────────────────────────

export const listServicesFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => readInput.parse(raw))
  .handler(async ({ data }): Promise<Service[]> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);
    const { data: rows, error } = await sb
      .from("services")
      .select("*")
      .eq("tenant_id", tenantId)
      .order("category", { ascending: true })
      .order("name", { ascending: true });
    if (error) throw new Error(`Couldn't list services: ${error.message}`);
    return (rows ?? []).map((r) => rowToService(r as ServiceRow));
  });

// ─── createServiceFn ──────────────────────────────────────────────────────

export const createServiceFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => createServiceInput.parse(raw))
  .handler(async ({ data }): Promise<Service> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);
    const { data: row, error } = await sb
      .from("services")
      .insert({
        tenant_id: tenantId,
        name: data.service.name,
        category: data.service.category,
        service_price: data.service.servicePrice,
        cogs_per_service: data.service.cogsPerService,
        cogs_source: "manual",
        notes: data.service.notes,
      })
      .select("*")
      .single();
    if (error || !row) {
      throw new Error(`Couldn't create service: ${error?.message ?? "no row"}`);
    }
    return rowToService(row as ServiceRow);
  });

// ─── updateServiceFn ──────────────────────────────────────────────────────

export const updateServiceFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => updateServiceInput.parse(raw))
  .handler(async ({ data }): Promise<Service> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);
    // Editing a manual COGS field keeps cogs_source = 'manual'. v1.29.3
    // will introduce the auto-derive path that flips it to 'derived'.
    const { data: row, error } = await sb
      .from("services")
      .update({
        name: data.service.name,
        category: data.service.category,
        service_price: data.service.servicePrice,
        cogs_per_service: data.service.cogsPerService,
        cogs_source: "manual",
        notes: data.service.notes,
      })
      .eq("id", data.id)
      .eq("tenant_id", tenantId)
      .select("*")
      .single();
    if (error || !row) {
      throw new Error(`Couldn't update service: ${error?.message ?? "no row"}`);
    }
    return rowToService(row as ServiceRow);
  });

// ─── deleteServiceFn ──────────────────────────────────────────────────────

export const deleteServiceFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => deleteInput.parse(raw))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);
    const { error } = await sb
      .from("services")
      .delete()
      .eq("id", data.id)
      .eq("tenant_id", tenantId);
    if (error) throw new Error(`Couldn't delete service: ${error.message}`);
    return { ok: true };
  });
