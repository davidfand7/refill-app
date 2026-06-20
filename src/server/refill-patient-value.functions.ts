/**
 * Patient Value Tiering — recompute server fn (Patient-Profitability OS, Pillar 1).
 *
 * Value tier is a PERCENTILE within the tenant's own book, so it can't be
 * computed per-row at ingest — it needs the whole population at once. This fn
 * mirrors the proven whole-book batch shape of `runAllocation`
 * (refill-recognition-allocation.functions.ts) and "Recompute reliability now"
 * (emma-reliability.functions.ts): load every patient (paginated past the
 * 1,000-row PostgREST cap via fetchAllRows), compute tiers in memory, then
 * batch-merge the result back onto each node's attachments jsonb (NO migration,
 * preserved across sales-CSV re-rolls by the rollup priorContact path).
 *
 * Reads `reliability_status.tier` (in_recovery = chronic 6mo no-show/cancel) +
 * softTags (negotiator/specialsSeeker) for the independent reliability axis.
 *
 * On-demand (owner button) for now; a cron pass is a later slice.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { admin } from "./admin-client";
import type { Json } from "@/integrations/supabase/types";
import type { PatientSummary } from "@/lib/patient-csv";
import { resolveEffectiveUserId } from "@/server/auth-helpers";
import { fetchAllRows } from "@/server/paginate";
import {
  assignValueTiers,
  isNonPatientName,
  reliabilityFlag,
  type PatientValueInputs,
  type ReliabilityFlag,
  type ValueTier,
} from "@/lib/patient-value";

const accessInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
});

export type RecomputeValueTiersResult = {
  patientsScanned: number;
  patientsWritten: number;
  /** Non-patient catch-all buckets (e.g. "Unassigned") excluded from ranking. */
  bucketsSkipped: number;
  byTier: Record<ValueTier, number>;
  byReliability: Record<ReliabilityFlag, number>;
  computedAt: string;
};

type PatientNodeRow = { id: string; attachments: Json | null };

export const recomputePatientValueTiers = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => accessInput.parse(raw))
  .handler(async ({ data }): Promise<RecomputeValueTiersResult> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();

    // 1) Load EVERY patient node (paginated — a >1,000-patient tenant would
    //    otherwise silently truncate, skewing the whole-book percentile).
    const rows = await fetchAllRows<PatientNodeRow>((from, to) =>
      sb
        .from("knowledge_nodes")
        .select("id, attachments")
        .eq("user_id", effectiveUserId)
        .eq("node_type", "patient")
        .order("id", { ascending: true })
        .range(from, to),
    );

    // 2) Reliability tiers for this tenant (in_recovery = the "watch" signal).
    const reliabilityRows = await fetchAllRows<{
      patient_node_id: string | null;
      tier: string | null;
    }>((from, to) =>
      sb
        .from("reliability_status")
        .select("patient_node_id, tier")
        .eq("user_id", effectiveUserId)
        .order("patient_node_id", { ascending: true })
        .range(from, to),
    );
    const inRecovery = new Set<string>();
    for (const r of reliabilityRows) {
      if (r.patient_node_id && r.tier === "in_recovery") {
        inRecovery.add(r.patient_node_id);
      }
    }

    // 3) Build the rankable inputs from each patient summary. Non-patient
    //    catch-all buckets (e.g. QuickBooks "Unassigned") are EXCLUDED — they
    //    aggregate unattributed sales and would rank as fake whales, skewing
    //    the percentile and surfacing as targetable "top" patients. Any such
    //    bucket carrying a stale tier from a prior run gets it CLEARED below.
    type Entry = { id: string; summary: PatientSummary } & PatientValueInputs;
    const entries: Entry[] = [];
    const bucketsToClear: Array<{ id: string; summary: PatientSummary }> = [];
    let bucketsSkipped = 0;
    for (const row of rows) {
      const summary = row.attachments as unknown as PatientSummary | null;
      if (!summary) continue;
      if (isNonPatientName(summary.displayName)) {
        bucketsSkipped += 1;
        if (
          summary.valueTier != null ||
          summary.valueScore != null ||
          summary.reliabilityFlag != null
        ) {
          bucketsToClear.push({ id: row.id, summary });
        }
        continue;
      }
      entries.push({
        id: row.id,
        summary,
        firstVisit: summary.firstVisit ?? null,
        lastVisit: summary.lastVisit ?? null,
        totalVisits: typeof summary.totalVisits === "number" ? summary.totalVisits : 0,
        netSpendUsd: typeof summary.netSpendUsd === "number" ? summary.netSpendUsd : 0,
      });
    }

    // 4) Whole-book value tiering (percentile relative to the tenant's book).
    const now = Date.now();
    const tiers = assignValueTiers(entries, now);
    const computedAt = new Date().toISOString();

    const byTier: Record<ValueTier, number> = { top: 0, core: 0, emerging: 0 };
    const byReliability: Record<ReliabilityFlag, number> = { reliable: 0, watch: 0 };

    // 5) Build merged attachments per patient (read-modify-write merge so we
    //    never clobber the rest of the summary). Only re-write rows whose tier
    //    fields actually changed — keeps the batch small on re-runs.
    type Update = { id: string; attachments: Json };
    const updates: Update[] = [];
    for (const e of entries) {
      const tier = tiers.get(e.id);
      if (!tier) continue;
      const flag = reliabilityFlag({
        inRecovery: inRecovery.has(e.id),
        negotiatorAlways: e.summary.softTags?.negotiator?.value === "always",
        specialsSeeker: e.summary.softTags?.specialsSeeker?.value === true,
      });
      byTier[tier.valueTier] += 1;
      byReliability[flag] += 1;

      const unchanged =
        e.summary.valueTier === tier.valueTier &&
        e.summary.valueScore === tier.valueScore &&
        e.summary.reliabilityFlag === flag;
      if (unchanged) continue;

      const next: PatientSummary = {
        ...e.summary,
        valueTier: tier.valueTier,
        valueScore: tier.valueScore,
        reliabilityFlag: flag,
        valueTieredAt: computedAt,
      };
      updates.push({ id: e.id, attachments: next as unknown as Json });
    }

    // 5b) Clear stale tier fields off any non-patient bucket (so a previously
    //     mis-tiered "Unassigned" stops reading/targeting as top).
    for (const b of bucketsToClear) {
      const cleared: PatientSummary = {
        ...b.summary,
        valueTier: null,
        valueScore: null,
        reliabilityFlag: null,
        valueTieredAt: computedAt,
      };
      updates.push({ id: b.id, attachments: cleared as unknown as Json });
    }

    // 6) Bulk-write changed rows. Chunked Promise.all (matches the reliability
    //    recompute write shape) — bounded round trips without a CASE-WHEN.
    const CHUNK = 50;
    for (let i = 0; i < updates.length; i += CHUNK) {
      const chunk = updates.slice(i, i + CHUNK);
      await Promise.all(
        chunk.map((u) =>
          sb
            .from("knowledge_nodes")
            .update({ attachments: u.attachments, updated_at: computedAt })
            .eq("id", u.id)
            .eq("user_id", effectiveUserId),
        ),
      );
    }

    return {
      patientsScanned: entries.length,
      patientsWritten: updates.length,
      bucketsSkipped,
      byTier,
      byReliability,
      computedAt,
    };
  });
