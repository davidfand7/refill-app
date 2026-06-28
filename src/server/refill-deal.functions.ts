/**
 * refill-deal.functions.ts — the Deal Desk's capture model (v2.201.0, Phase 2).
 *
 * A "deal" is the rep↔spa negotiation captured as one record: the triangle
 * Purchase ⇄ Samples ⇄ Promo (project_buying_rewards_taxonomy). The owner enters
 * from whichever corner they're standing in; any corner is optional. Stored as a
 * knowledge_node (node_type='deal', context='recognition') — no migration, same
 * lightweight pattern as allocation_settings/allocation_suggestion.
 *
 * Capture, not ledger: this records the deal so SmartSpa can reason about it
 * (and so the Promo corner can deploy sample-funded outreach). It does NOT make
 * the owner account for every unit.
 */

import { createServerFn } from "@tanstack/react-start";
import { admin } from "./admin-client";
import { z } from "zod";

import type { Json } from "@/integrations/supabase/types";
import { resolveEffectiveUserId } from "@/server/auth-helpers";
import { fetchAllRows } from "@/server/paginate";

export type DealCorner = "purchase" | "samples" | "promo";
export type DealStatus = "draft" | "active" | "closed";

export type Deal = {
  id: string;
  status: DealStatus;
  manufacturer: string | null;
  repName: string | null;
  /** Which door the deal was opened from. */
  enteredFrom: DealCorner;
  purchase: { note: string; products: string[] } | null;
  /** inventoryIds = rebate_inventory_units node ids created for this deal's samples. */
  samples: { inventoryIds: string[]; note: string } | null;
  promo: {
    description: string;
    offerId?: string | null;
    deployedSuggestionIds?: string[];
  } | null;
  notes: string;
  createdAt: string;
  updatedAt: string;
};

type DealAttachments = Omit<Deal, "id" | "createdAt">;

const accessInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
});

const cornerEnum = z.enum(["purchase", "samples", "promo"]);
const statusEnum = z.enum(["draft", "active", "closed"]);

const purchaseSchema = z
  .object({
    note: z.string().max(2000).default(""),
    products: z.array(z.string().max(120)).max(50).default([]),
  })
  .nullable();
const samplesSchema = z
  .object({
    inventoryIds: z.array(z.string().uuid()).max(100).default([]),
    note: z.string().max(2000).default(""),
  })
  .nullable();
const promoSchema = z
  .object({
    description: z.string().max(2000).default(""),
    offerId: z.string().uuid().nullable().optional(),
    deployedSuggestionIds: z.array(z.string().uuid()).max(500).optional(),
  })
  .nullable();

function hydrate(row: {
  id: string;
  attachments: unknown;
  created_at: string;
  updated_at: string;
}): Deal {
  const a = (row.attachments ?? {}) as Partial<DealAttachments>;
  return {
    id: row.id,
    status: a.status ?? "draft",
    manufacturer: a.manufacturer ?? null,
    repName: a.repName ?? null,
    enteredFrom: a.enteredFrom ?? "purchase",
    purchase: a.purchase ?? null,
    samples: a.samples ?? null,
    promo: a.promo ?? null,
    notes: a.notes ?? "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function dealTitle(d: Pick<Deal, "manufacturer" | "enteredFrom">): string {
  return `Deal — ${d.manufacturer ?? "rep"} (${d.enteredFrom})`;
}

// ─── listDeals ──────────────────────────────────────────────────────────────

export const listDeals = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => accessInput.parse(raw))
  .handler(async ({ data }): Promise<Deal[]> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const rows = await fetchAllRows<{
      id: string;
      attachments: unknown;
      created_at: string;
      updated_at: string;
    }>((from, to) =>
      sb
        .from("knowledge_nodes")
        .select("id, attachments, created_at, updated_at")
        .eq("user_id", effectiveUserId)
        .eq("node_type", "deal")
        .order("created_at", { ascending: false })
        .range(from, to),
    );
    return rows.map(hydrate);
  });

// ─── createDeal ─────────────────────────────────────────────────────────────

const createInput = accessInput.extend({
  enteredFrom: cornerEnum,
  manufacturer: z.string().max(60).nullable().optional(),
  repName: z.string().max(120).nullable().optional(),
  purchase: purchaseSchema.optional(),
  samples: samplesSchema.optional(),
  promo: promoSchema.optional(),
  notes: z.string().max(2000).optional(),
});

export const createDeal = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => createInput.parse(raw))
  .handler(async ({ data }): Promise<Deal> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const nowIso = new Date().toISOString();
    const attachments: DealAttachments = {
      status: "draft",
      manufacturer: data.manufacturer ?? null,
      repName: data.repName ?? null,
      enteredFrom: data.enteredFrom,
      purchase: data.purchase ?? null,
      samples: data.samples ?? null,
      promo: data.promo ?? null,
      notes: data.notes ?? "",
      updatedAt: nowIso,
    };
    const { data: inserted, error } = await sb
      .from("knowledge_nodes")
      .insert({
        user_id: effectiveUserId,
        node_type: "deal",
        title: dealTitle({
          manufacturer: attachments.manufacturer,
          enteredFrom: attachments.enteredFrom,
        }),
        context: "recognition",
        content: "",
        attachments: attachments as unknown as Json,
      })
      .select("id, attachments, created_at, updated_at")
      .single();
    if (error) throw new Error(`Couldn't create deal: ${error.message}`);
    return hydrate(inserted);
  });

// ─── updateDeal ─────────────────────────────────────────────────────────────

const updateInput = accessInput.extend({
  id: z.string().uuid(),
  status: statusEnum.optional(),
  manufacturer: z.string().max(60).nullable().optional(),
  repName: z.string().max(120).nullable().optional(),
  purchase: purchaseSchema.optional(),
  samples: samplesSchema.optional(),
  promo: promoSchema.optional(),
  notes: z.string().max(2000).optional(),
});

export const updateDeal = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => updateInput.parse(raw))
  .handler(async ({ data }): Promise<Deal> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const { data: existing, error: readErr } = await sb
      .from("knowledge_nodes")
      .select("id, attachments, created_at, updated_at")
      .eq("id", data.id)
      .eq("user_id", effectiveUserId)
      .eq("node_type", "deal")
      .maybeSingle();
    if (readErr) throw new Error(`Couldn't read deal: ${readErr.message}`);
    if (!existing) throw new Error("Deal not found.");

    const prior = hydrate(existing);
    const nowIso = new Date().toISOString();
    // Only overwrite fields the caller provided (undefined = leave as-is; null is
    // a real value for clearing a corner).
    const next: DealAttachments = {
      status: data.status ?? prior.status,
      manufacturer:
        data.manufacturer !== undefined ? data.manufacturer : prior.manufacturer,
      repName: data.repName !== undefined ? data.repName : prior.repName,
      enteredFrom: prior.enteredFrom,
      purchase: data.purchase !== undefined ? data.purchase : prior.purchase,
      samples: data.samples !== undefined ? data.samples : prior.samples,
      promo: data.promo !== undefined ? data.promo : prior.promo,
      notes: data.notes !== undefined ? data.notes : prior.notes,
      updatedAt: nowIso,
    };
    const { data: updated, error } = await sb
      .from("knowledge_nodes")
      .update({
        title: dealTitle({
          manufacturer: next.manufacturer,
          enteredFrom: next.enteredFrom,
        }),
        attachments: next as unknown as Json,
        updated_at: nowIso,
      })
      .eq("id", data.id)
      .eq("user_id", effectiveUserId)
      .select("id, attachments, created_at, updated_at")
      .single();
    if (error) throw new Error(`Couldn't update deal: ${error.message}`);
    return hydrate(updated);
  });
