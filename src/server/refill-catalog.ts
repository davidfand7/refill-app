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
import { parseServiceListCsv } from "@/lib/catalog-csv";
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

// ══ Canonical Brands lookup + retroactive recategorize (v1.30.0) ═════════

export type CanonicalBrand = {
  id: string;
  displayName: string;
  aliases: string[];
  category: ServiceCategory;
  manufacturer: ProductManufacturer | null;
  unitType: ProductUnitType;
  notes: string | null;
};

type CanonicalBrandRow = {
  id: string;
  display_name: string;
  aliases: string[] | null;
  category: string;
  manufacturer: string | null;
  unit_type: string;
  notes: string | null;
};

function rowToCanonicalBrand(r: CanonicalBrandRow): CanonicalBrand {
  return {
    id: r.id,
    displayName: r.display_name,
    aliases: r.aliases ?? [],
    category: r.category as ServiceCategory,
    manufacturer: (r.manufacturer as ProductManufacturer | null) ?? null,
    unitType: r.unit_type as ProductUnitType,
    notes: r.notes,
  };
}

async function loadAllCanonicalBrands(sb: SupabaseAdmin): Promise<CanonicalBrand[]> {
  const { data, error } = await sb
    .from("canonical_brands")
    .select("*");
  if (error) throw new Error(`Couldn't load canonical brands: ${error.message}`);
  return (data ?? []).map((r) => rowToCanonicalBrand(r as CanonicalBrandRow));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Match the given input name against the canonical brand registry.
 *
 * Strategy: build a flat list of (alias, brand) pairs (each brand contributes
 * its aliases + its display_name), sort by alias length descending so the
 * MOST SPECIFIC name matches first ("Restylane Refyne" beats "Restylane"),
 * test each as a word-boundary case-insensitive regex against the input.
 * First match wins.
 *
 * Returns null when no canonical brand matches. The caller falls back to
 * regex-based name inference (the v1.29.4.x category-keyword path).
 */
export function lookupCanonicalBrand(
  name: string,
  brands: CanonicalBrand[],
): CanonicalBrand | null {
  if (!name) return null;
  const pairs: Array<{ alias: string; brand: CanonicalBrand }> = [];
  for (const brand of brands) {
    const seen = new Set<string>();
    for (const alias of brand.aliases) {
      const a = alias.trim();
      if (!a || seen.has(a.toLowerCase())) continue;
      seen.add(a.toLowerCase());
      pairs.push({ alias: a, brand });
    }
    if (!seen.has(brand.displayName.toLowerCase())) {
      pairs.push({ alias: brand.displayName, brand });
    }
  }
  pairs.sort((a, b) => b.alias.length - a.alias.length);
  for (const { alias, brand } of pairs) {
    const re = new RegExp(`\\b${escapeRegex(alias)}\\b`, "i");
    if (re.test(name)) return brand;
  }
  return null;
}

export type RecategorizeReceipt = {
  scanned: number;
  recategorized: number;
  unchanged: number;
  unmatched: number;
  changes: Array<{
    serviceId: string;
    name: string;
    oldCategory: ServiceCategory;
    newCategory: ServiceCategory;
    matchedBrand: string;
  }>;
};

// ─── Admin CRUD for canonical_brands (system-wide reference) ──────────────

const CANONICAL_CATEGORY_VALUES = ["tox", "filler", "laser", "facial", "skincare", "other"] as const;

const brandPayload = z.object({
  displayName: z.string().trim().min(1, "Display name is required.").max(120),
  aliases: z.array(z.string().trim().min(1).max(120)).default([]),
  category: z.enum(CANONICAL_CATEGORY_VALUES),
  manufacturer: z.enum(MANUFACTURER_VALUES).nullable(),
  unitType: z.enum(UNIT_VALUES),
  notes: z.string().trim().max(500).nullable(),
});

const createBrandInput = z.object({
  accessToken: z.string().min(1),
  brand: brandPayload,
});
const updateBrandInput = z.object({
  accessToken: z.string().min(1),
  id: z.string().uuid(),
  brand: brandPayload,
});
const deleteBrandInput = z.object({
  accessToken: z.string().min(1),
  id: z.string().uuid(),
});
const listBrandsInput = z.object({
  accessToken: z.string().min(1),
});

// All canonical-brand mutations require admin role. The lookup-only path
// (read) is authenticated-only via RLS; service-role writes flow through
// these server fns which gate on app_role = 'admin'.
async function requireAdmin(sb: SupabaseAdmin, userId: string): Promise<void> {
  const { data, error } = await sb
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (error) throw new Error(`Role check failed: ${error.message}`);
  if (!data) throw new Error("Admin role required.");
}

export const listCanonicalBrandsFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => listBrandsInput.parse(raw))
  .handler(async ({ data }): Promise<CanonicalBrand[]> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
    });
    const sb = admin();
    // Read is admin-only via this fn (the table itself is readable by any
    // authenticated user via RLS — the admin gate here keeps the admin
    // CRUD surface focused).
    await requireAdmin(sb, effectiveUserId);
    return loadAllCanonicalBrands(sb);
  });

export const createCanonicalBrandFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => createBrandInput.parse(raw))
  .handler(async ({ data }): Promise<CanonicalBrand> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
    });
    const sb = admin();
    await requireAdmin(sb, effectiveUserId);
    const { data: row, error } = await sb
      .from("canonical_brands")
      .insert({
        display_name: data.brand.displayName,
        aliases: data.brand.aliases,
        category: data.brand.category,
        manufacturer: data.brand.manufacturer,
        unit_type: data.brand.unitType,
        notes: data.brand.notes,
      })
      .select("*")
      .single();
    if (error || !row) throw new Error(`Couldn't create brand: ${error?.message ?? "no row"}`);
    return rowToCanonicalBrand(row as CanonicalBrandRow);
  });

export const updateCanonicalBrandFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => updateBrandInput.parse(raw))
  .handler(async ({ data }): Promise<CanonicalBrand> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
    });
    const sb = admin();
    await requireAdmin(sb, effectiveUserId);
    const { data: row, error } = await sb
      .from("canonical_brands")
      .update({
        display_name: data.brand.displayName,
        aliases: data.brand.aliases,
        category: data.brand.category,
        manufacturer: data.brand.manufacturer,
        unit_type: data.brand.unitType,
        notes: data.brand.notes,
      })
      .eq("id", data.id)
      .select("*")
      .single();
    if (error || !row) throw new Error(`Couldn't update brand: ${error?.message ?? "no row"}`);
    return rowToCanonicalBrand(row as CanonicalBrandRow);
  });

export const deleteCanonicalBrandFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => deleteBrandInput.parse(raw))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
    });
    const sb = admin();
    await requireAdmin(sb, effectiveUserId);
    const { error } = await sb
      .from("canonical_brands")
      .delete()
      .eq("id", data.id);
    if (error) throw new Error(`Couldn't delete brand: ${error.message}`);
    return { ok: true };
  });

export const recategorizeServicesFromBrandsFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => readInput.parse(raw))
  .handler(async ({ data }): Promise<RecategorizeReceipt> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);
    const brands = await loadAllCanonicalBrands(sb);
    const { data: services, error } = await sb
      .from("services")
      .select("id, name, notes, category")
      .eq("tenant_id", tenantId);
    if (error) throw new Error(`Couldn't list services: ${error.message}`);
    const rows = (services ?? []) as Array<{
      id: string;
      name: string;
      notes: string | null;
      category: string;
    }>;
    let scanned = 0;
    let recategorized = 0;
    let unchanged = 0;
    let unmatched = 0;
    const changes: RecategorizeReceipt["changes"] = [];
    for (const r of rows) {
      scanned++;
      // Try the name first, then fall back to notes for a longer-text match.
      const matchName = lookupCanonicalBrand(r.name, brands);
      const match = matchName ?? (r.notes ? lookupCanonicalBrand(r.notes, brands) : null);
      if (!match) {
        unmatched++;
        continue;
      }
      const oldCategory = r.category as ServiceCategory;
      if (oldCategory === match.category) {
        unchanged++;
        continue;
      }
      const { error: updErr } = await sb
        .from("services")
        .update({ category: match.category })
        .eq("id", r.id)
        .eq("tenant_id", tenantId);
      if (updErr) {
        unchanged++;
        continue;
      }
      recategorized++;
      changes.push({
        serviceId: r.id,
        name: r.name,
        oldCategory,
        newCategory: match.category,
        matchedBrand: match.displayName,
      });
    }
    return { scanned, recategorized, unchanged, unmatched, changes };
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

// ══ Service-Products linkage + auto-COGS derive (v1.29.3) ════════════════

export type ServiceProductLink = {
  id: string;
  serviceId: string;
  productId: string;
  productBrand: string;
  productUnitType: string;
  productCostPerUnit: number;
  quantityPerService: number;
  derivedCostContribution: number;
};

type ServiceProductRow = {
  id: string;
  service_id: string;
  product_id: string;
  quantity_per_service: string | number;
  products: {
    id: string;
    brand: string;
    unit_type: string;
    cost_per_unit: string | number;
    tenant_id: string;
  } | null;
};

function rowToLink(r: ServiceProductRow): ServiceProductLink | null {
  if (!r.products) return null;
  const qty = typeof r.quantity_per_service === "string" ? Number(r.quantity_per_service) : r.quantity_per_service;
  const cost = typeof r.products.cost_per_unit === "string" ? Number(r.products.cost_per_unit) : r.products.cost_per_unit;
  return {
    id: r.id,
    serviceId: r.service_id,
    productId: r.product_id,
    productBrand: r.products.brand,
    productUnitType: r.products.unit_type,
    productCostPerUnit: cost,
    quantityPerService: qty,
    derivedCostContribution: cost * qty,
  };
}

/**
 * Compute SUM(product.cost_per_unit × link.quantity_per_service) for a service.
 * If the service has cogs_source = 'derived', this value gets written back to
 * services.cogs_per_service on every link/unlink/quantity change so the read
 * path stays single-column-simple.
 */
async function computeDerivedCogs(
  sb: SupabaseAdmin,
  serviceId: string,
  tenantId: string,
): Promise<number> {
  const { data, error } = await sb
    .from("service_products")
    .select(`
      quantity_per_service,
      products!inner ( cost_per_unit, tenant_id )
    `)
    .eq("service_id", serviceId);
  if (error) throw new Error(`Couldn't compute derived COGS: ${error.message}`);
  let sum = 0;
  for (const r of (data ?? []) as unknown as Array<{
    quantity_per_service: string | number;
    products: { cost_per_unit: string | number; tenant_id: string };
  }>) {
    if (r.products?.tenant_id !== tenantId) continue;
    const qty = typeof r.quantity_per_service === "string" ? Number(r.quantity_per_service) : r.quantity_per_service;
    const cost = typeof r.products.cost_per_unit === "string" ? Number(r.products.cost_per_unit) : r.products.cost_per_unit;
    sum += qty * cost;
  }
  return Math.round(sum * 100) / 100;
}

/**
 * If the service is in 'derived' mode, recompute and persist cogs_per_service
 * from the current linkage. No-op if in 'manual' mode.
 */
async function syncDerivedCogsIfNeeded(
  sb: SupabaseAdmin,
  serviceId: string,
  tenantId: string,
): Promise<void> {
  const { data: svc, error: svcErr } = await sb
    .from("services")
    .select("cogs_source")
    .eq("id", serviceId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (svcErr) throw new Error(`Couldn't read service: ${svcErr.message}`);
  if (!svc || svc.cogs_source !== "derived") return;
  const derived = await computeDerivedCogs(sb, serviceId, tenantId);
  const { error: updErr } = await sb
    .from("services")
    .update({ cogs_per_service: derived })
    .eq("id", serviceId)
    .eq("tenant_id", tenantId);
  if (updErr) throw new Error(`Couldn't persist derived COGS: ${updErr.message}`);
}

async function loadServiceById(
  sb: SupabaseAdmin,
  serviceId: string,
  tenantId: string,
): Promise<Service> {
  const { data, error } = await sb
    .from("services")
    .select("*")
    .eq("id", serviceId)
    .eq("tenant_id", tenantId)
    .single();
  if (error || !data) throw new Error(`Couldn't load service: ${error?.message ?? "no row"}`);
  return rowToService(data as ServiceRow);
}

async function loadLinksForService(
  sb: SupabaseAdmin,
  serviceId: string,
  tenantId: string,
): Promise<ServiceProductLink[]> {
  const { data, error } = await sb
    .from("service_products")
    .select(`
      id,
      service_id,
      product_id,
      quantity_per_service,
      products ( id, brand, unit_type, cost_per_unit, tenant_id )
    `)
    .eq("service_id", serviceId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Couldn't list service-products: ${error.message}`);
  const rows = (data ?? []) as unknown as ServiceProductRow[];
  return rows
    .map(rowToLink)
    .filter((l): l is ServiceProductLink => l !== null && l.productCostPerUnit >= 0)
    .filter((l) => {
      // defense-in-depth: ensure the joined product belongs to the same tenant
      const r = rows.find((row) => row.id === l.id);
      return r?.products?.tenant_id === tenantId;
    });
}

const linkInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
  serviceId: z.string().uuid(),
});

const createLinkInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
  serviceId: z.string().uuid(),
  productId: z.string().uuid(),
  quantityPerService: z.number().positive("Quantity must be greater than 0."),
});

const updateLinkInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
  linkId: z.string().uuid(),
  quantityPerService: z.number().positive("Quantity must be greater than 0."),
});

const unlinkInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
  linkId: z.string().uuid(),
});

const setCogsSourceInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
  serviceId: z.string().uuid(),
  cogsSource: z.enum(["manual", "derived"]),
});

export type ServiceLinkageBundle = {
  service: Service;
  links: ServiceProductLink[];
};

// ─── listServiceProductsFn ────────────────────────────────────────────────

export const listServiceProductsFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => linkInput.parse(raw))
  .handler(async ({ data }): Promise<ServiceLinkageBundle> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);
    const service = await loadServiceById(sb, data.serviceId, tenantId);
    const links = await loadLinksForService(sb, data.serviceId, tenantId);
    return { service, links };
  });

// ─── linkProductToServiceFn ───────────────────────────────────────────────

export const linkProductToServiceFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => createLinkInput.parse(raw))
  .handler(async ({ data }): Promise<ServiceLinkageBundle> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);
    // Validate both service + product belong to this tenant.
    const { data: svc, error: svcErr } = await sb
      .from("services")
      .select("id")
      .eq("id", data.serviceId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (svcErr) throw new Error(`Couldn't verify service: ${svcErr.message}`);
    if (!svc) throw new Error("Service not found in this tenant.");
    const { data: prod, error: prodErr } = await sb
      .from("products")
      .select("id")
      .eq("id", data.productId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (prodErr) throw new Error(`Couldn't verify product: ${prodErr.message}`);
    if (!prod) throw new Error("Product not found in this tenant.");
    // Upsert via the unique (service_id, product_id) constraint — if the
    // owner clicks Link twice on the same product, second click updates qty.
    const { error: linkErr } = await sb
      .from("service_products")
      .upsert(
        {
          service_id: data.serviceId,
          product_id: data.productId,
          quantity_per_service: data.quantityPerService,
        },
        { onConflict: "service_id,product_id" },
      );
    if (linkErr) throw new Error(`Couldn't link product: ${linkErr.message}`);
    await syncDerivedCogsIfNeeded(sb, data.serviceId, tenantId);
    const service = await loadServiceById(sb, data.serviceId, tenantId);
    const links = await loadLinksForService(sb, data.serviceId, tenantId);
    return { service, links };
  });

// ─── updateServiceProductQuantityFn ───────────────────────────────────────

export const updateServiceProductQuantityFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => updateLinkInput.parse(raw))
  .handler(async ({ data }): Promise<ServiceLinkageBundle> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);
    // Verify the link belongs to a service in this tenant.
    const { data: linkRow, error: linkErr } = await sb
      .from("service_products")
      .select(`service_id, services!inner(tenant_id)`)
      .eq("id", data.linkId)
      .maybeSingle();
    if (linkErr) throw new Error(`Couldn't verify link: ${linkErr.message}`);
    const linkRowTyped = linkRow as unknown as { service_id: string; services: { tenant_id: string } } | null;
    if (!linkRowTyped || linkRowTyped.services.tenant_id !== tenantId) {
      throw new Error("Link not found in this tenant.");
    }
    const serviceId = linkRowTyped.service_id;
    const { error: updErr } = await sb
      .from("service_products")
      .update({ quantity_per_service: data.quantityPerService })
      .eq("id", data.linkId);
    if (updErr) throw new Error(`Couldn't update quantity: ${updErr.message}`);
    await syncDerivedCogsIfNeeded(sb, serviceId, tenantId);
    const service = await loadServiceById(sb, serviceId, tenantId);
    const links = await loadLinksForService(sb, serviceId, tenantId);
    return { service, links };
  });

// ─── unlinkServiceProductFn ───────────────────────────────────────────────

export const unlinkServiceProductFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => unlinkInput.parse(raw))
  .handler(async ({ data }): Promise<ServiceLinkageBundle> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);
    const { data: linkRow, error: linkErr } = await sb
      .from("service_products")
      .select(`service_id, services!inner(tenant_id)`)
      .eq("id", data.linkId)
      .maybeSingle();
    if (linkErr) throw new Error(`Couldn't verify link: ${linkErr.message}`);
    const linkRowTyped = linkRow as unknown as { service_id: string; services: { tenant_id: string } } | null;
    if (!linkRowTyped || linkRowTyped.services.tenant_id !== tenantId) {
      throw new Error("Link not found in this tenant.");
    }
    const serviceId = linkRowTyped.service_id;
    const { error: delErr } = await sb
      .from("service_products")
      .delete()
      .eq("id", data.linkId);
    if (delErr) throw new Error(`Couldn't unlink: ${delErr.message}`);
    await syncDerivedCogsIfNeeded(sb, serviceId, tenantId);
    const service = await loadServiceById(sb, serviceId, tenantId);
    const links = await loadLinksForService(sb, serviceId, tenantId);
    return { service, links };
  });

// ══ CSV Import (v1.29.4) ═════════════════════════════════════════════════

export type ImportPreviewRow = {
  rowIndex: number;
  parsedName: string;
  rawType: string | null;
  parsedCategory: ServiceCategory;
  categorySource: "csv" | "name-inferred" | "default";
  parsedPrice: number;
  parsedCogs: number | null;
  parsedDescription: string | null;
  isService: boolean;
  action: "create" | "update" | "skip-non-service" | "skip-error";
  existingServiceId: string | null;
  warnings: string[];
};

export type ImportPreview = {
  headers: string[];
  headerRowIndex: number;
  fieldMapping: {
    name: string | null;
    type: string | null;
    category: string | null;
    price: string | null;
    cost: string | null;
    duration: string | null;
    description: string | null;
  };
  unmappedHeaders: string[];
  totalRows: number;
  parseableRows: number;
  skippedRows: number;
  nonServiceRows: number;
  willCreate: number;
  willUpdate: number;
  willSkipNonService: number;
  withCogs: number;
  preview: ImportPreviewRow[];
  parseErrors: Array<{ rowIndex: number; reason: string }>;
};

export type ImportReceipt = {
  created: number;
  updated: number;
  failed: Array<{ rowIndex: number; name: string; reason: string }>;
};

const importInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
  csv: z.string().min(1, "CSV file is empty."),
  mode: z.enum(["preview", "commit"]),
});

export const ingestServicesCsvFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => importInput.parse(raw))
  .handler(async ({ data }): Promise<ImportPreview | ImportReceipt> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);

    const parsed = parseServiceListCsv(data.csv);

    // Fetch existing services for upsert-by-name matching.
    const { data: existing, error: existingErr } = await sb
      .from("services")
      .select("id, name")
      .eq("tenant_id", tenantId);
    if (existingErr) throw new Error(`Couldn't list existing services: ${existingErr.message}`);
    const byNameLower = new Map<string, string>();
    for (const s of existing ?? []) {
      byNameLower.set((s.name as string).trim().toLowerCase(), s.id as string);
    }

    if (data.mode === "preview") {
      let willCreate = 0;
      let willUpdate = 0;
      let willSkipNonService = 0;
      let withCogs = 0;
      const preview: ImportPreviewRow[] = parsed.rows.map((r) => {
        const existingId = byNameLower.get(r.parsedName.trim().toLowerCase()) ?? null;
        let action: ImportPreviewRow["action"];
        if (!r.isService) {
          action = "skip-non-service";
          willSkipNonService++;
        } else if (existingId) {
          action = "update";
          willUpdate++;
        } else {
          action = "create";
          willCreate++;
        }
        if (r.parsedCogs !== null) withCogs++;
        return {
          rowIndex: r.rowIndex,
          parsedName: r.parsedName,
          rawType: r.rawType,
          parsedCategory: r.parsedCategory,
          categorySource: r.categorySource,
          parsedPrice: r.parsedPrice ?? 0,
          parsedCogs: r.parsedCogs,
          parsedDescription: r.parsedDescription,
          isService: r.isService,
          action,
          existingServiceId: existingId,
          warnings: r.warnings,
        };
      });
      return {
        headers: parsed.headers,
        headerRowIndex: parsed.headerRowIndex,
        fieldMapping: parsed.fieldMapping,
        unmappedHeaders: parsed.unmappedHeaders,
        totalRows: parsed.totalRows,
        parseableRows: parsed.parseableRows,
        skippedRows: parsed.skippedRows,
        nonServiceRows: parsed.nonServiceRows,
        willCreate,
        willUpdate,
        willSkipNonService,
        withCogs,
        preview,
        parseErrors: parsed.parseErrors,
      };
    }

    // Commit path — upsert each row.
    let created = 0;
    let updated = 0;
    const failed: ImportReceipt["failed"] = [];

    for (const r of parsed.rows) {
      // Skip non-service rows entirely on commit — they're products
      // (retail items) and belong in a future products-CSV import path,
      // not in the services table.
      if (!r.isService) continue;
      const existingId = byNameLower.get(r.parsedName.trim().toLowerCase()) ?? null;
      try {
        if (existingId) {
          // On update, only set cogs_per_service if the CSV provided one
          // AND the existing service is in 'manual' mode. Skip cogs write
          // for derived-mode services (their cogs is auto-managed) — would
          // be silently overwritten on next link change otherwise.
          const updatePayload: Record<string, unknown> = {
            category: r.parsedCategory,
            service_price: r.parsedPrice ?? 0,
            notes: r.parsedDescription,
          };
          if (r.parsedCogs !== null) {
            const { data: existing } = await sb
              .from("services")
              .select("cogs_source")
              .eq("id", existingId)
              .eq("tenant_id", tenantId)
              .maybeSingle();
            if (existing?.cogs_source !== "derived") {
              updatePayload.cogs_per_service = r.parsedCogs;
              updatePayload.cogs_source = "manual";
            }
          }
          const { error } = await sb
            .from("services")
            .update(updatePayload)
            .eq("id", existingId)
            .eq("tenant_id", tenantId);
          if (error) throw new Error(error.message);
          updated++;
        } else {
          const { error } = await sb
            .from("services")
            .insert({
              tenant_id: tenantId,
              name: r.parsedName,
              category: r.parsedCategory,
              service_price: r.parsedPrice ?? 0,
              cogs_per_service: r.parsedCogs,
              cogs_source: "manual",
              notes: r.parsedDescription,
            });
          if (error) throw new Error(error.message);
          created++;
        }
      } catch (err) {
        failed.push({
          rowIndex: r.rowIndex,
          name: r.parsedName,
          reason: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }

    return { created, updated, failed };
  });

// ─── setServiceCogsSourceFn ───────────────────────────────────────────────

export const setServiceCogsSourceFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => setCogsSourceInput.parse(raw))
  .handler(async ({ data }): Promise<ServiceLinkageBundle> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);
    if (data.cogsSource === "derived") {
      const derived = await computeDerivedCogs(sb, data.serviceId, tenantId);
      const { error } = await sb
        .from("services")
        .update({ cogs_source: "derived", cogs_per_service: derived })
        .eq("id", data.serviceId)
        .eq("tenant_id", tenantId);
      if (error) throw new Error(`Couldn't switch to derived: ${error.message}`);
    } else {
      // Flipping to manual leaves the current cogs_per_service intact so
      // the owner has a starting value to edit. They can clear or change
      // it via the regular service-edit form.
      const { error } = await sb
        .from("services")
        .update({ cogs_source: "manual" })
        .eq("id", data.serviceId)
        .eq("tenant_id", tenantId);
      if (error) throw new Error(`Couldn't switch to manual: ${error.message}`);
    }
    const service = await loadServiceById(sb, data.serviceId, tenantId);
    const links = await loadLinksForService(sb, data.serviceId, tenantId);
    return { service, links };
  });
