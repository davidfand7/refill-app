/**
 * Shared spa-profile readers for the three Emma surfaces.
 *
 * Pre-v1.26.19 these three helpers lived inline in each of
 *   src/server/emma-rescue.functions.ts
 *   src/server/emma-preshow.functions.ts
 *   src/server/emma-blast.functions.ts
 * with bit-for-bit identical bodies (resolveSpaFromNumber was the
 * 3-way duplicate; resolveSpaName the 2-way). The v1.26.18 entry
 * called out this folding as the next DRY pass — this is it.
 *
 * Every value lives in `knowledge_nodes` rows with
 *   user_id      = the spa tenant
 *   context      = 'spa-profile'
 *   lookup_key   = 'spa-name' | 'from-number' | 'owner-display-name'
 *   title        = the value
 *
 * The same bucket holds future tenant scalars (hours, address, etc.)
 * with no schema migration cost.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

type SpaProfileClient = SupabaseClient<Database>;

export async function resolveSpaName(
  sb: SpaProfileClient,
  userId: string,
): Promise<string> {
  const { data } = await sb
    .from("knowledge_nodes")
    .select("title")
    .eq("user_id", userId)
    .eq("context", "spa-profile")
    .eq("lookup_key", "spa-name")
    .maybeSingle();
  return data?.title?.trim() || "your spa";
}

// v1.26.12 — solo-practitioner override. When set, providerClause renders
// this name in place of the "with X" suppression for the case where the
// Acuity calendar's provider_name equals the spa name. Null = no override =
// suppression holds (matches v379.2 semantics for multi-practitioner spas
// where calendar names alias the practice).
export async function resolveOwnerDisplayName(
  sb: SpaProfileClient,
  userId: string,
): Promise<string | null> {
  const { data } = await sb
    .from("knowledge_nodes")
    .select("title")
    .eq("user_id", userId)
    .eq("context", "spa-profile")
    .eq("lookup_key", "owner-display-name")
    .maybeSingle();
  const trimmed = data?.title?.trim();
  return trimmed || null;
}

// v1.26.18 — pulls from knowledge_nodes spa-profile (the same bucket the
// v1.26.12 owner-display-name override lives in) instead of the
// `phone_numbers` table that never existed in Refill's schema (vestigial
// pattern from the cleaved-from Liz CRM). Returns null when unset; the
// willNeedFromNumber gate at the call site handles direct-vs-proxy modes.
export async function resolveSpaFromNumber(
  sb: SpaProfileClient,
  userId: string,
): Promise<string | null> {
  const { data } = await sb
    .from("knowledge_nodes")
    .select("title")
    .eq("user_id", userId)
    .eq("context", "spa-profile")
    .eq("lookup_key", "from-number")
    .maybeSingle();
  return data?.title?.trim() || null;
}

// v1.26.22 — Settings UI bundle reader. Returns all three scalars in one
// round-trip with no fallback strings ("your spa" etc. — those are
// SMS-composer concerns, not editor concerns). Empty/missing rows
// render as null so the form shows blank inputs.
export type SpaProfileLookupKey = "spa-name" | "owner-display-name" | "from-number";

export type SpaProfileBundle = {
  spaName: string | null;
  ownerDisplayName: string | null;
  fromNumber: string | null;
};

export async function getSpaProfileBundle(
  sb: SpaProfileClient,
  userId: string,
): Promise<SpaProfileBundle> {
  const { data } = await sb
    .from("knowledge_nodes")
    .select("lookup_key, title")
    .eq("user_id", userId)
    .eq("context", "spa-profile")
    .in("lookup_key", ["spa-name", "owner-display-name", "from-number"]);
  const byKey = new Map<string, string | null>(
    (data ?? []).map((r) => [r.lookup_key ?? "", r.title?.trim() || null]),
  );
  return {
    spaName: byKey.get("spa-name") ?? null,
    ownerDisplayName: byKey.get("owner-display-name") ?? null,
    fromNumber: byKey.get("from-number") ?? null,
  };
}

// v1.26.22 — Settings UI writer. UPSERT a single lookup_key; passing
// an empty/whitespace value DELETEs the row (cleanest representation
// of "unset" — both readers above treat null and empty-trim as the
// same state, so storing an explicit empty row would just create
// future ambiguity). Relies on the partial unique index on
// (user_id, context, lookup_key) WHERE context IN ('spa-profile',
// 'services') AND lookup_key IS NOT NULL from migration
// 20260511010000_idempotent_spa_claim.sql. PG matches the partial
// index for spa-profile inserts so ON CONFLICT resolves correctly.
export async function setSpaProfileLookupKey(
  sb: SpaProfileClient,
  userId: string,
  lookupKey: SpaProfileLookupKey,
  value: string | null,
): Promise<void> {
  const trimmed = value?.trim();
  if (!trimmed) {
    const { error } = await sb
      .from("knowledge_nodes")
      .delete()
      .eq("user_id", userId)
      .eq("context", "spa-profile")
      .eq("lookup_key", lookupKey);
    if (error) throw new Error(`Couldn't clear ${lookupKey}: ${error.message}`);
    return;
  }
  const { error } = await sb.from("knowledge_nodes").upsert(
    {
      user_id: userId,
      context: "spa-profile",
      lookup_key: lookupKey,
      title: trimmed,
    },
    { onConflict: "user_id,context,lookup_key" },
  );
  if (error) throw new Error(`Couldn't save ${lookupKey}: ${error.message}`);
}
