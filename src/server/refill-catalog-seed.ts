/**
 * Refill Catalog Seed — "ships fully loaded" engine (v2.130.0, Phase 1b).
 *
 * Copies the cross-tenant master catalog (manufacturer_catalog) into a tenant's
 * products, computing cost from the tenant's selected loyalty tier via the pure
 * resolver (manufacturer-tier-resolver.ts). Real portal "Your Price" (cost_source
 * 'portal'/'manual') is NEVER clobbered — tier work only touches 'tier_estimate'
 * /'unset'. See the v2_130_0 migration + reference_allergan_app_tiers.
 *
 *   seedTenantCatalogFromMaster — fully-load a tenant from the master book
 *   applyTenantTierSelection    — pick a tier → re-resolve estimate costs
 *   getManufacturerPrograms     — reference read (tier selector UI)
 *   getTenantTierSelections     — a tenant's current selections
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { admin } from "./admin-client";
import { getTenantIdForUser, resolveEffectiveUserId } from "@/server/auth-helpers";
import { fetchAllRows } from "@/server/paginate";
import type { Json } from "@/integrations/supabase/types";
import {
  resolvePerUnitCost,
  type ManufacturerProgramTiers,
  type TierSelection,
} from "@/lib/manufacturer-tier-resolver";

const SEED_NO_TENANT_MSG =
  "No Refill tenant — finish onboarding before loading the starter catalog.";

type MasterRow = {
  id: string;
  manufacturer: string;
  brand_family: string | null;
  product_name: string;
  sku: string | null;
  category: string;
  unit_type: string;
  units_per_box: number;
  list_price: string | number;
  default_subcategory_area: string | null;
  notes: string | null;
};

type ProgramRow = { manufacturer: string; status: string; tiers: ManufacturerProgramTiers };
type SelectionRow = { manufacturer: string; selection: TierSelection };

function num(v: string | number): number {
  return typeof v === "string" ? Number(v) : v;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Resolve per-unit list + cost + cost_source for one master row under a tenant's
 *  selection. No active program / no selection → list as cost, flagged 'unset'. */
function resolveRow(
  m: MasterRow,
  program: ProgramRow | undefined,
  selection: TierSelection | undefined,
): { listPricePerUnit: number; costPerUnit: number; costSource: "tier_estimate" | "unset" } {
  const units = m.units_per_box > 0 ? m.units_per_box : 1;
  const listBox = num(m.list_price);
  if (program && program.status === "active" && selection) {
    const r = resolvePerUnitCost({
      listPriceBox: listBox,
      unitsPerBox: units,
      brandFamily: m.brand_family,
      selection,
      program: program.tiers,
    });
    return { ...r, costSource: "tier_estimate" };
  }
  const listPerUnit = round2(listBox / units);
  return { listPricePerUnit: listPerUnit, costPerUnit: listPerUnit, costSource: "unset" };
}

async function loadPrograms(sb: ReturnType<typeof admin>): Promise<Map<string, ProgramRow>> {
  const rows = await fetchAllRows<{ manufacturer: string; status: string; tiers: Json }>((from, to) =>
    sb.from("manufacturer_programs").select("manufacturer, status, tiers").range(from, to),
  );
  const map = new Map<string, ProgramRow>();
  for (const p of rows) {
    map.set(p.manufacturer, {
      manufacturer: p.manufacturer,
      status: p.status,
      tiers: p.tiers as ManufacturerProgramTiers,
    });
  }
  return map;
}

async function loadSelections(
  sb: ReturnType<typeof admin>,
  tenantId: string,
): Promise<Map<string, TierSelection>> {
  const rows = await fetchAllRows<{ manufacturer: string; selection: Json }>((from, to) =>
    sb
      .from("tenant_manufacturer_tiers")
      .select("manufacturer, selection")
      .eq("tenant_id", tenantId)
      .range(from, to),
  );
  const map = new Map<string, TierSelection>();
  for (const r of rows) map.set(r.manufacturer, r.selection as TierSelection);
  return map;
}

// ─── seedTenantCatalogFromMaster ────────────────────────────────────────────

const seedInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
  /** Restrict to specific manufacturers; omitted = all active master rows. */
  manufacturers: z.array(z.string()).optional(),
});

export const seedTenantCatalogFromMasterFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => seedInput.parse(raw))
  .handler(async ({ data }): Promise<{ inserted: number; skipped: number }> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId, SEED_NO_TENANT_MSG);

    const master = await fetchAllRows<MasterRow>((from, to) =>
      (data.manufacturers?.length
        ? sb
            .from("manufacturer_catalog")
            .select("*")
            .eq("status", "active")
            .in("manufacturer", data.manufacturers)
        : sb.from("manufacturer_catalog").select("*").eq("status", "active")
      )
        .order("sort_order", { ascending: true, nullsFirst: false })
        .range(from, to),
    );

    const [programs, selections] = await Promise.all([loadPrograms(sb), loadSelections(sb, tenantId)]);

    // Already-seeded master rows (by catalog_ref_id) — never duplicate.
    const existingRefs = new Set(
      (
        await fetchAllRows<{ catalog_ref_id: string | null }>((from, to) =>
          sb.from("products").select("catalog_ref_id").eq("tenant_id", tenantId).range(from, to),
        )
      )
        .map((r) => r.catalog_ref_id)
        .filter((x): x is string => !!x),
    );

    const toInsert = master
      .filter((m) => !existingRefs.has(m.id))
      .map((m) => {
        const r = resolveRow(m, programs.get(m.manufacturer), selections.get(m.manufacturer));
        return {
          tenant_id: tenantId,
          brand: m.product_name,
          category: m.category,
          unit_type: m.unit_type,
          cost_per_unit: r.costPerUnit,
          sales_price_per_unit: 0, // spa sets their own retail/treatment price
          manufacturer: m.manufacturer,
          brand_family: m.brand_family,
          sku: m.sku,
          units_per_box: m.units_per_box,
          list_price: r.listPricePerUnit,
          subcategory_area: m.default_subcategory_area,
          cost_source: r.costSource,
          catalog_ref_id: m.id,
          notes: m.notes,
        };
      });

    if (toInsert.length > 0) {
      // Chunk to keep payloads sane.
      for (let i = 0; i < toInsert.length; i += 200) {
        const { error } = await sb.from("products").insert(toInsert.slice(i, i + 200));
        if (error) throw new Error(`Seed insert failed: ${error.message}`);
      }
    }
    return { inserted: toInsert.length, skipped: existingRefs.size };
  });

// ─── applyTenantTierSelection ───────────────────────────────────────────────

const applyInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
  manufacturer: z.string().min(1),
  selection: z.object({
    portfolioLevel: z.string().nullable().optional(),
    brandTiers: z.record(z.string(), z.number().nullable()).optional(),
  }),
});

export const applyTenantTierSelectionFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => applyInput.parse(raw))
  .handler(async ({ data }): Promise<{ updated: number }> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId, SEED_NO_TENANT_MSG);

    const { error: upErr } = await sb.from("tenant_manufacturer_tiers").upsert(
      { tenant_id: tenantId, manufacturer: data.manufacturer, selection: data.selection },
      { onConflict: "tenant_id,manufacturer" },
    );
    if (upErr) throw new Error(`Couldn't save tier selection: ${upErr.message}`);

    const programs = await loadPrograms(sb);
    const program = programs.get(data.manufacturer);
    if (!program || program.status !== "active") return { updated: 0 };

    // Only re-resolve estimate/unset rows — NEVER portal/manual (real costs).
    const products = await fetchAllRows<{
      id: string;
      catalog_ref_id: string | null;
    }>((from, to) =>
      sb
        .from("products")
        .select("id, catalog_ref_id")
        .eq("tenant_id", tenantId)
        .eq("manufacturer", data.manufacturer)
        .in("cost_source", ["tier_estimate", "unset"])
        .not("catalog_ref_id", "is", null)
        .range(from, to),
    );
    if (products.length === 0) return { updated: 0 };

    const refIds = products.map((p) => p.catalog_ref_id).filter((x): x is string => !!x);
    const masterById = new Map<string, MasterRow>();
    for (const m of await fetchAllRows<MasterRow>((from, to) =>
      sb.from("manufacturer_catalog").select("*").in("id", refIds).range(from, to),
    )) {
      masterById.set(m.id, m);
    }

    let updated = 0;
    for (const p of products) {
      const m = p.catalog_ref_id ? masterById.get(p.catalog_ref_id) : undefined;
      if (!m) continue;
      const r = resolveRow(m, program, data.selection as TierSelection);
      const { error } = await sb
        .from("products")
        .update({ cost_per_unit: r.costPerUnit, cost_source: "tier_estimate", list_price: r.listPricePerUnit })
        .eq("id", p.id)
        .eq("tenant_id", tenantId);
      if (!error) updated += 1;
    }
    return { updated };
  });

// ─── reads for the tier-selector UI (Phase 2) ───────────────────────────────

const readInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
});

export const getManufacturerProgramsFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => readInput.parse(raw))
  .handler(async (): Promise<
    Array<{ manufacturer: string; programName: string; status: string; tiers: ManufacturerProgramTiers }>
  > => {
    const sb = admin();
    const rows = await fetchAllRows<{
      manufacturer: string;
      program_name: string;
      status: string;
      tiers: Json;
    }>((from, to) =>
      sb
        .from("manufacturer_programs")
        .select("manufacturer, program_name, status, tiers")
        .order("status", { ascending: false })
        .order("manufacturer", { ascending: true })
        .range(from, to),
    );
    return rows.map((p) => ({
      manufacturer: p.manufacturer,
      programName: p.program_name,
      status: p.status,
      tiers: p.tiers as ManufacturerProgramTiers,
    }));
  });

export const getTenantTierSelectionsFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => readInput.parse(raw))
  .handler(async ({ data }): Promise<Array<{ manufacturer: string; selection: TierSelection }>> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId, SEED_NO_TENANT_MSG);
    const rows = await fetchAllRows<{ manufacturer: string; selection: Json }>((from, to) =>
      sb
        .from("tenant_manufacturer_tiers")
        .select("manufacturer, selection")
        .eq("tenant_id", tenantId)
        .range(from, to),
    );
    return rows.map((r) => ({ manufacturer: r.manufacturer, selection: r.selection as TierSelection }));
  });
