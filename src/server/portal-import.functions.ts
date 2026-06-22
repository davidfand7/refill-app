/**
 * Vision portal-import engine (v2.138.0, Ship 1 of the vision-ingestion moat).
 *
 * Reads a manufacturer portal "Your Price" screenshot with Claude vision,
 * matches the prices to the tenant's catalog, and stages proposals for owner
 * review. On confirm, matched rows get cost_per_unit + cost_source='portal'
 * (the Verified badge) — Estimate → Verified. The auth-walled, per-spa-unique
 * portal numbers no CSV/API/scraper can reach. See project_vision_ingestion_moat.
 *
 * ONE pipeline, two ingest mouths:
 *   - in-app upload  → createPortalImportFromUploadFn (this file, Ship 1/2)
 *   - email-forward  → the inbound lane calls extractPortalPrices + matchToCatalog
 *                      + insertBatch directly (Ship 3)
 *
 * NEVER blind-writes. The owner-review step (applyPortalImportBatchFn with an
 * explicit confirmed list) is the accuracy + GIGO backstop — esp. the per-BOX
 * ÷ units_per_box conversion (Allergan box = 2 syringes; see
 * reference_catalog_packaging_units, the #1 cost-import trap).
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { admin } from "./admin-client";
import { getTenantIdForUser, resolveEffectiveUserId } from "@/server/auth-helpers";
import { fetchAllRows } from "@/server/paginate";
import type { Json } from "@/integrations/supabase/types";

const NO_TENANT_MSG =
  "No Refill tenant — finish onboarding before importing portal prices.";

// Twin of refill-manufacturer-profile.functions.ts getAnthropicClient — kept
// local to avoid widening that module's export surface.
function getAnthropicClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("Portal import not configured — ANTHROPIC_API_KEY missing.");
  }
  return new Anthropic({ apiKey });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─── Vision extraction ──────────────────────────────────────────────────────

const IMAGE_MEDIA = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
type ImageMedia = (typeof IMAGE_MEDIA)[number];

/** One product line read off the portal screenshot. */
export type ParsedPortalRow = {
  name: string;
  price: number;
  /** What the portal's price is denominated in, as labeled on screen. */
  unitBasis: "box" | "unit" | "unknown";
  sku: string | null;
};

const parsedRowSchema = z.object({
  name: z.string().min(1),
  price: z.number().nonnegative(),
  unitBasis: z.enum(["box", "unit", "unknown"]).default("unknown"),
  sku: z.string().nullable().default(null),
});

const EXTRACTION_SYSTEM = `You read aesthetic-manufacturer ordering-portal screenshots (Allergan/AbbVie APP, Galderma ASPIRE, Evolus, Merz, etc.) and extract the spa's NEGOTIATED prices.

Return ONLY a JSON object: { "manufacturer": string|null, "rows": Row[] }.
Row = { "name": string, "price": number, "unitBasis": "box"|"unit"|"unknown", "sku": string|null }.

Rules:
- name: the product as printed (e.g. "Juvederm Voluma XC", "Botox Cosmetic 100 Units", "Jeuveau 100U"). Keep the strength/size if shown.
- price: the spa's price — prefer the "Your Price" / negotiated / net column over MSRP/list if both appear. Plain number, no "$" or commas.
- unitBasis: "box" if the price is per box/case/multipack; "unit" if per syringe/vial/single; "unknown" if not stated. Do NOT guess a conversion — just report what's labeled.
- sku: the item/SKU/catalog number if visible, else null.
- manufacturer: lowercase key if identifiable (abbvie, galderma, evolus, merz, revance), else null.
- Skip headers, totals, shipping, taxes, and any row without a real product price.
- Output ONLY the JSON object — no markdown, no commentary.`;

/** Run Claude vision over one or more portal screenshots → parsed rows. */
export async function extractPortalPrices(
  images: Array<{ data: string; mediaType: ImageMedia }>,
  manufacturerHint?: string | null,
): Promise<{ manufacturer: string | null; rows: ParsedPortalRow[]; raw: string }> {
  const client = getAnthropicClient();
  const hint = manufacturerHint
    ? `\n\nHint: the owner says this is from manufacturer '${manufacturerHint}'. Use that for the manufacturer field unless the screenshot clearly says otherwise.`
    : "";

  const imageBlocks = images.map((img) => ({
    type: "image" as const,
    source: { type: "base64" as const, media_type: img.mediaType, data: img.data },
  }));

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: EXTRACTION_SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            ...imageBlocks,
            {
              type: "text",
              text: `Extract the spa's product prices from this manufacturer portal screenshot.${hint}`,
            },
          ],
        },
      ],
    });

    const text = response.content
      .find((b): b is Anthropic.TextBlock => b.type === "text")
      ?.text?.trim();
    if (!text) throw new Error("Vision returned an empty response — try a clearer screenshot.");

    const stripped = text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    let parsed: { manufacturer?: string | null; rows?: unknown };
    try {
      parsed = JSON.parse(stripped) as { manufacturer?: string | null; rows?: unknown };
    } catch {
      throw new Error("Couldn't read the prices from that image — try a sharper, fuller screenshot.");
    }
    const rows = z.array(parsedRowSchema).safeParse(parsed.rows ?? []);
    if (!rows.success || rows.data.length === 0) {
      throw new Error("No product prices found in that screenshot.");
    }
    return {
      manufacturer: parsed.manufacturer ? String(parsed.manufacturer).toLowerCase().trim() : null,
      rows: rows.data,
      raw: stripped,
    };
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) {
      throw new Error("Vision is rate-limited right now — try again in 30s.");
    }
    if (e instanceof Anthropic.AuthenticationError) {
      throw new Error("Portal import isn't configured (auth) — ping support.");
    }
    throw e instanceof Error ? e : new Error("Vision extraction failed.");
  }
}

// ─── Catalog matching ───────────────────────────────────────────────────────

type ProductRow = {
  id: string;
  brand: string;
  sku: string | null;
  brand_family: string | null;
  manufacturer: string | null;
  units_per_box: number | null;
  cost_per_unit: number | string | null;
  cost_source: string | null;
};

/** A staged proposal: one parsed row resolved against the tenant's catalog. */
export type PortalImportProposal = {
  parsedName: string;
  parsedPrice: number;
  parsedUnitBasis: "box" | "unit" | "unknown";
  parsedSku: string | null;
  matchedProductId: string | null;
  matchedBrand: string | null;
  matchConfidence: "high" | "medium" | "low" | "none";
  currentCostPerUnit: number | null;
  currentCostSource: string | null;
  unitsPerBox: number | null;
  /** Per-unit cost we'd write (box price ÷ units_per_box when basis=box). */
  proposedCostPerUnit: number | null;
};

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenOverlap(a: string, b: string): number {
  const sa = new Set(normalize(a).split(" ").filter((t) => t.length > 1));
  const sb = new Set(normalize(b).split(" ").filter((t) => t.length > 1));
  if (sa.size === 0 || sb.size === 0) return 0;
  let hit = 0;
  for (const t of sa) if (sb.has(t)) hit += 1;
  return hit / Math.max(sa.size, sb.size);
}

/** Resolve parsed rows against the tenant's products. Computes the per-unit
 *  proposed cost with the packaging conversion (box ÷ units_per_box). */
export function matchToCatalog(
  products: ProductRow[],
  rows: ParsedPortalRow[],
): PortalImportProposal[] {
  const bySku = new Map<string, ProductRow>();
  for (const p of products) if (p.sku) bySku.set(p.sku.trim().toLowerCase(), p);

  return rows.map((r) => {
    let match: ProductRow | undefined;
    let confidence: PortalImportProposal["matchConfidence"] = "none";

    // 1) SKU exact (highest trust).
    if (r.sku) match = bySku.get(r.sku.trim().toLowerCase());
    if (match) confidence = "high";

    // 2) Normalized-name exact, then best token overlap.
    if (!match) {
      const exact = products.find((p) => normalize(p.brand) === normalize(r.name));
      if (exact) {
        match = exact;
        confidence = "high";
      } else {
        let best: ProductRow | undefined;
        let bestScore = 0;
        for (const p of products) {
          const score = tokenOverlap(p.brand, r.name);
          if (score > bestScore) {
            bestScore = score;
            best = p;
          }
        }
        if (best && bestScore >= 0.34) {
          match = best;
          confidence = bestScore >= 0.6 ? "medium" : "low";
        }
      }
    }

    const units = match?.units_per_box && match.units_per_box > 0 ? match.units_per_box : 1;
    // Conversion: a box price divides by units_per_box; a per-unit (or
    // unknown, on a 1-per-box product) price is already per unit.
    let proposed: number | null = null;
    if (match) {
      if (r.unitBasis === "box" && units > 1) proposed = round2(r.price / units);
      else proposed = round2(r.price);
    }
    const curCost =
      match?.cost_per_unit == null
        ? null
        : typeof match.cost_per_unit === "string"
          ? Number(match.cost_per_unit)
          : match.cost_per_unit;

    return {
      parsedName: r.name,
      parsedPrice: r.price,
      parsedUnitBasis: r.unitBasis,
      parsedSku: r.sku,
      matchedProductId: match?.id ?? null,
      matchedBrand: match?.brand ?? null,
      matchConfidence: match ? confidence : "none",
      currentCostPerUnit: curCost,
      currentCostSource: match?.cost_source ?? null,
      unitsPerBox: match?.units_per_box ?? null,
      proposedCostPerUnit: proposed,
    };
  });
}

async function loadTenantProducts(
  sb: ReturnType<typeof admin>,
  tenantId: string,
  manufacturer?: string | null,
): Promise<ProductRow[]> {
  const cols =
    "id, brand, sku, brand_family, manufacturer, units_per_box, cost_per_unit, cost_source";
  return fetchAllRows<ProductRow>((from, to) =>
    (manufacturer
      ? sb.from("products").select(cols).eq("tenant_id", tenantId).eq("manufacturer", manufacturer)
      : sb.from("products").select(cols).eq("tenant_id", tenantId)
    ).range(from, to),
  );
}

/** Shared core: extract → match → insert a pending_review batch. Both ingest
 *  mouths (upload, email) call this. Returns the new batch id + proposals. */
export async function ingestPortalImport(args: {
  sb: ReturnType<typeof admin>;
  tenantId: string;
  source: "upload" | "email";
  images: Array<{ data: string; mediaType: ImageMedia }>;
  manufacturerHint?: string | null;
}): Promise<{ batchId: string; manufacturer: string | null; proposals: PortalImportProposal[] }> {
  const { sb, tenantId, source, images, manufacturerHint } = args;
  const extracted = await extractPortalPrices(images, manufacturerHint);
  const manufacturer = manufacturerHint || extracted.manufacturer;
  // Match within the manufacturer when known (tighter), else whole catalog.
  const products = await loadTenantProducts(sb, tenantId, manufacturer ?? undefined);
  const proposals = matchToCatalog(products, extracted.rows);

  const { data: batch, error } = await sb
    .from("portal_import_batches")
    .insert({
      tenant_id: tenantId,
      source,
      manufacturer: manufacturer ?? null,
      status: "pending_review",
      rows: proposals as unknown as Json,
      raw_extract: extracted.raw,
    })
    .select("id")
    .single();
  if (error) throw new Error(`Couldn't stage the import: ${error.message}`);
  return { batchId: batch.id, manufacturer: manufacturer ?? null, proposals };
}

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

    await sb
      .from("portal_import_batches")
      .update({ status: "applied", reviewed_at: new Date().toISOString() })
      .eq("id", data.batchId)
      .eq("tenant_id", tenantId);

    return { updated };
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
