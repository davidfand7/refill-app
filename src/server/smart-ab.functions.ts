/**
 * Smart-A/B server fns (v2.95) — create an experiment, read its verdict, record
 * outcomes. The bandit math lives in src/lib/smart-ab.ts (pure + tested); this
 * file owns persistence against the shared offers table + offer_experiments.
 *
 * An experiment is N arm rows in manufacturer_promo_offers (source='spa') that
 * share an experiment_id. The arms differ only in their TERMS (the variants —
 * "20% off" vs "$50 off"); their targeting (service, cohort, schedule) is
 * shared so the only variable a patient experiences is the offer itself. The
 * winner is decided by real bookings (ab_conversions ÷ ab_impressions), called
 * by the Thompson-sampling bandit — the impartial arbiter.
 *
 * This ship is the engine CORE: data model + bandit + the create/verdict/record
 * API. Wiring assignment into the push path + the verdict UI is the next slice.
 */

import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import { admin } from "./admin-client";
import type { Database } from "@/integrations/supabase/types";
import { getTenantIdForUser, resolveEffectiveUserId, requireAdmin } from "@/server/auth-helpers";
import { fetchAllRows } from "@/server/paginate";
import { normalizeForMatch } from "@/lib/promo-calendar";
import {
  listOfferCohortTargets,
  composeOfferPushBody,
  firstNameOf,
  escHtml,
} from "@/server/refill-promo-calendar.functions";
import { resolveSpaName } from "@/server/emma-spa-profile";
import { tenantBooksOnExternalPms } from "@/server/scheduling-settings.functions";
import { postResendEmail } from "@/server/resend-send";
import {
  computeVerdict,
  thompsonPickArm,
  mulberry32,
  type AbArm,
  type AbVerdict,
} from "@/lib/smart-ab";

type AnySb = ReturnType<typeof createClient<Database>>;

function offersTbl(sb: AnySb) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (sb as unknown as { from(t: string): any }).from("manufacturer_promo_offers");
}
function experimentsTbl(sb: AnySb) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (sb as unknown as { from(t: string): any }).from("offer_experiments");
}
function assignmentsTbl(sb: AnySb) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (sb as unknown as { from(t: string): any }).from("offer_experiment_assignments");
}

const VARIANT_TYPES = ["dollars_off", "percent_off", "free_addon", "discount_addon"] as const;

/** One arm's varying terms — what the bandit is testing. */
const variantSchema = z.object({
  offerType: z.enum(VARIANT_TYPES).default("dollars_off"),
  discountUsd: z.number().positive().max(100000).nullable().optional(),
  valuePct: z.number().positive().max(100).nullable().optional(),
  addonLabel: z.string().max(160).nullable().optional(),
  /** Short label for the verdict UI; auto-derived if omitted. */
  label: z.string().max(120).optional(),
});

function variantLabel(v: z.infer<typeof variantSchema>): string {
  if (v.label?.trim()) return v.label.trim();
  switch (v.offerType) {
    case "percent_off":
      return v.valuePct != null ? `${v.valuePct}% off` : "% off";
    case "free_addon":
      return v.addonLabel ? `Free ${v.addonLabel}` : "Free add-on";
    case "discount_addon":
      return v.discountUsd != null
        ? `$${Math.round(v.discountUsd)} off ${v.addonLabel ?? "add-on"}`
        : "Add-on offer";
    case "dollars_off":
    default:
      return v.discountUsd != null ? `$${Math.round(v.discountUsd)} off` : "$ off";
  }
}

const createInput = z.object({
  accessToken: z.string(),
  viewAsUserId: z.string().optional(),
  /** Shared trigger service all arms apply to. */
  serviceName: z.string().min(1).max(160),
  /** Shared targeting (the only variable a patient sees is the offer terms). */
  targetCohort: z.enum(["all", "lapsed", "new", "expiring", "vip", "waitlist"]).default("all"),
  activeWeekdays: z.array(z.number().int().min(0).max(6)).max(7).nullable().optional(),
  quantityCap: z.number().int().positive().max(100000).nullable().optional(),
  startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  baseLabel: z.string().max(200).optional(),
  /** The variants — at least 2 to be an A/B. */
  variants: z.array(variantSchema).min(2).max(6),
});

export type AbExperimentSummary = {
  experimentId: string;
  baseLabel: string | null;
  status: "running" | "decided" | "stopped";
  winnerOfferId: string | null;
  createdAt: string;
  /** The shared cohort across arms — 'all' can't be pushed (public badge). */
  targetCohort: string;
  arms: Array<{ offerId: string; label: string }>;
};

export const createAbExperiment = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => createInput.parse(input))
  .handler(async ({ data }): Promise<{ experimentId: string }> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);

    const product = normalizeForMatch(data.serviceName);
    if (!product) throw new Error("Pick a service for this experiment.");

    // Per-variant required-value validation (same rules as a single offer).
    for (const v of data.variants) {
      if (v.offerType === "percent_off" && v.valuePct == null)
        throw new Error(`"${variantLabel(v)}": enter a percentage.`);
      if ((v.offerType === "dollars_off" || v.offerType === "discount_addon") && v.discountUsd == null)
        throw new Error(`"${variantLabel(v)}": enter a dollar amount.`);
      if ((v.offerType === "free_addon" || v.offerType === "discount_addon") && !v.addonLabel?.trim())
        throw new Error(`"${variantLabel(v)}": name the add-on.`);
    }

    const { data: exp, error: expErr } = await experimentsTbl(sb)
      .insert({
        tenant_id: tenantId,
        base_label: data.baseLabel?.trim() || `Test on ${data.serviceName}`,
        status: "running",
      })
      .select("id")
      .single();
    if (expErr || !exp) {
      throw new Error(
        `Couldn't create experiment: ${(expErr as { message?: string } | null)?.message ?? "insert failed"}`,
      );
    }
    const experimentId = exp.id as string;

    const weekdays =
      data.activeWeekdays && data.activeWeekdays.length > 0 ? data.activeWeekdays : null;
    const rows = data.variants.map((v) => {
      const label = variantLabel(v);
      const addonLabel = v.addonLabel?.trim() || null;
      return {
        tenant_id: tenantId,
        source: "spa",
        manufacturer: null,
        product,
        title: label,
        ab_label: label,
        experiment_id: experimentId,
        discount_usd: v.discountUsd ?? null,
        starts_on: data.startsOn ?? null,
        ends_on: data.endsOn ?? null,
        promotion_type: "A/B variant",
        raw_title: data.serviceName,
        offer_type: v.offerType,
        value_pct: v.valuePct ?? null,
        addon_service_name: addonLabel ? normalizeForMatch(addonLabel) : null,
        addon_label: addonLabel,
        is_active: true,
        target_cohort: data.targetCohort,
        active_weekdays: weekdays,
        quantity_cap: data.quantityCap ?? null,
        cap_period: weekdays ? "weekly" : "total",
        cap_period_start: null,
      };
    });
    const { error: armErr } = await offersTbl(sb).insert(rows);
    if (armErr) {
      // Roll back the experiment row so we don't orphan it.
      await experimentsTbl(sb).delete().eq("id", experimentId);
      throw new Error(
        `Couldn't create variants: ${(armErr as { message?: string }).message ?? "insert failed"}`,
      );
    }
    return { experimentId };
  });

type ArmRow = {
  id: string;
  ab_label: string | null;
  title: string;
  ab_impressions: number | string | null;
  ab_conversions: number | string | null;
};

export type AbVerdictResult = {
  experimentId: string;
  status: "running" | "decided" | "stopped";
  winnerOfferId: string | null;
  baseLabel: string | null;
  verdict: AbVerdict;
};

const verdictInput = z.object({
  accessToken: z.string(),
  viewAsUserId: z.string().optional(),
  experimentId: z.string().uuid(),
});

export const getAbVerdict = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => verdictInput.parse(input))
  .handler(async ({ data }): Promise<AbVerdictResult> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);

    const { data: expRow } = await experimentsTbl(sb)
      .select("id, base_label, status, winner_offer_id")
      .eq("id", data.experimentId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (!expRow) throw new Error("Experiment not found.");

    const { data: armRows } = await offersTbl(sb)
      .select("id, ab_label, title, ab_impressions, ab_conversions")
      .eq("tenant_id", tenantId)
      .eq("experiment_id", data.experimentId);
    const arms: AbArm[] = ((armRows as ArmRow[] | null) ?? []).map((r) => ({
      id: r.id,
      label: r.ab_label ?? r.title,
      impressions: r.ab_impressions != null ? Number(r.ab_impressions) : 0,
      conversions: r.ab_conversions != null ? Number(r.ab_conversions) : 0,
    }));

    // Seed the verdict from the experiment id so reads are stable (no jitter).
    const seed = hashSeed(data.experimentId);
    const verdict = computeVerdict(arms, { seed });

    let status = expRow.status as AbVerdictResult["status"];
    let winnerOfferId = (expRow.winner_offer_id as string | null) ?? null;

    // Auto-decide: once the bandit clears the confidence threshold with enough
    // sample, lock the winner + pause the losing arms so everyone converges on
    // the winner. Idempotent — only fires while still 'running'.
    if (status === "running" && verdict.recommendStop && verdict.best) {
      winnerOfferId = verdict.best.id;
      await experimentsTbl(sb)
        .update({ status: "decided", winner_offer_id: winnerOfferId, decided_at: new Date().toISOString() })
        .eq("id", data.experimentId)
        .eq("tenant_id", tenantId);
      // Pause every arm except the winner (they stop badging / sending).
      await offersTbl(sb)
        .update({ is_active: false })
        .eq("tenant_id", tenantId)
        .eq("experiment_id", data.experimentId)
        .neq("id", winnerOfferId);
      status = "decided";
    }

    return {
      experimentId: data.experimentId,
      status,
      winnerOfferId,
      baseLabel: (expRow.base_label as string | null) ?? null,
      verdict,
    };
  });

/** Stable 32-bit seed from a uuid string (so verdict draws are reproducible). */
function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Record an outcome against one arm — an impression (the patient was assigned
// this variant) and, if they booked, a conversion. Atomic RPC bump. This is the
// primitive the push-assignment path + booking attribution call in the next
// slice; exported now so the wiring has a stable seam.
const outcomeInput = z.object({
  accessToken: z.string(),
  viewAsUserId: z.string().optional(),
  offerId: z.string().uuid(),
  conversion: z.boolean().default(false),
});

export const recordAbOutcome = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => outcomeInput.parse(input))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);
    // Scope the bump to an arm this tenant owns.
    const { data: arm } = await offersTbl(sb)
      .select("id")
      .eq("id", data.offerId)
      .eq("tenant_id", tenantId)
      .not("experiment_id", "is", null)
      .maybeSingle();
    if (!arm) throw new Error("Not an A/B arm for this tenant.");
    await (
      sb as unknown as { rpc(fn: string, p: Record<string, unknown>): PromiseLike<unknown> }
    ).rpc("bump_ab_outcome", { p_offer_id: data.offerId, p_conversion: data.conversion });
    return { ok: true };
  });

// ── Simulator (demo/verify, NO live-path touch) ─────────────────────────────
//
// Mirrors the proven admin "Simulate a cancellation" tool: lets the owner watch
// the bandit work WITHOUT waiting for real sends/bookings. Each round Thompson-
// picks an arm from the CURRENT counts (so reach visibly shifts toward the
// front-runner), then converts with a synthetic per-arm "appeal" derived from
// the variant's terms (a bigger discount books a little better) plus a small
// per-arm jitter so a clear winner emerges. Accumulates deltas locally and
// writes ONE update per arm. Clearly synthetic — these counts are demo data.
type SimArmRow = {
  id: string;
  ab_label: string | null;
  title: string;
  offer_type: string | null;
  discount_usd: number | string | null;
  value_pct: number | string | null;
  ab_impressions: number | string | null;
  ab_conversions: number | string | null;
};

function syntheticAppeal(r: SimArmRow): number {
  const d = r.discount_usd != null ? Number(r.discount_usd) : 0;
  const p = r.value_pct != null ? Number(r.value_pct) : 0;
  const value = d / 600 + p / 250; // bigger offer → a bit more appealing
  // Deterministic per-arm jitter so two similar offers still separate.
  const jitter = (hashSeed(r.id) % 9) / 100 - 0.04;
  const a = 0.1 + value + jitter;
  return Math.max(0.04, Math.min(0.4, a));
}

const simInput = z.object({
  accessToken: z.string(),
  viewAsUserId: z.string().optional(),
  experimentId: z.string().uuid(),
  rounds: z.number().int().min(1).max(500).default(40),
});

export const simulateAbRound = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => simInput.parse(input))
  .handler(async ({ data }): Promise<{ ok: true; added: number }> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);

    const { data: rows } = await offersTbl(sb)
      .select("id, ab_label, title, offer_type, discount_usd, value_pct, ab_impressions, ab_conversions")
      .eq("tenant_id", tenantId)
      .eq("experiment_id", data.experimentId);
    const armRows = (rows as SimArmRow[] | null) ?? [];
    if (armRows.length < 2) throw new Error("Experiment has no arms to simulate.");

    const appeal = new Map(armRows.map((r) => [r.id, syntheticAppeal(r)]));
    const live: AbArm[] = armRows.map((r) => ({
      id: r.id,
      label: r.ab_label ?? r.title,
      impressions: r.ab_impressions != null ? Number(r.ab_impressions) : 0,
      conversions: r.ab_conversions != null ? Number(r.ab_conversions) : 0,
    }));
    const startImp = live.reduce((s, a) => s + a.impressions, 0);
    const rng = mulberry32((hashSeed(data.experimentId) ^ (startImp * 2654435761)) >>> 0);

    for (let i = 0; i < data.rounds; i++) {
      // Reseed the pick per round (cheap) so allocation reflects current counts.
      const pick = thompsonPickArm(live, ((rng() * 2 ** 32) >>> 0) ^ i);
      if (!pick) break;
      const arm = live.find((a) => a.id === pick.id)!;
      arm.impressions += 1;
      if (rng() < (appeal.get(arm.id) ?? 0.1)) arm.conversions += 1;
    }

    // One UPDATE per arm with the accumulated deltas.
    for (let k = 0; k < armRows.length; k++) {
      await offersTbl(sb)
        .update({ ab_impressions: live[k].impressions, ab_conversions: live[k].conversions })
        .eq("id", live[k].id)
        .eq("tenant_id", tenantId);
    }
    return { ok: true, added: data.rounds };
  });

export const listAbExperiments = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({ accessToken: z.string(), viewAsUserId: z.string().optional() })
      .parse(input),
  )
  .handler(async ({ data }): Promise<AbExperimentSummary[]> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);

    const { data: exps } = await experimentsTbl(sb)
      .select("id, base_label, status, winner_offer_id, created_at")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false });
    const list = (exps as Array<{
      id: string;
      base_label: string | null;
      status: string;
      winner_offer_id: string | null;
      created_at: string;
    }> | null) ?? [];
    if (list.length === 0) return [];

    const { data: armRows } = await offersTbl(sb)
      .select("id, ab_label, title, experiment_id, target_cohort")
      .eq("tenant_id", tenantId)
      .not("experiment_id", "is", null);
    const armsByExp = new Map<string, Array<{ offerId: string; label: string }>>();
    const cohortByExp = new Map<string, string>();
    for (const r of (armRows as Array<{ id: string; ab_label: string | null; title: string; experiment_id: string; target_cohort: string | null }> | null) ?? []) {
      const arr = armsByExp.get(r.experiment_id) ?? [];
      arr.push({ offerId: r.id, label: r.ab_label ?? r.title });
      armsByExp.set(r.experiment_id, arr);
      if (!cohortByExp.has(r.experiment_id)) cohortByExp.set(r.experiment_id, r.target_cohort ?? "all");
    }

    return list.map((e) => ({
      experimentId: e.id,
      baseLabel: e.base_label,
      status: e.status as AbExperimentSummary["status"],
      winnerOfferId: e.winner_offer_id,
      createdAt: e.created_at,
      targetCohort: cohortByExp.get(e.id) ?? "all",
      arms: armsByExp.get(e.id) ?? [],
    }));
  });

// ── draftExperimentPush — the assignment half of the live loop ──────────────
//
// Push an A/B experiment to its cohort: each patient is assigned ONE arm
// (Thompson sampling, sticky), an impression is counted for that arm, and the
// patient gets the message for THEIR variant. A later booking credits the arm
// they were assigned (recordExperimentConversion). Draft-first + opt-out-safe +
// human-gated, exactly like draftOfferPushFn: composes one message per patient
// and emails the batch to the spa's proxy inbox for review + send.
type PushArmRow = {
  id: string;
  ab_label: string | null;
  title: string;
  target_cohort: string | null;
  ab_impressions: number | string | null;
  ab_conversions: number | string | null;
};

export type ExperimentPushResult = {
  drafted: number;
  assignedNew: number;
  skippedNoPhone: number;
  sentTo: string | null;
  error: string | null;
};

export const draftExperimentPush = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => verdictInput.parse(input))
  .handler(async ({ data }): Promise<ExperimentPushResult> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);

    const { data: expRow } = await experimentsTbl(sb)
      .select("id, status")
      .eq("id", data.experimentId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (!expRow) throw new Error("Experiment not found.");
    if (expRow.status !== "running") throw new Error("This test is finished — nothing to push.");

    const { data: armRows } = await offersTbl(sb)
      .select("id, ab_label, title, target_cohort, ab_impressions, ab_conversions")
      .eq("tenant_id", tenantId)
      .eq("experiment_id", data.experimentId);
    const arms = (armRows as PushArmRow[] | null) ?? [];
    if (arms.length < 2) throw new Error("This test has no versions to push.");
    const cohort = arms[0].target_cohort ?? "all";
    if (cohort === "all") {
      throw new Error(
        "Give this test an audience (Lapsed / New / Expiring) before pushing — an all-patients test runs on your public booking page, where versions can't be split per patient.",
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const any = sb as unknown as { from(t: string): any; rpc(fn: string, p: Record<string, unknown>): PromiseLike<unknown> };
    const { data: policy } = await any
      .from("noshow_policies")
      .select("rescue_proxy_email")
      .eq("user_id", effectiveUserId)
      .maybeSingle();
    const proxyEmail = (policy?.rescue_proxy_email as string | null)?.trim() || null;
    if (!proxyEmail) {
      throw new Error(
        "Set your iMessage proxy email first (Refill → no-show settings) so drafts have somewhere to land.",
      );
    }

    const spaName = await resolveSpaName(
      sb as unknown as Parameters<typeof resolveSpaName>[0],
      effectiveUserId,
    );
    const { data: tenantRow } = await sb
      .from("tenants")
      .select("slug")
      .eq("id", tenantId)
      .maybeSingle();
    let slug = (tenantRow as { slug?: string } | null)?.slug ?? "";
    if (slug && (await tenantBooksOnExternalPms(sb, tenantId))) slug = "";

    const targets = await listOfferCohortTargets(
      sb as unknown as Parameters<typeof listOfferCohortTargets>[0],
      effectiveUserId,
      cohort as Parameters<typeof listOfferCohortTargets>[2],
    );

    // Existing assignments so a re-push keeps each patient on the same variant.
    // PAGINATED — a lapsed cohort can run to ~2,000 patients; a fixed read would
    // cap at 1,000 and silently re-assign the overflow (new variant + double
    // impression) on every re-push. Page past the cap.
    const existing = await fetchAllRows<{ patient_node_id: string; arm_offer_id: string }>(
      (from, to) =>
        assignmentsTbl(sb)
          .select("patient_node_id, arm_offer_id")
          .eq("tenant_id", tenantId)
          .eq("experiment_id", data.experimentId)
          .order("patient_node_id", { ascending: true })
          .range(from, to),
    );
    const assignedArm = new Map<string, string>(
      existing.map((r) => [r.patient_node_id, r.arm_offer_id]),
    );

    // Live arm counts — Thompson-pick new patients off the current state, and
    // advance local impression counts as we assign so within-batch allocation
    // stays balanced (no conversions yet → near-even explore).
    const live: AbArm[] = arms.map((a) => ({
      id: a.id,
      label: a.ab_label ?? a.title,
      impressions: a.ab_impressions != null ? Number(a.ab_impressions) : 0,
      conversions: a.ab_conversions != null ? Number(a.ab_conversions) : 0,
    }));
    const titleById = new Map(arms.map((a) => [a.id, a.title]));
    const impDelta = new Map<string, number>();
    const newAssignments: Array<{ tenant_id: string; experiment_id: string; patient_node_id: string; arm_offer_id: string }> = [];

    const built: Array<{ name: string; phone: string; body: string }> = [];
    let skippedNoPhone = 0;
    for (const t of targets) {
      const phone = (t.phone ?? "").trim();
      if (!phone) {
        skippedNoPhone += 1;
        continue;
      }
      let armId = assignedArm.get(t.patientNodeId);
      if (!armId) {
        const seed = hashSeed(`${data.experimentId}:${t.patientNodeId}`);
        const pick = thompsonPickArm(live, seed) ?? live[0];
        armId = pick.id;
        assignedArm.set(t.patientNodeId, armId);
        const lc = live.find((a) => a.id === armId);
        if (lc) lc.impressions += 1; // advance local state for the next pick
        impDelta.set(armId, (impDelta.get(armId) ?? 0) + 1);
        newAssignments.push({
          tenant_id: tenantId,
          experiment_id: data.experimentId,
          patient_node_id: t.patientNodeId,
          arm_offer_id: armId,
        });
      }
      const title = titleById.get(armId) ?? "your offer";
      built.push({ name: t.name || "(unnamed)", phone, body: composeOfferPushBody(firstNameOf(t.name), spaName, title, slug) });
    }

    if (built.length === 0) {
      return { drafted: 0, assignedNew: 0, skippedNoPhone, sentTo: null, error: "No reachable patients in this cohort (none had a phone number)." };
    }

    // Persist new assignments + count their impressions (atomic per-arm bump).
    if (newAssignments.length > 0) {
      await assignmentsTbl(sb).insert(newAssignments);
      for (const [armId, n] of impDelta) {
        await any.rpc("bump_ab_impression", { p_offer_id: armId, p_n: n });
      }
    }

    const subject = `${built.length} A/B draft${built.length === 1 ? "" : "s"} — SmartSpa is testing versions`;
    const rows = built
      .map(
        (b) =>
          `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee">${escHtml(b.name)}</td><td style="padding:6px 10px;border-bottom:1px solid #eee">${escHtml(b.phone)}</td><td style="padding:6px 10px;border-bottom:1px solid #eee">${escHtml(b.body)}</td></tr>`,
      )
      .join("");
    const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1c2024">
<p>Paste this whole email into Claude Desktop with the iMessage MCP installed. Claude will call <code>draft_imessage(recipient_phone, body)</code> for each row — one Messages.app conversation per draft. Review each and tap Send.</p>
<p><strong>SmartSpa A/B test</strong> &middot; ${built.length} patient(s) &middot; each is testing one of your versions${skippedNoPhone ? ` &middot; ${skippedNoPhone} skipped (no phone)` : ""}. Which version books best decides the winner.</p>
<table style="border-collapse:collapse;font-size:13px"><thead><tr><th style="text-align:left;padding:6px 10px;border-bottom:2px solid #ccc">Name</th><th style="text-align:left;padding:6px 10px;border-bottom:2px solid #ccc">Phone</th><th style="text-align:left;padding:6px 10px;border-bottom:2px solid #ccc">Message</th></tr></thead><tbody>${rows}</tbody></table>
</div>`;
    const text = built.map((b) => `${b.name}\t${b.phone}\t${b.body}`).join("\n");

    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey) throw new Error("Server is missing RESEND_API_KEY.");
    try {
      const res = await postResendEmail({
        apiKey: resendKey,
        from: process.env.REFILL_FROM_EMAIL ?? "offers@smartspa.app",
        to: [proxyEmail],
        subject,
        text,
        html,
        tags: [
          { name: "type", value: "refill-ab-push" },
          { name: "tenant", value: effectiveUserId },
        ],
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        return { drafted: built.length, assignedNew: newAssignments.length, skippedNoPhone, sentTo: null, error: `Resend ${res.status}: ${res.body.slice(0, 200)}` };
      }
    } catch (e) {
      return { drafted: built.length, assignedNew: newAssignments.length, skippedNoPhone, sentTo: null, error: e instanceof Error ? e.message : String(e) };
    }
    return { drafted: built.length, assignedNew: newAssignments.length, skippedNoPhone, sentTo: proxyEmail, error: null };
  });

// ── The Arbiter (v2.99) — anonymized cross-spa promo-performance verdict ─────
//
// The crown-jewel data product, internal-first (Grasshopper Q2): pool every
// A/B arm across ALL tenants by product + offer STRUCTURE, and let the same
// impartial bandit math say which structure books best — "$65 off books 1.7×
// the $50 off across N spas, 92% confident." Spa identity is masked (only a
// count); no patient data. This is the pitch-deck / partnership-leverage asset
// (a manufacturer-facing dashboard would build on the same pooled read later).
// Admin-only.
type ArbiterArmRow = {
  product: string;
  manufacturer: string | null;
  offer_type: string | null;
  discount_usd: number | string | null;
  value_pct: number | string | null;
  addon_label: string | null;
  ab_impressions: number | string | null;
  ab_conversions: number | string | null;
  tenant_id: string;
};

function structureKeyAndLabel(r: ArbiterArmRow): { key: string; label: string } {
  const t = r.offer_type ?? "dollars_off";
  const d = r.discount_usd != null ? Math.round(Number(r.discount_usd)) : null;
  const p = r.value_pct != null ? Number(r.value_pct) : null;
  const a = r.addon_label?.trim() || null;
  switch (t) {
    case "percent_off":
      return { key: `percent_off:${p}`, label: p != null ? `${p}% off` : "% off" };
    case "free_addon":
      return { key: `free_addon:${(a ?? "").toLowerCase()}`, label: a ? `Free ${a}` : "Free add-on" };
    case "discount_addon":
      return { key: `discount_addon:${d}:${(a ?? "").toLowerCase()}`, label: d != null ? `$${d} off ${a ?? "add-on"}` : "Add-on offer" };
    case "dollars_off":
    default:
      return { key: `dollars_off:${d}`, label: d != null ? `$${d} off` : "$ off" };
  }
}

export type ArbiterProductVerdict = {
  product: string;
  /** Most common known manufacturer for this product (or null). */
  manufacturer: string | null;
  /** Distinct spas contributing data (anonymized — count only). */
  spaCount: number;
  verdict: AbVerdict;
};

export const getArbiterVerdicts = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ accessToken: z.string() }).parse(input))
  .handler(async ({ data }): Promise<ArbiterProductVerdict[]> => {
    await requireAdmin(data.accessToken);
    const sb = admin();

    // Every A/B arm across ALL tenants — paginated (cross-tenant, unbounded).
    const rows = await fetchAllRows<ArbiterArmRow>((from, to) =>
      offersTbl(sb)
        .select(
          "product, manufacturer, offer_type, discount_usd, value_pct, addon_label, ab_impressions, ab_conversions, tenant_id",
        )
        .not("experiment_id", "is", null)
        .order("product", { ascending: true })
        .range(from, to),
    );

    // Group by product → structure. Pool impressions/conversions across spas;
    // track distinct tenants (anonymized count) + the dominant manufacturer.
    type Struct = { label: string; impressions: number; conversions: number };
    const byProduct = new Map<
      string,
      {
        structs: Map<string, Struct>;
        tenants: Set<string>;
        mfrCounts: Map<string, number>;
      }
    >();
    for (const r of rows) {
      const product = (r.product ?? "").trim().toLowerCase();
      if (!product) continue;
      let pg = byProduct.get(product);
      if (!pg) {
        pg = { structs: new Map(), tenants: new Set(), mfrCounts: new Map() };
        byProduct.set(product, pg);
      }
      const { key, label } = structureKeyAndLabel(r);
      const s = pg.structs.get(key) ?? { label, impressions: 0, conversions: 0 };
      s.impressions += r.ab_impressions != null ? Number(r.ab_impressions) : 0;
      s.conversions += r.ab_conversions != null ? Number(r.ab_conversions) : 0;
      pg.structs.set(key, s);
      pg.tenants.add(r.tenant_id);
      const mfr = r.manufacturer?.trim().toLowerCase();
      if (mfr) pg.mfrCounts.set(mfr, (pg.mfrCounts.get(mfr) ?? 0) + 1);
    }

    const out: ArbiterProductVerdict[] = [];
    for (const [product, pg] of byProduct) {
      // Only products with ≥2 distinct structures make an A/B verdict.
      if (pg.structs.size < 2) continue;
      const arms: AbArm[] = [...pg.structs.entries()].map(([key, s]) => ({
        id: key,
        label: s.label,
        impressions: s.impressions,
        conversions: s.conversions,
      }));
      const verdict = computeVerdict(arms, { seed: hashSeed(product) });
      let topMfr: string | null = null;
      let topN = 0;
      for (const [m, n] of pg.mfrCounts) if (n > topN) { topN = n; topMfr = m; }
      out.push({ product, manufacturer: topMfr, spaCount: pg.tenants.size, verdict });
    }
    // Most-evidenced products first.
    out.sort((a, b) => b.verdict.totalImpressions - a.verdict.totalImpressions);
    return out;
  });
