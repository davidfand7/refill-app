/**
 * Reward-attribution holds — the confidence gate's review queue + resolution.
 *
 * The trust-repair rung (project_trusted_onboarding, step 7). When reward
 * ingestion can't narrow a $ reward to ONE patient, it HOLDS instead of
 * guessing (manufacturer-reward-ingest.functions.ts). This file is the human
 * side of that gate:
 *
 *   listAttributionHoldsFn   — the "needs your eyes" queue for the rewards page.
 *   resolveAttributionHoldFn — the owner latches it: assign to a candidate
 *       (attributes the orphaned reward + LEARNS the alias so the next import
 *       auto-resolves it) or dismiss (leave it unmatched, honestly).
 *
 * Service-role only, accessToken + resolveEffectiveUserId, mirroring the
 * connection-health expect-gate fn pair (listExpectedSourcesFn / setExpectedSourceFn).
 */

import { createServerFn } from "@tanstack/react-start";
import { admin } from "./admin-client";
import { z } from "zod";

import { resolveEffectiveUserId } from "@/server/auth-helpers";

type SupabaseAdmin = ReturnType<typeof admin>;

/** Loose view for tables not yet in the generated types (see ingest file). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function looseTbl(sb: SupabaseAdmin, t: string): any {
  return (sb as unknown as { from(t: string): unknown }).from(t);
}

export type AttributionCandidate = {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
};

export type AttributionHold = {
  id: string;
  manufacturer: string;
  brandProduct: string;
  program: string | null;
  rewardAmountUsd: number | null;
  expirationDate: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  signals: string[];
  candidates: AttributionCandidate[];
  createdAt: string;
};

// ─── listAttributionHoldsFn ────────────────────────────────────────────────

const listInput = z.object({
  accessToken: z.string(),
  viewAsUserId: z.string().optional(),
});

export const listAttributionHoldsFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => listInput.parse(raw))
  .handler(async ({ data }): Promise<AttributionHold[]> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const { data: rows, error } = await looseTbl(sb, "reward_attribution_holds")
      .select(
        "id, manufacturer, brand_product, program, reward_amount_usd, expiration_date, contact_name, contact_email, contact_phone, signals, candidates, created_at",
      )
      .eq("user_id", effectiveUserId)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) {
      // The migration may not have landed in this environment yet — degrade to
      // an empty queue rather than break the rewards page.
      return [];
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return ((rows ?? []) as any[]).map((r) => ({
      id: r.id,
      manufacturer: r.manufacturer,
      brandProduct: r.brand_product,
      program: r.program ?? null,
      rewardAmountUsd: r.reward_amount_usd == null ? null : Number(r.reward_amount_usd),
      expirationDate: r.expiration_date ?? null,
      contactName: r.contact_name ?? null,
      contactEmail: r.contact_email ?? null,
      contactPhone: r.contact_phone ?? null,
      signals: Array.isArray(r.signals) ? r.signals : [],
      candidates: Array.isArray(r.candidates) ? r.candidates : [],
      createdAt: r.created_at,
    }));
  });

// ─── resolveAttributionHoldFn ──────────────────────────────────────────────

const resolveInput = z.object({
  accessToken: z.string(),
  viewAsUserId: z.string().optional(),
  holdId: z.string(),
  /** "assign" attributes the reward to chosen patient + learns the alias;
   *  "dismiss" leaves it unmatched (none of these). */
  choice: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("assign"), nodeId: z.string() }),
    z.object({ kind: z.literal("dismiss") }),
  ]),
});

export const resolveAttributionHoldFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => resolveInput.parse(raw))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const nowIso = new Date().toISOString();

    // Load the hold (tenant-scoped) so the resolution can't touch another spa's.
    const { data: hold, error: loadErr } = await looseTbl(sb, "reward_attribution_holds")
      .select("id, manufacturer, brand_product, match_key, fingerprint, candidates, status")
      .eq("id", data.holdId)
      .eq("user_id", effectiveUserId)
      .single();
    if (loadErr || !hold) throw new Error("That review item couldn't be found.");
    if (hold.status !== "pending") return { ok: true }; // already answered — idempotent

    if (data.choice.kind === "dismiss") {
      await looseTbl(sb, "reward_attribution_holds")
        .update({ status: "dismissed", resolved_at: nowIso, updated_at: nowIso })
        .eq("id", hold.id)
        .eq("user_id", effectiveUserId);
      return { ok: true };
    }

    // Assign — the chosen node must be one of the recorded candidates (never an
    // arbitrary patient): the gate only lets the owner pick among what matched.
    const nodeId = data.choice.nodeId;
    const candidateIds = (Array.isArray(hold.candidates) ? hold.candidates : []).map(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (c: any) => c?.id,
    );
    if (!candidateIds.includes(nodeId)) {
      throw new Error("That patient isn't one of the options for this reward.");
    }

    // 1) Attribute the orphaned reward to the chosen patient (exact tuple).
    const { error: attrErr } = await sb
      .from("patient_reward_entries")
      .update({ patient_node_id: nodeId, updated_at: nowIso })
      .eq("user_id", effectiveUserId)
      .eq("manufacturer", hold.manufacturer)
      .eq("brand_product", hold.brand_product)
      .eq("match_key", hold.match_key);
    if (attrErr) throw new Error(`Couldn't attribute the reward: ${attrErr.message}`);

    // 2) Correction teaches — learn this exact contact fingerprint → patient, so
    //    the next import of the same person auto-resolves (no second guess).
    await looseTbl(sb, "reward_match_aliases").upsert(
      {
        user_id: effectiveUserId,
        fingerprint: hold.fingerprint,
        node_id: nodeId,
        updated_at: nowIso,
      },
      { onConflict: "user_id,fingerprint" },
    );

    // 3) Close the hold.
    await looseTbl(sb, "reward_attribution_holds")
      .update({ status: "resolved", resolved_node_id: nodeId, resolved_at: nowIso, updated_at: nowIso })
      .eq("id", hold.id)
      .eq("user_id", effectiveUserId);

    return { ok: true };
  });
