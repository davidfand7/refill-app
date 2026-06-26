/**
 * Refill Attribution Agent — settings + performance metrics (v1.34.7).
 *
 * Mirrors the v1.34.6 Refill surface but for Attribution. Settings live
 * as a knowledge_nodes row with node_type='attribution_settings' (no
 * migration; the same pattern v1.31.5 used for custom_tag_definitions).
 *
 * Attribution dispatch is in src/server/emma-attribution.functions.ts —
 * this module is read/write for Karen's spa-owner control surface +
 * a getRecoveryStats wrapper.
 */

import { createServerFn } from "@tanstack/react-start";
import { admin } from "./admin-client";
import { z } from "zod";

import type { Database, Json } from "@/integrations/supabase/types";
import { resolveEffectiveUserId } from "@/server/auth-helpers";

// ─── Public types ─────────────────────────────────────────────────────────

export type AttributionSettings = {
  enabled: boolean;
  /** A booking within this many hours of outreach counts as recovered. */
  windowHours: number;
  /** Below this $ amount, recovery auto-confirms. Above, queue for review. 0 = always auto. */
  autoConfirmThresholdUsd: number;
  /** Tie-break weights when multiple agents could claim the same booking. */
  agentWeights: {
    rescue: number;
    preshow: number;
    post_recovery: number;
  };
  updatedAt: string | null;
};

export type AttributionMetrics = {
  windowDays: number;
  recoveriesAttributed: number;
  attributedRevenueUsd: number;
  manualConfirms: number;
  unconfirmed: number;
};

// ─── Admin client ─────────────────────────────────────────────────────────

// ─── Defaults ─────────────────────────────────────────────────────────────

const DEFAULTS: AttributionSettings = {
  enabled: true,
  windowHours: 72,
  autoConfirmThresholdUsd: 0,
  agentWeights: {
    rescue: 1.0,
    preshow: 0.5,
    post_recovery: 0.8,
  },
  updatedAt: null,
};

// ─── Zod validators ───────────────────────────────────────────────────────

const accessInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
});

const updateSettingsInput = accessInput.extend({
  enabled: z.boolean().optional(),
  windowHours: z.number().int().min(1).max(720).optional(),
  autoConfirmThresholdUsd: z.number().int().min(0).max(100000).optional(),
  agentWeights: z
    .object({
      rescue: z.number().min(0).max(10),
      preshow: z.number().min(0).max(10),
      post_recovery: z.number().min(0).max(10),
    })
    .optional(),
});

const metricsInput = accessInput.extend({
  windowDays: z.number().int().min(1).max(365).default(7).optional(),
});

// ─── Read settings ────────────────────────────────────────────────────────

/**
 * v1.34.9.5: exported so emma-attribution.functions.ts dispatch can read
 * the settings at reconcile time. Takes any admin-style supabase client
 * (the dispatch path has its own client; reusing the loader keeps the
 * default-fallback logic single-sourced).
 */
export async function loadAttributionSettings(
  sb: ReturnType<typeof admin>,
  userId: string,
): Promise<AttributionSettings> {
  return loadSettings(sb, userId);
}

async function loadSettings(
  sb: ReturnType<typeof admin>,
  userId: string,
): Promise<AttributionSettings> {
  const { data: row, error } = await sb
    .from("knowledge_nodes")
    .select("attachments, updated_at")
    .eq("user_id", userId)
    .eq("node_type", "attribution_settings")
    .maybeSingle();
  if (error) {
    throw new Error(`Couldn't read attribution settings: ${error.message}`);
  }
  if (!row) return DEFAULTS;
  const stored = (row.attachments ?? {}) as Partial<AttributionSettings>;
  return {
    enabled: stored.enabled ?? DEFAULTS.enabled,
    windowHours: stored.windowHours ?? DEFAULTS.windowHours,
    autoConfirmThresholdUsd:
      stored.autoConfirmThresholdUsd ?? DEFAULTS.autoConfirmThresholdUsd,
    agentWeights: stored.agentWeights ?? DEFAULTS.agentWeights,
    updatedAt: row.updated_at,
  };
}

export const getAttributionSettings = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => accessInput.parse(raw))
  .handler(async ({ data }): Promise<AttributionSettings> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    return loadSettings(sb, effectiveUserId);
  });

// ─── Update settings ──────────────────────────────────────────────────────

export const updateAttributionSettings = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => updateSettingsInput.parse(raw))
  .handler(async ({ data }): Promise<AttributionSettings> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const prior = await loadSettings(sb, effectiveUserId);
    const next: AttributionSettings = {
      enabled: data.enabled ?? prior.enabled,
      windowHours: data.windowHours ?? prior.windowHours,
      autoConfirmThresholdUsd:
        data.autoConfirmThresholdUsd ?? prior.autoConfirmThresholdUsd,
      agentWeights: data.agentWeights ?? prior.agentWeights,
      updatedAt: new Date().toISOString(),
    };

    // Upsert by (user_id, node_type) — knowledge_nodes doesn't have a
    // composite unique, so we check + insert/update.
    const { data: existing } = await sb
      .from("knowledge_nodes")
      .select("id")
      .eq("user_id", effectiveUserId)
      .eq("node_type", "attribution_settings")
      .maybeSingle();

    if (existing) {
      const { error } = await sb
        .from("knowledge_nodes")
        .update({
          attachments: next as unknown as Json,
          updated_at: next.updatedAt!,
        })
        .eq("id", existing.id);
      if (error) {
        throw new Error(`Couldn't update attribution settings: ${error.message}`);
      }
    } else {
      const { error } = await sb.from("knowledge_nodes").insert({
        user_id: effectiveUserId,
        node_type: "attribution_settings",
        title: "Attribution settings",
        context: "agent_config",
        content: "",
        attachments: next as unknown as Json,
      });
      if (error) {
        throw new Error(`Couldn't create attribution settings: ${error.message}`);
      }
    }
    return next;
  });

/**
 * v2.30.0 — flip just the `enabled` master toggle, server-side (no accessToken).
 * The Auto-Verify Recoveries Skill (skills.functions.ts) gates auto-reconciliation
 * through this: adopt → on, Pause → off. Mirrors the upsert in
 * updateAttributionSettings but callable from the dispatch/skills layer, like
 * loadAttributionSettings / setNoshowPolicyGate. Preserves all other settings.
 */
export async function setAttributionEnabled(
  sb: ReturnType<typeof admin>,
  userId: string,
  enabled: boolean,
): Promise<void> {
  const prior = await loadSettings(sb, userId);
  const next: AttributionSettings = {
    ...prior,
    enabled,
    updatedAt: new Date().toISOString(),
  };
  const { data: existing } = await sb
    .from("knowledge_nodes")
    .select("id")
    .eq("user_id", userId)
    .eq("node_type", "attribution_settings")
    .maybeSingle();
  if (existing) {
    const { error } = await sb
      .from("knowledge_nodes")
      .update({ attachments: next as unknown as Json, updated_at: next.updatedAt! })
      .eq("id", existing.id);
    if (error) throw new Error(`Couldn't update attribution settings: ${error.message}`);
  } else {
    const { error } = await sb.from("knowledge_nodes").insert({
      user_id: userId,
      node_type: "attribution_settings",
      title: "Attribution settings",
      context: "agent_config",
      content: "",
      attachments: next as unknown as Json,
    });
    if (error) throw new Error(`Couldn't create attribution settings: ${error.message}`);
  }
}

// ─── Performance metrics ──────────────────────────────────────────────────

export const getAttributionAgentMetrics = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => metricsInput.parse(raw))
  .handler(async ({ data }): Promise<AttributionMetrics> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();

    const windowDays = data.windowDays ?? 7;
    const since = new Date(
      Date.now() - windowDays * 24 * 60 * 60 * 1000,
    ).toISOString();

    const { data: rows, error } = await sb
      .from("recovery_events")
      .select("attributed_revenue_usd, verification_source, verified_at, created_at")
      .eq("user_id", effectiveUserId)
      .gte("created_at", since);
    if (error) {
      throw new Error(`Couldn't load attribution metrics: ${error.message}`);
    }

    const recoveriesAttributed = rows?.length ?? 0;
    const attributedRevenueUsd = (rows ?? []).reduce(
      (sum, r) => sum + (Number(r.attributed_revenue_usd) || 0),
      0,
    );
    const manualConfirms = (rows ?? []).filter(
      (r) => r.verification_source === "manual",
    ).length;
    const unconfirmed = (rows ?? []).filter((r) => !r.verified_at).length;

    return {
      windowDays,
      recoveriesAttributed,
      attributedRevenueUsd,
      manualConfirms,
      unconfirmed,
    };
  });
