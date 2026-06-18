/**
 * Refill Rescue Agent — settings + performance metrics (v1.34.6).
 *
 * Mirrors the refill-preshow-agent.functions.ts pattern, but Rescue
 * stays single-policy per spa (no Rescue PROFILES like Preshow has —
 * the rescue domain doesn't benefit from per-cohort cadence routing
 * the same way Preshow does). Rescue settings live on the existing
 * noshow_policies row (rescue_enabled, rescue_eligible_treatments,
 * rescue_max_concurrent, rescue_outreach_window_min, rescue_proxy_*).
 *
 * Dispatch logic is unchanged in emma-rescue.functions.ts — this module
 * is read/write for Karen's spa-owner surface.
 */

import { createServerFn } from "@tanstack/react-start";
import { admin } from "./admin-client";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { resolveEffectiveUserId } from "@/server/auth-helpers";

// ─── Public types ─────────────────────────────────────────────────────────

export type RescuePolicy = {
  enabled: boolean;
  eligibleTreatments: string[];
  maxConcurrent: number;
  outreachWindowMin: number;
  proxyPhone: string | null;
  proxyEmail: string | null;
  updatedAt: string;
};

export type RescueAgentMetrics = {
  windowDays: number;
  offersSent: number;
  offersClaimed: number;
  offersExpired: number;
  conversionRate: number;
};

// ─── Admin client ─────────────────────────────────────────────────────────

// ─── Zod validators ───────────────────────────────────────────────────────

const accessInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
});

const updatePolicyInput = accessInput.extend({
  enabled: z.boolean().optional(),
  eligibleTreatments: z.array(z.string().min(1).max(80)).max(50).optional(),
  maxConcurrent: z.number().int().min(0).max(50).optional(),
  outreachWindowMin: z.number().int().min(1).max(43200).optional(),
  proxyPhone: z.string().max(40).nullable().optional(),
  proxyEmail: z.string().email().max(240).nullable().optional(),
});

const metricsInput = accessInput.extend({
  windowDays: z.number().int().min(1).max(365).default(7).optional(),
});

// ─── Hydration ────────────────────────────────────────────────────────────

type PolicyRow = Database["public"]["Tables"]["noshow_policies"]["Row"];

function hydratePolicy(row: PolicyRow): RescuePolicy {
  return {
    enabled: row.rescue_enabled,
    eligibleTreatments: (row.rescue_eligible_treatments ?? []) as string[],
    maxConcurrent: row.rescue_max_concurrent,
    outreachWindowMin: row.rescue_outreach_window_min,
    proxyPhone: row.rescue_proxy_phone,
    proxyEmail: row.rescue_proxy_email,
    updatedAt: row.updated_at,
  };
}

// ─── getRescuePolicy ──────────────────────────────────────────────────────

export const getRescuePolicy = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => accessInput.parse(raw))
  .handler(async ({ data }): Promise<RescuePolicy | null> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const { data: row, error } = await sb
      .from("noshow_policies")
      .select("*")
      .eq("user_id", effectiveUserId)
      .maybeSingle();
    if (error) throw new Error(`Couldn't load rescue policy: ${error.message}`);
    return row ? hydratePolicy(row) : null;
  });

// ─── updateRescuePolicy ───────────────────────────────────────────────────

export const updateRescuePolicy = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => updatePolicyInput.parse(raw))
  .handler(async ({ data }): Promise<RescuePolicy> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();

    const updates: Database["public"]["Tables"]["noshow_policies"]["Update"] = {
      updated_at: new Date().toISOString(),
    };
    if (data.enabled !== undefined) updates.rescue_enabled = data.enabled;
    if (data.eligibleTreatments !== undefined) {
      updates.rescue_eligible_treatments = data.eligibleTreatments.map((t) =>
        t.toLowerCase().trim(),
      );
    }
    if (data.maxConcurrent !== undefined)
      updates.rescue_max_concurrent = data.maxConcurrent;
    if (data.outreachWindowMin !== undefined)
      updates.rescue_outreach_window_min = data.outreachWindowMin;
    if (data.proxyPhone !== undefined)
      updates.rescue_proxy_phone = data.proxyPhone;
    if (data.proxyEmail !== undefined)
      updates.rescue_proxy_email = data.proxyEmail;

    // Upsert-style: if no row yet, insert one with defaults + updates.
    const { data: existing } = await sb
      .from("noshow_policies")
      .select("id")
      .eq("user_id", effectiveUserId)
      .maybeSingle();

    if (!existing) {
      const { data: inserted, error: insErr } = await sb
        .from("noshow_policies")
        .insert({
          user_id: effectiveUserId,
          ...updates,
        })
        .select("*")
        .single();
      if (insErr) throw new Error(`Couldn't create rescue policy: ${insErr.message}`);
      return hydratePolicy(inserted);
    }

    const { data: row, error } = await sb
      .from("noshow_policies")
      .update(updates)
      .eq("user_id", effectiveUserId)
      .select("*")
      .single();
    if (error) throw new Error(`Couldn't update rescue policy: ${error.message}`);
    return hydratePolicy(row);
  });

// ─── getRescueAgentMetrics ────────────────────────────────────────────────

export const getRescueAgentMetrics = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => metricsInput.parse(raw))
  .handler(async ({ data }): Promise<RescueAgentMetrics> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();

    const windowDays = data.windowDays ?? 7;
    const since = new Date(
      Date.now() - windowDays * 24 * 60 * 60 * 1000,
    ).toISOString();

    const { data: offers, error } = await sb
      .from("rescue_offers")
      .select("id, claimed_at, expired_at, created_at")
      .eq("user_id", effectiveUserId)
      .gte("created_at", since);
    if (error) throw new Error(`Couldn't load rescue metrics: ${error.message}`);

    const offersSent = offers?.length ?? 0;
    const offersClaimed = (offers ?? []).filter((o) => o.claimed_at).length;
    const offersExpired = (offers ?? []).filter(
      (o) => !o.claimed_at && o.expired_at,
    ).length;
    const conversionRate = offersSent > 0 ? offersClaimed / offersSent : 0;

    return {
      windowDays,
      offersSent,
      offersClaimed,
      offersExpired,
      conversionRate,
    };
  });
