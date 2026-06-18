/**
 * Emma(OS) reliability tier engine + pattern alerts (v362).
 *
 * Per-patient reliability tier computed from appointment history.
 *
 * Tier rules (configurable per spa via noshow_policies.reliability_tier_thresholds):
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
import { admin } from "./admin-client";
import { z } from "zod";

import type { Database, Json } from "@/integrations/supabase/types";
import { resolveEffectiveUserId } from "@/server/auth-helpers";
import { classifyAppointmentOutcome } from "@/lib/noshow-classify";

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
      body: `SmartSpa flagged ${who} as in-recovery. Consider asking them to confirm in advance for their next booking, or talk to them at their next visit. Their status returns to normal once the 6-month window rolls past their no-shows.`,
    };
  }
  if (toTier === "vip") {
    return {
      kind: "vip_unlocked",
      headline: `${who} just hit VIP status (${totalVisits} visits)`,
      body: `${who} is one of your most loyal patients. Consider a thank-you note, an exclusive offer, or first access to new treatments. SmartSpa never asks VIPs for deposits regardless of policy.`,
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
      body: `Reliable repeat patient. SmartSpa's pre-show reminders will adopt a warmer tone (less formal confirmation language).`,
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
      body: `Possibly due to a stale account or the rolling window passing some visits. SmartSpa still treats them normally.`,
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

  // 1) Load policy thresholds (or use defaults) + the spa-wide no-show rule
  //    opt-in (v2.39.0). The two new columns aren't in generated types yet, so
  //    read the whole row off a loose view of the client.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const looseSb = sb as unknown as { from(t: string): any };
  const { data: policy } = await looseSb
    .from("noshow_policies")
    .select("reliability_tier_thresholds, noshow_rule_applies_reliability, noshow_notice_hours")
    .eq("user_id", userId)
    .maybeSingle();
  const thresholds = readThresholds(policy?.reliability_tier_thresholds ?? null);
  const ruleExt = (policy ?? {}) as unknown as {
    noshow_rule_applies_reliability?: boolean | null;
    noshow_notice_hours?: number | null;
  };
  const applyRule = ruleExt.noshow_rule_applies_reliability === true;
  const noticeHours = ruleExt.noshow_notice_hours ?? 24;

  // 2) Pull appointment history for this patient
  const windowMs =
    thresholds.in_recovery_window_months * 30 * 24 * 60 * 60 * 1000;
  const windowStart = new Date(Date.now() - windowMs).toISOString();

  // cancelled_at (v2.34.0) isn't in generated types yet — read via the loose view.
  const { data: appointments } = await looseSb
    .from("appointments")
    .select("status, scheduled_at, updated_at, cancelled_at")
    .eq("user_id", userId)
    .eq("patient_node_id", patientNodeId);

  const all = (appointments ?? []) as Array<{
    status: string;
    scheduled_at: string;
    updated_at: string | null;
    cancelled_at: string | null;
  }>;
  let noShows6mo = 0;
  let totalVisits = 0;
  let cancellations6mo = 0;
  let graceCancellations6mo = 0;
  let noShowsLifetime = 0;
  let cancellationsLifetime = 0;
  let lastActivityAt: string | null = null;

  for (const a of all) {
    // When the spa opts in (v2.39.0), a late cancel (cancelled inside the
    // notice window) ALSO counts as a no-show for the reliability tier — so a
    // chronic late-canceller can reach in_recovery, not just a no-shower. The
    // raw cancellation counts (grace display) are left untouched: a late cancel
    // counts toward BOTH, by design (it's the stricter outcome the rule names).
    const countsAsNoShow =
      a.status === "no_show" ||
      (applyRule &&
        a.status === "cancelled" &&
        classifyAppointmentOutcome({
          status: a.status,
          scheduledAt: a.scheduled_at,
          cancelledAt: a.cancelled_at,
          noticeHours,
        }).outcome === "no_show");

    if (a.status === "showed") totalVisits++;
    if (countsAsNoShow) noShowsLifetime++;
    if (a.status === "cancelled") cancellationsLifetime++;
    if (a.scheduled_at >= windowStart) {
      if (countsAsNoShow) noShows6mo++;
      if (a.status === "cancelled") {
        cancellations6mo++;
        // v2.50.0: grace forgives FAIR-NOTICE cancels only. A late cancel that
        // the rule reclassifies as a no-show (countsAsNoShow) is penalized on
        // the tier and does NOT also consume a grace credit — no double jeopardy.
        // When the rule is off, countsAsNoShow is never true for a cancel, so
        // this is byte-identical to the old raw cancellation count.
        if (!countsAsNoShow) graceCancellations6mo++;
      }
    }
    const activity = a.updated_at ?? a.scheduled_at;
    if (activity && (!lastActivityAt || activity > lastActivityAt)) {
      lastActivityAt = activity;
    }
  }

  const newTier = computeTier({ noShows6mo, totalVisits }, thresholds);

  // 3) Read prior reliability row (for transition detection)
  const { data: prior } = await sb
    .from("reliability_status")
    .select("tier")
    .eq("user_id", userId)
    .eq("patient_node_id", patientNodeId)
    .maybeSingle();
  const priorTier: ReliabilityTier | null = (prior?.tier ?? null) as ReliabilityTier | null;

  // 4) Upsert the materialized row
  const nowIso = new Date().toISOString();
  const { error: upsertErr } = await sb
    .from("reliability_status")
    .upsert(
      {
        user_id: userId,
        patient_node_id: patientNodeId,
        tier: newTier,
        no_shows_6mo: noShows6mo,
        total_visits: totalVisits,
        cancellations_6mo: cancellations6mo,
        no_shows_lifetime: noShowsLifetime,
        cancellations_lifetime: cancellationsLifetime,
        grace_credits_used: graceCancellations6mo, // v2.50.0: honored cancels only when rule on; raw count otherwise
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
        .from("pattern_alerts")
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
//
// v1.26.9 BULK REFACTOR. The pre-v1.26.9 implementation looped
// recomputeReliabilityForPatient per patient — each iteration ~4-6 DB
// round trips. At Karen-scale (~700 patients) that's 2800-4200 RTs, well
// past the Cloudflare Workers CPU timeout the v1.25.7 RPC was created to
// fix for the count columns. The cron was silently timing out, leaving
// tiers indefinitely stale after bulk ingests.
//
// New shape: ~5-15 RTs total regardless of patient count.
//   1. Refresh counts via the v1.25.7 RPC (single SQL statement)
//   2. Read policy thresholds (1 RT)
//   3. Read all reliability rows for the user (1 RT)
//   4. Compute new tier per row IN MEMORY using existing computeTier()
//   5. Bulk-write changed tiers via chunked UPDATEs (Promise.all'd, chunk=50)
//   6. Batch-insert pattern_alerts for transitions (1 RT for names + 1 RT for insert)
//
// The per-patient path (recomputeReliabilityForPatient, called from
// updateAppointmentStatus on per-status flips) is unchanged — single
// patient calls don't have scale issues. Coexists.

export async function recomputeReliabilityForUser(args: {
  sb: SupabaseAdmin;
  userId: string;
  // v1.26.10 — distinguishes cron sweep from manual button click in the
  // reliability_runs log. Defaults to 'manual' so legacy callers that
  // don't pass it (none in tree today) get the safer label.
  trigger?: "cron" | "manual";
}): Promise<{
  patientsRecomputed: number;
  transitions: number;
  completedAt: string;
}> {
  const { sb, userId, trigger = "manual" } = args;

  // v2.50.0: when the spa has opted the no-show rule INTO reliability scoring,
  // the raw-status SQL RPC (Step 1) would under-count — a late cancel must also
  // count as a no-show, and a grace credit must NOT be spent on it. The RPC
  // can't see the notice-window rule, so the nightly sweep would silently
  // CLOBBER the rule-aware counts the per-status trigger path writes. To keep
  // ONE source of truth (the canonical classifier) and guarantee the sweep
  // agrees with the trigger path byte-for-byte, opted-in spas recompute via
  // recomputeReliabilityForPatient per patient. The default path (rule off)
  // keeps the fast RPC below, untouched — zero behavior change.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const looseRule = sb as unknown as { from(t: string): any };
  const { data: rulePolicy } = await looseRule
    .from("noshow_policies")
    .select("noshow_rule_applies_reliability")
    .eq("user_id", userId)
    .maybeSingle();
  if (rulePolicy?.noshow_rule_applies_reliability === true) {
    return recomputeReliabilityRuleAware({ sb, userId, trigger });
  }

  // Step 0 (v1.26.11): snapshot patient_node_ids that ALREADY have a
  // reliability row before the RPC runs. Anything NOT in this set is being
  // tiered for the first time — that's an initial assignment, not a
  // transition, and should not fire a promotion alert.
  //
  // composeAlert() already short-circuits when fromTier === null (line ~162),
  // but the bulk path can't surface a null fromTier: the RPC at step 1
  // INSERT … ON CONFLICTs new rows with the column default tier='trusted',
  // step 3 reads them back as 'trusted', and step 4's diff sees
  // 'trusted' → 'vip' (or whatever) — looking like a real promotion. Result
  // pre-v1.26.11: every brand-new patient on a tenant's first-ever sweep got
  // a fake "promotion" alert. Karen's first sweep produced 200 of these in
  // one batch — pure noise, no signal.
  //
  // This snapshot is the missing context: if the patient_node_id isn't in
  // `priorPatientIds`, suppress the alert at step 6.
  const { data: priorRows } = await sb
    .from("reliability_status")
    .select("patient_node_id")
    .eq("user_id", userId);
  const priorPatientIds = new Set(
    (priorRows ?? []).map((r) => r.patient_node_id),
  );

  // Step 1: Refresh counts (no_shows_6mo, cancellations_6mo, no_shows_lifetime,
  // cancellations_lifetime, total_visits) via the v1.25.7 RPC. Single SQL
  // statement; handles new rows via INSERT ... ON CONFLICT.
  const { error: rpcErr } = await sb.rpc("refill_recompute_reliability_counts", {
    p_user_id: userId,
  });
  if (rpcErr) {
    throw new Error(`Couldn't refresh reliability counts: ${rpcErr.message}`);
  }

  // Step 2: Load policy thresholds (or use defaults).
  const { data: policy } = await sb
    .from("noshow_policies")
    .select("reliability_tier_thresholds")
    .eq("user_id", userId)
    .maybeSingle();
  const thresholds = readThresholds(
    policy?.reliability_tier_thresholds ?? null,
  );

  // Step 3: Read all reliability rows back. Counts are now fresh from step 1.
  const { data: rows, error: readErr } = await sb
    .from("reliability_status")
    .select("patient_node_id, tier, no_shows_6mo, total_visits")
    .eq("user_id", userId);
  if (readErr) {
    throw new Error(`Couldn't read reliability rows: ${readErr.message}`);
  }

  const all = rows ?? [];

  // v1.26.10 — anchor a single completion timestamp for both the
  // recomputed_at column writes (changed rows) and the runs-log row.
  // Keeps "Last computed" on the freshness card aligned with the
  // recomputed_at stamp that would appear on a tier-changed row.
  const completedAt = new Date().toISOString();

  // Step 4: In-memory tier computation. Diff against current.
  type TierUpdate = {
    patientNodeId: string;
    priorTier: ReliabilityTier;
    newTier: ReliabilityTier;
    noShows6mo: number;
    totalVisits: number;
  };
  const updates: TierUpdate[] = [];
  for (const r of all) {
    const newTier = computeTier(
      { noShows6mo: r.no_shows_6mo, totalVisits: r.total_visits },
      thresholds,
    );
    if (newTier !== r.tier) {
      updates.push({
        patientNodeId: r.patient_node_id,
        priorTier: r.tier as ReliabilityTier,
        newTier,
        noShows6mo: r.no_shows_6mo,
        totalVisits: r.total_visits,
      });
    }
  }

  if (updates.length === 0) {
    await logReliabilityRun(sb, {
      userId,
      completedAt,
      patientsRecomputed: all.length,
      transitions: 0,
      trigger,
    });
    return { patientsRecomputed: all.length, transitions: 0, completedAt };
  }

  // Step 5: Bulk-write tier changes. Chunked UPDATEs (Promise.all'd) keep
  // round trips bounded without exposing a CASE-WHEN bulk-UPDATE SQL shape
  // through supabase-js. Chunk size 50 → ~1 RT per 50 updates.
  const chunkSize = 50;
  for (let i = 0; i < updates.length; i += chunkSize) {
    const chunk = updates.slice(i, i + chunkSize);
    await Promise.all(
      chunk.map((u) =>
        sb
          .from("reliability_status")
          .update({ tier: u.newTier, recomputed_at: completedAt })
          .eq("user_id", userId)
          .eq("patient_node_id", u.patientNodeId),
      ),
    );
  }

  // Step 6: Fire pattern_alerts for transitions. composeAlert() returns null
  // for non-meaningful transitions (e.g. trusted → trusted equivalence,
  // initial assignment); filter those out. Batch insert.
  //
  // v1.26.11 — also drop updates whose patient was NOT in the pre-RPC
  // snapshot. Those are first-time tier assignments dressed up as
  // 'trusted → X' transitions by the ON CONFLICT INSERT default. Real
  // transitions (a known patient crossing a threshold) stay in.
  const realTransitions = updates.filter((u) =>
    priorPatientIds.has(u.patientNodeId),
  );
  const patientIds = realTransitions.map((u) => u.patientNodeId);
  const { data: patients } = await sb
    .from("knowledge_nodes")
    .select("id, title")
    .in("id", patientIds);
  const nameById = new Map(
    (patients ?? []).map((p) => [p.id, p.title as string | null]),
  );

  const alertRows = realTransitions
    .map((u) => {
      const alert = composeAlert({
        fromTier: u.priorTier,
        toTier: u.newTier,
        patientName: nameById.get(u.patientNodeId) ?? null,
        noShows6mo: u.noShows6mo,
        totalVisits: u.totalVisits,
      });
      if (!alert) return null;
      return {
        user_id: userId,
        patient_node_id: u.patientNodeId,
        kind: alert.kind,
        from_tier: u.priorTier,
        to_tier: u.newTier,
        headline: alert.headline,
        body: alert.body,
      };
    })
    .filter((a): a is NonNullable<typeof a> => a !== null);

  if (alertRows.length > 0) {
    const { error: alertErr } = await sb
      .from("pattern_alerts")
      .insert(alertRows);
    if (alertErr) {
      console.error("pattern_alerts batch insert failed:", alertErr.message);
    }
  }

  // v1.26.10 — persist the sweep result so the freshness card can show
  // it after the toast fades + after a page reload.
  await logReliabilityRun(sb, {
    userId,
    completedAt,
    patientsRecomputed: all.length,
    transitions: alertRows.length,
    trigger,
  });

  return {
    patientsRecomputed: all.length,
    transitions: alertRows.length,
    completedAt,
  };
}

// v2.50.0 — rule-aware bulk recompute for spas that opted the no-show rule into
// reliability scoring. Delegates to recomputeReliabilityForPatient (the same
// rule-aware path the status trigger uses) for every patient, so the nightly
// sweep produces identical counts/tier/grace to the live trigger — no clobber,
// one source of truth. recomputeReliabilityForPatient handles its own
// transition alerts and naturally suppresses first-time assignments (prior tier
// is genuinely null for a never-tiered patient), so this path sidesteps the
// RPC path's fake-promotion hazard entirely. Sequential by design: per-patient
// recompute is several DB round-trips each, and correctness beats wall-clock on
// a nightly cron that only opted-in spas take.
async function recomputeReliabilityRuleAware(args: {
  sb: SupabaseAdmin;
  userId: string;
  trigger: "cron" | "manual";
}): Promise<{ patientsRecomputed: number; transitions: number; completedAt: string }> {
  const { sb, userId, trigger } = args;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const looseSb = sb as unknown as { from(t: string): any };
  // Collect the COMPLETE distinct patient set by paging through appointment
  // rows. A single .select() is silently capped at PostgREST's 1000-row
  // default — a spa with thousands of appointments would only surface the
  // patients in the first page, leaving the rest stale (the v2.52.0 bug a real
  // sweep on Rejuv exposed: 695 patients, but only 174 recomputed). Page until
  // a short page signals the end.
  const idSet = new Set<string>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await looseSb
      .from("appointments")
      .select("patient_node_id")
      .eq("user_id", userId)
      .not("patient_node_id", "is", null)
      .range(from, from + PAGE - 1);
    if (error) {
      console.error("[reliability-sweep] patient page failed:", error.message);
      break;
    }
    const rows = (data ?? []) as Array<{ patient_node_id: string | null }>;
    for (const r of rows) if (r.patient_node_id) idSet.add(r.patient_node_id);
    if (rows.length < PAGE) break;
  }
  const ids = [...idSet];

  let transitions = 0;
  for (const patientNodeId of ids) {
    try {
      const r = await recomputeReliabilityForPatient({ sb, userId, patientNodeId });
      if (r.transitioned) transitions++;
    } catch (e) {
      console.error(
        "[reliability-sweep] rule-aware per-patient recompute failed:",
        e instanceof Error ? e.message : e,
      );
    }
  }

  const completedAt = new Date().toISOString();
  await logReliabilityRun(sb, {
    userId,
    completedAt,
    patientsRecomputed: ids.length,
    transitions,
    trigger,
  });
  return { patientsRecomputed: ids.length, transitions, completedAt };
}

// v1.26.10 — best-effort insert into the runs log. A failure here is
// observability data loss only; the sweep itself succeeded, so we
// console.error rather than throw (matches the pattern_alerts insert
// posture above).
async function logReliabilityRun(
  sb: SupabaseAdmin,
  row: {
    userId: string;
    completedAt: string;
    patientsRecomputed: number;
    transitions: number;
    trigger: "cron" | "manual";
  },
): Promise<void> {
  const { error } = await sb.from("reliability_runs").insert({
    user_id: row.userId,
    completed_at: row.completedAt,
    patients_recomputed: row.patientsRecomputed,
    transitions: row.transitions,
    trigger: row.trigger,
  });
  if (error) {
    console.error("reliability_runs insert failed:", error.message);
  }
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
  viewAsUserId: z.string().uuid().optional(),
});

const cardInput = z.object({
  accessToken: z.string().min(1),
  patientNodeId: z.string().uuid(),
  viewAsUserId: z.string().uuid().optional(),
});

// v1.26.9 — observability + manual recompute lever.
const freshnessInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
});
const recomputeNowInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
});

export type ReliabilityFreshness = {
  latestRecomputedAt: string | null;
  patientsTracked: number;
  // v1.26.10 — persisted result of the most recent sweep. Null when
  // no run has been logged yet for this tenant (first deploy after
  // the runs-table migration; cleared tenants; etc.).
  lastRun: {
    completedAt: string;
    patientsRecomputed: number;
    transitions: number;
    trigger: "cron" | "manual";
  } | null;
};

export type RecomputeNowResult = {
  patientsRecomputed: number;
  transitions: number;
  completedAt: string;
};

export const listPatternAlerts = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => listInput.parse(input))
  .handler(async ({ data }): Promise<PatternAlert[]> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();

    let query = sb
      .from("pattern_alerts")
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
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();

    await sb
      .from("pattern_alerts")
      .update({
        dismissed_at: new Date().toISOString(),
        dismissed_by: effectiveUserId,
      })
      .eq("id", data.alertId)
      .eq("user_id", effectiveUserId)
      .is("dismissed_at", null);
    return { ok: true };
  });

export const getReliabilityCard = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => cardInput.parse(input))
  .handler(async ({ data }): Promise<ReliabilityCard | null> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();

    const { data: row } = await sb
      .from("reliability_status")
      .select(
        "tier, no_shows_6mo, total_visits, cancellations_6mo, grace_credits_used, last_activity_at, recomputed_at",
      )
      .eq("user_id", effectiveUserId)
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
// inside EITHER the rolling 6-month window or the patient's lifetime.
// Powers the A-list rules page's "exclude cancellation history" toggle
// (the toggle still excludes either signal — labeled "cancellation history"
// because in real data the cancel:no-show ratio runs ~85:1, per v1.26.2).
// Fetched once at mount, joined into matchesRules() client-side.
//
// v1.26.4: lifetime counts (no_shows_lifetime + cancellations_lifetime)
// are now materialized on reliability_status alongside the 6mo
// columns, so this returns both. Surface chose to expose lifetime in the
// toggle description so Karen sees the full history alongside the rolling
// window. The rule itself still filters on the 6mo window today — switching
// to a lifetime filter is a separate UX decision (see project_emma_noshow_
// recovery_engine).

const flagsInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
});

export type ReliabilityFlag = {
  patientNodeId: string;
  noShows6mo: number;
  cancellations6mo: number;
  noShowsLifetime: number;
  cancellationsLifetime: number;
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
      .from("reliability_status")
      .select(
        "patient_node_id, no_shows_6mo, cancellations_6mo, no_shows_lifetime, cancellations_lifetime",
      )
      .eq("user_id", effectiveUserId)
      .or(
        "no_shows_6mo.gt.0,cancellations_6mo.gt.0,no_shows_lifetime.gt.0,cancellations_lifetime.gt.0",
      );
    if (error) {
      throw new Error(`Couldn't load reliability flags: ${error.message}`);
    }
    return (rows ?? []).map((r) => ({
      patientNodeId: r.patient_node_id,
      noShows6mo: r.no_shows_6mo,
      cancellations6mo: r.cancellations_6mo,
      noShowsLifetime: r.no_shows_lifetime,
      cancellationsLifetime: r.cancellations_lifetime,
    }));
  });

// ─── getReliabilityFreshness + recomputeReliabilityNow (v1.26.9) ──────────
//
// Observability + manual lever. The cron at 02:00 UTC daily recomputes
// tiers across all spas; tier transitions emit pattern_alerts. But after
// a bulk Acuity ingest the counts refresh instantly (v1.25.7 RPC) while
// tier stays on whatever the cron last computed — for fresh data that's
// "trusted" by default for new patients, and otherwise the stale tier
// from the prior day. Freshness surface shows lag; manual button forces
// an immediate sweep.

export const getReliabilityFreshness = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => freshnessInput.parse(input))
  .handler(async ({ data }): Promise<ReliabilityFreshness> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();

    // v1.26.10 — three queries in parallel:
    //   1. patientsTracked: count of rows in reliability_status
    //   2. lastRun: most recent reliability_runs row (post-v1.26.10)
    //   3. latestRecomputedAtFallback: max(recomputed_at) — used only when
    //      no runs row exists yet (covers the gap between migration deploy
    //      and the first sweep that writes to the runs log).
    const [{ count }, { data: lastRunRow }, { data: latestFallbackRow }] =
      await Promise.all([
        sb
          .from("reliability_status")
          .select("id", { count: "exact", head: true })
          .eq("user_id", effectiveUserId),
        sb
          .from("reliability_runs")
          .select("completed_at, patients_recomputed, transitions, trigger")
          .eq("user_id", effectiveUserId)
          .order("completed_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        sb
          .from("reliability_status")
          .select("recomputed_at")
          .eq("user_id", effectiveUserId)
          .order("recomputed_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

    const lastRun = lastRunRow
      ? {
          completedAt: lastRunRow.completed_at,
          patientsRecomputed: lastRunRow.patients_recomputed,
          transitions: lastRunRow.transitions,
          trigger: lastRunRow.trigger as "cron" | "manual",
        }
      : null;

    return {
      latestRecomputedAt:
        lastRun?.completedAt ?? latestFallbackRow?.recomputed_at ?? null,
      patientsTracked: count ?? 0,
      lastRun,
    };
  });

export const recomputeReliabilityNow = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => recomputeNowInput.parse(input))
  .handler(async ({ data }): Promise<RecomputeNowResult> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    // v1.26.10 — pass through trigger='manual' so the runs log can tell
    // user-initiated sweeps apart from overnight cron sweeps. completedAt
    // is now sourced from the sweep itself (same timestamp written to the
    // runs row + onto recomputed_at on changed rows) instead of a fresh
    // post-sweep Date.now(), which kept drifting a few ms ahead.
    const r = await recomputeReliabilityForUser({
      sb,
      userId: effectiveUserId,
      trigger: "manual",
    });
    return {
      patientsRecomputed: r.patientsRecomputed,
      transitions: r.transitions,
      completedAt: r.completedAt,
    };
  });
