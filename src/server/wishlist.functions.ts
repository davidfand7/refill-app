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

// ─── Earned-gate: the value moment (project_trusted_onboarding) ─────────────
//
// The wishlist is an EARNED affordance, not an early-onboarding prompt:
// premature wishes — before the spa has felt SmartSpa earn its keep — are
// noise. The strategy doc's magic moment is "time-to-first-verifiable-dollar,"
// so the gate opens the first time this spa has a VERIFIED recovery win (real
// recovered revenue — the same signal the billing scoreboard bills on). Once
// earned it stays open. recovery_events is user-scoped (predates the
// tenant model), so we check the resolved owner's user_id. The widget also
// shows for an admin explicitly viewing-as a tenant (operator context), so the
// support channel is never hidden from us regardless of the spa's stage.
export const hasReachedValueMoment = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => listMyInput.parse(raw))
  .handler(async ({ data }): Promise<{ reached: boolean }> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    const { data: rows, error } = await sb
      .from("recovery_events")
      .select("id")
      .eq("user_id", effectiveUserId)
      .not("verified_at", "is", null)
      .limit(1);
    if (error) throw new Error(`Couldn't check value moment: ${error.message}`);
    return { reached: (rows ?? []).length > 0 };
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

// ═══════════════════════════════════════════════════════════════════════════
// v1.33.1 — AI-assist (Claude Sonnet 4.6) for Wishlist authoring
// ═══════════════════════════════════════════════════════════════════════════
//
// Three server fns that wrap the Anthropic SDK to help Karen turn a brief
// title into a buildable spec without writing it all herself:
//
//   aiDraftWishlistDescription  — Title → 3-5 sentence draft in Karen's voice
//   aiPolishWishlistDescription — Karen-edited description → structured spec
//                                  (WHAT/WHY/WHERE/acceptance criteria)
//   aiEstimateWishlistBuild     — Polished spec → one-line dev cost preview
//                                  ("~45 min build · scoped for v1.34.0")
//
// All three:
//   - Use Sonnet 4.6 (interactive UX latency + spec-writing quality sweet spot)
//   - Are gated through resolveEffectiveUserId + tenant check (cost protection)
//   - Surface typed Anthropic errors as toast-friendly messages
//   - Skip prompt caching (system prompts too short to clear the 2K token min)
//
// Requires `wrangler secret put ANTHROPIC_API_KEY` server-side.

import Anthropic from "@anthropic-ai/sdk";

// JSON schema for the polished spec format — passed to Claude's structured
// output system. Mirrors PolishedSpecSchema below but kept hand-written
// because @anthropic-ai/sdk's zodOutputFormat helper requires Zod v4 and
// the project is on Zod v3. We still validate the API response at runtime
// via PolishedSpecSchema.parse(), so we get the same safety either way.
const POLISHED_SPEC_JSON_SCHEMA = {
  type: "object" as const,
  properties: {
    what: {
      type: "string",
      description: "1-2 sentences naming the feature/change concretely",
    },
    why: {
      type: "string",
      description:
        "The spa owner's use case in her voice — preserve her framing and examples",
    },
    where: {
      type: "string",
      description: "Which Refill surface/page/flow this affects",
    },
    acceptanceCriteria: {
      type: "array",
      items: { type: "string" },
      description:
        "Testable bullets defining done — concrete enough to build without re-asking",
    },
  },
  required: ["what", "why", "where", "acceptanceCriteria"],
  additionalProperties: false,
};

const REFILL_CONTEXT = `Refill is a no-show recovery + patient profitability platform for med-spas, built on TanStack Start + Supabase + Cloudflare Workers. Spa owners use it to fill canceled appointment slots, soft-tag patients with editorial signals (income tier, negotiator stance, family relationships, etc.), track per-patient purchase cadence (toxin/filler/etc.), and request platform features via the Wishlist. The engineering team ships customer-requested features in 48 hours or less — that 48h SLA is the platform's competitive moat.`;

const KAREN_VOICE_SYSTEM_PROMPT = `You are drafting a Wishlist feature description on behalf of a med-spa owner using Refill.

${REFILL_CONTEXT}

Your job: take a brief feature title the spa owner typed, and draft a 3-5 sentence description in HER voice — first-person ("I"/"my spa"/"my patients"), concrete examples from her actual front-desk experience (real patient scenarios, real workflows), no developer jargon, no "as a user" templates. Write the way she would write if she had 5 minutes to flesh out the thought.

She'll edit the draft before submitting, so optimize for "good starting point" not "perfect final text."

Output ONLY the description text — no preamble, no headers, no quotation marks.`;

const BUILDABLE_SPEC_SYSTEM_PROMPT = `You are polishing a med-spa owner's feature Wishlist request into a buildable spec for the Refill engineering team.

${REFILL_CONTEXT}

The polished spec has four parts:
- what: 1-2 sentences naming the feature/change concretely. Engineering-direct.
- why: the spa owner's use case in HER voice. Preserve her framing and examples — her real-world motivation IS the requirement.
- where: which Refill surface/page/flow this affects (patient detail, soft tags card, recovery dashboard, admin tools, etc.). Be specific.
- acceptanceCriteria: 3-5 testable bullets defining "done" — concrete enough that an engineer can implement without re-asking the spa owner.

Don't expand scope beyond what she asked. If her description is ambiguous, the acceptance criteria should call out the ambiguity rather than guess.`;

const COST_ESTIMATE_SYSTEM_PROMPT = `You are estimating dev cost for a Refill Wishlist feature.

${REFILL_CONTEXT}

The Refill engineering pace (Po = Claude Opus working with Grasshopper, the CTO):
- Copy / layout tweaks: <30 min
- New form/card on existing page: 30-90 min
- New table + CRUD server fns + UI: 2-4 hours
- New cross-page workflow + admin tools: half-day to full-day
- Schema migration + complex business logic + multi-surface UI: full-day to multi-day

Return ONE LINE only, in this exact shape:
"~<duration> build · scoped for <vX.Y.Z>"

Examples:
"~45 min build · scoped for v1.34.0"
"~3 hours build · scoped for v1.34.0"
"~half-day build · scoped for v1.34.0"

Err toward "scoped for v1.X+1.0" if the spec has any non-trivial complexity. The next available pill after v1.33.x is v1.34.0.

Output ONLY the one-line estimate — no preamble, no headers, no quotation marks.`;

function getAnthropicClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "AI assist not configured — ANTHROPIC_API_KEY missing. Set it via `wrangler secret put ANTHROPIC_API_KEY`.",
    );
  }
  return new Anthropic({ apiKey });
}

function translateAnthropicError(e: unknown): never {
  if (e instanceof Anthropic.RateLimitError) {
    throw new Error("AI assist is rate-limited right now — try again in 30s.");
  }
  if (e instanceof Anthropic.AuthenticationError) {
    throw new Error(
      "AI assist not configured — admin needs to set ANTHROPIC_API_KEY.",
    );
  }
  if (e instanceof Anthropic.APIError) {
    throw new Error(`AI assist failed: ${e.message}`);
  }
  throw e;
}

// ─── Public types for AI-assist ───────────────────────────────────────────

export const PolishedSpecSchema = z.object({
  what: z
    .string()
    .describe("1-2 sentences naming the feature/change concretely"),
  why: z
    .string()
    .describe(
      "The spa owner's use case in her voice — preserve her framing and examples",
    ),
  where: z
    .string()
    .describe("Which Refill surface/page/flow this affects"),
  acceptanceCriteria: z
    .array(z.string())
    .min(2)
    .max(8)
    .describe(
      "Testable bullets defining done — concrete enough to build without re-asking",
    ),
});
export type PolishedSpec = z.infer<typeof PolishedSpecSchema>;

// ─── Zod input validators ─────────────────────────────────────────────────

const aiDraftInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
  title: z.string().min(1).max(140),
});

const aiPolishInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
  title: z.string().min(1).max(140),
  description: z.string().min(1).max(5000),
});

const aiEstimateInput = z.object({
  accessToken: z.string().min(1),
  viewAsUserId: z.string().uuid().optional(),
  polished: PolishedSpecSchema,
});

// ─── Fn 1: Draft description from title ───────────────────────────────────

export const aiDraftWishlistDescription = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => aiDraftInput.parse(raw))
  .handler(async ({ data }): Promise<{ description: string }> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    await getTenantIdForUser(sb, effectiveUserId); // tenant-gate the AI cost

    try {
      const response = await getAnthropicClient().messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        thinking: { type: "disabled" },
        output_config: { effort: "low" },
        system: KAREN_VOICE_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `Tag title from spa owner: "${data.title}"\n\nDraft a 3-5 sentence wishlist description in HER voice — first-person, concrete front-desk examples, no jargon. Output the description text only.`,
          },
        ],
      });

      const text = response.content
        .find((b): b is Anthropic.TextBlock => b.type === "text")
        ?.text?.trim();
      if (!text) throw new Error("AI returned no description.");
      return { description: text };
    } catch (e) {
      translateAnthropicError(e);
    }
  });

// ─── Fn 2: Polish edited description into buildable spec ──────────────────

export const aiPolishWishlistDescription = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => aiPolishInput.parse(raw))
  .handler(async ({ data }): Promise<{ polished: PolishedSpec }> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    await getTenantIdForUser(sb, effectiveUserId);

    try {
      const response = await getAnthropicClient().messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 2048,
        thinking: { type: "adaptive" },
        output_config: {
          effort: "medium",
          format: {
            type: "json_schema",
            schema: POLISHED_SPEC_JSON_SCHEMA,
          },
        },
        system: BUILDABLE_SPEC_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `Polish this wishlist request into a buildable spec.\n\nTitle: ${data.title}\n\nSpa owner's description:\n${data.description}`,
          },
        ],
      });

      const text = response.content
        .find((b): b is Anthropic.TextBlock => b.type === "text")
        ?.text?.trim();
      if (!text) {
        throw new Error(
          "AI polish returned no content — try editing your description and resubmitting, or skip polish and submit as-is.",
        );
      }
      const parsed: unknown = JSON.parse(text);
      const validated = PolishedSpecSchema.parse(parsed);
      return { polished: validated };
    } catch (e) {
      translateAnthropicError(e);
    }
  });

// ─── Fn 3: Dev-cost estimate from polished spec ───────────────────────────

export const aiEstimateWishlistBuild = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => aiEstimateInput.parse(raw))
  .handler(async ({ data }): Promise<{ estimate: string }> => {
    const { effectiveUserId } = await resolveEffectiveUserId({
      accessToken: data.accessToken,
      viewAsUserId: data.viewAsUserId,
    });
    const sb = admin();
    await getTenantIdForUser(sb, effectiveUserId);

    try {
      const response = await getAnthropicClient().messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 128,
        thinking: { type: "disabled" },
        output_config: { effort: "low" },
        system: COST_ESTIMATE_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `Estimate dev cost for this Wishlist spec:\n${JSON.stringify(data.polished, null, 2)}`,
          },
        ],
      });

      const text = response.content
        .find((b): b is Anthropic.TextBlock => b.type === "text")
        ?.text?.trim();
      if (!text) throw new Error("AI estimate returned empty.");
      return { estimate: text };
    } catch (e) {
      translateAnthropicError(e);
    }
  });
