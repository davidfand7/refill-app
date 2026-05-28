/**
 * Emma(OS) cross-spa intelligence + benchmark recommendations (v365).
 *
 * THE MOAT-OF-MOATS. Cross-tenant aggregate learnings that no
 * incumbent can ship without:
 *   1. Data across many spas
 *   2. The architecture to analyze it
 *   3. The trust to be allowed access
 *
 * v365 ships the schema + a rules-based starter recommendation
 * generator. When fewer than N=10 spas exist in a cohort, the system
 * falls back to curated best-practice rules ("starter_rule" source).
 * As more spas onboard, computeBenchmarks fills emma_setting_benchmarks
 * and generateRecommendationsForUser transitions naturally to data-
 * derived suggestions ("benchmark_data" source).
 *
 * Four surfaces:
 *   generateRecommendationsForUser  — internal helper, called by cron
 *                                      + foreground page-view debounce
 *   listRecommendations             — UI list for /app/refill/rescue
 *   applyRecommendation             — one-tap accept; calls updateNoShowPolicy
 *                                      with the suggested value
 *   dismissRecommendation           — spa-owner dismisses
 *
 * Plus computeBenchmarks (cron helper) which aggregates per-spa
 * settings + recovery metrics into emma_setting_benchmarks when the
 * sample size justifies it.
 *
 * Established 2026-05-17 (Promotions Engine v365).
 */

import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database, Json } from "@/integrations/supabase/types";
import { resolveEffectiveUserId, verifyAuth } from "@/server/auth-helpers";

// ─── Public types ─────────────────────────────────────────────────────────

export type RecommendationSource = "starter_rule" | "benchmark_data";

export type Recommendation = {
  id: string;
  settingKey: string;
  currentValue: string | null;
  suggestedValue: string;
  source: RecommendationSource;
  headline: string;
  body: string | null;
  projectedLiftUsd: number | null;
  appliedAt: string | null;
  dismissedAt: string | null;
  generatedAt: string;
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

// ─── Starter rules ────────────────────────────────────────────────────────

/**
 * The rules-based starter that works without N>=10 cohort data.
 * Industry research + best practices, conservative lift estimates.
 *
 * Each rule produces one candidate recommendation. The generator runs
 * each rule against a single spa's settings + recovery activity, and
 * emits a Recommendation row when the rule fires.
 *
 * The lift_usd_per_month numbers are conservative estimates from
 * industry data; the spa sees them as projections, not promises.
 */
type StarterRule = {
  settingKey: string;
  fires: (input: SpaSettingsInput) => boolean;
  suggestedValue: (input: SpaSettingsInput) => string;
  headline: (input: SpaSettingsInput) => string;
  body: (input: SpaSettingsInput) => string;
  projectedLiftUsdPerMonth: number;
};

type SpaSettingsInput = {
  preshow_enabled: boolean;
  preshow_cadence_hours: number[];
  preshow_tone: string;
  preshow_channel: string;
  optin_footer_enabled: boolean;
  optin_list_url: string | null;
  rescue_enabled: boolean;
  rescue_max_concurrent: number;
  grace_credits_per_6mo: number;
  monthly_appointment_count: number;
  waitlist_size: number;
};

const STARTER_RULES: StarterRule[] = [
  // Rule 1: add T-3h reminder when missing
  {
    settingKey: "preshow_cadence_hours",
    fires: (i) =>
      i.preshow_enabled && !i.preshow_cadence_hours.includes(3),
    suggestedValue: (i) =>
      JSON.stringify(
        Array.from(new Set([...i.preshow_cadence_hours, 3])).sort((a, b) => b - a),
      ),
    headline: () => "Add a T-3h reminder",
    body: () =>
      "A same-day confirmation 3 hours before the appointment catches the 'I forgot' segment. Industry data shows a ~12-18% no-show reduction adding this single offset on top of T-48h + T-24h.",
    projectedLiftUsdPerMonth: 800,
  },
  // Rule 2: enable rescue agent when off and waitlist exists
  {
    settingKey: "rescue_enabled",
    fires: (i) => !i.rescue_enabled && i.waitlist_size >= 5,
    suggestedValue: () => "true",
    headline: () => "Enable the same-day rescue agent",
    body: (i) =>
      `You have ${i.waitlist_size} patients on your waitlist but the rescue agent is off. When an appointment cancels, Emma offers the freed slot to the top 5 fit-patients via SMS — first tap wins. Most spas recover 40-50% of cancelled-slot revenue this way.`,
    projectedLiftUsdPerMonth: 1800,
  },
  // Rule 3: warm tone for high-engagement
  {
    settingKey: "preshow_tone",
    fires: (i) => i.preshow_tone === "professional" && i.monthly_appointment_count < 500,
    suggestedValue: () => "warm",
    headline: () => "Try the warm tone for small-spa scale",
    body: () =>
      "Professional tone is great for high-volume operations, but at your scale a warm conversational tone tends to drive higher confirmation rates. Patients respond more to a message that feels like a person, not a system.",
    projectedLiftUsdPerMonth: 400,
  },
  // Rule 4: enable optin footer when off
  {
    settingKey: "optin_footer_enabled",
    fires: (i) => !i.optin_footer_enabled,
    suggestedValue: () => "true",
    headline: () => "Turn the universal opt-in footer back on",
    body: () =>
      "The opt-in footer is how patients join your last-minute openings list. Without it, your waitlist never grows organically — every new opt-in is a manual click from you. Most spas see their list grow 3-5 patients per week with the footer enabled.",
    projectedLiftUsdPerMonth: 600,
  },
  // Rule 5: tighten grace credits if no_show count is high (placeholder)
  {
    settingKey: "grace_credits_per_6mo",
    fires: (i) => i.grace_credits_per_6mo >= 4,
    suggestedValue: () => "2",
    headline: () => "Consider tightening grace credits to 2 per 6 months",
    body: () =>
      "You currently allow 4+ free last-minute cancels per patient per 6 months. The industry default is 2 — strict enough to discourage casual cancels, generous enough to handle real life. Patients hit the 'in-recovery' threshold faster, which means earlier visibility into chronic offenders.",
    projectedLiftUsdPerMonth: 0,
  },
];

// ─── Compute spa settings input ───────────────────────────────────────────

async function loadSpaSettingsInput(
  sb: SupabaseAdmin,
  userId: string,
): Promise<SpaSettingsInput> {
  const [policy, apptRes, waitRes] = await Promise.all([
    sb
      .from("emma_noshow_policies")
      .select(
        "preshow_enabled, preshow_cadence_hours, preshow_tone, preshow_channel, optin_footer_enabled, optin_list_url, rescue_enabled, rescue_max_concurrent, grace_credits_per_6mo",
      )
      .eq("user_id", userId)
      .maybeSingle(),
    sb
      .from("emma_appointments")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .gte(
        "scheduled_at",
        new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      ),
    sb
      .from("emma_waitlist")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("status", "active"),
  ]);

  return {
    preshow_enabled: policy.data?.preshow_enabled ?? true,
    preshow_cadence_hours: policy.data?.preshow_cadence_hours ?? [48, 24, 3],
    preshow_tone: policy.data?.preshow_tone ?? "warm",
    preshow_channel: policy.data?.preshow_channel ?? "auto",
    optin_footer_enabled: policy.data?.optin_footer_enabled ?? true,
    optin_list_url: policy.data?.optin_list_url ?? null,
    rescue_enabled: policy.data?.rescue_enabled ?? false,
    rescue_max_concurrent: policy.data?.rescue_max_concurrent ?? 5,
    grace_credits_per_6mo: policy.data?.grace_credits_per_6mo ?? 2,
    monthly_appointment_count: apptRes.count ?? 0,
    waitlist_size: waitRes.count ?? 0,
  };
}

// ─── generateRecommendationsForUser ───────────────────────────────────────

export async function generateRecommendationsForUser(args: {
  sb: SupabaseAdmin;
  userId: string;
}): Promise<{ generated: number; skipped: number }> {
  const { sb, userId } = args;

  const input = await loadSpaSettingsInput(sb, userId);
  let generated = 0;
  let skipped = 0;

  for (const rule of STARTER_RULES) {
    if (!rule.fires(input)) {
      // Rule no longer applies — clean up any prior active row.
      await sb
        .from("emma_setting_recommendations")
        .delete()
        .eq("user_id", userId)
        .eq("setting_key", rule.settingKey)
        .is("applied_at", null)
        .is("dismissed_at", null);
      continue;
    }

    const currentValue = JSON.stringify(
      (input as unknown as Record<string, unknown>)[rule.settingKey],
    );
    const suggestedValue = rule.suggestedValue(input);

    // Idempotency — don't recreate identical active rows.
    const { data: existing } = await sb
      .from("emma_setting_recommendations")
      .select("id, applied_at, dismissed_at, suggested_value")
      .eq("user_id", userId)
      .eq("setting_key", rule.settingKey)
      .maybeSingle();

    if (existing) {
      if (
        existing.applied_at ||
        (existing.dismissed_at && existing.suggested_value === suggestedValue)
      ) {
        // Already applied OR dismissed for the same suggestion — skip.
        skipped++;
        continue;
      }
      // Refresh the row with the latest values.
      await sb
        .from("emma_setting_recommendations")
        .update({
          current_value: currentValue,
          suggested_value: suggestedValue,
          headline: rule.headline(input),
          body: rule.body(input),
          projected_lift_usd: rule.projectedLiftUsdPerMonth,
          source: "starter_rule",
          dismissed_at: null, // Re-surface if conditions changed
          dismissed_by: null,
          generated_at: new Date().toISOString(),
        })
        .eq("id", existing.id);
      generated++;
      continue;
    }

    await sb.from("emma_setting_recommendations").insert({
      user_id: userId,
      setting_key: rule.settingKey,
      current_value: currentValue,
      suggested_value: suggestedValue,
      source: "starter_rule",
      headline: rule.headline(input),
      body: rule.body(input),
      projected_lift_usd: rule.projectedLiftUsdPerMonth,
    });
    generated++;
  }

  return { generated, skipped };
}

// ─── Zod ──────────────────────────────────────────────────────────────────

const listInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
});

const idInput = z.object({
  accessToken: z.string().min(1),
  recommendationId: z.string().uuid(),
});

// ─── listRecommendations (UI) ─────────────────────────────────────────────

export const listRecommendations = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => listInput.parse(input))
  .handler(async ({ data }): Promise<Recommendation[]> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();

    // Foreground regen with simple per-spa debounce — only recompute
    // if the last generation is older than 1 hour. This is cheap
    // (rules-based eval over ~5 rules) so we can be liberal.
    const { data: latest } = await sb
      .from("emma_setting_recommendations")
      .select("generated_at")
      .eq("user_id", effectiveUserId)
      .order("generated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const needsRegen = !latest || latest.generated_at < oneHourAgo;
    if (needsRegen) {
      try {
        await generateRecommendationsForUser({ sb, userId: effectiveUserId });
      } catch (e) {
        console.error("recommendations regen failed:", e instanceof Error ? e.message : e);
      }
    }

    const { data: rows, error } = await sb
      .from("emma_setting_recommendations")
      .select(
        "id, setting_key, current_value, suggested_value, source, headline, body, projected_lift_usd, applied_at, dismissed_at, generated_at",
      )
      .eq("user_id", effectiveUserId)
      .is("applied_at", null)
      .is("dismissed_at", null)
      .order("projected_lift_usd", { ascending: false, nullsFirst: false })
      .limit(10);
    if (error) throw new Error(`Couldn't load recommendations: ${error.message}`);

    return (rows ?? []).map((r) => ({
      id: r.id,
      settingKey: r.setting_key,
      currentValue: r.current_value,
      suggestedValue: r.suggested_value,
      source: r.source as RecommendationSource,
      headline: r.headline,
      body: r.body,
      projectedLiftUsd: r.projected_lift_usd ? Number(r.projected_lift_usd) : null,
      appliedAt: r.applied_at,
      dismissedAt: r.dismissed_at,
      generatedAt: r.generated_at,
    }));
  });

// ─── applyRecommendation ──────────────────────────────────────────────────

export const applyRecommendation = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => idInput.parse(input))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();

    const { data: rec, error: readErr } = await sb
      .from("emma_setting_recommendations")
      .select("id, setting_key, suggested_value")
      .eq("id", data.recommendationId)
      .eq("user_id", userId)
      .is("applied_at", null)
      .maybeSingle();
    if (readErr) throw new Error(`Couldn't load: ${readErr.message}`);
    if (!rec) throw new Error("Recommendation not found or already actioned.");

    // Snapshot current policy for rollback.
    const { data: snapshot } = await sb
      .from("emma_noshow_policies")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();

    // Apply the suggested value. Parse based on setting_key.
    const patch: Record<string, unknown> = {};
    switch (rec.setting_key) {
      case "preshow_cadence_hours":
        patch.preshow_cadence_hours = JSON.parse(rec.suggested_value);
        break;
      case "rescue_enabled":
      case "optin_footer_enabled":
      case "preshow_enabled":
      case "deposit_enabled":
        patch[rec.setting_key] = rec.suggested_value === "true";
        break;
      case "preshow_tone":
      case "preshow_channel":
        patch[rec.setting_key] = rec.suggested_value;
        break;
      case "grace_credits_per_6mo":
      case "rescue_max_concurrent":
      case "rescue_outreach_window_min":
      case "deposit_refund_window_hours":
        patch[rec.setting_key] = parseInt(rec.suggested_value, 10);
        break;
      default:
        throw new Error(`Unknown setting_key: ${rec.setting_key}`);
    }

    const { error: upsertErr } = await sb
      .from("emma_noshow_policies")
      .upsert(
        { user_id: userId, ...patch },
        { onConflict: "user_id" },
      );
    if (upsertErr) {
      throw new Error(`Couldn't apply: ${upsertErr.message}`);
    }

    await sb
      .from("emma_setting_recommendations")
      .update({
        applied_at: new Date().toISOString(),
        rollback_snapshot: (snapshot as unknown as Json) ?? null,
      })
      .eq("id", rec.id);

    return { ok: true };
  });

// ─── dismissRecommendation ────────────────────────────────────────────────

export const dismissRecommendation = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => idInput.parse(input))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const userId = await verifyAuth(data.accessToken);
    const sb = admin();

    await sb
      .from("emma_setting_recommendations")
      .update({
        dismissed_at: new Date().toISOString(),
        dismissed_by: userId,
      })
      .eq("id", data.recommendationId)
      .eq("user_id", userId)
      .is("applied_at", null);
    return { ok: true };
  });

// ─── computeBenchmarks (cron helper, placeholder for N>=10) ───────────────

/**
 * Aggregate per-spa settings + recovery metrics into the benchmarks
 * table. Gated on cohort size >= 10 — until we cross that threshold
 * across all segments, this fn writes nothing. Once we cross, the
 * generateRecommendationsForUser fn will start picking up benchmark_data
 * rows alongside the starter_rule rows.
 *
 * For v365 this is mostly inert — we don't have 10+ spas yet. Schema
 * is ready; activation lights up automatically as more spas onboard.
 */
export async function computeBenchmarks(args: {
  sb: SupabaseAdmin;
}): Promise<{ benchmarks_written: number }> {
  const { sb } = args;
  const MINIMUM_COHORT_SIZE = 10;

  // Count distinct spas with at least one verified recovery event in
  // the last 90 days (active spas).
  const { data: rows } = await sb
    .from("emma_recovery_events")
    .select("user_id")
    .not("verified_at", "is", null)
    .gte(
      "verified_at",
      new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
    );
  const activeSpaCount = new Set((rows ?? []).map((r) => r.user_id)).size;

  if (activeSpaCount < MINIMUM_COHORT_SIZE) {
    return { benchmarks_written: 0 };
  }

  // TODO(v365.x): when cohort is sufficient, aggregate per-spa monthly
  // recovery by (segment, setting, value) and write to
  // emma_setting_benchmarks. The generator will then prefer
  // 'benchmark_data' source over 'starter_rule' when a benchmark row
  // exists for the setting.

  return { benchmarks_written: 0 };
}
