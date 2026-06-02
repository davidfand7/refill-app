/**
 * Refill Recognition — Inventory CRUD (v1.34.2).
 *
 * Server fns for the Recognition Allocation Engine's substrate: inventory
 * entries Karen can deploy as recognition currency to selected patients.
 *
 * Two inventory kinds (separate node_types to enforce the documentation
 * wall at SCHEMA level — per the 2026-06-02 scout of the manufacturer
 * rebate substrate):
 *   - 'rebate_inventory_documented' — portal-issued (Alle for Business /
 *     Allergan APP / Galderma Aspire / Evolus official promos). Provenance
 *     fields live in attachments (program, period, source_ref).
 *   - 'rebate_inventory_anonymous' — on-hand. NO provenance fields exist
 *     on this node_type at all (not nullable — absent). The wall holds:
 *     nothing in the schema can be reverse-engineered into "this was
 *     sample-bridged from rep X / deal Y."
 *
 * Lifecycle (units_total / units_deployed) lives in the dedicated
 * rebate_inventory_units table for atomic UPDATE semantics. 1:1 with the
 * knowledge_node (rebate_inventory_units.node_id unique).
 *
 * Auth pattern matches refill-catalog.ts verbatim: verifyAuth →
 * resolveEffectiveUserId (admin viewAs honored).
 *
 * v1.34.2 ships CRUD only. v1.34.2.1 will add the Manufacturer Profile
 * surface + AI extraction. v1.34.3 will add cohort scoring + allocation
 * engine. v1.34.4 closes the loop with iMessage MCP delivery.
 */

import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database, Json } from "@/integrations/supabase/types";
import { resolveEffectiveUserId } from "@/server/auth-helpers";

// ─── Public types ─────────────────────────────────────────────────────────

export type RebateInventoryKind = "documented" | "anonymous";

/**
 * Unified shape returned to the UI. Documented + anonymous flatten into
 * one type with a kind discriminator; UI branches on kind to render the
 * provenance fields (programName/programPeriod/sourceRef) only when
 * kind === "documented".
 */
export type RebateInventoryEntry = {
  /** rebate_inventory_units.id — the row the UI mutates against. */
  id: string;
  /** knowledge_nodes.id — the declarative metadata node. */
  nodeId: string;
  kind: RebateInventoryKind;
  brand: string;
  sku: string;
  unitsTotal: number;
  unitsDeployed: number;
  notes: string | null;
  createdAt: string;
  updatedAt: string;

  // Documented-only fields (null for anonymous).
  manufacturer: string | null;
  programName: string | null;
  programPeriod: string | null;
  sourceRef: string | null;
  earnedDate: string | null;
  expiresDate: string | null;

  // Anonymous-only field (null for documented).
  enteredDate: string | null;
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
type NodeRow = Database["public"]["Tables"]["knowledge_nodes"]["Row"];
type UnitsRow = Database["public"]["Tables"]["rebate_inventory_units"]["Row"];

// ─── Zod validators ───────────────────────────────────────────────────────

const accessInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
});

const createDocumentedInput = accessInput.extend({
  manufacturer: z.string().min(1).max(50),
  brand: z.string().min(1).max(100),
  sku: z.string().min(1).max(100),
  programName: z.string().min(1).max(100),
  programPeriod: z.string().min(1).max(50),
  sourceRef: z.string().max(200).optional(),
  unitsTotal: z.number().int().min(0).max(10000),
  earnedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  expiresDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  notes: z.string().max(2000).optional(),
});

const createAnonymousInput = accessInput.extend({
  brand: z.string().min(1).max(100),
  sku: z.string().min(1).max(100),
  unitsTotal: z.number().int().min(0).max(10000),
  notes: z.string().max(2000).optional(),
});

const idInput = accessInput.extend({
  id: z.string().uuid(),
});

const updateInput = idInput.extend({
  brand: z.string().min(1).max(100).optional(),
  sku: z.string().min(1).max(100).optional(),
  unitsTotal: z.number().int().min(0).max(10000).optional(),
  notes: z.string().max(2000).nullable().optional(),
});

// ─── Hydration ────────────────────────────────────────────────────────────

type DocumentedAttachments = {
  brand?: string;
  manufacturer?: string;
  programName?: string;
  programPeriod?: string;
  sourceRef?: string;
  earnedDate?: string;
  expiresDate?: string;
};

type AnonymousAttachments = {
  brand?: string;
  enteredDate?: string;
};

function hydrate(node: NodeRow, units: UnitsRow): RebateInventoryEntry {
  const kind: RebateInventoryKind =
    node.node_type === "rebate_inventory_documented" ? "documented" : "anonymous";
  const att = (node.attachments as unknown as
    | (DocumentedAttachments & AnonymousAttachments)
    | null) ?? {};

  return {
    id: units.id,
    nodeId: node.id,
    kind,
    brand: att.brand ?? node.title,
    sku: node.lookup_key ?? "",
    unitsTotal: units.units_total,
    unitsDeployed: units.units_deployed,
    notes: node.content || null,
    createdAt: node.created_at,
    updatedAt: units.updated_at,

    manufacturer: kind === "documented" ? att.manufacturer ?? null : null,
    programName: kind === "documented" ? att.programName ?? null : null,
    programPeriod: kind === "documented" ? att.programPeriod ?? null : null,
    sourceRef: kind === "documented" ? att.sourceRef ?? null : null,
    earnedDate: kind === "documented" ? att.earnedDate ?? null : null,
    expiresDate: kind === "documented" ? att.expiresDate ?? null : null,
    enteredDate: kind === "anonymous" ? att.enteredDate ?? null : null,
  };
}

// ─── listRebateInventory ──────────────────────────────────────────────────

export const listRebateInventory = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => accessInput.parse(raw))
  .handler(async ({ data }): Promise<RebateInventoryEntry[]> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();

    const { data: nodes, error: nodesErr } = await sb
      .from("knowledge_nodes")
      .select("*")
      .eq("user_id", effectiveUserId)
      .in("node_type", [
        "rebate_inventory_documented",
        "rebate_inventory_anonymous",
      ])
      .order("created_at", { ascending: false });
    if (nodesErr) throw new Error(`Couldn't load inventory: ${nodesErr.message}`);
    if (!nodes || nodes.length === 0) return [];

    const nodeIds = nodes.map((n) => n.id);
    const { data: unitsRows, error: unitsErr } = await sb
      .from("rebate_inventory_units")
      .select("*")
      .eq("user_id", effectiveUserId)
      .in("node_id", nodeIds)
      .is("soft_deleted_at", null);
    if (unitsErr) throw new Error(`Couldn't load inventory units: ${unitsErr.message}`);

    const unitsByNode = new Map<string, UnitsRow>();
    for (const u of unitsRows ?? []) unitsByNode.set(u.node_id, u);

    return nodes
      .filter((n) => unitsByNode.has(n.id))
      .map((n) => hydrate(n, unitsByNode.get(n.id)!));
  });

// ─── createDocumentedInventory ────────────────────────────────────────────

export const createDocumentedInventory = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => createDocumentedInput.parse(raw))
  .handler(async ({ data }): Promise<RebateInventoryEntry> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();

    const attachments: DocumentedAttachments = {
      brand: data.brand,
      manufacturer: data.manufacturer,
      programName: data.programName,
      programPeriod: data.programPeriod,
      sourceRef: data.sourceRef,
      earnedDate: data.earnedDate,
      expiresDate: data.expiresDate,
    };

    const { data: node, error: nodeErr } = await sb
      .from("knowledge_nodes")
      .insert({
        user_id: effectiveUserId,
        node_type: "rebate_inventory_documented",
        context: "recognition",
        title: data.brand,
        content: data.notes ?? "",
        lookup_key: data.sku,
        lookup_type: "rebate_inventory_documented",
        attachments: attachments as unknown as Json,
        source: "recognition-pool-entry",
      })
      .select("*")
      .single();
    if (nodeErr) throw new Error(`Couldn't create inventory node: ${nodeErr.message}`);

    const { data: units, error: unitsErr } = await sb
      .from("rebate_inventory_units")
      .insert({
        user_id: effectiveUserId,
        node_id: node.id,
        units_total: data.unitsTotal,
        units_deployed: 0,
      })
      .select("*")
      .single();
    if (unitsErr) {
      // No SDK-level tx — manually revert the node insert so we don't
      // leave a dangling metadata row without a lifecycle counterpart.
      await sb.from("knowledge_nodes").delete().eq("id", node.id);
      throw new Error(`Couldn't create inventory units: ${unitsErr.message}`);
    }

    return hydrate(node, units);
  });

// ─── createAnonymousInventory ─────────────────────────────────────────────

export const createAnonymousInventory = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => createAnonymousInput.parse(raw))
  .handler(async ({ data }): Promise<RebateInventoryEntry> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();

    const today = new Date().toISOString().slice(0, 10);
    const attachments: AnonymousAttachments = {
      brand: data.brand,
      enteredDate: today,
    };

    const { data: node, error: nodeErr } = await sb
      .from("knowledge_nodes")
      .insert({
        user_id: effectiveUserId,
        node_type: "rebate_inventory_anonymous",
        context: "recognition",
        title: data.brand,
        content: data.notes ?? "",
        lookup_key: data.sku,
        lookup_type: "rebate_inventory_anonymous",
        attachments: attachments as unknown as Json,
        source: "recognition-pool-entry",
      })
      .select("*")
      .single();
    if (nodeErr) throw new Error(`Couldn't create inventory node: ${nodeErr.message}`);

    const { data: units, error: unitsErr } = await sb
      .from("rebate_inventory_units")
      .insert({
        user_id: effectiveUserId,
        node_id: node.id,
        units_total: data.unitsTotal,
        units_deployed: 0,
      })
      .select("*")
      .single();
    if (unitsErr) {
      await sb.from("knowledge_nodes").delete().eq("id", node.id);
      throw new Error(`Couldn't create inventory units: ${unitsErr.message}`);
    }

    return hydrate(node, units);
  });

// ─── updateRebateInventory ────────────────────────────────────────────────

export const updateRebateInventory = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => updateInput.parse(raw))
  .handler(async ({ data }): Promise<RebateInventoryEntry> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();

    const { data: units, error: unitsErr } = await sb
      .from("rebate_inventory_units")
      .select("*")
      .eq("id", data.id)
      .eq("user_id", effectiveUserId)
      .is("soft_deleted_at", null)
      .maybeSingle();
    if (unitsErr) throw new Error(`Couldn't load inventory: ${unitsErr.message}`);
    if (!units) throw new Error("Inventory entry not found.");

    const { data: node, error: nodeErr } = await sb
      .from("knowledge_nodes")
      .select("*")
      .eq("id", units.node_id)
      .eq("user_id", effectiveUserId)
      .maybeSingle();
    if (nodeErr || !node) throw new Error(`Couldn't load inventory node.`);

    const nodeUpdates: Database["public"]["Tables"]["knowledge_nodes"]["Update"] = {
      updated_at: new Date().toISOString(),
    };
    if (data.brand !== undefined) {
      nodeUpdates.title = data.brand;
      const priorAtt = (node.attachments as unknown as Record<string, unknown>) ?? {};
      nodeUpdates.attachments = { ...priorAtt, brand: data.brand } as unknown as Json;
    }
    if (data.sku !== undefined) nodeUpdates.lookup_key = data.sku;
    if (data.notes !== undefined) nodeUpdates.content = data.notes ?? "";

    const { data: nodeAfter, error: nodeUpdErr } = await sb
      .from("knowledge_nodes")
      .update(nodeUpdates)
      .eq("id", node.id)
      .eq("user_id", effectiveUserId)
      .select("*")
      .single();
    if (nodeUpdErr) throw new Error(`Couldn't update inventory node: ${nodeUpdErr.message}`);

    let unitsAfter = units;
    if (data.unitsTotal !== undefined) {
      if (data.unitsTotal < units.units_deployed) {
        throw new Error(
          `Can't set units_total to ${data.unitsTotal} — ${units.units_deployed} are already deployed.`,
        );
      }
      const { data: u, error: e } = await sb
        .from("rebate_inventory_units")
        .update({
          units_total: data.unitsTotal,
          updated_at: new Date().toISOString(),
        })
        .eq("id", data.id)
        .eq("user_id", effectiveUserId)
        .select("*")
        .single();
      if (e) throw new Error(`Couldn't update units total: ${e.message}`);
      unitsAfter = u;
    }

    return hydrate(nodeAfter, unitsAfter);
  });

// ─── deleteRebateInventory (soft delete) ──────────────────────────────────

export const deleteRebateInventory = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => idInput.parse(raw))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();

    const { error } = await sb
      .from("rebate_inventory_units")
      .update({
        soft_deleted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", data.id)
      .eq("user_id", effectiveUserId)
      .is("soft_deleted_at", null);
    if (error) throw new Error(`Couldn't delete inventory: ${error.message}`);

    return { ok: true };
  });
