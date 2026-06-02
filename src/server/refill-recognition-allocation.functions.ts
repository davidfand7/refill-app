/**
 * Refill Recognition Allocation Engine — the 4th agent (v1.34.5).
 *
 * Per project_recognition_allocation_engine_spec:
 *   - Three-cohort default split: Loyal Vintage 40% / Top-Decile Current 40% /
 *     At-Risk Overlay 20%. Karen-adjustable per period.
 *   - Reads rebate_inventory_units (substrate) + manufacturer profiles
 *     (substrate) + patient summaries (from existing PatientSummary).
 *   - Outputs: allocation suggestions Karen confirms one-by-one.
 *
 * v1.34.5 ships the engine + settings + suggestions UI. Delivery integration
 * (iMessage MCP → Karen-Mac → patient) is v1.34.x next.
 *
 * Storage:
 *   - Allocation settings: knowledge_nodes row with node_type='allocation_settings'
 *   - Allocation suggestions: knowledge_nodes rows with node_type='allocation_suggestion';
 *     status field on attachments tracks pending / confirmed / dismissed
 *
 * Scoring heuristics for v1.34.5 MVP (the more sophisticated profitability-engine
 * scoring lands in a follow-on):
 *   - Loyal Vintage: first_visit > 12mo ago && last_visit < 180d ago && totalVisits ≥ 4
 *   - Top-Decile Current: top 10% by last-12-mo spend (cohort min = $1)
 *   - At-Risk: last-3mo spend < prior-3mo spend && last_visit between 60-180d ago
 */

import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database, Json } from "@/integrations/supabase/types";
import type { PatientSummary } from "@/lib/patient-csv";
import { resolveEffectiveUserId } from "@/server/auth-helpers";

// ─── Public types ─────────────────────────────────────────────────────────

export type Cohort = "loyal_vintage" | "top_decile_current" | "at_risk";

export type AllocationSettings = {
  /** Sum of three should = 100. */
  splitLoyalVintagePct: number;
  splitTopDecileCurrentPct: number;
  splitAtRiskPct: number;
  /** Cooldown — don't re-allocate to the same patient within N months. */
  cooldownMonths: number;
  /** Karen must explicitly confirm before a suggestion is delivered. */
  requireManualConfirm: boolean;
  updatedAt: string | null;
};

export type AllocationSuggestion = {
  id: string;
  patientNodeId: string;
  patientDisplayName: string;
  cohort: Cohort;
  brand: string;
  manufacturer: string | null;
  units: number;
  rebateInventoryId: string;
  score: number;
  rationale: string;
  status: "pending" | "confirmed" | "dismissed";
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

// ─── Defaults ─────────────────────────────────────────────────────────────

const DEFAULTS: AllocationSettings = {
  splitLoyalVintagePct: 40,
  splitTopDecileCurrentPct: 40,
  splitAtRiskPct: 20,
  cooldownMonths: 12,
  requireManualConfirm: true,
  updatedAt: null,
};

// ─── Zod ──────────────────────────────────────────────────────────────────

const accessInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
});

const updateSettingsInput = accessInput.extend({
  splitLoyalVintagePct: z.number().int().min(0).max(100).optional(),
  splitTopDecileCurrentPct: z.number().int().min(0).max(100).optional(),
  splitAtRiskPct: z.number().int().min(0).max(100).optional(),
  cooldownMonths: z.number().int().min(0).max(36).optional(),
  requireManualConfirm: z.boolean().optional(),
});

const idInput = accessInput.extend({
  id: z.string().uuid(),
});

// ─── Settings ─────────────────────────────────────────────────────────────

async function loadSettings(
  sb: ReturnType<typeof admin>,
  userId: string,
): Promise<AllocationSettings> {
  const { data: row, error } = await sb
    .from("knowledge_nodes")
    .select("attachments, updated_at")
    .eq("user_id", userId)
    .eq("node_type", "allocation_settings")
    .maybeSingle();
  if (error) throw new Error(`Couldn't read allocation settings: ${error.message}`);
  if (!row) return DEFAULTS;
  const s = (row.attachments ?? {}) as Partial<AllocationSettings>;
  return {
    splitLoyalVintagePct: s.splitLoyalVintagePct ?? DEFAULTS.splitLoyalVintagePct,
    splitTopDecileCurrentPct:
      s.splitTopDecileCurrentPct ?? DEFAULTS.splitTopDecileCurrentPct,
    splitAtRiskPct: s.splitAtRiskPct ?? DEFAULTS.splitAtRiskPct,
    cooldownMonths: s.cooldownMonths ?? DEFAULTS.cooldownMonths,
    requireManualConfirm: s.requireManualConfirm ?? DEFAULTS.requireManualConfirm,
    updatedAt: row.updated_at,
  };
}

export const getAllocationSettings = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => accessInput.parse(raw))
  .handler(async ({ data }): Promise<AllocationSettings> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    return loadSettings(sb, effectiveUserId);
  });

export const updateAllocationSettings = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => updateSettingsInput.parse(raw))
  .handler(async ({ data }): Promise<AllocationSettings> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const prior = await loadSettings(sb, effectiveUserId);
    const next: AllocationSettings = {
      splitLoyalVintagePct:
        data.splitLoyalVintagePct ?? prior.splitLoyalVintagePct,
      splitTopDecileCurrentPct:
        data.splitTopDecileCurrentPct ?? prior.splitTopDecileCurrentPct,
      splitAtRiskPct: data.splitAtRiskPct ?? prior.splitAtRiskPct,
      cooldownMonths: data.cooldownMonths ?? prior.cooldownMonths,
      requireManualConfirm:
        data.requireManualConfirm ?? prior.requireManualConfirm,
      updatedAt: new Date().toISOString(),
    };

    const { data: existing } = await sb
      .from("knowledge_nodes")
      .select("id")
      .eq("user_id", effectiveUserId)
      .eq("node_type", "allocation_settings")
      .maybeSingle();

    if (existing) {
      const { error } = await sb
        .from("knowledge_nodes")
        .update({
          attachments: next as unknown as Json,
          updated_at: next.updatedAt!,
        })
        .eq("id", existing.id);
      if (error) throw new Error(`Couldn't update settings: ${error.message}`);
    } else {
      const { error } = await sb.from("knowledge_nodes").insert({
        user_id: effectiveUserId,
        node_type: "allocation_settings",
        title: "Allocation settings",
        context: "recognition",
        content: "",
        attachments: next as unknown as Json,
      });
      if (error) throw new Error(`Couldn't create settings: ${error.message}`);
    }
    return next;
  });

// ─── List suggestions ─────────────────────────────────────────────────────

type SuggestionAttachments = {
  patientNodeId: string;
  patientDisplayName: string;
  cohort: Cohort;
  brand: string;
  manufacturer: string | null;
  units: number;
  rebateInventoryId: string;
  score: number;
  rationale: string;
  status: "pending" | "confirmed" | "dismissed";
};

export const listAllocationSuggestions = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => accessInput.parse(raw))
  .handler(async ({ data }): Promise<AllocationSuggestion[]> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const { data: rows, error } = await sb
      .from("knowledge_nodes")
      .select("id, attachments, created_at, updated_at")
      .eq("user_id", effectiveUserId)
      .eq("node_type", "allocation_suggestion")
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw new Error(`Couldn't load suggestions: ${error.message}`);
    return (rows ?? []).map((r) => {
      const a = (r.attachments ?? {}) as SuggestionAttachments;
      return {
        id: r.id,
        patientNodeId: a.patientNodeId,
        patientDisplayName: a.patientDisplayName,
        cohort: a.cohort,
        brand: a.brand,
        manufacturer: a.manufacturer,
        units: a.units,
        rebateInventoryId: a.rebateInventoryId,
        score: a.score,
        rationale: a.rationale,
        status: a.status,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    });
  });

// ─── Confirm / dismiss suggestion ─────────────────────────────────────────

async function patchStatus(
  sb: ReturnType<typeof admin>,
  userId: string,
  id: string,
  status: "confirmed" | "dismissed",
): Promise<AllocationSuggestion> {
  const { data: row, error: readErr } = await sb
    .from("knowledge_nodes")
    .select("id, attachments, created_at, updated_at")
    .eq("id", id)
    .eq("user_id", userId)
    .eq("node_type", "allocation_suggestion")
    .maybeSingle();
  if (readErr) throw new Error(`Couldn't load suggestion: ${readErr.message}`);
  if (!row) throw new Error("Suggestion not found.");
  const a = { ...((row.attachments ?? {}) as SuggestionAttachments), status };
  const nowIso = new Date().toISOString();
  const { error: updErr } = await sb
    .from("knowledge_nodes")
    .update({
      attachments: a as unknown as Json,
      updated_at: nowIso,
    })
    .eq("id", id);
  if (updErr) throw new Error(`Couldn't update suggestion: ${updErr.message}`);

  // If confirming, increment rebate_inventory_units.units_deployed by units.
  if (status === "confirmed") {
    const { data: existing } = await sb
      .from("rebate_inventory_units")
      .select("units_deployed, units_total")
      .eq("id", a.rebateInventoryId)
      .eq("user_id", userId)
      .maybeSingle();
    if (existing) {
      const next = Math.min(
        existing.units_deployed + a.units,
        existing.units_total,
      );
      await sb
        .from("rebate_inventory_units")
        .update({ units_deployed: next })
        .eq("id", a.rebateInventoryId);
    }
  }

  return {
    id: row.id,
    patientNodeId: a.patientNodeId,
    patientDisplayName: a.patientDisplayName,
    cohort: a.cohort,
    brand: a.brand,
    manufacturer: a.manufacturer,
    units: a.units,
    rebateInventoryId: a.rebateInventoryId,
    score: a.score,
    rationale: a.rationale,
    status: a.status,
    createdAt: row.created_at,
    updatedAt: nowIso,
  };
}

export const confirmAllocationSuggestion = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => idInput.parse(raw))
  .handler(async ({ data }): Promise<AllocationSuggestion> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    return patchStatus(sb, effectiveUserId, data.id, "confirmed");
  });

export const dismissAllocationSuggestion = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => idInput.parse(raw))
  .handler(async ({ data }): Promise<AllocationSuggestion> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    return patchStatus(sb, effectiveUserId, data.id, "dismissed");
  });

// ─── Scoring + matching engine ────────────────────────────────────────────

type PatientScored = {
  patientNodeId: string;
  patientDisplayName: string;
  cohort: Cohort;
  score: number;
  rationale: string;
};

function daysBetween(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((now - t) / (24 * 60 * 60 * 1000));
}

function classifyPatient(
  patient: PatientSummary,
  spendDecileCutoff: number,
  patientNodeId: string,
  now: number,
): PatientScored | null {
  const firstVisitDays = daysBetween(patient.firstVisit, now);
  const lastVisitDays = daysBetween(patient.lastVisit, now);
  if (lastVisitDays === null) return null;

  const last12moSpend = patient.netSpendUsd ?? 0;

  // At-Risk overlay — declining engagement + still in re-engageable window.
  if (lastVisitDays >= 60 && lastVisitDays <= 180 && last12moSpend > 0) {
    return {
      patientNodeId,
      patientDisplayName: patient.displayName,
      cohort: "at_risk",
      score: 100 - lastVisitDays / 2 + Math.min(50, last12moSpend / 100),
      rationale: `Last visit ${lastVisitDays}d ago; at-risk re-engagement window.`,
    };
  }

  // Top-Decile Current — high recent spend + active.
  if (last12moSpend >= spendDecileCutoff && lastVisitDays < 180) {
    return {
      patientNodeId,
      patientDisplayName: patient.displayName,
      cohort: "top_decile_current",
      score: Math.min(200, last12moSpend / 50),
      rationale: `Top-decile YTD spend ($${Math.round(last12moSpend).toLocaleString()}); active.`,
    };
  }

  // Loyal Vintage — long tenure + steady visits + still active.
  if (
    firstVisitDays !== null &&
    firstVisitDays > 365 &&
    lastVisitDays < 180 &&
    patient.totalVisits >= 4
  ) {
    return {
      patientNodeId,
      patientDisplayName: patient.displayName,
      cohort: "loyal_vintage",
      score:
        Math.min(80, patient.totalVisits * 4) +
        Math.min(40, firstVisitDays / 30),
      rationale: `${Math.round(firstVisitDays / 365)} yr tenure; ${patient.totalVisits} visits; active.`,
    };
  }

  return null;
}

type InventoryRowLite = {
  id: string;
  brand: string;
  available: number;
  manufacturer: string | null;
};

export const runAllocation = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => accessInput.parse(raw))
  .handler(
    async ({
      data,
    }): Promise<{
      generated: number;
      perCohort: Record<Cohort, number>;
      inventoryUsed: number;
      noOpReason?: string;
    }> => {
      const { effectiveUserId } = await resolveEffectiveUserId({
        accessToken: data.accessToken,
        viewAsUserId: data.viewAsUserId,
      });
      const sb = admin();
      const settings = await loadSettings(sb, effectiveUserId);

      // 1) Load available rebate inventory.
      const { data: invRows, error: invErr } = await sb
        .from("rebate_inventory_units")
        .select("id, units_total, units_deployed, node_id")
        .eq("user_id", effectiveUserId);
      if (invErr) throw new Error(`Couldn't load inventory: ${invErr.message}`);
      const nodeIds = (invRows ?? []).map((r) => r.node_id);
      let nodeMap = new Map<string, { brand: string; manufacturer: string | null }>();
      if (nodeIds.length > 0) {
        const { data: nodeRows } = await sb
          .from("knowledge_nodes")
          .select("id, title, attachments")
          .in("id", nodeIds);
        nodeMap = new Map(
          (nodeRows ?? []).map((n) => {
            const a = (n.attachments ?? {}) as { manufacturer?: string };
            return [n.id, { brand: n.title, manufacturer: a.manufacturer ?? null }];
          }),
        );
      }
      const inventory: InventoryRowLite[] = (invRows ?? [])
        .map((r) => {
          const meta = nodeMap.get(r.node_id);
          return {
            id: r.id,
            brand: meta?.brand ?? "Unknown",
            available: Math.max(0, r.units_total - r.units_deployed),
            manufacturer: meta?.manufacturer ?? null,
          };
        })
        .filter((r) => r.available > 0);
      if (inventory.length === 0) {
        return {
          generated: 0,
          perCohort: { loyal_vintage: 0, top_decile_current: 0, at_risk: 0 },
          inventoryUsed: 0,
          noOpReason: "No available rebate inventory.",
        };
      }
      const totalAvailable = inventory.reduce((s, r) => s + r.available, 0);

      // 2) Load patients.
      const { data: ptRows, error: ptErr } = await sb
        .from("knowledge_nodes")
        .select("id, attachments")
        .eq("user_id", effectiveUserId)
        .eq("node_type", "patient")
        .limit(5000);
      if (ptErr) throw new Error(`Couldn't load patients: ${ptErr.message}`);

      // 3) Determine spend-decile cutoff (10th-percentile from the top).
      const spendValues: number[] = [];
      for (const r of ptRows ?? []) {
        const s = (r.attachments as unknown as PatientSummary | null)?.netSpendUsd;
        if (typeof s === "number" && s > 0) spendValues.push(s);
      }
      spendValues.sort((a, b) => b - a);
      const decileIdx = Math.floor(spendValues.length * 0.1);
      const spendDecileCutoff = spendValues[decileIdx] ?? 1;

      // 4) Score every patient → classify into cohort.
      const now = Date.now();
      const scored: PatientScored[] = [];
      for (const row of ptRows ?? []) {
        const summary = row.attachments as unknown as PatientSummary | null;
        if (!summary) continue;
        const s = classifyPatient(summary, spendDecileCutoff, row.id, now);
        if (s) scored.push(s);
      }
      if (scored.length === 0) {
        return {
          generated: 0,
          perCohort: { loyal_vintage: 0, top_decile_current: 0, at_risk: 0 },
          inventoryUsed: 0,
          noOpReason: "No patients qualified for any cohort.",
        };
      }

      // 5) Cooldown — drop patients with a confirmed allocation in window.
      const cooldownSince = new Date(
        now - settings.cooldownMonths * 30 * 24 * 60 * 60 * 1000,
      ).toISOString();
      const { data: recent } = await sb
        .from("knowledge_nodes")
        .select("attachments, updated_at")
        .eq("user_id", effectiveUserId)
        .eq("node_type", "allocation_suggestion")
        .gte("updated_at", cooldownSince);
      const cooldownSet = new Set<string>();
      for (const r of recent ?? []) {
        const a = (r.attachments ?? {}) as Partial<SuggestionAttachments>;
        if (a.status === "confirmed" && a.patientNodeId) {
          cooldownSet.add(a.patientNodeId);
        }
      }

      // 6) Split inventory per cohort.
      const targets: Record<Cohort, number> = {
        loyal_vintage: Math.floor(
          (totalAvailable * settings.splitLoyalVintagePct) / 100,
        ),
        top_decile_current: Math.floor(
          (totalAvailable * settings.splitTopDecileCurrentPct) / 100,
        ),
        at_risk: Math.floor((totalAvailable * settings.splitAtRiskPct) / 100),
      };

      // 7) Per cohort, take top-N by score where N = target units, skip cooldown.
      const perCohort: Record<Cohort, PatientScored[]> = {
        loyal_vintage: [],
        top_decile_current: [],
        at_risk: [],
      };
      for (const s of scored) perCohort[s.cohort].push(s);
      for (const k of Object.keys(perCohort) as Cohort[]) {
        perCohort[k].sort((a, b) => b.score - a.score);
      }

      // 8) Greedy allocate inventory: cohort order → for each picked patient,
      //    pick the brand with the most remaining units. 1 unit per patient.
      const suggestions: SuggestionAttachments[] = [];
      const cohortGenerated: Record<Cohort, number> = {
        loyal_vintage: 0,
        top_decile_current: 0,
        at_risk: 0,
      };
      let inventoryUsed = 0;
      const remaining = new Map(inventory.map((i) => [i.id, i.available]));
      for (const cohort of [
        "loyal_vintage",
        "top_decile_current",
        "at_risk",
      ] as Cohort[]) {
        const target = targets[cohort];
        let count = 0;
        for (const patient of perCohort[cohort]) {
          if (count >= target) break;
          if (cooldownSet.has(patient.patientNodeId)) continue;
          // Pick the inventory row with most remaining units.
          let pick: InventoryRowLite | null = null;
          let max = 0;
          for (const inv of inventory) {
            const rem = remaining.get(inv.id) ?? 0;
            if (rem > max) {
              max = rem;
              pick = inv;
            }
          }
          if (!pick || max <= 0) break;
          remaining.set(pick.id, max - 1);
          inventoryUsed += 1;
          count += 1;
          cohortGenerated[cohort] += 1;
          suggestions.push({
            patientNodeId: patient.patientNodeId,
            patientDisplayName: patient.patientDisplayName,
            cohort,
            brand: pick.brand,
            manufacturer: pick.manufacturer,
            units: 1,
            rebateInventoryId: pick.id,
            score: Math.round(patient.score),
            rationale: patient.rationale,
            status: "pending",
          });
        }
      }

      // 9) Write suggestions as knowledge_nodes rows.
      if (suggestions.length > 0) {
        const inserts = suggestions.map((s) => ({
          user_id: effectiveUserId,
          node_type: "allocation_suggestion",
          context: "recognition",
          title: `${s.brand} → ${s.patientDisplayName}`,
          content: s.rationale,
          attachments: s as unknown as Json,
        }));
        const { error } = await sb.from("knowledge_nodes").insert(inserts);
        if (error) {
          throw new Error(`Couldn't persist suggestions: ${error.message}`);
        }
      }

      return {
        generated: suggestions.length,
        perCohort: cohortGenerated,
        inventoryUsed,
      };
    },
  );
