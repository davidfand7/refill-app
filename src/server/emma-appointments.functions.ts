/**
 * Emma(OS) appointment ingestion + management (v360).
 *
 * The data layer the no-show recovery engine reads from. Three surfaces:
 *
 *   ingestAppointmentCsv  — auto-detects PMS dialect (Acuity, Boulevard,
 *                            Mangomint, Vagaro, AestheticsPro, AR, generic)
 *                            and upserts appointments rows. Idempotent
 *                            on (user_id, external_id, source) where
 *                            external_id is present.
 *   listAppointments      — for the /app/refill/appointments UI.
 *   updateAppointmentStatus — manual status flip (the spa marks a no-show
 *                            or showed via the UI). Writes the audit event
 *                            to appointment_status_events.
 *   getNoShowPolicy       — load the spa's noshow policy (auto-creates a
 *                            row with defaults on first read).
 *   updateNoShowPolicy    — merge-patch the policy row.
 *
 * Patient matching: when ingesting CSV rows we try (phone → email →
 * normalized name) against existing knowledge_nodes patients. On match,
 * patient_node_id is set. On no-match we leave it null; the pre-show
 * agent skips null-patient appointments, but the spa owner sees them
 * in the appointments table and can manually link.
 *
 * Established 2026-05-17 (Promotions Engine v360).
 */

import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { admin } from "./admin-client";
import { z } from "zod";

import type { Database, Json } from "@/integrations/supabase/types";
import { resolveEffectiveUserId, verifyAuth } from "@/server/auth-helpers";
import {
  parseAppointmentCsv,
  parseAppointmentCsvWithAliases,
  type AppointmentDialect,
  type ParsedAppointment,
} from "@/lib/appointment-csv";
import { mapCsvHeaders, type AiMappingResult } from "@/server/emma-csv-mapper.functions";
import { parseCsvGrid } from "@/lib/csv-grid";
import {
  nameMatchCandidates,
  normalizeEmail,
  normalizePhone,
  rosterKeyVariants,
} from "@/lib/normalize-patient";

// ─── Public types ─────────────────────────────────────────────────────────

export type AppointmentStatus =
  | "scheduled"
  | "confirmed"
  | "cancelled"
  | "no_show"
  | "showed"
  | "rescheduled";

export type EmmaAppointment = {
  id: string;
  patientNodeId: string | null;
  patientName: string | null;
  patientPhone: string | null;
  patientEmail: string | null;
  scheduledAt: string;
  durationMin: number;
  treatmentType: string | null;
  providerName: string | null;
  status: AppointmentStatus;
  externalId: string | null;
  source: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

export type IngestReceipt = {
  dialect: AppointmentDialect;
  dialectConfidence: "high" | "medium" | "low";
  totalParsed: number;
  inserted: number;
  updated: number;
  skipped: number;
  patientsMatched: number;
  patientsUnmatched: number;
  warnings: { sourceRow: number; reason: string }[];
  /**
   * Present when v368 LLM mapper was used to interpret an unrecognized CSV.
   * The UI shows an AI-mapped badge + the platform name + optional inline
   * mapping editor (so the spa can correct misreads with one edit).
   */
  aiMapping?: {
    platform: string | null;
    fromCache: boolean;
    userCorrected: boolean;
    headerHash: string;
    aliases: Record<string, string[]>;
  };
};

export type NoShowPolicy = {
  preshowEnabled: boolean;
  preshowCadenceHours: number[];
  preshowTone: "warm" | "professional" | "casual";
  preshowChannel: "sms" | "email" | "auto";
  optinFooterEnabled: boolean;
  optinFooterText: string;
  optinListUrl: string | null;
  graceCreditsPer6mo: number;
  rescueEnabled: boolean;
  rescueMaxConcurrent: number;
  rescueOutreachWindowMin: number;
  depositEnabled: boolean;
  depositAmountUsd: number | null;
  depositTrigger: "in_recovery_tier" | "new_patient" | "high_value_treatment" | null;
  depositRefundWindowHours: number;
  reliabilityTierThresholds: Json;
  /**
   * v379 trial-mode: when set, rescue dispatch sends ONE aggregated SMS
   * to this number instead of per-patient SMSes. Null = direct send
   * (production behavior). The spa owner forwards URLs to actual
   * patients manually — or pipes the proxy email into Claude Desktop
   * for iMessage draft automation.
   */
  rescueProxyPhone: string | null;
  /**
   * v379 trial-mode: when set, rescue dispatch sends ONE aggregated
   * email with pre-formatted READY-TO-SEND drafts (one per offer) to
   * this address. Null = no proxy email.
   */
  rescueProxyEmail: string | null;
  // ── Reschedule Reminders (v2.34.0) ──
  /** Master on/off for the Reschedule Reminders agent (also the Skill gate). */
  rescheduleEnabled: boolean;
  /** THE canonical no-show rule: a cancellation with less than this many hours'
   *  notice counts as a no-show. Default 24. */
  noshowNoticeHours: number;
  /** Whether the operator wants to follow up honored cancels. */
  rescheduleTargetCancels: boolean;
  /** Whether the operator wants to follow up no-shows (incl. late cancels). */
  rescheduleTargetNoshows: boolean;
  /** How far back the sweep looks for un-followed-up outcomes (days). */
  rescheduleLookbackDays: number;
  /** Grace window (days): wait this long after a cancel/no-show before a nudge
   *  is eligible, giving the patient time to self-rebook first. 0 = off. */
  rescheduleDelayDays: number;
  /** Opt-in: apply the no-show rule (a late cancel = a no-show) to reliability
   *  scoring too, not just Reschedule Reminders. Default false. */
  noshowRuleAppliesReliability: boolean;
};

// ─── Admin client ─────────────────────────────────────────────────────────

type SupabaseAdmin = ReturnType<typeof admin>;

// ─── Zod ──────────────────────────────────────────────────────────────────

const ingestInput = z.object({
  accessToken: z.string().min(1),
  csv: z.string().min(1),
  sourceFilename: z.string().max(200).optional(),
  // v1.25.5: admin viewing-as opt-in. Without this, the ingest writes
  // appointments to the ADMIN's user_id while the patient index is also
  // built from admin (who has 0 patients) → 100% match failure. See
  // resolveEffectiveUserId in auth-helpers.ts.
  viewAsUserId: z.string().uuid().optional(),
});

const listInput = z.object({
  accessToken: z.string().min(1),
  fromIso: z.string().datetime().optional(),
  toIso: z.string().datetime().optional(),
  // v1.25.5: admin viewing-as opt-in so the appointments list reads
  // the impersonated tenant's bucket, not the admin's empty one.
  viewAsUserId: z.string().uuid().optional(),
});

const statusInput = z.object({
  accessToken: z.string().min(1),
  appointmentId: z.string().uuid(),
  status: z.enum([
    "scheduled",
    "confirmed",
    "cancelled",
    "no_show",
    "showed",
    "rescheduled",
  ]),
  reason: z.string().max(500).optional(),
  viewAsUserId: z.string().uuid().optional(),
});

const policyInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
});

const policyUpdateInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
  patch: z
    .object({
      preshowEnabled: z.boolean().optional(),
      preshowCadenceHours: z.array(z.number().int().min(1).max(168)).optional(),
      preshowTone: z.enum(["warm", "professional", "casual"]).optional(),
      preshowChannel: z.enum(["sms", "email", "auto"]).optional(),
      optinFooterEnabled: z.boolean().optional(),
      optinFooterText: z.string().min(1).max(280).optional(),
      optinListUrl: z.string().url().optional().nullable(),
      graceCreditsPer6mo: z.number().int().min(0).max(20).optional(),
      rescueEnabled: z.boolean().optional(),
      rescueMaxConcurrent: z.number().int().min(1).max(50).optional(),
      rescueOutreachWindowMin: z.number().int().min(5).max(720).optional(),
      depositEnabled: z.boolean().optional(),
      depositAmountUsd: z.number().min(0).max(1000).optional().nullable(),
      depositTrigger: z
        .enum(["in_recovery_tier", "new_patient", "high_value_treatment"])
        .optional()
        .nullable(),
      depositRefundWindowHours: z.number().int().min(1).max(168).optional(),
      rescueProxyPhone: z.string().max(40).optional().nullable(),
      rescueProxyEmail: z.string().email().max(200).optional().nullable(),
      // Reschedule Reminders (v2.34.0)
      rescheduleEnabled: z.boolean().optional(),
      noshowNoticeHours: z.number().int().min(0).max(336).optional(),
      rescheduleTargetCancels: z.boolean().optional(),
      rescheduleTargetNoshows: z.boolean().optional(),
      rescheduleLookbackDays: z.number().int().min(1).max(90).optional(),
      rescheduleDelayDays: z.number().int().min(0).max(60).optional(),
      noshowRuleAppliesReliability: z.boolean().optional(),
    })
    .strict(),
});

// ─── Helpers ──────────────────────────────────────────────────────────────

function hydrateAppointment(row: {
  id: string;
  user_id: string;
  patient_node_id: string | null;
  scheduled_at: string;
  duration_min: number;
  treatment_type: string | null;
  provider_name: string | null;
  status: string;
  external_id: string | null;
  source: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
  patient_name?: string | null;
  patient_phone?: string | null;
  patient_email?: string | null;
}): EmmaAppointment {
  return {
    id: row.id,
    patientNodeId: row.patient_node_id,
    patientName: row.patient_name ?? null,
    patientPhone: row.patient_phone ?? null,
    patientEmail: row.patient_email ?? null,
    scheduledAt: row.scheduled_at,
    durationMin: row.duration_min,
    treatmentType: row.treatment_type,
    providerName: row.provider_name,
    status: row.status as AppointmentStatus,
    externalId: row.external_id,
    source: row.source,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * v372.2: in-memory patient index built once per ingest. Replaces the
 * v360 per-row matchPatient that did 3 DB queries × 1000-row-pull-and-
 * filter PER appointment — at 911 appointments × 3 queries × 1000 rows
 * = ~2.7M rows over the wire, blowing past the Cloudflare Workers 30s
 * CPU timeout. Index approach: single fetch of all patient nodes for
 * userId, build hash maps by phone/email/lookup_key, match each
 * appointment with pure in-memory lookups.
 *
 * v378: keys are normalized through @/lib/normalize-patient so the
 * ingest side and the patient roster produce identical comparable
 * keys. Suffix-stripped name variants are also indexed (when they don't
 * collide with another patient), so "Johnson Jr" on one side and
 * "Johnson" on the other resolve. Phone is digits-only on both sides;
 * email is trim+lower on both sides.
 */
export type PatientIndex = {
  byPhone: Map<string, string>;
  byEmail: Map<string, string>;
  byNameKey: Map<string, string>;
  /** Track stripped-variant collisions so we don't bind ambiguous keys —
   *  two patients sharing a stripped name (e.g. Robert Johnson Jr and
   *  Robert Johnson Sr) would otherwise become indistinguishable, which
   *  is a worse failure than the existing miss. */
  strippedCollisions: Set<string>;
};

/** v381.5: minimal patient-identifier shape — anything with these four
 *  fields can be passed to matchPatientFromIndex. ParsedAppointment is
 *  a superset and remains compatible; live API ingest paths (Acuity
 *  webhook, OAuth backfill) construct this directly. */
export type PatientIdentifiers = {
  patientFirstName: string | null;
  patientLastName: string | null;
  patientPhone: string | null;
  patientEmail: string | null;
};

export async function buildPatientIndex(
  sb: SupabaseClient<Database>,
  userId: string,
): Promise<PatientIndex> {
  const byPhone = new Map<string, string>();
  const byEmail = new Map<string, string>();
  const byNameKey = new Map<string, string>();
  const strippedCollisions = new Set<string>();

  // Single bounded fetch — covers 10K patients which is well past any
  // realistic single-location spa (Rejuv has ~1,126; multi-location
  // chains typically <5K). If a customer ever exceeds 10K we'll
  // paginate.
  const { data } = await sb
    .from("knowledge_nodes")
    .select("id, lookup_key, attachments")
    .eq("user_id", userId)
    .eq("node_type", "patient")
    .eq("context", "patients")
    .limit(10000);

  for (const node of data ?? []) {
    const a = node.attachments as { phone?: string; email?: string } | null;
    const normPhone = normalizePhone(a?.phone);
    if (normPhone) byPhone.set(normPhone, node.id);
    const normEmail = normalizeEmail(a?.email);
    if (normEmail) byEmail.set(normEmail, node.id);

    if (node.lookup_key) {
      // Original lookup_key wins on collision — it's the canonical row
      // and existing data already references it. Stripped variants only
      // populate when they don't collide with anything.
      const variants = rosterKeyVariants(node.lookup_key);
      const original = variants[0];
      if (original && !byNameKey.has(original)) {
        byNameKey.set(original, node.id);
      }
      for (let i = 1; i < variants.length; i++) {
        const v = variants[i];
        if (!v) continue;
        if (strippedCollisions.has(v)) continue;
        if (byNameKey.has(v) && byNameKey.get(v) !== node.id) {
          // Two patients share this stripped key — burn it so neither
          // gets a false-positive match.
          strippedCollisions.add(v);
          byNameKey.delete(v);
        } else {
          byNameKey.set(v, node.id);
        }
      }
    }
  }

  return { byPhone, byEmail, byNameKey, strippedCollisions };
}

/**
 * Match a parsed appointment to an existing patient knowledge_node.
 * Match strategy (precision-first cascade):
 *   1. phone (digits-only, US country-code stripped)
 *   2. email (trim+lowercase)
 *   3. name candidates from nameMatchCandidates — ordered last-first,
 *      first-last, last-first-suffix-stripped, first-last-suffix-stripped
 *
 * First hit wins. Returns null when every candidate misses.
 */
export function matchPatientFromIndex(
  parsed: PatientIdentifiers,
  index: PatientIndex,
): string | null {
  const phone = normalizePhone(parsed.patientPhone);
  if (phone) {
    const id = index.byPhone.get(phone);
    if (id) return id;
  }
  const email = normalizeEmail(parsed.patientEmail);
  if (email) {
    const id = index.byEmail.get(email);
    if (id) return id;
  }
  for (const candidate of nameMatchCandidates(
    parsed.patientFirstName,
    parsed.patientLastName,
  )) {
    const id = index.byNameKey.get(candidate);
    if (id) return id;
  }
  return null;
}

const POLICY_DEFAULTS: NoShowPolicy = {
  preshowEnabled: true,
  preshowCadenceHours: [48, 24, 3],
  preshowTone: "warm",
  preshowChannel: "auto",
  optinFooterEnabled: true,
  optinFooterText: "Want first dibs on last-minute openings?",
  optinListUrl: null,
  graceCreditsPer6mo: 2,
  rescueEnabled: false,
  rescueMaxConcurrent: 5,
  rescueOutreachWindowMin: 90,
  depositEnabled: false,
  depositAmountUsd: null,
  depositTrigger: null,
  depositRefundWindowHours: 24,
  reliabilityTierThresholds: {
    trusted_max_noshows: 0,
    regular_min_visits: 3,
    vip_min_visits: 12,
    in_recovery_threshold: 3,
    in_recovery_window_months: 6,
  } as Json,
  rescueProxyPhone: null,
  rescueProxyEmail: null,
  rescheduleEnabled: false,
  noshowNoticeHours: 24,
  rescheduleTargetCancels: true,
  rescheduleTargetNoshows: true,
  rescheduleLookbackDays: 14,
  rescheduleDelayDays: 0,
  noshowRuleAppliesReliability: false,
};

function rowToPolicy(
  row: Database["public"]["Tables"]["noshow_policies"]["Row"],
): NoShowPolicy {
  return {
    preshowEnabled: row.preshow_enabled,
    preshowCadenceHours: row.preshow_cadence_hours,
    preshowTone: row.preshow_tone as NoShowPolicy["preshowTone"],
    preshowChannel: row.preshow_channel as NoShowPolicy["preshowChannel"],
    optinFooterEnabled: row.optin_footer_enabled,
    optinFooterText: row.optin_footer_text,
    optinListUrl: row.optin_list_url,
    graceCreditsPer6mo: row.grace_credits_per_6mo,
    rescueEnabled: row.rescue_enabled,
    rescueMaxConcurrent: row.rescue_max_concurrent,
    rescueOutreachWindowMin: row.rescue_outreach_window_min,
    depositEnabled: row.deposit_enabled,
    depositAmountUsd: row.deposit_amount_usd ? Number(row.deposit_amount_usd) : null,
    depositTrigger: row.deposit_trigger as NoShowPolicy["depositTrigger"],
    depositRefundWindowHours: row.deposit_refund_window_hours,
    reliabilityTierThresholds: row.reliability_tier_thresholds,
    rescueProxyPhone: row.rescue_proxy_phone,
    rescueProxyEmail: row.rescue_proxy_email,
    // v2.34.0 columns aren't in generated types yet — read via a loose view
    // (same posture as the skills tables) with defaults for a not-yet-migrated row.
    ...(() => {
      const r = row as unknown as {
        reschedule_enabled?: boolean | null;
        noshow_notice_hours?: number | null;
        reschedule_target_cancels?: boolean | null;
        reschedule_target_noshows?: boolean | null;
        reschedule_lookback_days?: number | null;
        reschedule_delay_days?: number | null;
        noshow_rule_applies_reliability?: boolean | null;
      };
      return {
        rescheduleEnabled: r.reschedule_enabled ?? false,
        noshowNoticeHours: r.noshow_notice_hours ?? 24,
        rescheduleTargetCancels: r.reschedule_target_cancels ?? true,
        rescheduleTargetNoshows: r.reschedule_target_noshows ?? true,
        rescheduleLookbackDays: r.reschedule_lookback_days ?? 14,
        rescheduleDelayDays: r.reschedule_delay_days ?? 0,
        noshowRuleAppliesReliability: r.noshow_rule_applies_reliability ?? false,
      };
    })(),
  };
}

// ─── ingestAppointmentCsv ─────────────────────────────────────────────────

export const ingestAppointmentCsv = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => ingestInput.parse(input))
  .handler(async ({ data }): Promise<IngestReceipt> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const userId = effectiveUserId;
    const sb = admin();

    let parsed = parseAppointmentCsv(data.csv);
    let aiMapping: AiMappingResult | null = null;

    // v368: LLM column-mapper fallback. Trigger when the deterministic
    // cascade produced csv-generic AND either no appointments at all
    // (header shape didn't match the fuzzy regexes) OR low confidence.
    // The mapper returns null on any failure so we always have a parse.
    const shouldTryMapper =
      parsed.dialect === "csv-generic" &&
      (parsed.appointments.length === 0 || parsed.dialectConfidence === "low");
    if (shouldTryMapper && parsed.headers.length > 0) {
      const grid = parseCsvGrid(data.csv);
      const sampleRows = grid.slice(1, 4);
      try {
        aiMapping = await mapCsvHeaders(sb, userId, parsed.headers, sampleRows);
      } catch (err) {
        console.warn(
          "[ingestAppointmentCsv] mapper threw (ignored):",
          err instanceof Error ? err.message : err,
        );
        aiMapping = null;
      }
      if (aiMapping) {
        const remapped = parseAppointmentCsvWithAliases(
          data.csv,
          aiMapping.aliases,
        );
        if (remapped.appointments.length > 0) {
          parsed = remapped;
        }
      }
    }

    const receipt: IngestReceipt = {
      dialect: parsed.dialect,
      dialectConfidence: parsed.dialectConfidence,
      totalParsed: parsed.appointments.length,
      inserted: 0,
      updated: 0,
      skipped: 0,
      patientsMatched: 0,
      patientsUnmatched: 0,
      warnings: parsed.warnings,
      aiMapping: aiMapping
        ? {
            platform: aiMapping.platform,
            fromCache: aiMapping.fromCache,
            userCorrected: aiMapping.userCorrected,
            headerHash: aiMapping.headerHash,
            aliases: aiMapping.aliases as Record<string, string[]>,
          }
        : undefined,
    };

    if (parsed.appointments.length === 0) {
      return receipt;
    }

    // v372.2: build patient index ONCE before the loop (single DB query),
    // then match each appointment via in-memory lookups. Replaces the
    // v360 per-row matcher that did 3 round-trips × 1000-row fetches per
    // appointment — at ~900 appointments that blew past Cloudflare
    // Workers' 30s CPU timeout. New approach: 1 query + 900 hash lookups
    // = ~1 second total.
    const patientIndex = await buildPatientIndex(sb, userId);
    const rowsToUpsert: Database["public"]["Tables"]["appointments"]["Insert"][] = [];
    for (const a of parsed.appointments) {
      const patientNodeId = matchPatientFromIndex(a, patientIndex);
      if (patientNodeId) receipt.patientsMatched++;
      else receipt.patientsUnmatched++;

      rowsToUpsert.push({
        user_id: userId,
        patient_node_id: patientNodeId,
        scheduled_at: a.scheduledAt,
        duration_min: a.durationMin,
        treatment_type: a.treatmentType,
        provider_name: a.providerName,
        status: a.status,
        external_id: a.externalId,
        source: parsed.dialect,
        notes: a.notes,
      });
    }

    // Idempotent re-import: upsert on (user_id, external_id, source) when
    // external_id is present. When external_id is null, the unique
    // constraint doesn't apply so we'd duplicate — handle by checking
    // (scheduled_at, treatment_type, patient_node_id) heuristically.
    // For v1 we accept the duplication for null-external_id rows; the
    // appointment list UI lets the owner dedupe manually.

    // Split into rows-with-external-id (upsertable) and rows-without (plain insert).
    const withExternal = rowsToUpsert.filter((r) => r.external_id);
    const withoutExternal = rowsToUpsert.filter((r) => !r.external_id);

    if (withExternal.length > 0) {
      const { data: upserted, error } = await sb
        .from("appointments")
        .upsert(withExternal, {
          onConflict: "user_id,external_id,source",
        })
        .select("id, created_at, updated_at");
      if (error) {
        throw new Error(`Couldn't upsert appointments: ${error.message}`);
      }
      // Heuristic: if created_at == updated_at, it's an insert; otherwise update.
      for (const row of upserted ?? []) {
        if (row.created_at === row.updated_at) receipt.inserted++;
        else receipt.updated++;
      }
    }

    if (withoutExternal.length > 0) {
      const { data: inserted, error } = await sb
        .from("appointments")
        .insert(withoutExternal)
        .select("id");
      if (error) {
        throw new Error(`Couldn't insert appointments: ${error.message}`);
      }
      receipt.inserted += inserted?.length ?? 0;
    }

    // v1.25.7: bulk-ingest reliability sweep — now a single RPC instead
    // of looping recomputeReliabilityForPatient per patient. The v1.25.5
    // implementation timed out on Karen's ~800-patient ingest because
    // each per-patient call did ~3 round trips → 2,400+ RTs total → past
    // the 30s Workers CPU budget. The new RPC computes counts in one SQL
    // statement (CTE + INSERT...ON CONFLICT) and updates only the count
    // columns; tier stays on its existing path (per-row trigger + cron).
    // See migration 20260528010000.
    if (receipt.patientsMatched > 0) {
      try {
        await sb.rpc("refill_recompute_reliability_counts", {
          p_user_id: userId,
        });
      } catch (e) {
        console.error(
          "post-ingest reliability sweep failed:",
          e instanceof Error ? e.message : e,
        );
      }
    }

    return receipt;
  });

// ─── listAppointments ─────────────────────────────────────────────────────

export const listAppointments = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => listInput.parse(input))
  .handler(async ({ data }): Promise<EmmaAppointment[]> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const userId = effectiveUserId;
    const sb = admin();

    // Default window: from now to +30 days
    const from = data.fromIso ?? new Date().toISOString();
    const to =
      data.toIso ??
      new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    const { data: rows, error } = await sb
      .from("appointments")
      .select(
        "id, user_id, patient_node_id, scheduled_at, duration_min, treatment_type, provider_name, status, external_id, source, notes, created_at, updated_at",
      )
      .eq("user_id", userId)
      .gte("scheduled_at", from)
      .lte("scheduled_at", to)
      .order("scheduled_at", { ascending: true })
      .limit(500);
    if (error) throw new Error(`Couldn't list appointments: ${error.message}`);

    // Hydrate with patient names (one extra round trip for the set of patient_node_ids).
    const patientIds = Array.from(
      new Set(
        (rows ?? [])
          .map((r) => r.patient_node_id)
          .filter((id): id is string => id !== null),
      ),
    );
    const patientById = new Map<
      string,
      { name: string | null; phone: string | null; email: string | null }
    >();
    if (patientIds.length > 0) {
      const { data: patients } = await sb
        .from("knowledge_nodes")
        .select("id, title, attachments")
        .in("id", patientIds);
      for (const p of patients ?? []) {
        const a = p.attachments as { phone?: string; email?: string } | null;
        patientById.set(p.id, {
          name: p.title,
          phone: a?.phone ?? null,
          email: a?.email ?? null,
        });
      }
    }

    return (rows ?? []).map((r) =>
      hydrateAppointment({
        ...r,
        patient_name: r.patient_node_id
          ? patientById.get(r.patient_node_id)?.name ?? null
          : null,
        patient_phone: r.patient_node_id
          ? patientById.get(r.patient_node_id)?.phone ?? null
          : null,
        patient_email: r.patient_node_id
          ? patientById.get(r.patient_node_id)?.email ?? null
          : null,
      }),
    );
  });

// ─── updateAppointmentStatus ──────────────────────────────────────────────

export const updateAppointmentStatus = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => statusInput.parse(input))
  .handler(async ({ data }): Promise<EmmaAppointment> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const userId = effectiveUserId;
    const sb = admin();

    // Read current status for the audit event.
    const { data: existing, error: readErr } = await sb
      .from("appointments")
      .select("*")
      .eq("id", data.appointmentId)
      .eq("user_id", userId)
      .maybeSingle();
    if (readErr) throw new Error(`Couldn't load appointment: ${readErr.message}`);
    if (!existing) throw new Error("Appointment not found.");

    if (existing.status !== data.status) {
      // Audit log first (best-effort — non-blocking if it fails)
      await sb
        .from("appointment_status_events")
        .insert({
          user_id: userId,
          appointment_id: data.appointmentId,
          from_status: existing.status,
          to_status: data.status,
          triggered_by: "spa-owner",
          reason: data.reason ?? null,
        })
        .then(({ error }) => {
          if (error) console.error("audit insert failed:", error.message);
        });
    }

    // v2.34.0: stamp the cancellation moment so Reschedule Reminders can tell a
    // fair-notice cancel from a late one (notice lead-time = scheduled_at −
    // cancelled_at). Clear it when an appointment leaves the cancelled state.
    // cancelled_at isn't in generated types yet → loose-cast the patch.
    const statusPatch: Record<string, unknown> = { status: data.status };
    if (data.status === "cancelled") {
      statusPatch.cancelled_at = new Date().toISOString();
    } else if (existing.status === "cancelled") {
      statusPatch.cancelled_at = null;
    }

    const { data: updated, error: updErr } = await sb
      .from("appointments")
      .update(
        statusPatch as Database["public"]["Tables"]["appointments"]["Update"],
      )
      .eq("id", data.appointmentId)
      .eq("user_id", userId)
      .select("*")
      .single();
    if (updErr || !updated) {
      throw new Error(`Couldn't update status: ${updErr?.message ?? "no row"}`);
    }

    // v361: fire same-day rescue when an appointment flips to
    // cancelled/no_show with a future scheduled_at.
    // v373.3: AWAIT — Workers isolate terminates at response time, so
    // void/fire-and-forget silently drops the dispatcher. Karen waits
    // ~3-5s on the no-show click; acceptable for a load-bearing action.
    if (
      (data.status === "cancelled" || data.status === "no_show") &&
      new Date(updated.scheduled_at).getTime() > Date.now()
    ) {
      try {
        const { dispatchRescueAttempt } = await import(
          "@/server/emma-rescue.functions"
        );
        await dispatchRescueAttempt({
          sb,
          userId,
          appointmentId: data.appointmentId,
        });
      } catch (e) {
        console.error("rescue dispatch failed:", e instanceof Error ? e.message : e);
      }
    }

    // v362: recompute reliability tier whenever a status flip might
    // change it (showed/no_show/cancelled are the load-bearing transitions).
    // v373.3: AWAIT — same Workers isolate-termination bug as the rescue
    // dispatcher above.
    if (
      updated.patient_node_id &&
      ["showed", "no_show", "cancelled"].includes(data.status)
    ) {
      try {
        const { recomputeReliabilityForPatient } = await import(
          "@/server/emma-reliability.functions"
        );
        await recomputeReliabilityForPatient({
          sb,
          userId,
          patientNodeId: updated.patient_node_id,
        });
      } catch (e) {
        console.error(
          "reliability recompute failed:",
          e instanceof Error ? e.message : e,
        );
      }
    }

    return hydrateAppointment(updated);
  });

// ─── linkAppointmentToPatient (v2.177.0) ──────────────────────────────────
// Manually attach an UNMATCHED appointment to a patient — the gap the v360
// ingest doc promised ("the spa owner sees them … and can manually link") but
// never shipped. Until now the only remedy for an unmatched row was re-running
// the whole CSV through the matcher and hoping. This resolves one row inline:
// verify the patient belongs to the tenant, set patient_node_id, recompute the
// patient's reliability (history-derived), and return the appointment hydrated
// with the patient's name so the row flips "Unmatched patient" → the name. Once
// linked, the pre-show + rescue agents stop skipping it on their next sweep.

const linkInput = z.object({
  accessToken: z.string().min(1),
  appointmentId: z.string().uuid(),
  patientNodeId: z.string().uuid(),
  viewAsUserId: z.string().uuid().optional(),
});

export const linkAppointmentToPatient = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => linkInput.parse(input))
  .handler(async ({ data }): Promise<EmmaAppointment> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const userId = effectiveUserId;
    const sb = admin();

    // Ownership check on the patient (+ grab display fields for the return).
    const { data: patient, error: pErr } = await sb
      .from("knowledge_nodes")
      .select("id, title, attachments")
      .eq("id", data.patientNodeId)
      .eq("user_id", userId)
      .maybeSingle();
    if (pErr) throw new Error(`Couldn't load patient: ${pErr.message}`);
    if (!patient) throw new Error("Patient not found.");

    // Set the link (scoped to the tenant's own appointment).
    const { data: updated, error: updErr } = await sb
      .from("appointments")
      .update({
        patient_node_id: data.patientNodeId,
      } as Database["public"]["Tables"]["appointments"]["Update"])
      .eq("id", data.appointmentId)
      .eq("user_id", userId)
      .select("*")
      .single();
    if (updErr || !updated) {
      throw new Error(
        `Couldn't link patient: ${updErr?.message ?? "appointment not found"}`,
      );
    }

    // Reliability is history-derived; a freshly-linked appointment can shift
    // the patient's tier. Best-effort (same isolate-safe await pattern as
    // updateAppointmentStatus).
    try {
      const { recomputeReliabilityForPatient } = await import(
        "@/server/emma-reliability.functions"
      );
      await recomputeReliabilityForPatient({
        sb,
        userId,
        patientNodeId: data.patientNodeId,
      });
    } catch (e) {
      console.error(
        "reliability recompute failed:",
        e instanceof Error ? e.message : e,
      );
    }

    const att = (patient.attachments ?? {}) as { phone?: string | null; email?: string | null };
    return hydrateAppointment({
      ...updated,
      patient_name: patient.title ?? null,
      patient_phone: att.phone ?? null,
      patient_email: att.email ?? null,
    });
  });

// ─── getNoShowPolicy ──────────────────────────────────────────────────────

export const getNoShowPolicy = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => policyInput.parse(input))
  .handler(async ({ data }): Promise<NoShowPolicy> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const userId = effectiveUserId;
    const sb = admin();

    const { data: row, error } = await sb
      .from("noshow_policies")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw new Error(`Couldn't load policy: ${error.message}`);

    if (row) return rowToPolicy(row);

    // First-read: insert defaults so the row exists for future updates.
    const { data: created, error: createErr } = await sb
      .from("noshow_policies")
      .insert({ user_id: userId })
      .select("*")
      .single();
    if (createErr || !created) {
      // Best-effort fallback to in-memory defaults; the next call will retry the insert.
      return POLICY_DEFAULTS;
    }
    return rowToPolicy(created);
  });

// ─── updateNoShowPolicy ───────────────────────────────────────────────────

export const updateNoShowPolicy = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => policyUpdateInput.parse(input))
  .handler(async ({ data }): Promise<NoShowPolicy> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const userId = effectiveUserId;
    const sb = admin();

    const patch: Database["public"]["Tables"]["noshow_policies"]["Update"] = {};
    if (data.patch.preshowEnabled !== undefined)
      patch.preshow_enabled = data.patch.preshowEnabled;
    if (data.patch.preshowCadenceHours !== undefined)
      patch.preshow_cadence_hours = data.patch.preshowCadenceHours;
    if (data.patch.preshowTone !== undefined)
      patch.preshow_tone = data.patch.preshowTone;
    if (data.patch.preshowChannel !== undefined)
      patch.preshow_channel = data.patch.preshowChannel;
    if (data.patch.optinFooterEnabled !== undefined)
      patch.optin_footer_enabled = data.patch.optinFooterEnabled;
    if (data.patch.optinFooterText !== undefined)
      patch.optin_footer_text = data.patch.optinFooterText;
    if (data.patch.optinListUrl !== undefined)
      patch.optin_list_url = data.patch.optinListUrl;
    if (data.patch.graceCreditsPer6mo !== undefined)
      patch.grace_credits_per_6mo = data.patch.graceCreditsPer6mo;
    if (data.patch.rescueEnabled !== undefined)
      patch.rescue_enabled = data.patch.rescueEnabled;
    if (data.patch.rescueMaxConcurrent !== undefined)
      patch.rescue_max_concurrent = data.patch.rescueMaxConcurrent;
    if (data.patch.rescueOutreachWindowMin !== undefined)
      patch.rescue_outreach_window_min = data.patch.rescueOutreachWindowMin;
    if (data.patch.depositEnabled !== undefined)
      patch.deposit_enabled = data.patch.depositEnabled;
    if (data.patch.depositAmountUsd !== undefined)
      patch.deposit_amount_usd = data.patch.depositAmountUsd;
    if (data.patch.depositTrigger !== undefined)
      patch.deposit_trigger = data.patch.depositTrigger;
    if (data.patch.depositRefundWindowHours !== undefined)
      patch.deposit_refund_window_hours = data.patch.depositRefundWindowHours;
    if (data.patch.rescueProxyPhone !== undefined)
      patch.rescue_proxy_phone = data.patch.rescueProxyPhone;
    if (data.patch.rescueProxyEmail !== undefined)
      patch.rescue_proxy_email = data.patch.rescueProxyEmail;

    // v2.34.0 Reschedule Reminders columns — not in generated types yet, so
    // collected in a loose patch and merged at the upsert (loose-cast there).
    const extPatch: Record<string, unknown> = {};
    if (data.patch.rescheduleEnabled !== undefined)
      extPatch.reschedule_enabled = data.patch.rescheduleEnabled;
    if (data.patch.noshowNoticeHours !== undefined)
      extPatch.noshow_notice_hours = data.patch.noshowNoticeHours;
    if (data.patch.rescheduleTargetCancels !== undefined)
      extPatch.reschedule_target_cancels = data.patch.rescheduleTargetCancels;
    if (data.patch.rescheduleTargetNoshows !== undefined)
      extPatch.reschedule_target_noshows = data.patch.rescheduleTargetNoshows;
    if (data.patch.rescheduleLookbackDays !== undefined)
      extPatch.reschedule_lookback_days = data.patch.rescheduleLookbackDays;
    if (data.patch.rescheduleDelayDays !== undefined)
      extPatch.reschedule_delay_days = data.patch.rescheduleDelayDays;
    if (data.patch.noshowRuleAppliesReliability !== undefined)
      extPatch.noshow_rule_applies_reliability = data.patch.noshowRuleAppliesReliability;

    if (Object.keys(patch).length === 0 && Object.keys(extPatch).length === 0) {
      throw new Error("Nothing to update.");
    }

    // Upsert: ensures the row exists for first-time updaters.
    const { data: updated, error } = await sb
      .from("noshow_policies")
      .upsert(
        { user_id: userId, ...patch, ...extPatch } as unknown as Database["public"]["Tables"]["noshow_policies"]["Insert"],
        { onConflict: "user_id" },
      )
      .select("*")
      .single();
    if (error || !updated) {
      throw new Error(`Couldn't update policy: ${error?.message ?? "no row"}`);
    }

    return rowToPolicy(updated);
  });

// ─── getAppointmentMatchCoverage (v378) ───────────────────────────────────

export type AppointmentMatchCoverage = {
  total: number;
  matched: number;
  unmatched: number;
  futureTotal: number;
  futureMatched: number;
  futureUnmatched: number;
};

/**
 * Read-only coverage stat for the appointments page (v378). Surfaces how
 * many ingested appointments resolved to a patient_node_id vs. how many
 * are orphaned. Splits all-time vs. future-only because future-only is
 * the actionable number (past unmatched appointments can't be reminded
 * or rescued; they're already over).
 *
 * Powers the &quot;X future appointments aren't linked&quot; banner on the
 * appointments page — the screenshot-grade visibility for the v378
 * normalizer lift. Re-uploading the source CSV after deploy reruns the
 * matcher; this stat is what makes the before/after legible.
 */
export const getAppointmentMatchCoverage = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        accessToken: z.string().min(1),
        viewAsUserId: z.string().uuid().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<AppointmentMatchCoverage> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const userId = effectiveUserId;
    const sb = admin();

    const nowIso = new Date().toISOString();

    const [allRes, allMatchedRes, futureRes, futureMatchedRes] =
      await Promise.all([
        sb
          .from("appointments")
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId),
        sb
          .from("appointments")
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId)
          .not("patient_node_id", "is", null),
        sb
          .from("appointments")
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId)
          .gte("scheduled_at", nowIso),
        sb
          .from("appointments")
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId)
          .gte("scheduled_at", nowIso)
          .not("patient_node_id", "is", null),
      ]);

    const total = allRes.count ?? 0;
    const matched = allMatchedRes.count ?? 0;
    const futureTotal = futureRes.count ?? 0;
    const futureMatched = futureMatchedRes.count ?? 0;

    return {
      total,
      matched,
      unmatched: total - matched,
      futureTotal,
      futureMatched,
      futureUnmatched: futureTotal - futureMatched,
    };
  });
