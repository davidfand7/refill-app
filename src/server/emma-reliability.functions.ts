/**
 * Emma(OS) reliability tier engine + pattern alerts (v362).
 *
 * Per-patient reliability tier computed from appointment history.
 *
 * Tier rules (configurable per spa via emma_noshow_policies.reliability_tier_thresholds):
 *
 *   in_recovery — no_shows in last in_recovery_window_months >= in_recovery_threshold
 *                  (default: 3 no-shows in 6 months)
 *                  Highest priority — preempts vip/regular checks.
 *   vip         — total showed visits >= vip_min_visits
 *                  (default: 12)
 *   regular     — total showed visits >= regular_min_visits
 *                  (default: 3)
 *   trusted     — default for new patients + everyone who doesn't qualify above
 *
 * Pattern alerts fire on tier TRANSITIONS only (not on initial assignment).
 * Examples:
 *   trusted → in_recovery       → kind='in_recovery_triggered', headline emphasizes pattern
 *   regular → vip               → kind='vip_unlocked', positive framing
 *   in_recovery → regular       → kind='returned_to_trusted', celebrate
 *
 * Three surfaces:
 *   recomputeReliabilityForPatient — pure fn; called by foreground trigger
 *                                     (updateAppointmentStatus) on every status change
 *   recomputeReliabilityForUser    — sweep helper; called by cron + UI bulk action
 *   listPatternAlerts              — for /app/refill/rescue Patterns tab
 *   dismissPatternAlert            — owner closes an alert
 *   getReliabilityCard             — per-patient detail (for future patient profile)
 *
 * Established 2026-05-17 (Promotions Engine v362).
 */

import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database, Json } from "@/integrations/supabase/types";
import { resolveEffectiveUserId, verifyAuth } from "@/server/auth-helpers";

// ─── Public types ─────────────────────────────────────────────────────────

export type ReliabilityTier = "trusted" | "regular" | "vip" | "in_recovery";

export type ReliabilityCard = {
  tier: ReliabilityTier;
  noShows6mo: number;
  totalVisits: number;
  cancellations6mo: number;
  graceCreditsUsed: number;
  lastActivityAt: string | null;
  recomputedAt: string;
};

export type PatternAlertKind =
  | "tier_promoted"
  | "tier_demoted"
  | "in_recovery_triggered"
  | "vip_unlocked"
  | "regular_unlocked"
  | "returned_to_trusted";

export type PatternAlert = {
  id: string;
  patientNodeId: string;
  patientName: string | null;
  kind: PatternAlertKind;
  fromTier: ReliabilityTier | null;
  toTier: ReliabilityTier;
  headline: string;
  body: string | null;
  dismissedAt: string | null;
  createdAt: string;
};

type PolicyThresholds = {
  trusted_max_noshows: number;
  regular_min_visits: number;
  vip_min_visits: number;
  in_recovery_threshold: number;
  in_recovery_window_months: number;
};

const POLICY_DEFAULTS: PolicyThresholds = {
  trusted_max_noshows: 0,
  regular_min_visits: 3,
  vip_min_visits: 12,
  in_recovery_threshold: 3,
  in_recovery_window_months: 6,
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

// ─── Tier computation ─────────────────────────────────────────────────────

function readThresholds(raw: Json | null): PolicyThresholds {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return POLICY_DEFAULTS;
  const obj = raw as Record<string, unknown>;
  return {
    trusted_max_noshows:
      typeof obj.trusted_max_noshows === "number"
        ? obj.trusted_max_noshows
        : POLICY_DEFAULTS.trusted_max_noshows,
    regular_min_visits:
      typeof obj.regular_min_visits === "number"
        ? obj.regular_min_visits
        : POLICY_DEFAULTS.regular_min_visits,
    vip_min_visits:
      typeof obj.vip_min_visits === "number"
        ? obj.vip_min_visits
        : POLICY_DEFAULTS.vip_min_visits,
    in_recovery_threshold:
      typeof obj.in_recovery_threshold === "number"
        ? obj.in_recovery_threshold
        : POLICY_DEFAULTS.in_recovery_threshold,
    in_recovery_window_months:
      typeof obj.in_recovery_window_months === "number"
        ? obj.in_recovery_window_months
        : POLICY_DEFAULTS.in_recovery_window_months,
  };
}

function computeTier(
  totals: {
    noShows6mo: number;
    totalVisits: number;
  },
  thresholds: PolicyThresholds,
): ReliabilityTier {
  if (totals.noShows6mo >= thresholds.in_recovery_threshold) return "in_recovery";
  if (totals.totalVisits >= thresholds.vip_min_visits) return "vip";
  if (totals.totalVisits >= thresholds.regular_min_visits) return "regular";
  return "trusted";
}

// ─── Alert composition ────────────────────────────────────────────────────

function composeAlert(args: {
  fromTier: ReliabilityTier | null;
  toTier: ReliabilityTier;
  patientName: string | null;
  noShows6mo: number;
  totalVisits: number;
}): { kind: PatternAlertKind; headline: string; body: string } | null {
  const { fromTier, toTier, patientName, noShows6mo, totalVisits } = args;
  if (fromTier === toTier) return null;

  // Initial assignment (no prior tier) is not an alert.
  if (fromTier === null) return null;

  const who = patientName ?? "This patient";

  if (toTier === "in_recovery") {
    return {
      kind: "in_recovery_triggered",
      headline: `Pattern: ${who} has ${noShows6mo} no-shows in the last 6 months`,
      body: `Emma flagged ${who} as in-recovery. Consider asking them to confirm in advance for their next booking, or talk to them at their next visit. Their status returns to normal once the 6-month window rolls past their no-shows.`,
    };
  }
  if (toTier === "vip") {
    return {
      kind: "vip_unlocked",
      headline: `${who} just hit VIP status (${totalVisits} visits)`,
      body: `${who} is one of your most loyal patients. Consider a thank-you note, an exclusive offer, or first access to new treatments. Emma never asks VIPs for deposits regardless of policy.`,
    };
  }
  if (toTier === "regular") {
    if (fromTier === "in_recovery") {
      return {
        kind: "returned_to_trusted",
        headline: `${who} is back on track`,
        body: `${who} no longer qualifies as in-recovery — the no-show window has rolled past. Their reliability status is back to regular. Consider a check-in if it feels right.`,
      };
    }
    return {
      kind: "regular_unlocked",
      headline: `${who} crossed ${totalVisits} visits — now a Regular`,
      body: `Reliable repeat patient. Emma's pre-show reminders will adopt a warmer tone (less formal confirmation language).`,
    };
  }
  if (toTier === "trusted") {
    if (fromTier === "in_recovery") {
      return {
        kind: "returned_to_trusted",
        headline: `${who} is back on track`,
        body: `${who} no longer qualifies as in-recovery — the no-show window has rolled past. Reliability status is back to trusted.`,
      };
    }
    return {
      kind: "tier_demoted",
      headline: `${who} dropped from ${fromTier} to trusted`,
      body: `Possibly due to a stale account or the rolling window passing some visits. Emma still treats them normally.`,
    };
  }
  return null;
}

// ─── recomputeReliabilityForPatient ───────────────────────────────────────

/**
 * Recompute reliability tier for ONE patient. Idempotent. Fires a
 * pattern_alert if the tier transitioned.
 *
 * Caller can be:
 *   - The foreground updateAppointmentStatus trigger (on status change)
 *   - The daily cron sweep (recomputeReliabilityForUser iterates all
 *     patients of one spa)
 *   - Manual UI action
 */
export async function recomputeReliabilityForPatient(args: {
  sb: SupabaseAdmin;
  userId: string;
  patientNodeId: string;
}): Promise<{ tier: ReliabilityTier; transitioned: boolean }> {
  const { sb, userId, patientNodeId } = args;

  // 1) Load policy thresholds (or use defaults)
  const { data: policy } = await sb
    .from("emma_noshow_policies")
    .select("reliability_tier_thresholds")
    .eq("user_id", userId)
    .maybeSingle();
  const thresholds = readThresholds(policy?.reliability_tier_thresholds ?? null);

  // 2) Pull appointment history for this patient
  const windowMs =
    thresholds.in_recovery_window_months * 30 * 24 * 60 * 60 * 1000;
  const windowStart = new Date(Date.now() - windowMs).toISOString();

  const { data: appointments } = await sb
    .from("emma_appointments")
    .select("status, scheduled_at, updated_at")
    .eq("user_id", userId)
    .eq("patient_node_id", patientNodeId);

  const all = appointments ?? [];
  let noShows6mo = 0;
  let totalVisits = 0;
  let cancellations6mo = 0;
  let lastActivityAt: string | null = null;

  for (const a of all) {
    if (a.status === "showed") totalVisits++;
    if (a.scheduled_at >= windowStart) {
      if (a.status === "no_show") noShows6mo++;
      if (a.status === "cancelled") cancellations6mo++;
    }
    const activity = a.updated_at ?? a.scheduled_at;
    if (activity && (!lastActivityAt || activity > lastActivityAt)) {
      lastActivityAt = activity;
    }
  }

  const newTier = computeTier({ noShows6mo, totalVisits }, thresholds);

  // 3) Read prior reliability row (for transition detection)
  const { data: prior } = await sb
    .from("emma_reliability_status")
    .select("tier")
    .eq("user_id", userId)
    .eq("patient_node_id", patientNodeId)
    .maybeSingle();
  const priorTier: ReliabilityTier | null = (prior?.tier ?? null) as ReliabilityTier | null;

  // 4) Upsert the materialized row
  const nowIso = new Date().toISOString();
  const { error: upsertErr } = await sb
    .from("emma_reliability_status")
    .upsert(
      {
        user_id: userId,
        patient_node_id: patientNodeId,
        tier: newTier,
        no_shows_6mo: noShows6mo,
        total_visits: totalVisits,
        cancellations_6mo: cancellations6mo,
        grace_credits_used: cancellations6mo, // For v362, grace = cancellation count in window
        last_activity_at: lastActivityAt,
        recomputed_at: nowIso,
      },
      { onConflict: "user_id,patient_node_id" },
    );
  if (upsertErr) {
    throw new Error(`Couldn't write reliability: ${upsertErr.message}`);
  }

  // 5) Fire a pattern alert if transitioned
  const transitioned = priorTier !== null && priorTier !== newTier;
  if (transitioned) {
    // Load patient name for the alert headline
    const { data: patient } = await sb
      .from("knowledge_nodes")
      .select("title")
      .eq("id", patientNodeId)
      .maybeSingle();
    const patientName = patient?.title ?? null;
    const alert = composeAlert({
      fromTier: priorTier,
      toTier: newTier,
      patientName,
      noShows6mo,
      totalVisits,
    });
    if (alert) {
      await sb
        .from("emma_pattern_alerts")
        .insert({
          user_id: userId,
          patient_node_id: patientNodeId,
          kind: alert.kind,
          from_tier: priorTier,
          to_tier: newTier,
          headline: alert.headline,
          body: alert.body,
        })
        .then(({ error }) => {
          if (error) console.error("pattern_alerts insert failed:", error.message);
        });
    }
  }

  return { tier: newTier, transitioned };
}

// ─── recomputeReliabilityForUser (cron sweep helper) ──────────────────────

export async function recomputeReliabilityForUser(args: {
  sb: SupabaseAdmin;
  userId: string;
}): Promise<{ patientsRecomputed: number; transitions: number }> {
  const { sb, userId } = args;

  // Get distinct patient_node_ids that have any appointment history.
  const { data: rows } = await sb
    .from("emma_appointments")
    .select("patient_node_id")
    .eq("user_id", userId)
    .not("patient_node_id", "is", null);

  const patientIds = Array.from(
    new Set(
      (rows ?? [])
        .map((r) => r.patient_node_id)
        .filter((id): id is string => id !== null),
    ),
  );

  let transitions = 0;
  for (const pid of patientIds) {
    try {
      const r = await recomputeReliabilityForPatient({
        sb,
        userId,
        patientNodeId: pid,
      });
      if (r.transitioned) transitions++;
    } catch (e) {
      console.error(
        `recompute failed for ${pid}:`,
        e instanceof Error ? e.message : e,
      );
    }
  }

  return { patientsRecomputed: patientIds.length, transitions };
}

// ─── Server fns ───────────────────────────────────────────────────────────

const listInput = z.object({
  accessToken: z.string().min(1),
  filter: z.enum(["unread", "all"]).optional(),
  viewAsUserId: z.string().uuid().optional(),
});

const dismissInput = z.object({
  accessToken: z.string().min(1),
  alertId: z.string().uuid(),
});

const cardInput = z.object({
  accessToken: z.string().min(1),
  patientNodeId: z.string().uuid(),
});

export const listPatternAlerts = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => listInput.parse(input))
  .handler(async ({ data }): Promise<PatternAlert[]> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();

    let query = sb
      .from("emma_pattern_alerts")
      .select(
        "id, patient_node_id, kind, from_tier, to_tier, headline, body, dismissed_at, created_at",
      )
      .eq("user_id", effectiveUserId)
      .order("created_at", { ascending: false })
      .limit(200);
    if (data.filter !== "all") {
      query = query.is("dismissed_at", null);
    }
    const { data: rows, error } = await query;
    if (error) throw new Error(`Couldn't load alerts: ${error.message}`);
    if (!rows || rows.length === 0) return [];

    const patientIds = Array.from(new Set(rows.map((r) => r.patient_node_id)));
    const { data: patients } = await sb
      .from("knowledge_nodes")
      .select("id, title")
      .in("id", patientIds);
    const patientNameById = new Map(
      (patients ?? []).map((p) => [p.id, p.title as string | null]),
    );

    return rows.map((r) => ({
      id: r.id,
      patientNodeId: r.patient_node_id,
      patientName: patientNameById.get(r.patient_node_id) ?? null,
      kind: r.kind as PatternAlertKind,
      fromTier: r.from_tier as ReliabilityTier | null,
      toTier: r.to_tier as ReliabilityTier,
      headline: r.headline,
      body: r.body,
      dismissedAt: r.dismissed_at,
      createdAt: r.created_at,
    }));
  });

export const dismissPatternAlert = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => dismissInput.parse(input))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();

    await sb
      .from("emma_pattern_alerts")
      .update({
        dismissed_at: new Date().toISOString(),
        dismissed_by: userId,
      })
      .eq("id", data.alertId)
      .eq("user_id", userId)
      .is("dismissed_at", null);
    return { ok: true };
  });

export const getReliabilityCard = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => cardInput.parse(input))
  .handler(async ({ data }): Promise<ReliabilityCard | null> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();

    const { data: row } = await sb
      .from("emma_reliability_status")
      .select(
        "tier, no_shows_6mo, total_visits, cancellations_6mo, grace_credits_used, last_activity_at, recomputed_at",
      )
      .eq("user_id", userId)
      .eq("patient_node_id", data.patientNodeId)
      .maybeSingle();
    if (!row) return null;
    return {
      tier: row.tier as ReliabilityTier,
      noShows6mo: row.no_shows_6mo,
      totalVisits: row.total_visits,
      cancellations6mo: row.cancellations_6mo,
      graceCreditsUsed: row.grace_credits_used,
      lastActivityAt: row.last_activity_at,
      recomputedAt: row.recomputed_at,
    };
  });

// ─── listReliabilityFlags (v1.25.4) ───────────────────────────────────────
//
// Bulk reader: returns one row per patient with a no-show or cancellation
// inside the rolling 6-month reliability window. Powers the A-list rules
// page's "exclude cancellation history" toggle (the toggle still excludes
// either signal — labeled "cancellation history" because in real data the
// cancel:no-show ratio runs ~85:1, per v1.26.2). Fetched once at mount,
// joined into matchesRules() client-side.
//
// The window is 6mo (not lifetime) because that's what emma_reliability_
// status materializes. If lifetime semantics are needed later, switch to
// a count(*) against emma_appointments filtered by status IN ('no_show',
// 'cancelled') without the recomputed_at window cap.

const flagsInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
});

export type ReliabilityFlag = {
  patientNodeId: string;
  noShows6mo: number;
  cancellations6mo: number;
};

export const listReliabilityFlags = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => flagsInput.parse(input))
  .handler(async ({ data }): Promise<ReliabilityFlag[]> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const { data: rows, error } = await sb
      .from("emma_reliability_status")
      .select("patient_node_id, no_shows_6mo, cancellations_6mo")
      .eq("user_id", effectiveUserId)
      .or("no_shows_6mo.gt.0,cancellations_6mo.gt.0");
    if (error) {
      throw new Error(`Couldn't load reliability flags: ${error.message}`);
    }
    return (rows ?? []).map((r) => ({
      patientNodeId: r.patient_node_id,
      noShows6mo: r.no_shows_6mo,
      cancellations6mo: r.cancellations_6mo,
    }));
  });
