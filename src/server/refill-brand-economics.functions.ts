/**
 * Brand Economics + Manufacturer Incentive Ledger — Pillar 2.1 server layer.
 *
 *   listIncentiveLedger        — the owner's incentive entries (one config node each)
 *   upsertIncentiveLedgerEntry — create/update one entry
 *   deleteIncentiveLedgerEntry — remove one entry
 *   getBrandEconomics          — fuse the products catalog + active ledger into
 *                                per-brand margin_now + value-feel, ranked by
 *                                category (the panel + the future recommender read this)
 *
 * The ledger is owner-config, stored as `node_type='incentive_ledger_entry'`
 * knowledge_nodes (jsonb, NO migration — mirrors manufacturer_profile /
 * allocation_settings). Each entry is one node; the entry's `id` IS the node id.
 * Products live in the tenant-scoped catalog (`products`); the ledger is
 * user-scoped like the other owner-config nodes — both resolve from the same
 * effectiveUserId so admin view-as works.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { admin } from "./admin-client";
import type { Json } from "@/integrations/supabase/types";
import { getTenantIdForUser, resolveEffectiveUserId } from "@/server/auth-helpers";
import { fetchAllRows } from "@/server/paginate";
import {
  rankBrandEconomics,
  defaultBeneficiary,
  type BrandCostInput,
  type BrandEconomics,
  type IncentiveLedgerEntry,
  type IncentiveType,
  type IncentiveBeneficiary,
} from "@/lib/brand-economics";

const accessInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
});

const INCENTIVE_TYPES = ["rebate", "sample", "voucher", "patient_reward", "instant"] as const;
const BENEFICIARIES = ["spa", "patient"] as const;

const entryPayload = z.object({
  /** Present = update that node; absent = insert a new one. */
  id: z.string().uuid().optional(),
  brand: z.string().trim().min(1, "Brand is required.").max(120),
  manufacturer: z.string().trim().max(120).nullable(),
  category: z.string().trim().min(1).max(60),
  incentiveType: z.enum(INCENTIVE_TYPES),
  beneficiary: z.enum(BENEFICIARIES).nullable(),
  amountUsd: z.number().nonnegative("Amount can't be negative.").max(1_000_000),
  perUnit: z.boolean(),
  startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  notes: z.string().trim().max(500).nullable(),
});

const upsertInput = accessInput.extend({ entry: entryPayload });
const deleteInput = accessInput.extend({ id: z.string().uuid() });

const LEDGER_NO_TENANT_MSG =
  "No Refill tenant — finish onboarding before opening Brand Economics.";

// ─── Hydrate a node row → IncentiveLedgerEntry ──────────────────────────────

type LedgerNodeRow = { id: string; attachments: Json | null };

function hydrateEntry(row: LedgerNodeRow): IncentiveLedgerEntry | null {
  const a = (row.attachments ?? {}) as Partial<IncentiveLedgerEntry>;
  if (!a.brand || !a.incentiveType) return null;
  const incentiveType = a.incentiveType as IncentiveType;
  return {
    id: row.id,
    brand: a.brand,
    manufacturer: a.manufacturer ?? null,
    category: a.category ?? "other",
    incentiveType,
    beneficiary: (a.beneficiary as IncentiveBeneficiary | undefined) ?? defaultBeneficiary(incentiveType),
    amountUsd: typeof a.amountUsd === "number" ? a.amountUsd : 0,
    perUnit: a.perUnit ?? true,
    startsOn: a.startsOn ?? null,
    endsOn: a.endsOn ?? null,
    notes: a.notes ?? null,
  };
}

async function loadLedger(
  sb: ReturnType<typeof admin>,
  userId: string,
): Promise<IncentiveLedgerEntry[]> {
  const rows = await fetchAllRows<LedgerNodeRow>((from, to) =>
    sb
      .from("knowledge_nodes")
      .select("id, attachments")
      .eq("user_id", userId)
      .eq("node_type", "incentive_ledger_entry")
      .order("id", { ascending: true })
      .range(from, to),
  );
  return rows.map(hydrateEntry).filter((e): e is IncentiveLedgerEntry => e !== null);
}

// ─── List ───────────────────────────────────────────────────────────────────

export const listIncentiveLedger = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => accessInput.parse(raw))
  .handler(async ({ data }): Promise<IncentiveLedgerEntry[]> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    return loadLedger(admin(), effectiveUserId);
  });

// ─── Upsert ─────────────────────────────────────────────────────────────────

export const upsertIncentiveLedgerEntry = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => upsertInput.parse(raw))
  .handler(async ({ data }): Promise<IncentiveLedgerEntry> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const p = data.entry;
    const beneficiary = p.beneficiary ?? defaultBeneficiary(p.incentiveType);
    // Stored shape mirrors IncentiveLedgerEntry minus the id (id = node id).
    const attachments = {
      brand: p.brand,
      manufacturer: p.manufacturer,
      category: p.category,
      incentiveType: p.incentiveType,
      beneficiary,
      amountUsd: p.amountUsd,
      perUnit: p.perUnit,
      startsOn: p.startsOn,
      endsOn: p.endsOn,
      notes: p.notes,
    };
    const title = `${p.brand} — ${p.incentiveType}`;
    const nowIso = new Date().toISOString();

    if (p.id) {
      // Update only within this tenant's own nodes (user_id guard).
      const { data: updated, error } = await sb
        .from("knowledge_nodes")
        .update({ title, attachments: attachments as unknown as Json, updated_at: nowIso })
        .eq("id", p.id)
        .eq("user_id", effectiveUserId)
        .eq("node_type", "incentive_ledger_entry")
        .select("id")
        .maybeSingle();
      if (error) throw new Error(`Couldn't update incentive: ${error.message}`);
      if (!updated) throw new Error("Incentive not found.");
      return { ...attachments, id: updated.id } as IncentiveLedgerEntry;
    }

    const { data: inserted, error } = await sb
      .from("knowledge_nodes")
      .insert({
        user_id: effectiveUserId,
        node_type: "incentive_ledger_entry",
        context: "recognition",
        title,
        content: p.notes ?? "",
        attachments: attachments as unknown as Json,
      })
      .select("id")
      .single();
    if (error) throw new Error(`Couldn't add incentive: ${error.message}`);
    return { ...attachments, id: inserted.id } as IncentiveLedgerEntry;
  });

// ─── Delete ─────────────────────────────────────────────────────────────────

export const deleteIncentiveLedgerEntry = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => deleteInput.parse(raw))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const { error } = await admin()
      .from("knowledge_nodes")
      .delete()
      .eq("id", data.id)
      .eq("user_id", effectiveUserId)
      .eq("node_type", "incentive_ledger_entry");
    if (error) throw new Error(`Couldn't delete incentive: ${error.message}`);
    return { ok: true };
  });

// ─── Brand economics (catalog × ledger) ─────────────────────────────────────

export type BrandEconomicsBundle = {
  /** Per-brand economics, ranked by margin_now within each category. */
  economics: BrandEconomics[];
  /** The active incentive entries (full ledger; UI shows active vs scheduled). */
  ledger: IncentiveLedgerEntry[];
  /** UTC date the economics were computed against (active-window anchor). */
  todayIso: string;
};

type CatalogProductRow = {
  brand: string;
  category: string;
  manufacturer: string | null;
  cost_per_unit: string | number;
  sales_price_per_unit: string | number;
};

export const getBrandEconomics = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => accessInput.parse(raw))
  .handler(async ({ data }): Promise<BrandEconomicsBundle> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId, LEDGER_NO_TENANT_MSG);

    // Active (non-hidden) products only — hidden brands aren't in play.
    const productRows = await fetchAllRows<CatalogProductRow>((from, to) =>
      sb
        .from("products")
        .select("brand, category, manufacturer, cost_per_unit, sales_price_per_unit")
        .eq("tenant_id", tenantId)
        .is("hidden_at", null)
        .order("category", { ascending: true })
        .order("brand", { ascending: true })
        .range(from, to),
    );
    const products: BrandCostInput[] = productRows.map((r) => ({
      brand: r.brand,
      manufacturer: r.manufacturer ?? null,
      category: r.category,
      costPerUnit: typeof r.cost_per_unit === "string" ? Number(r.cost_per_unit) : r.cost_per_unit,
      salesPricePerUnit:
        typeof r.sales_price_per_unit === "string"
          ? Number(r.sales_price_per_unit)
          : r.sales_price_per_unit,
    }));

    const ledger = await loadLedger(sb, effectiveUserId);
    const todayIso = new Date().toISOString().slice(0, 10);
    return {
      economics: rankBrandEconomics(products, ledger, todayIso),
      ledger,
      todayIso,
    };
  });
