/**
 * Vision portal-import server fns (v2.139.0, Ship 2 of the vision-ingestion moat).
 *
 * Client-safe entrypoints on top of portal-import-core.ts. The heavy vision +
 * matching engine (which imports @anthropic-ai/sdk → node:crypto/fs) lives in
 * the server-only core; these createServerFn handlers reach it via a *dynamic*
 * import inside the handler body, so the SDK never lands in the browser bundle
 * even though the catalog UI imports this module. See project_vision_portal_import.
 *
 * ONE pipeline, two ingest mouths:
 *   - in-app upload  → createPortalImportFromUploadFn (this file)
 *   - email-forward  → the inbound lane imports portal-import-core directly (Ship 3)
 *
 * NEVER blind-writes. The owner-review step (applyPortalImportBatchFn with an
 * explicit confirmed list) is the accuracy + GIGO backstop — esp. the per-BOX
 * ÷ units_per_box conversion (Allergan box = 2 syringes; see
 * reference_catalog_packaging_units, the #1 cost-import trap).
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { admin } from "./admin-client";
import { getTenantIdForUser, resolveEffectiveUserId } from "@/server/auth-helpers";
import { fetchAllRows } from "@/server/paginate";
import type { Json } from "@/integrations/supabase/types";
import type { PortalImportProposal } from "./portal-import-core";

export type { PortalImportProposal } from "./portal-import-core";

const NO_TENANT_MSG =
  "No Refill tenant — finish onboarding before importing portal prices.";

// Browser-safe (plain strings); used by the input schema below. The core owns
// its own copy for the engine — kept here so this module needs no value import
// from the Anthropic-bearing core.
const IMAGE_MEDIA = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

// ─── Server fns (in-app: upload, list, apply, dismiss) ──────────────────────

const imageSchema = z.object({
  data: z.string().min(1).max(15_000_000), // base64; ~10MB raw cap
  mediaType: z.enum(IMAGE_MEDIA),
});

const uploadInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
  manufacturer: z.string().optional(),
  images: z.array(imageSchema).min(1).max(8),
});

export const createPortalImportFromUploadFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => uploadInput.parse(raw))
  .handler(
    async ({
      data,
    }): Promise<{ batchId: string; manufacturer: string | null; proposals: PortalImportProposal[] }> => {
      const { effectiveUserId } = await resolveEffectiveUserId({
        accessToken: data.accessToken,
        viewAsUserId: data.viewAsUserId,
      });
      const sb = admin();
      const tenantId = await getTenantIdForUser(sb, effectiveUserId, NO_TENANT_MSG);
      // Dynamic import keeps the Anthropic SDK out of the client bundle.
      const { ingestPortalImport } = await import("./portal-import-core");
      return ingestPortalImport({
        sb,
        tenantId,
        source: "upload",
        images: data.images,
        manufacturerHint: data.manufacturer ?? null,
      });
    },
  );

const listInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
});

export type PortalImportBatch = {
  id: string;
  source: "upload" | "email";
  manufacturer: string | null;
  status: "pending_review" | "applied" | "dismissed";
  proposals: PortalImportProposal[];
  createdAt: string;
  reviewedAt: string | null;
};

export const listPortalImportBatchesFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => listInput.parse(raw))
  .handler(async ({ data }): Promise<PortalImportBatch[]> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId, NO_TENANT_MSG);
    const rows = await fetchAllRows<{
      id: string;
      source: string;
      manufacturer: string | null;
      status: string;
      rows: Json;
      created_at: string;
      reviewed_at: string | null;
    }>((from, to) =>
      sb
        .from("portal_import_batches")
        .select("id, source, manufacturer, status, rows, created_at, reviewed_at")
        .eq("tenant_id", tenantId)
        .order("created_at", { ascending: false })
        .range(from, to),
    );
    return rows.map((b) => ({
      id: b.id,
      source: b.source as "upload" | "email",
      manufacturer: b.manufacturer,
      status: b.status as "pending_review" | "applied" | "dismissed",
      proposals: (Array.isArray(b.rows) ? b.rows : []) as unknown as PortalImportProposal[],
      createdAt: b.created_at,
      reviewedAt: b.reviewed_at,
    }));
  });

const applyInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
  batchId: z.string().uuid(),
  /** Product ids the owner confirmed — only these get the portal cost. */
  confirmProductIds: z.array(z.string().uuid()).min(1),
});

/** First integer in a qty label ("250 vials" → 250), else null. */
function parseQtyDigits(qty: string): number | null {
  const m = qty.match(/(\d[\d,]*)/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * Persist confirmed volume-tier ladders to the tenant's verified_ladders
 * (P2) — the REAL per-rung portal prices, stored PER-TENANT (never the shared
 * manufacturer_programs). Keyed by brand_family; merges into any existing
 * ladders + preserves the tenant's tier selection. Non-fatal: the verified
 * cost is already written, the ladder is a bonus for the Programs view +
 * future buy-optimization.
 */
async function persistVerifiedLadders(
  sb: ReturnType<typeof admin>,
  tenantId: string,
  tiered: PortalImportProposal[],
  nowIso: string,
): Promise<void> {
  const ids = tiered.map((p) => p.matchedProductId).filter((x): x is string => !!x);
  if (ids.length === 0) return;
  const { data: prods } = await sb
    .from("products")
    .select("id, manufacturer, brand, brand_family, unit_type")
    .in("id", ids)
    .eq("tenant_id", tenantId);
  const meta = new Map((prods ?? []).map((r) => [r.id, r]));

  // Load the program's ladder family names per manufacturer so we can (a) use
  // the canonical key the Programs display expects, and (b) derive a family
  // when the product's brand_family is null (e.g. an inline-added product).
  const mfrs = [...new Set((prods ?? []).map((r) => r.manufacturer).filter((x): x is string => !!x))];
  const ladderKeysByMfr = new Map<string, string[]>();
  for (const mfr of mfrs) {
    const { data: prog } = await sb
      .from("manufacturer_programs")
      .select("tiers")
      .eq("manufacturer", mfr)
      .maybeSingle();
    const t = (prog?.tiers ?? {}) as { productLadders?: Record<string, unknown> };
    ladderKeysByMfr.set(mfr, Object.keys(t.productLadders ?? {}));
  }
  function deriveFamily(
    brand: string | null,
    brandFamily: string | null,
    keys: string[],
  ): string | null {
    if (brandFamily && keys.includes(brandFamily)) return brandFamily;
    const b = (brand ?? "").toLowerCase();
    return keys.find((k) => b.includes(k.toLowerCase())) ?? brandFamily ?? null;
  }

  // manufacturer → { brand_family → ladder }
  const byMfr = new Map<string, Record<string, unknown>>();
  for (const p of tiered) {
    const m = p.matchedProductId ? meta.get(p.matchedProductId) : undefined;
    if (!m || !m.manufacturer || !p.tiers) continue;
    const family = deriveFamily(m.brand, m.brand_family, ladderKeysByMfr.get(m.manufacturer) ?? []);
    if (!family) continue;
    const ladder = {
      unitType: m.unit_type ?? "unit",
      currentPrice: p.proposedCostPerUnit,
      capturedAt: nowIso,
      tiers: p.tiers.map((t) => ({
        qty: t.qty,
        minUnits: parseQtyDigits(t.qty),
        price: t.pricePerUnit,
      })),
    };
    const fam = byMfr.get(m.manufacturer) ?? {};
    fam[family] = ladder;
    byMfr.set(m.manufacturer, fam);
  }

  for (const [mfr, ladders] of byMfr) {
    const { data: existing } = await sb
      .from("tenant_manufacturer_tiers")
      .select("selection, verified_ladders")
      .eq("tenant_id", tenantId)
      .eq("manufacturer", mfr)
      .maybeSingle();
    const merged = {
      ...((existing?.verified_ladders as Record<string, unknown> | null) ?? {}),
      ...ladders,
    };
    await sb.from("tenant_manufacturer_tiers").upsert(
      {
        tenant_id: tenantId,
        manufacturer: mfr,
        selection: (existing?.selection as Json) ?? ({} as unknown as Json),
        verified_ladders: merged as unknown as Json,
      },
      { onConflict: "tenant_id,manufacturer" },
    );
  }
}

export const applyPortalImportBatchFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => applyInput.parse(raw))
  .handler(async ({ data }): Promise<{ updated: number }> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId, NO_TENANT_MSG);

    const { data: batch, error: bErr } = await sb
      .from("portal_import_batches")
      .select("id, rows, status")
      .eq("id", data.batchId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (bErr) throw new Error(`Couldn't load that import: ${bErr.message}`);
    if (!batch) throw new Error("That import batch wasn't found.");

    const proposals: PortalImportProposal[] = (
      Array.isArray(batch.rows) ? batch.rows : []
    ) as unknown as PortalImportProposal[];
    const confirm = new Set(data.confirmProductIds);
    // Only apply confirmed rows that actually matched + have a proposed cost.
    const toApply = proposals.filter(
      (p) =>
        p.matchedProductId &&
        confirm.has(p.matchedProductId) &&
        p.proposedCostPerUnit != null &&
        p.proposedCostPerUnit >= 0,
    );

    let updated = 0;
    for (const p of toApply) {
      const cost = p.proposedCostPerUnit;
      if (cost == null || !p.matchedProductId) continue;
      // Portal "Your Price" is the top cost authority — overrides estimate /
      // unset / manual / a stale portal value alike.
      const { error } = await sb
        .from("products")
        .update({ cost_per_unit: cost, cost_source: "portal" })
        .eq("id", p.matchedProductId)
        .eq("tenant_id", tenantId);
      if (!error) updated += 1;
    }

    const nowIso = new Date().toISOString();

    // P2: persist any confirmed volume-tier ladders per-tenant (verified).
    const tieredApplied = toApply.filter((p) => p.tiers && p.tiers.length > 0);
    if (tieredApplied.length > 0) {
      try {
        await persistVerifiedLadders(sb, tenantId, tieredApplied, nowIso);
      } catch {
        // non-fatal — the verified cost is already written.
      }
    }

    await sb
      .from("portal_import_batches")
      .update({ status: "applied", reviewed_at: nowIso })
      .eq("id", data.batchId)
      .eq("tenant_id", tenantId);

    return { updated };
  });

// Valid product manufacturer enum (mirrors refill-catalog MANUFACTURER_VALUES);
// the batch's free-string manufacturer is only kept if it maps to a real one.
const PRODUCT_MANUFACTURERS = [
  "abbvie", "galderma", "evolus", "merz", "skinceuticals", "eltamd", "neocutis",
  "obagi", "revance", "rha", "sciton", "abbvie-coolsculpting", "generic", "in_house",
] as const;

const createFromRowInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
  batchId: z.string().uuid(),
  /** Index into the batch's staged proposals (the unmatched row being added). */
  rowIndex: z.number().int().nonnegative(),
  brand: z.string().trim().min(1).max(120),
  category: z.enum(["tox", "filler", "biostimulator", "laser_consumable", "facial", "skincare", "other"]),
  unitType: z.enum(["vial", "syringe", "bottle", "session", "other"]),
  salesPricePerUnit: z.number().nonnegative().default(0),
  /** Units per box — used to convert a box-priced row to per-unit cost. */
  unitsPerBox: z.number().int().positive().max(100).optional(),
});

/** Create a brand-new catalog product from an unmatched portal row. The cost is
 *  read from the SERVER-stored parsed price (never a client value) and stamped
 *  cost_source='portal' (Verified) — the portal number is the authority. Closes
 *  the dead-end where an unrecognized product had no path forward. */
export const createProductFromPortalRowFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => createFromRowInput.parse(raw))
  .handler(async ({ data }): Promise<{ productId: string; brand: string }> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId, NO_TENANT_MSG);

    const { data: batch, error: bErr } = await sb
      .from("portal_import_batches")
      .select("manufacturer, rows")
      .eq("id", data.batchId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (bErr) throw new Error(`Couldn't load that import: ${bErr.message}`);
    if (!batch) throw new Error("That import batch wasn't found.");

    const proposals: PortalImportProposal[] = (
      Array.isArray(batch.rows) ? batch.rows : []
    ) as unknown as PortalImportProposal[];
    const row = proposals[data.rowIndex];
    if (!row) throw new Error("That price row wasn't found in the import.");

    // Server-trusted per-unit cost from the stored portal price (GIGO-safe):
    // box price ÷ units_per_box; a per-unit / unknown price is already per unit.
    const units = data.unitsPerBox && data.unitsPerBox > 1 ? data.unitsPerBox : 1;
    const cost =
      row.parsedUnitBasis === "box" && units > 1
        ? Math.round((row.parsedPrice / units) * 100) / 100
        : row.parsedPrice;

    const manufacturer =
      batch.manufacturer && (PRODUCT_MANUFACTURERS as readonly string[]).includes(batch.manufacturer)
        ? batch.manufacturer
        : null;

    const { data: created, error } = await sb
      .from("products")
      .insert({
        tenant_id: tenantId,
        brand: data.brand,
        category: data.category,
        unit_type: data.unitType,
        cost_per_unit: cost,
        sales_price_per_unit: data.salesPricePerUnit,
        cost_source: "portal",
        manufacturer,
        units_per_box: units > 1 ? units : null,
        notes: null,
      })
      .select("id, brand")
      .single();
    if (error) throw new Error(`Couldn't add product: ${error.message}`);
    return { productId: created.id, brand: created.brand };
  });

const dismissInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
  batchId: z.string().uuid(),
});

export const dismissPortalImportBatchFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => dismissInput.parse(raw))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId, NO_TENANT_MSG);
    const { error } = await sb
      .from("portal_import_batches")
      .update({ status: "dismissed", reviewed_at: new Date().toISOString() })
      .eq("id", data.batchId)
      .eq("tenant_id", tenantId);
    if (error) throw new Error(`Couldn't dismiss that import: ${error.message}`);
    return { ok: true };
  });
