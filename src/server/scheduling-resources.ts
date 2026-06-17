/**
 * Smart Scheduling — resource (room/chair/device) availability + assignment
 * (v1.58.0). Shared by the public booking fns and the owner calendar fns.
 *
 * Model: a service may require a resource TYPE. Resources of a type are
 * interchangeable (pooling) — capacity = count of active resources of that type.
 * A time is fulfillable when fewer than `capacity` appointments of that type
 * overlap it. At booking we pick a specific free resource and stamp resource_id;
 * the no_resource_overlap EXCLUDE constraint is the final race arbiter.
 *
 * Resource occupancy uses the appointment BODY [start, start+duration) — no
 * separate resource buffer in MVP (provider buffer already spaces a provider's
 * own appointments; cross-provider room contention uses bodies).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

type Sb = SupabaseClient<Database>;

export type ResourceType = "room" | "chair" | "device";

interface Interval {
  startMs: number;
  endMs: number;
}

/** IDs of active resources of a given type for a tenant. */
async function activeResourceIds(sb: Sb, tenantId: string, type: ResourceType): Promise<string[]> {
  const { data } = await sb
    .from("scheduling_resources")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("type", type)
    .eq("is_active", true);
  return (data ?? []).map((r) => r.id);
}

/** Live (non-cancelled, non-expired-hold) occupancy of the given resources. */
async function occupancy(sb: Sb, resourceIds: string[], fromMs: number, toMs: number) {
  if (!resourceIds.length) return [] as Array<Interval & { resourceId: string }>;
  const { data } = await sb
    .from("appointments")
    .select("scheduled_at, duration_min, status, slot_held_until, resource_id")
    .in("resource_id", resourceIds)
    .neq("status", "cancelled")
    .gte("scheduled_at", new Date(fromMs - 24 * 60 * 60_000).toISOString())
    .lt("scheduled_at", new Date(toMs + 24 * 60 * 60_000).toISOString());
  const now = Date.now();
  const out: Array<Interval & { resourceId: string }> = [];
  for (const a of data ?? []) {
    if (!a.resource_id) continue;
    // An expired hold frees the resource (mirrors the provider-busy logic).
    if (a.status === "held" && !(a.slot_held_until && new Date(a.slot_held_until).getTime() > now)) {
      continue;
    }
    const s = new Date(a.scheduled_at).getTime();
    out.push({ resourceId: a.resource_id, startMs: s, endMs: s + a.duration_min * 60_000 });
  }
  return out;
}

export interface ResourcePool {
  capacity: number;
  busy: Interval[];
}

/** Capacity + occupancy for a type across a window — used to filter offered slots. */
export async function loadResourcePool(
  sb: Sb,
  tenantId: string,
  type: ResourceType,
  fromIso: string,
  toIso: string,
): Promise<ResourcePool> {
  const ids = await activeResourceIds(sb, tenantId, type);
  const busy = await occupancy(sb, ids, new Date(fromIso).getTime(), new Date(toIso).getTime());
  return { capacity: ids.length, busy: busy.map(({ startMs, endMs }) => ({ startMs, endMs })) };
}

/** Is at least one resource free for [startMs, startMs+durationMin)? */
export function resourceFreeAt(pool: ResourcePool, startMs: number, durationMin: number): boolean {
  if (pool.capacity === 0) return false;
  const endMs = startMs + durationMin * 60_000;
  let overlaps = 0;
  for (const b of pool.busy) {
    if (b.startMs < endMs && b.endMs > startMs) overlaps++;
  }
  return overlaps < pool.capacity;
}

/**
 * Pick a specific free active resource of `type` for [startMs, startMs+dur).
 * Returns its id, or null if the type has no capacity / none free. The caller
 * stamps resource_id; the EXCLUDE constraint arbitrates concurrent races.
 */
export async function assignFreeResource(
  sb: Sb,
  tenantId: string,
  type: ResourceType,
  startMs: number,
  durationMin: number,
): Promise<string | null> {
  const ids = await activeResourceIds(sb, tenantId, type);
  if (!ids.length) return null;
  const endMs = startMs + durationMin * 60_000;
  const busy = await occupancy(sb, ids, startMs, endMs);
  const byResource = new Map<string, Interval[]>();
  for (const b of busy) {
    const arr = byResource.get(b.resourceId) ?? [];
    arr.push({ startMs: b.startMs, endMs: b.endMs });
    byResource.set(b.resourceId, arr);
  }
  for (const id of ids) {
    const intervals = byResource.get(id) ?? [];
    const conflict = intervals.some((iv) => iv.startMs < endMs && iv.endMs > startMs);
    if (!conflict) return id;
  }
  return null;
}

/** Coerce a stored/required type string to the known union, or null. */
export function asResourceType(t: string | null | undefined): ResourceType | null {
  return t === "room" || t === "chair" || t === "device" ? t : null;
}
