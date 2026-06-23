/**
 * Portal-import core — SERVER-ONLY (v2.139.0, Ship 2 refactor).
 *
 * The vision + matching + staging engine for portal-import, split out of
 * portal-import.functions.ts so the @anthropic-ai/sdk import (which pulls in
 * node:crypto/fs) never reaches the browser bundle. The createServerFn wrappers
 * in portal-import.functions.ts reach this via a *dynamic* import inside their
 * handler bodies (handlers are stripped client-side); the Ship 3 email lane
 * imports it directly server-side. Nothing here is client-safe.
 *
 * See project_vision_portal_import / project_vision_ingestion_moat.
 */

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { admin } from "./admin-client";
import { fetchAllRows } from "@/server/paginate";
import type { Json } from "@/integrations/supabase/types";

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

export const IMAGE_MEDIA = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type ImageMedia = (typeof IMAGE_MEDIA)[number];

/** One product line read off the portal screenshot. */
export type ParsedPortalRow = {
  name: string;
  price: number;
  /** What the portal's price is denominated in, as labeled on screen. */
  unitBasis: "box" | "unit" | "unknown";
  sku: string | null;
  /** Volume-tier ladder rungs when the page is a single-product quantity ladder. */
  tiers?: Array<{ qty: string; pricePerUnit: number }> | null;
};

const tierSchema = z.object({
  qty: z.string(),
  pricePerUnit: z.number().nonnegative(),
});

const parsedRowSchema = z.object({
  name: z.string().min(1),
  price: z.number().nonnegative(),
  unitBasis: z.enum(["box", "unit", "unknown"]).default("unknown"),
  sku: z.string().nullable().default(null),
  tiers: z.array(tierSchema).nullable().default(null),
});

const EXTRACTION_SYSTEM = `You read aesthetic-manufacturer ordering-portal screenshots (Allergan/AbbVie APP, Galderma ASPIRE, Evolus, Merz, etc.) and extract the spa's NEGOTIATED prices.

Return ONLY a JSON object: { "manufacturer": string|null, "rows": Row[] }.
Row = { "name": string, "price": number, "unitBasis": "box"|"unit"|"unknown", "sku": string|null, "tiers": [{ "qty": string, "pricePerUnit": number }]|null }.

Rules:
- name: the product as printed (e.g. "Juvederm Voluma XC", "Botox Cosmetic 100 Units", "Jeuveau 100U"). Keep the strength/size if shown.
- price: the spa's price — prefer the "Your Price" / negotiated / net column over MSRP/list if both appear. Plain number, no "$" or commas.
- unitBasis: "box" if the price is per box/case/multipack; "unit" if per syringe/vial/single; "unknown" if not stated. Do NOT guess a conversion — just report what's labeled.
- sku: the item/SKU/catalog number if visible, else null.
- manufacturer: lowercase key if identifiable (abbvie, galderma, evolus, merz, revance), else null.
- tiers: null for a normal price list. ONLY populated for a volume ladder (next rule).
- Skip headers, totals, shipping, taxes, and any row without a real product price.

VOLUME / QUANTITY LADDERS: Some pages show ONE product with several quantity options (e.g. 250 / 150 / 100 / 50 / 20 / 1 vials), each with its own per-UNIT price, often with a highlighted "Your Price". For such a page:
- Emit a SINGLE row for that product (NOT one row per quantity).
- "price" = the spa's CURRENT effective per-unit price: prefer an explicit "Your Price" / "Your Cost" figure; else the rung the spa is currently on (typically the lowest-quantity / entry rung).
- "unitBasis" = "unit".
- "tiers" = every quantity rung shown, as [{ "qty": "250 vials", "pricePerUnit": 379 }, ...] (ascending or as printed).
- Do this ONLY for a single-product quantity ladder; a normal multi-PRODUCT price list stays one row per product with "tiers": null.

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

// ─── Text extraction (bookmarklet lane: page innerText, no screenshot) ───────

const TEXT_EXTRACTION_SYSTEM = `You read the pasted TEXT of an aesthetic-manufacturer ordering-portal page (Allergan/AbbVie APP, Galderma ASPIRE, Evolus, Merz, etc.) and extract the spa's NEGOTIATED prices. The text is a raw dump of a web page, so it may contain nav/menu/footer noise — ignore it.

Return ONLY a JSON object: { "manufacturer": string|null, "rows": Row[] }.
Row = { "name": string, "price": number, "unitBasis": "box"|"unit"|"unknown", "sku": string|null, "tiers": [{ "qty": string, "pricePerUnit": number }]|null }.

Rules:
- name: the product as printed (e.g. "Juvederm Voluma XC", "Botox Cosmetic 100 Units", "Jeuveau 100U").
- price: the spa's price — prefer "Your Price" / negotiated / net over MSRP/list. Plain number, no "$" or commas.
- unitBasis: "box" if per box/case/multipack; "unit" if per syringe/vial/single; "unknown" if not stated. Do NOT guess a conversion.
- sku: item/SKU/catalog number if present, else null.
- manufacturer: lowercase key if identifiable (abbvie, galderma, evolus, merz, revance), else null.
- tiers: null for a normal price list. For a single-product VOLUME/QUANTITY ladder (one product, several quantity options each with a per-unit price), emit ONE row: "price" = the current/effective per-unit price (prefer an explicit "Your Price"); "unitBasis" = "unit"; "tiers" = every rung as [{ "qty": "250 vials", "pricePerUnit": 379 }, ...].
- Skip headers, totals, shipping, taxes, nav, and any row without a real product price.
- Output ONLY the JSON object — no markdown, no commentary.`;

/** Extract prices from the pasted TEXT of a portal page (bookmarklet lane). */
export async function extractPortalPricesFromText(
  text: string,
  manufacturerHint?: string | null,
): Promise<{ manufacturer: string | null; rows: ParsedPortalRow[]; raw: string }> {
  const client = getAnthropicClient();
  const hint = manufacturerHint
    ? `\n\nHint: the owner says this is from manufacturer '${manufacturerHint}'. Use that unless the text clearly says otherwise.`
    : "";
  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: TEXT_EXTRACTION_SYSTEM,
      messages: [
        {
          role: "user",
          content: `Extract the spa's product prices from this portal page text.${hint}\n\n--- PAGE TEXT ---\n${text.slice(0, 60000)}`,
        },
      ],
    });
    const out = response.content
      .find((b): b is Anthropic.TextBlock => b.type === "text")
      ?.text?.trim();
    if (!out) throw new Error("Couldn't read any prices from that page — try the page that shows your pricing.");
    const stripped = out.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    let parsed: { manufacturer?: string | null; rows?: unknown };
    try {
      parsed = JSON.parse(stripped) as { manufacturer?: string | null; rows?: unknown };
    } catch {
      throw new Error("Couldn't read the prices from that page — open the page that lists your prices and try again.");
    }
    const rows = z.array(parsedRowSchema).safeParse(parsed.rows ?? []);
    if (!rows.success || rows.data.length === 0) {
      throw new Error("No product prices found on that page.");
    }
    return {
      manufacturer: parsed.manufacturer ? String(parsed.manufacturer).toLowerCase().trim() : null,
      rows: rows.data,
      raw: stripped,
    };
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) {
      throw new Error("Extraction is rate-limited right now — try again in 30s.");
    }
    throw e instanceof Error ? e : new Error("Text extraction failed.");
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
  /** Volume-tier ladder rungs (single-product quantity ladder), else null. */
  tiers: Array<{ qty: string; pricePerUnit: number }> | null;
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
      tiers: r.tiers ?? null,
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
  /** Resend message id (email lane) → idempotency: one batch per message, so a
   *  double-delivery to >1 inbound webhook doesn't double-stage. */
  sourceMessageId?: string | null;
}): Promise<{
  batchId: string;
  manufacturer: string | null;
  proposals: PortalImportProposal[];
  deduped?: boolean;
}> {
  const { sb, tenantId, source, images, manufacturerHint, sourceMessageId } = args;

  // Return an already-staged batch for this message (skips a second vision
  // call when the re-delivery is not simultaneous).
  if (sourceMessageId) {
    const existing = await findBatchByMessageId(sb, tenantId, sourceMessageId);
    if (existing) return { ...existing, deduped: true };
  }

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
      source_message_id: sourceMessageId ?? null,
    })
    .select("id")
    .single();
  if (error) {
    // 23505 = unique violation: a concurrent delivery won the race. Return its
    // batch instead of erroring (the dedup index did its job).
    if ((error as { code?: string }).code === "23505" && sourceMessageId) {
      const existing = await findBatchByMessageId(sb, tenantId, sourceMessageId);
      if (existing) return { ...existing, deduped: true };
    }
    throw new Error(`Couldn't stage the import: ${error.message}`);
  }
  return { batchId: batch.id, manufacturer: manufacturer ?? null, proposals };
}

/** Look up an already-staged batch by Resend message id. */
async function findBatchByMessageId(
  sb: ReturnType<typeof admin>,
  tenantId: string,
  sourceMessageId: string,
): Promise<{ batchId: string; manufacturer: string | null; proposals: PortalImportProposal[] } | null> {
  const { data } = await sb
    .from("portal_import_batches")
    .select("id, manufacturer, rows")
    .eq("tenant_id", tenantId)
    .eq("source_message_id", sourceMessageId)
    .maybeSingle();
  if (!data) return null;
  return {
    batchId: data.id,
    manufacturer: data.manufacturer ?? null,
    proposals: (Array.isArray(data.rows) ? data.rows : []) as unknown as PortalImportProposal[],
  };
}

/** Text-lane ingest (bookmarklet): extract from page text → match → stage.
 *  Mirrors ingestPortalImport but text-sourced; kept separate so the verified
 *  image path is untouched. */
export async function ingestPortalImportText(args: {
  sb: ReturnType<typeof admin>;
  tenantId: string;
  source: "upload" | "email";
  text: string;
  manufacturerHint?: string | null;
  sourceMessageId?: string | null;
}): Promise<{
  batchId: string;
  manufacturer: string | null;
  proposals: PortalImportProposal[];
  deduped?: boolean;
}> {
  const { sb, tenantId, source, text, manufacturerHint, sourceMessageId } = args;

  if (sourceMessageId) {
    const existing = await findBatchByMessageId(sb, tenantId, sourceMessageId);
    if (existing) return { ...existing, deduped: true };
  }

  const extracted = await extractPortalPricesFromText(text, manufacturerHint);
  const manufacturer = manufacturerHint || extracted.manufacturer;
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
      source_message_id: sourceMessageId ?? null,
    })
    .select("id")
    .single();
  if (error) {
    if ((error as { code?: string }).code === "23505" && sourceMessageId) {
      const existing = await findBatchByMessageId(sb, tenantId, sourceMessageId);
      if (existing) return { ...existing, deduped: true };
    }
    throw new Error(`Couldn't stage the import: ${error.message}`);
  }
  return { batchId: batch.id, manufacturer: manufacturer ?? null, proposals };
}
