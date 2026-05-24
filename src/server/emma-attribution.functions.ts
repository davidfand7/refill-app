/**
 * Emma(OS) recovery-event attribution engine (v363).
 *
 * The financial foundation of the "free + % of recovered revenue"
 * pricing model. Every recovered $ traceable; nothing the LLM
 * invented. [VERIFIED] discipline.
 *
 * Lifecycle of a recovery event:
 *   1. Agent reports save → recordRecoveryEvent creates a provisional
 *      row with verified_at=null, attributed_revenue_usd=null.
 *   2. One of two verification paths stamps the row:
 *      a. QBO reconciliation cron matches patient_transactions and
 *         stamps verified_at + 'qbo' + amount from the transaction.
 *      b. Manual confirm — spa owner enters the billed amount on the
 *         /app/refill/recovery dashboard; stamps verified_at + 'manual'.
 *   3. Verified rows flow into the v366 invoice computation.
 *
 * Two surfaces:
 *   recordRecoveryEvent          — internal helper used by agents
 *   reconcileRecoveryEventsForUser — cron + sweep helper
 *   manualConfirmRecovery        — spa-owner dashboard action
 *   listRecoveryEvents           — for /app/refill/recovery
 *   getRecoveryStats             — aggregate stats (this-month + lifetime)
 *
 * Established 2026-05-17 (Promotions Engine v363).
 */

import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { verifyAuth } from "@/server/auth-helpers";

// ─── Public types ─────────────────────────────────────────────────────────

export type RecoveryAgent = "rescue" | "post_recovery" | "preshow";
export type VerificationSource = "qbo" | "stripe" | "square" | "manual";

export type RecoveryEvent = {
  id: string;
  appointmentId: string | null;
  patientNodeId: string | null;
  patientName: string | null;
  recoveryAgent: RecoveryAgent;
  attributionMethod: string;
  attributedRevenueUsd: number | null;
  verificationSource: VerificationSource | null;
  verifiedAt: string | null;
  treatmentType: string | null;
  appointmentScheduledAt: string | null;
  createdAt: string;
};

export type TreatmentBreakdownRow = {
  treatmentType: string | null;
  count: number;
  recoveredUsd: number;
};

export type RecoveryStats = {
  monthVerifiedUsd: number;
  monthVerifiedCount: number;
  monthProvisionalCount: number;
  priorMonthVerifiedUsd: number;
  priorMonthVerifiedCount: number;
  lifetimeVerifiedUsd: number;
  lifetimeVerifiedCount: number;
  monthByTreatment: TreatmentBreakdownRow[];
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

// ─── recordRecoveryEvent (internal) ───────────────────────────────────────

/**
 * Create a provisional recovery event. Caller is the agent that did
 * the save (rescue, post_recovery, etc.). Idempotent on appointment_id —
 * if an event already exists for this appointment, returns the existing
 * row without creating a duplicate.
 */
export async function recordRecoveryEvent(args: {
  sb: SupabaseAdmin;
  userId: string;
  appointmentId: string;
  patientNodeId: string;
  recoveryAgent: RecoveryAgent;
  attributionMethod?: string;
  notes?: string;
}): Promise<{ id: string; created: boolean }> {
  const { sb, userId, appointmentId, patientNodeId, recoveryAgent } = args;

  // Idempotency check
  const { data: existing } = await sb
    .from("emma_recovery_events")
    .select("id")
    .eq("appointment_id", appointmentId)
    .maybeSingle();
  if (existing) {
    return { id: existing.id, created: false };
  }

  const { data: row, error } = await sb
    .from("emma_recovery_events")
    .insert({
      user_id: userId,
      appointment_id: appointmentId,
      patient_node_id: patientNodeId,
      recovery_agent: recoveryAgent,
      attribution_method: args.attributionMethod ?? "direct",
      notes: args.notes ?? null,
    })
    .select("id")
    .single();
  if (error || !row) {
    throw new Error(`Couldn't record recovery event: ${error?.message ?? "no row"}`);
  }

  // Back-reference on the appointment row for fast joins.
  await sb
    .from("emma_appointments")
    .update({ recovery_event_id: row.id })
    .eq("id", appointmentId)
    .then(({ error: e }) => {
      if (e) console.error("backref update failed:", e.message);
    });

  return { id: row.id, created: true };
}

// ─── reconcileRecoveryEventsForUser (cron helper) ─────────────────────────

/**
 * For one spa, scan unverified recovery events and try to match each
 * against patient_transactions in a 14-day window after the event's
 * creation timestamp. On match: stamp verified_at + 'qbo' + the
 * transaction's amount_usd.
 *
 * Conservative matching: same patient_node_id + transaction_date >=
 * event.created_at (we don't try to match transactions that pre-date
 * the save). If multiple transactions exist for the patient in the
 * window, take the LARGEST (the actual treatment, not the deposit or
 * retail item that might happen on the same visit).
 */
export async function reconcileRecoveryEventsForUser(args: {
  sb: SupabaseAdmin;
  userId: string;
}): Promise<{ matched: number; scanned: number }> {
  const { sb, userId } = args;

  const { data: unverified } = await sb
    .from("emma_recovery_events")
    .select("id, patient_node_id, created_at, appointment_id")
    .eq("user_id", userId)
    .is("verified_at", null)
    .not("patient_node_id", "is", null);
  if (!unverified || unverified.length === 0) return { matched: 0, scanned: 0 };

  let matched = 0;
  for (const ev of unverified) {
    if (!ev.patient_node_id) continue;
    const windowEnd = new Date(
      new Date(ev.created_at).getTime() + 14 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const windowStart = ev.created_at;

    const { data: txns } = await sb
      .from("patient_transactions")
      .select("id, amount_usd, transaction_date")
      .eq("user_id", userId)
      .eq("patient_node_id", ev.patient_node_id)
      .gte("transaction_date", windowStart.slice(0, 10))
      .lte("transaction_date", windowEnd.slice(0, 10))
      .gt("amount_usd", 0)
      .order("amount_usd", { ascending: false })
      .limit(1);

    const best = txns?.[0];
    if (!best) continue;

    const { error: upErr } = await sb
      .from("emma_recovery_events")
      .update({
        verified_at: new Date().toISOString(),
        verification_source: "qbo",
        attributed_revenue_usd: best.amount_usd,
        matched_transaction_id: best.id,
      })
      .eq("id", ev.id)
      .is("verified_at", null); // Race-safe — first writer wins.
    if (!upErr) matched++;
  }

  return { matched, scanned: unverified.length };
}

// ─── Zod ──────────────────────────────────────────────────────────────────

const listInput = z.object({
  accessToken: z.string().min(1),
  monthIso: z.string().optional(), // YYYY-MM, defaults to current month
});

const manualInput = z.object({
  accessToken: z.string().min(1),
  recoveryEventId: z.string().uuid(),
  amountUsd: z.number().min(0).max(100000),
  notes: z.string().max(500).optional(),
});

const unconfirmInput = z.object({
  accessToken: z.string().min(1),
  recoveryEventId: z.string().uuid(),
});

const statsInput = z.object({
  accessToken: z.string().min(1),
});

// ─── listRecoveryEvents (UI) ──────────────────────────────────────────────

export const listRecoveryEvents = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => listInput.parse(input))
  .handler(async ({ data }): Promise<RecoveryEvent[]> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();

    // Month bounds — UTC for the cron consistency. Spa-local rendering
    // happens in the UI.
    let monthStart: Date;
    let monthEnd: Date;
    if (data.monthIso) {
      const [y, m] = data.monthIso.split("-").map(Number);
      monthStart = new Date(Date.UTC(y, m - 1, 1));
      monthEnd = new Date(Date.UTC(y, m, 1));
    } else {
      const now = new Date();
      monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    }

    const { data: rows, error } = await sb
      .from("emma_recovery_events")
      .select(
        "id, appointment_id, patient_node_id, recovery_agent, attribution_method, attributed_revenue_usd, verification_source, verified_at, created_at",
      )
      .eq("user_id", userId)
      .gte("created_at", monthStart.toISOString())
      .lt("created_at", monthEnd.toISOString())
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw new Error(`Couldn't load events: ${error.message}`);
    if (!rows || rows.length === 0) return [];

    // Hydrate patient names + appointment context
    const patientIds = Array.from(
      new Set(
        rows
          .map((r) => r.patient_node_id)
          .filter((id): id is string => id !== null),
      ),
    );
    const aptIds = Array.from(
      new Set(
        rows
          .map((r) => r.appointment_id)
          .filter((id): id is string => id !== null),
      ),
    );

    const [{ data: patients }, { data: appointments }] = await Promise.all([
      patientIds.length > 0
        ? sb.from("knowledge_nodes").select("id, title").in("id", patientIds)
        : Promise.resolve({ data: [] }),
      aptIds.length > 0
        ? sb
            .from("emma_appointments")
            .select("id, treatment_type, scheduled_at")
            .in("id", aptIds)
        : Promise.resolve({ data: [] }),
    ]);

    const patientNameById = new Map(
      (patients ?? []).map((p) => [p.id, p.title as string | null]),
    );
    const aptById = new Map(
      (appointments ?? []).map((a) => [
        a.id,
        { treatment: a.treatment_type, when: a.scheduled_at },
      ]),
    );

    return rows.map((r) => ({
      id: r.id,
      appointmentId: r.appointment_id,
      patientNodeId: r.patient_node_id,
      patientName: r.patient_node_id
        ? patientNameById.get(r.patient_node_id) ?? null
        : null,
      recoveryAgent: r.recovery_agent as RecoveryAgent,
      attributionMethod: r.attribution_method,
      attributedRevenueUsd: r.attributed_revenue_usd
        ? Number(r.attributed_revenue_usd)
        : null,
      verificationSource: r.verification_source as VerificationSource | null,
      verifiedAt: r.verified_at,
      treatmentType: r.appointment_id
        ? aptById.get(r.appointment_id)?.treatment ?? null
        : null,
      appointmentScheduledAt: r.appointment_id
        ? aptById.get(r.appointment_id)?.when ?? null
        : null,
      createdAt: r.created_at,
    }));
  });

// ─── manualConfirmRecovery (spa owner dashboard action) ───────────────────

export const manualConfirmRecovery = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => manualInput.parse(input))
  .handler(async ({ data }): Promise<RecoveryEvent> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();

    const { data: updated, error } = await sb
      .from("emma_recovery_events")
      .update({
        verified_at: new Date().toISOString(),
        verification_source: "manual",
        attributed_revenue_usd: data.amountUsd,
        verified_by: userId,
        notes: data.notes ?? null,
      })
      .eq("id", data.recoveryEventId)
      .eq("user_id", userId)
      .is("verified_at", null) // Don't clobber an already-verified row.
      .select(
        "id, appointment_id, patient_node_id, recovery_agent, attribution_method, attributed_revenue_usd, verification_source, verified_at, created_at",
      )
      .maybeSingle();
    if (error || !updated) {
      throw new Error(
        `Couldn't confirm: ${error?.message ?? "already verified or not found"}`,
      );
    }
    return {
      id: updated.id,
      appointmentId: updated.appointment_id,
      patientNodeId: updated.patient_node_id,
      patientName: null,
      recoveryAgent: updated.recovery_agent as RecoveryAgent,
      attributionMethod: updated.attribution_method,
      attributedRevenueUsd: updated.attributed_revenue_usd
        ? Number(updated.attributed_revenue_usd)
        : null,
      verificationSource: updated.verification_source as VerificationSource | null,
      verifiedAt: updated.verified_at,
      treatmentType: null,
      appointmentScheduledAt: null,
      createdAt: updated.created_at,
    };
  });

// ─── unconfirmRecovery (allow the spa owner to undo a mis-confirm) ────────

export const unconfirmRecovery = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => unconfirmInput.parse(input))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();

    await sb
      .from("emma_recovery_events")
      .update({
        verified_at: null,
        verification_source: null,
        attributed_revenue_usd: null,
        verified_by: null,
      })
      .eq("id", data.recoveryEventId)
      .eq("user_id", userId)
      .eq("verification_source", "manual"); // Only manual verifications are undoable.
    return { ok: true };
  });

// ─── getRecoveryStats ─────────────────────────────────────────────────────

export const getRecoveryStats = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => statsInput.parse(input))
  .handler(async ({ data }): Promise<RecoveryStats> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();

    const now = new Date();
    const monthStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    const priorMonthStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1),
    );

    const [monthRes, priorMonthRes, lifetimeRes, provisionalRes] =
      await Promise.all([
        // Current-month verified — pull appointment_id so we can group by
        // treatment_type after a single join below.
        sb
          .from("emma_recovery_events")
          .select("attributed_revenue_usd, appointment_id")
          .eq("user_id", userId)
          .gte("verified_at", monthStart.toISOString())
          .not("verified_at", "is", null),
        // Prior-month verified — just the totals for MoM delta.
        sb
          .from("emma_recovery_events")
          .select("attributed_revenue_usd")
          .eq("user_id", userId)
          .gte("verified_at", priorMonthStart.toISOString())
          .lt("verified_at", monthStart.toISOString())
          .not("verified_at", "is", null),
        sb
          .from("emma_recovery_events")
          .select("attributed_revenue_usd")
          .eq("user_id", userId)
          .not("verified_at", "is", null),
        sb
          .from("emma_recovery_events")
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId)
          .is("verified_at", null)
          .gte("created_at", monthStart.toISOString()),
      ]);

    const monthRows = monthRes.data ?? [];
    const priorMonthRows = priorMonthRes.data ?? [];
    const lifetimeRows = lifetimeRes.data ?? [];

    const monthVerifiedUsd = monthRows.reduce(
      (sum, r) => sum + Number(r.attributed_revenue_usd ?? 0),
      0,
    );
    const priorMonthVerifiedUsd = priorMonthRows.reduce(
      (sum, r) => sum + Number(r.attributed_revenue_usd ?? 0),
      0,
    );
    const lifetimeVerifiedUsd = lifetimeRows.reduce(
      (sum, r) => sum + Number(r.attributed_revenue_usd ?? 0),
      0,
    );

    // Per-treatment breakdown for the current month. Hydrate treatment_type
    // via a single batched query against emma_appointments — same pattern
    // listRecoveryEvents uses for hydration.
    const monthAptIds = Array.from(
      new Set(
        monthRows
          .map((r) => r.appointment_id)
          .filter((id): id is string => id !== null),
      ),
    );
    const treatmentByAptId = new Map<string, string | null>();
    if (monthAptIds.length > 0) {
      const { data: apts } = await sb
        .from("emma_appointments")
        .select("id, treatment_type")
        .in("id", monthAptIds);
      for (const a of apts ?? []) {
        treatmentByAptId.set(a.id, a.treatment_type);
      }
    }
    const treatmentAccum = new Map<
      string | null,
      { count: number; recoveredUsd: number }
    >();
    for (const r of monthRows) {
      const treatment = r.appointment_id
        ? treatmentByAptId.get(r.appointment_id) ?? null
        : null;
      const acc = treatmentAccum.get(treatment) ?? { count: 0, recoveredUsd: 0 };
      acc.count += 1;
      acc.recoveredUsd += Number(r.attributed_revenue_usd ?? 0);
      treatmentAccum.set(treatment, acc);
    }
    const monthByTreatment: TreatmentBreakdownRow[] = Array.from(
      treatmentAccum.entries(),
    )
      .map(([treatmentType, v]) => ({
        treatmentType,
        count: v.count,
        recoveredUsd: +v.recoveredUsd.toFixed(2),
      }))
      .sort((a, b) => b.recoveredUsd - a.recoveredUsd);

    return {
      monthVerifiedUsd,
      monthVerifiedCount: monthRows.length,
      monthProvisionalCount: provisionalRes.count ?? 0,
      priorMonthVerifiedUsd,
      priorMonthVerifiedCount: priorMonthRows.length,
      lifetimeVerifiedUsd,
      lifetimeVerifiedCount: lifetimeRows.length,
      monthByTreatment,
    };
  });
