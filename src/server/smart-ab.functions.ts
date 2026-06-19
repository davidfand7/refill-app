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
import { getTenantIdForUser, resolveEffectiveUserId } from "@/server/auth-helpers";
import { normalizeForMatch } from "@/lib/promo-calendar";
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
  targetCohort: z.enum(["all", "lapsed", "new", "expiring"]).default("all"),
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
      .select("id, ab_label, title, experiment_id")
      .eq("tenant_id", tenantId)
      .not("experiment_id", "is", null);
    const armsByExp = new Map<string, Array<{ offerId: string; label: string }>>();
    for (const r of (armRows as Array<{ id: string; ab_label: string | null; title: string; experiment_id: string }> | null) ?? []) {
      const arr = armsByExp.get(r.experiment_id) ?? [];
      arr.push({ offerId: r.id, label: r.ab_label ?? r.title });
      armsByExp.set(r.experiment_id, arr);
    }

    return list.map((e) => ({
      experimentId: e.id,
      baseLabel: e.base_label,
      status: e.status as AbExperimentSummary["status"],
      winnerOfferId: e.winner_offer_id,
      createdAt: e.created_at,
      arms: armsByExp.get(e.id) ?? [],
    }));
  });
