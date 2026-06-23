/**
 * Incentive-ROI Scoreboard — the cross-source "Incentives at work" band
 * (v2.158.0, Part B of the island-cleanup arc).
 *
 * One tenant-scoped read that answers "what are my incentives actually
 * doing?" by unifying the three incentive surfaces against ONE honest lens:
 *
 *   - Recall      (metric_key='recall_booking')   → verified {bookings, $recovered}
 *   - Cross-sell  (metric_key='cross_sell_addon')  → verified {bookings, $recovered}
 *       Both ride recovery_events — a SETTLED win is verified_at-stamped with
 *       attributed_revenue_usd = the TREATMENT value reconciled from
 *       patient_transactions. That dollar is the SPA's recovered revenue, never
 *       SmartSpa's $5 fee. (We reuse aggregateMetricsForTenant — the exact same
 *       math billing settles on — so the scoreboard and the invoice can't drift.)
 *   - Allocation  (knowledge_nodes 'allocation_suggestion')  → SEND-ONLY.
 *       Allocation has no booking attribution yet, so we report it honestly as
 *       "incentives put to work" (count + units the spa committed to specific
 *       patients) with NO dollar claimed. Conversion attribution is a fast-follow
 *       (recovery_agent='allocation' + backref) — until then we don't pretend.
 *
 * Window: a trailing 12 months — recent enough to read as "at work," wide
 * enough to actually show signal on a practice that's still ramping.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { admin } from "./admin-client";
import type { Json } from "@/integrations/supabase/types";
import { getTenantIdForUser, resolveEffectiveUserId } from "@/server/auth-helpers";
import { aggregateMetricsForTenant } from "@/server/billing-fee-core";
import { fetchAllRows } from "@/server/paginate";

const WINDOW_DAYS = 365;

/** Allocation statuses that mean the spa actually committed the incentive to a
 * patient (units were deployed against the pool). 'pending'/'dismissed' never
 * left the suggestion stage, so they don't count as "put to work." */
const SENT_STATUSES = new Set(["confirmed", "dispatched", "sent"]);

export type IncentiveScoreboard = {
  windowDays: number;
  /** Recall + cross-sell each settle as a verified recovery_event. */
  recall: { count: number; recoveredUsd: number };
  crossSell: { count: number; recoveredUsd: number };
  /** Send-only: no $ until allocation→booking attribution ships. */
  allocation: { sentCount: number; units: number };
};

const accessInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
});

export const getIncentiveScoreboard = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => accessInput.parse(raw))
  .handler(async ({ data }): Promise<IncentiveScoreboard> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(
      sb,
      effectiveUserId,
      "No Refill tenant — finish onboarding first.",
    );

    const periodEnd = new Date();
    const periodStart = new Date(periodEnd.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

    // Recall + cross-sell: the SAME verified-win aggregation billing uses, so
    // the scoreboard's bookings/$ are byte-identical to what the invoice settles.
    const [agg, allocation] = await Promise.all([
      aggregateMetricsForTenant({ sb, tenantId, periodStart, periodEnd }),
      aggregateAllocationSent({ sb, userId: effectiveUserId, periodStart }),
    ]);

    const recall = agg.get("recall_booking") ?? { count: 0, revenueUsd: 0 };
    const crossSell = agg.get("cross_sell_addon") ?? { count: 0, revenueUsd: 0 };

    return {
      windowDays: WINDOW_DAYS,
      recall: { count: recall.count, recoveredUsd: +recall.revenueUsd.toFixed(2) },
      crossSell: { count: crossSell.count, recoveredUsd: +crossSell.revenueUsd.toFixed(2) },
      allocation,
    };
  });

/**
 * Allocation is user-scoped (knowledge_nodes rides user_id). Page past the
 * 1,000-row cap — a busy practice can accrue hundreds of suggestions, and an
 * undercounted "put to work" tally would quietly understate the lane.
 */
async function aggregateAllocationSent(args: {
  sb: ReturnType<typeof admin>;
  userId: string;
  periodStart: Date;
}): Promise<{ sentCount: number; units: number }> {
  const { sb, userId, periodStart } = args;
  type Row = { attachments: Json | null };
  const rows = await fetchAllRows<Row>((from, to) =>
    sb
      .from("knowledge_nodes")
      .select("id, attachments, created_at")
      .eq("user_id", userId)
      .eq("node_type", "allocation_suggestion")
      .gte("created_at", periodStart.toISOString())
      .order("id", { ascending: true })
      .range(from, to),
  );
  let sentCount = 0;
  let units = 0;
  for (const r of rows) {
    const a = (r.attachments ?? {}) as { status?: string; units?: number };
    if (a.status && SENT_STATUSES.has(a.status)) {
      sentCount += 1;
      units += Number(a.units ?? 0);
    }
  }
  return { sentCount, units };
}
