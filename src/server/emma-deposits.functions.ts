/**
 * Emma(OS) deposit-credit holds (v364).
 *
 * The OPTIONAL deposit mechanic for the chronic-offender tail. OFF
 * by default. The marketing line stays: "Emma never punishes your
 * patients — unless you tell us to."
 *
 * v364 scope: intent-only logging. When an in-recovery (or new-patient
 * or high-value-treatment, per policy.deposit_trigger) patient takes
 * a slot AND policy.deposit_enabled is true, Emma writes a row to
 * emma_deposit_holds with status='intent'. The spa owner sees it on
 * /app/refill/recovery Deposits tab. NO MONEY MOVES yet. v364.x wires
 * the Stripe payment_intent flow for actual card holds.
 *
 * Three surfaces:
 *   logDepositIntent          — internal helper (called by rescue + future bookings)
 *   listDepositIntents        — UI list for the recovery dashboard
 *   markDepositVoided         — spa cancels a logged intent (no-op for now since
 *                                no money was held, but useful for the audit)
 *
 * Established 2026-05-17 (Promotions Engine v364).
 */

import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { resolveEffectiveUserId } from "@/server/auth-helpers";

// ─── Public types ─────────────────────────────────────────────────────────

export type DepositStatus = "intent" | "held" | "applied" | "refunded" | "voided";

export type DepositTrigger =
  | "in_recovery_tier"
  | "new_patient"
  | "high_value_treatment";

export type DepositHold = {
  id: string;
  appointmentId: string;
  patientNodeId: string;
  patientName: string | null;
  triggerReason: DepositTrigger;
  amountUsd: number;
  status: DepositStatus;
  intentLoggedAt: string;
  appointmentScheduledAt: string | null;
  appointmentTreatment: string | null;
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

// ─── Eligibility check ────────────────────────────────────────────────────

/**
 * Decide whether a given (patient, appointment) combo should trigger
 * a deposit intent under the spa's current policy. Returns the trigger
 * reason if eligible, null otherwise.
 *
 * Called from claimRescueSlot (and future booking entry points) after
 * the appointment is assigned. Pure logic — no DB writes.
 */
export async function checkDepositEligibility(args: {
  sb: SupabaseAdmin;
  userId: string;
  patientNodeId: string;
  appointmentId: string;
}): Promise<{ eligible: boolean; reason: DepositTrigger | null; amountUsd: number | null }> {
  const { sb, userId, patientNodeId } = args;

  const { data: policy } = await sb
    .from("emma_noshow_policies")
    .select("deposit_enabled, deposit_amount_usd, deposit_trigger")
    .eq("user_id", userId)
    .maybeSingle();

  if (!policy || !policy.deposit_enabled || !policy.deposit_amount_usd) {
    return { eligible: false, reason: null, amountUsd: null };
  }
  const trigger = policy.deposit_trigger as DepositTrigger | null;
  if (!trigger) return { eligible: false, reason: null, amountUsd: null };

  if (trigger === "in_recovery_tier") {
    const { data: rel } = await sb
      .from("emma_reliability_status")
      .select("tier")
      .eq("user_id", userId)
      .eq("patient_node_id", patientNodeId)
      .maybeSingle();
    if (rel?.tier === "in_recovery") {
      return {
        eligible: true,
        reason: "in_recovery_tier",
        amountUsd: Number(policy.deposit_amount_usd),
      };
    }
    return { eligible: false, reason: null, amountUsd: null };
  }

  if (trigger === "new_patient") {
    // "New" = has zero showed visits on file. The reliability table
    // tracks total_visits — use it if present, else fall back to no.
    const { data: rel } = await sb
      .from("emma_reliability_status")
      .select("total_visits")
      .eq("user_id", userId)
      .eq("patient_node_id", patientNodeId)
      .maybeSingle();
    const totalVisits = rel?.total_visits ?? 0;
    if (totalVisits === 0) {
      return {
        eligible: true,
        reason: "new_patient",
        amountUsd: Number(policy.deposit_amount_usd),
      };
    }
    return { eligible: false, reason: null, amountUsd: null };
  }

  if (trigger === "high_value_treatment") {
    // For v1 we don't have a per-treatment value map; the trigger
    // matches when treatment_type contains 'laser' (placeholder until
    // a future ship adds explicit high-value treatment configuration).
    const { data: apt } = await sb
      .from("emma_appointments")
      .select("treatment_type")
      .eq("id", args.appointmentId)
      .maybeSingle();
    const t = apt?.treatment_type?.toLowerCase() ?? "";
    if (t.includes("laser") || t.includes("morpheus") || t.includes("emface")) {
      return {
        eligible: true,
        reason: "high_value_treatment",
        amountUsd: Number(policy.deposit_amount_usd),
      };
    }
    return { eligible: false, reason: null, amountUsd: null };
  }

  return { eligible: false, reason: null, amountUsd: null };
}

// ─── logDepositIntent (internal) ──────────────────────────────────────────

/**
 * Log a deposit intent row. Idempotent on appointment_id — calling
 * twice for the same appointment returns the existing row.
 */
export async function logDepositIntent(args: {
  sb: SupabaseAdmin;
  userId: string;
  appointmentId: string;
  patientNodeId: string;
  triggerReason: DepositTrigger;
  amountUsd: number;
}): Promise<{ id: string; created: boolean }> {
  const { sb, userId, appointmentId, patientNodeId, triggerReason, amountUsd } = args;

  const { data: existing } = await sb
    .from("emma_deposit_holds")
    .select("id")
    .eq("appointment_id", appointmentId)
    .maybeSingle();
  if (existing) return { id: existing.id, created: false };

  const { data: row, error } = await sb
    .from("emma_deposit_holds")
    .insert({
      user_id: userId,
      appointment_id: appointmentId,
      patient_node_id: patientNodeId,
      trigger_reason: triggerReason,
      amount_usd: amountUsd,
      status: "intent",
    })
    .select("id")
    .single();
  if (error || !row) {
    throw new Error(`Couldn't log deposit intent: ${error?.message ?? "no row"}`);
  }
  return { id: row.id, created: true };
}

// ─── Zod ──────────────────────────────────────────────────────────────────

const listInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
});

const voidInput = z.object({
  accessToken: z.string().min(1),
  depositHoldId: z.string().uuid(),
  viewAsUserId: z.string().uuid().optional(),
});

// ─── listDepositIntents ───────────────────────────────────────────────────

export const listDepositIntents = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => listInput.parse(input))
  .handler(async ({ data }): Promise<DepositHold[]> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();

    const { data: rows, error } = await sb
      .from("emma_deposit_holds")
      .select(
        "id, appointment_id, patient_node_id, trigger_reason, amount_usd, status, intent_logged_at",
      )
      .eq("user_id", effectiveUserId)
      .order("intent_logged_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(`Couldn't load deposits: ${error.message}`);
    if (!rows || rows.length === 0) return [];

    // Hydrate patient names + appointment context
    const patientIds = Array.from(new Set(rows.map((r) => r.patient_node_id)));
    const aptIds = Array.from(new Set(rows.map((r) => r.appointment_id)));

    const [{ data: patients }, { data: appointments }] = await Promise.all([
      sb.from("knowledge_nodes").select("id, title").in("id", patientIds),
      sb
        .from("emma_appointments")
        .select("id, treatment_type, scheduled_at")
        .in("id", aptIds),
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
      patientName: patientNameById.get(r.patient_node_id) ?? null,
      triggerReason: r.trigger_reason as DepositTrigger,
      amountUsd: Number(r.amount_usd),
      status: r.status as DepositStatus,
      intentLoggedAt: r.intent_logged_at,
      appointmentScheduledAt: aptById.get(r.appointment_id)?.when ?? null,
      appointmentTreatment: aptById.get(r.appointment_id)?.treatment ?? null,
    }));
  });

// ─── markDepositVoided ────────────────────────────────────────────────────

export const markDepositVoided = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => voidInput.parse(input))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();

    await sb
      .from("emma_deposit_holds")
      .update({
        status: "voided",
        voided_at: new Date().toISOString(),
        voided_by: effectiveUserId,
      })
      .eq("id", data.depositHoldId)
      .eq("user_id", effectiveUserId)
      .in("status", ["intent", "held"]); // Can't void already-applied/refunded
    return { ok: true };
  });
