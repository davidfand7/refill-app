/**
 * Wishlist server functions — v1.33.0 (Profitability Engine § N/A — this is the
 * COMPETITIVE MOAT layer, separate from the engine substrate).
 *
 * Per project_wishlist_thesis (banked 2026-06-01): customer-requested feature
 * build IS the moat. The pitch ("tired of one-size-fits-all? we'll build it
 * or tell you why we can't, in 48h") requires an in-product affordance.
 * This module exposes:
 *
 *   submitWishlistRequest    — Karen (spa-owner) submits a feature request.
 *   listMyWishlistRequests   — Karen sees her own status feed.
 *   addReplyToWishlistRequest— Either side appends to the conversation thread.
 *   listAllWishlistRequests  — Grasshopper (admin) sees the cross-tenant inbox.
 *   updateWishlistRequestStatus — Admin moves status through the workflow.
 *
 * Auth pattern:
 *   - Tenant-side fns: resolveEffectiveUserId (viewAs-honored).
 *   - Admin-side fns: requireAdmin (user_roles.role='admin').
 *   - Service-role client for all writes; manual user_id / tenant_id scoping
 *     mirrors the canonical_brands pattern from v1.30.0.
 *
 * Schema: see supabase/migrations/20260602002954_v1_33_0_wishlist.sql
 *
 * NOTE: types.ts has NOT yet been regenerated for the wishlist_requests
 * table, so all .from("wishlist_requests") calls use `as never` to satisfy
 * TS. Runtime behaviour is correct against the deployed schema.
 */

import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database, Json } from "@/integrations/supabase/types";
import { resolveEffectiveUserId } from "@/server/auth-helpers";

// ─── Public types ─────────────────────────────────────────────────────────

export type WishlistStatus =
  | "submitted"
  | "reviewing"
  | "in_progress"
  | "shipped"
  | "declined";

export type WishlistPriority = "low" | "normal" | "high" | "urgent";

export type WishlistMessage = {
  id: string;
  fromUserId: string;
  fromRole: "owner" | "admin";
  body: string;
  sentAt: string;
};

export type WishlistRequest = {
  id: string;
  userId: string;
  tenantId: string;
  title: string;
  description: string;
  area: string | null;
  priority: WishlistPriority;
  status: WishlistStatus;
  messages: WishlistMessage[];
  adminNotes: string | null;
  shippedInVersion: string | null;
  createdAt: string;
  updatedAt: string;
  reviewingAt: string | null;
  inProgressAt: string | null;
  shippedAt: string | null;
  declinedAt: string | null;
};

/** Admin inbox row — adds a denormalized tenant + submitter label for the list view. */
export type AdminWishlistRequest = WishlistRequest & {
  tenantName: string | null;
  submitterEmail: string | null;
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

async function getTenantIdForUser(
  sb: SupabaseAdmin,
  userId: string,
): Promise<string> {
  const { data, error } = await sb
    .from("tenant_memberships")
    .select("tenant_id, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Tenant lookup failed: ${error.message}`);
  if (!data) {
    throw new Error("No Refill tenant — finish onboarding before submitting a wishlist request.");
  }
  return data.tenant_id;
}

async function requireAdmin(
  sb: SupabaseAdmin,
  userId: string,
): Promise<void> {
  const { data, error } = await sb
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (error) throw new Error(`Role check failed: ${error.message}`);
  if (!data) throw new Error("Admin role required.");
}

// ─── Hydration ────────────────────────────────────────────────────────────

type WishlistRow = {
  id: string;
  user_id: string;
  tenant_id: string;
  title: string;
  description: string;
  area: string | null;
  priority: WishlistPriority;
  status: WishlistStatus;
  messages: WishlistMessage[] | null;
  admin_notes: string | null;
  shipped_in_version: string | null;
  created_at: string;
  updated_at: string;
  reviewing_at: string | null;
  in_progress_at: string | null;
  shipped_at: string | null;
  declined_at: string | null;
};

function hydrate(row: WishlistRow): WishlistRequest {
  return {
    id: row.id,
    userId: row.user_id,
    tenantId: row.tenant_id,
    title: row.title,
    description: row.description,
    area: row.area,
    priority: row.priority,
    status: row.status,
    messages: Array.isArray(row.messages) ? row.messages : [],
    adminNotes: row.admin_notes,
    shippedInVersion: row.shipped_in_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    reviewingAt: row.reviewing_at,
    inProgressAt: row.in_progress_at,
    shippedAt: row.shipped_at,
    declinedAt: row.declined_at,
  };
}

// ─── Zod validators ───────────────────────────────────────────────────────

const submitInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
  title: z.string().min(1).max(140),
  description: z.string().min(1).max(5000),
  area: z.string().max(200).nullable().optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
});

const listMyInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
});

const replyInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
  requestId: z.string().uuid(),
  body: z.string().min(1).max(5000),
});

const listAllInput = z.object({
  accessToken: z.string().min(1),
  statusFilter: z
    .array(z.enum(["submitted", "reviewing", "in_progress", "shipped", "declined"]))
    .optional(),
});

const updateStatusInput = z.object({
  accessToken: z.string().min(1),
  requestId: z.string().uuid(),
  status: z.enum(["submitted", "reviewing", "in_progress", "shipped", "declined"]),
  shippedInVersion: z.string().max(32).nullable().optional(),
  adminNotes: z.string().max(5000).nullable().optional(),
});

// ─── Server fns ───────────────────────────────────────────────────────────

export const submitWishlistRequest = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => submitInput.parse(raw))
  .handler(async ({ data }): Promise<WishlistRequest> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const tenantId = await getTenantIdForUser(sb, effectiveUserId);
    const { data: inserted, error } = await (sb as unknown as {
      from: (table: string) => {
        insert: (row: Record<string, unknown>) => {
          select: (cols: string) => {
            single: () => Promise<{ data: WishlistRow | null; error: { message: string } | null }>;
          };
        };
      };
    })
      .from("wishlist_requests")
      .insert({
        user_id: effectiveUserId,
        tenant_id: tenantId,
        title: data.title.trim(),
        description: data.description.trim(),
        area: data.area?.trim() || null,
        priority: data.priority,
        status: "submitted",
        messages: [] as unknown as Json,
      })
      .select("*")
      .single();
    if (error) throw new Error(`Couldn't submit wishlist request: ${error.message}`);
    if (!inserted) throw new Error("Wishlist insert returned no row.");
    return hydrate(inserted);
  });

export const listMyWishlistRequests = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => listMyInput.parse(raw))
  .handler(async ({ data }): Promise<WishlistRequest[]> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const { data: rows, error } = await (sb as unknown as {
      from: (table: string) => {
        select: (cols: string) => {
          eq: (col: string, val: string) => {
            order: (col: string, opts: { ascending: boolean }) => Promise<{
              data: WishlistRow[] | null;
              error: { message: string } | null;
            }>;
          };
        };
      };
    })
      .from("wishlist_requests")
      .select("*")
      .eq("user_id", effectiveUserId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(`Couldn't list requests: ${error.message}`);
    return (rows ?? []).map(hydrate);
  });

export const addReplyToWishlistRequest = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => replyInput.parse(raw))
  .handler(async ({ data }): Promise<WishlistRequest> => {
    const { effectiveUserId, callerUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    // Read existing row (admin or owner can reply; we check both paths).
    const { data: existing, error: readErr } = await (sb as unknown as {
      from: (table: string) => {
        select: (cols: string) => {
          eq: (col: string, val: string) => {
            maybeSingle: () => Promise<{
              data: WishlistRow | null;
              error: { message: string } | null;
            }>;
          };
        };
      };
    })
      .from("wishlist_requests")
      .select("*")
      .eq("id", data.requestId)
      .maybeSingle();
    if (readErr) throw new Error(`Couldn't read request: ${readErr.message}`);
    if (!existing) throw new Error("Wishlist request not found.");

    // Determine role: caller is owner if they own the request; else verify admin.
    let fromRole: "owner" | "admin";
    if (existing.user_id === effectiveUserId) {
      fromRole = "owner";
    } else {
      await requireAdmin(sb, callerUserId);
      fromRole = "admin";
    }

    const priorMessages: WishlistMessage[] = Array.isArray(existing.messages)
      ? existing.messages
      : [];
    const nextMessages: WishlistMessage[] = [
      ...priorMessages,
      {
        id: crypto.randomUUID(),
        fromUserId: callerUserId,
        fromRole,
        body: data.body.trim(),
        sentAt: new Date().toISOString(),
      },
    ];

    const { data: updated, error: updErr } = await (sb as unknown as {
      from: (table: string) => {
        update: (vals: Record<string, unknown>) => {
          eq: (col: string, val: string) => {
            select: (cols: string) => {
              single: () => Promise<{
                data: WishlistRow | null;
                error: { message: string } | null;
              }>;
            };
          };
        };
      };
    })
      .from("wishlist_requests")
      .update({ messages: nextMessages as unknown as Json })
      .eq("id", data.requestId)
      .select("*")
      .single();
    if (updErr) throw new Error(`Couldn't add reply: ${updErr.message}`);
    if (!updated) throw new Error("Reply update returned no row.");
    return hydrate(updated);
  });

export const listAllWishlistRequests = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => listAllInput.parse(raw))
  .handler(async ({ data }): Promise<AdminWishlistRequest[]> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
    });
    const sb = admin();
    await requireAdmin(sb, effectiveUserId);

    // Pull requests + join tenant + submitter info for the inbox display.
    type QueryBuilder = {
      from: (table: string) => {
        select: (cols: string) => {
          order: (col: string, opts: { ascending: boolean }) => Promise<{
            data: WishlistRow[] | null;
            error: { message: string } | null;
          }> & {
            in: (col: string, vals: string[]) => {
              order: (col: string, opts: { ascending: boolean }) => Promise<{
                data: WishlistRow[] | null;
                error: { message: string } | null;
              }>;
            };
          };
        };
      };
    };
    const baseQuery = (sb as unknown as QueryBuilder)
      .from("wishlist_requests")
      .select("*");
    let result: { data: WishlistRow[] | null; error: { message: string } | null };
    if (data.statusFilter && data.statusFilter.length > 0) {
      result = await (baseQuery.order("created_at", { ascending: false }) as Promise<
        typeof result
      > & {
        in: (col: string, vals: string[]) => {
          order: (col: string, opts: { ascending: boolean }) => Promise<typeof result>;
        };
      })
        .in("status", data.statusFilter)
        .order("created_at", { ascending: false });
    } else {
      result = await baseQuery.order("created_at", { ascending: false });
    }
    if (result.error)
      throw new Error(`Couldn't list requests: ${result.error.message}`);
    const requests = (result.data ?? []).map(hydrate);
    if (requests.length === 0) return [];

    // Hydrate tenant + submitter labels.
    const tenantIds = Array.from(new Set(requests.map((r) => r.tenantId)));
    const userIds = Array.from(new Set(requests.map((r) => r.userId)));

    const { data: tenants } = await sb
      .from("tenants")
      .select("id, name")
      .in("id", tenantIds);
    const tenantMap = new Map<string, string>();
    for (const t of tenants ?? []) {
      if (t.id && t.name) tenantMap.set(t.id, t.name);
    }

    const submitterMap = new Map<string, string>();
    for (const uid of userIds) {
      const { data: u } = await sb.auth.admin.getUserById(uid);
      const email = u?.user?.email ?? null;
      if (email) submitterMap.set(uid, email);
    }

    return requests.map((r) => ({
      ...r,
      tenantName: tenantMap.get(r.tenantId) ?? null,
      submitterEmail: submitterMap.get(r.userId) ?? null,
    }));
  });

export const updateWishlistRequestStatus = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => updateStatusInput.parse(raw))
  .handler(async ({ data }): Promise<WishlistRequest> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
    });
    const sb = admin();
    await requireAdmin(sb, effectiveUserId);

    const patch: Record<string, unknown> = { status: data.status };
    // Allow nulling these fields (e.g., re-opening a shipped request).
    if (data.shippedInVersion !== undefined) {
      patch.shipped_in_version = data.shippedInVersion;
    }
    if (data.adminNotes !== undefined) {
      patch.admin_notes = data.adminNotes;
    }

    const { data: updated, error } = await (sb as unknown as {
      from: (table: string) => {
        update: (vals: Record<string, unknown>) => {
          eq: (col: string, val: string) => {
            select: (cols: string) => {
              single: () => Promise<{
                data: WishlistRow | null;
                error: { message: string } | null;
              }>;
            };
          };
        };
      };
    })
      .from("wishlist_requests")
      .update(patch)
      .eq("id", data.requestId)
      .select("*")
      .single();
    if (error) throw new Error(`Couldn't update status: ${error.message}`);
    if (!updated) throw new Error("Update returned no row.");
    return hydrate(updated);
  });
