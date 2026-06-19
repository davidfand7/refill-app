/**
 * Smart-A/B conversion crediting (v2.98) — the booking half of the live loop.
 *
 * When a booking is attributed to a patient + service, credit the A/B arm THAT
 * patient was assigned (offer_experiment_assignments) with a conversion — the
 * "vote." Sticky + idempotent: each patient's assignment converts at most once
 * (converted_at guard), so a second booking can't double-count their vote.
 *
 * Lives in its own module (depends only on the pure matcher, not the
 * promo-calendar functions) so the booking path can import it without the
 * circular dependency that draftExperimentPush ↔ promo-calendar would create.
 * Best-effort: the caller wraps it; it never throws into the booking flow.
 */

import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { productMatchesName, normalizeForMatch } from "@/lib/promo-calendar";

type AnySb = ReturnType<typeof createClient<Database>>;

/**
 * Credit the patient's assigned arm a conversion if one of the booked service
 * names matches that arm's product. Returns whether a vote was recorded.
 */
export async function recordExperimentConversion(
  sb: AnySb,
  tenantId: string,
  patientNodeId: string,
  serviceNames: string[],
): Promise<{ credited: boolean }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const any = sb as unknown as { from(t: string): any };

  const { data: assigns } = await any
    .from("offer_experiment_assignments")
    .select("id, arm_offer_id, experiment_id")
    .eq("tenant_id", tenantId)
    .eq("patient_node_id", patientNodeId)
    .is("converted_at", null)
    // Bounded by design: a patient has at most one open assignment per
    // experiment they've been pushed (realistically 1–3). Cap well above that.
    .limit(100);
  const rows = (assigns as Array<{ id: string; arm_offer_id: string; experiment_id: string }> | null) ?? [];
  if (rows.length === 0) return { credited: false };

  // Load the assigned arms' products to match against the booked services.
  const armIds = [...new Set(rows.map((r) => r.arm_offer_id))];
  const { data: arms } = await any
    .from("manufacturer_promo_offers")
    .select("id, product")
    .in("id", armIds)
    .limit(armIds.length); // exactly the assigned arms — bounded by the query above
  const productById = new Map(
    ((arms as Array<{ id: string; product: string }> | null) ?? []).map((a) => [a.id, a.product]),
  );

  const normalizedBooked = serviceNames.map((n) => normalizeForMatch(n)).filter(Boolean);

  for (const r of rows) {
    const product = productById.get(r.arm_offer_id);
    if (!product) continue;
    const matches = normalizedBooked.some((n) => productMatchesName(product, n));
    if (!matches) continue;

    // Atomic conversion +1 (single UPDATE under a row lock) — concurrent
    // bookings can't lose the increment. Stamp the assignment converted so this
    // patient's vote counts at most once.
    await (
      sb as unknown as { rpc(fn: string, p: Record<string, unknown>): PromiseLike<unknown> }
    ).rpc("bump_ab_conversion", { p_offer_id: r.arm_offer_id });
    await any
      .from("offer_experiment_assignments")
      .update({ converted_at: new Date().toISOString() })
      .eq("id", r.id);
    return { credited: true };
  }
  return { credited: false };
}
