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
